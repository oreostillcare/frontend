import threading
import time
from collections import Counter

import cv2

from config import Settings, mask_rtsp_url
from detector import Detector, ModelPool, VEHICLE_CLASSES, draw_annotation_text
from vehicle_identity import GlobalVehicleRegistry


class CameraWorker:
    """Owns one camera capture and one detector pipeline for a physical camera."""

    def __init__(
        self,
        camera_id: int,
        source: int | str | None,
        config: Settings,
        line: tuple[int, int, int, int],
        model_pool: ModelPool | None = None,
        vehicle_registry: GlobalVehicleRegistry | None = None,
        detection_handler=None,
        transaction_state_provider=None,
    ):
        self.camera_id = camera_id
        self.source = source
        self.config = config
        self.detector = Detector(
            config,
            line,
            model_pool=model_pool,
            vehicle_registry=vehicle_registry,
        )
        self.detector.camera_id = camera_id
        self.detection_handler = detection_handler
        self.transaction_state_provider = transaction_state_provider

        self._stop = threading.Event()
        self._capture_thread: threading.Thread | None = None
        self._processing_thread: threading.Thread | None = None

        self._raw_condition = threading.Condition()
        self._raw_frame = None
        self._raw_version = 0
        self._raw_captured_at = 0.0

        self._jpeg_condition = threading.Condition()
        self._jpeg_frame: bytes | None = None
        self._jpeg_version = 0

        self.online = False
        self.capture_fps = 0.0
        self.fps = 0.0
        self.processing_ms: float | None = None
        self.frame_age_ms: float | None = None
        self.visible = 0
        self.classes: dict[str, int] = {}
        self.total_vehicles = 0
        self.expected_vehicles = 0
        self.vehicle_count_state = "CALCULATING"
        self.error: str | None = None

    def start(self) -> None:
        if self._capture_thread and self._capture_thread.is_alive():
            return
        if not self._source_is_configured(self.source):
            self.error = "Camera source not configured"
            return

        self._capture_thread = threading.Thread(
            target=self._capture_loop,
            name=f"camera-capture-{self.camera_id}",
            daemon=True,
        )
        self._processing_thread = threading.Thread(
            target=self._processing_loop,
            name=f"camera-detection-{self.camera_id}",
            daemon=True,
        )
        self._capture_thread.start()
        self._processing_thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._raw_condition:
            self._raw_condition.notify_all()
        with self._jpeg_condition:
            self._jpeg_condition.notify_all()

    def wait_until_stopped(self, timeout: float = 2.0) -> None:
        current_thread = threading.current_thread()
        for worker_thread in (self._capture_thread, self._processing_thread):
            if worker_thread and worker_thread is not current_thread:
                worker_thread.join(timeout=timeout)

    @staticmethod
    def _smoothed_fps(previous: float, instant: float) -> float:
        value = instant if previous <= 0 else (previous * 0.8) + (instant * 0.2)
        return round(value, 1)

    @staticmethod
    def _source_is_configured(source: int | str | None) -> bool:
        if isinstance(source, int):
            return source >= 0
        return bool(source and source.strip())

    def _open_capture(self):
        # RTSP - FOR FUTURE USE
        # The source URL may include username/password authentication. Restore
        # this return when switching the active source back to RTSP.
        # return cv2.VideoCapture(str(self.source), cv2.CAP_FFMPEG)

        # Camera Source = USB Cameras
        # DirectShow indices correspond to the Windows friendly-name order used
        # to configure Logi C270 HD WebCam and Web Camera.
        return cv2.VideoCapture(self.source, cv2.CAP_DSHOW)

    def _capture_errors(self) -> tuple[str, str]:
        # RTSP - FOR FUTURE USE
        # return (
        #     f"Unable to connect to {mask_rtsp_url(str(self.source))}",
        #     "Camera stream interrupted; reconnecting",
        # )

        # Camera Source = USB Cameras
        return (
            f"USB camera {self.camera_id} unavailable",
            f"USB camera {self.camera_id} interrupted; reconnecting",
        )

    def _mark_offline(self, error: str) -> None:
        self.online = False
        self.error = error
        with self._raw_condition:
            self._raw_frame = None
            self._raw_condition.notify_all()
        with self._jpeg_condition:
            self._jpeg_frame = None
            self._jpeg_condition.notify_all()

    def _capture_loop(self) -> None:
        last_capture_at: float | None = None
        unavailable_error, interrupted_error = self._capture_errors()

        while not self._stop.is_set():
            capture = None

            try:
                capture = self._open_capture()
                capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                capture.set(cv2.CAP_PROP_FPS, max(1, getattr(self.config, "camera_capture_fps", 60)))

                if not capture.isOpened():
                    self._mark_offline(unavailable_error)
                else:
                    while not self._stop.is_set():
                        ok, frame = capture.read()
                        captured_at = time.perf_counter()
                        if not ok or frame is None:
                            self._mark_offline(interrupted_error)
                            break

                        if last_capture_at is not None:
                            elapsed = captured_at - last_capture_at
                            if elapsed > 0:
                                self.capture_fps = self._smoothed_fps(self.capture_fps, 1 / elapsed)
                        last_capture_at = captured_at

                        # This is intentionally a one-frame overwrite buffer. The
                        # detector always receives the newest frame, so stale camera
                        # frames never form a processing queue.
                        with self._raw_condition:
                            self._raw_frame = frame
                            self._raw_captured_at = captured_at
                            self._raw_version += 1
                            self._raw_condition.notify_all()

                        self.online = True
                        self.error = None
            except (cv2.error, OSError, RuntimeError):
                self._mark_offline(unavailable_error)
            finally:
                if capture is not None:
                    try:
                        capture.release()
                    except (cv2.error, OSError, RuntimeError):
                        pass

            self._stop.wait(self.config.reconnect_seconds)

    def _processing_loop(self) -> None:
        interval = 1 / max(self.config.detection_fps, 0.1)
        last_raw_version = -1
        last_completed_at: float | None = None

        while not self._stop.is_set():
            with self._raw_condition:
                ready = self._raw_condition.wait_for(
                    lambda: self._stop.is_set()
                    or (self._raw_frame is not None and self._raw_version != last_raw_version),
                    timeout=1,
                )
                if self._stop.is_set():
                    return
                if not ready or self._raw_frame is None or self._raw_version == last_raw_version:
                    continue

                frame = self._raw_frame.copy()
                captured_at = self._raw_captured_at
                last_raw_version = self._raw_version

            started_at = time.perf_counter()
            annotated, detections = self.detector.process(frame)
            if self.detection_handler is not None:
                try:
                    self.detection_handler(self.camera_id, detections)
                except Exception as error:
                    self.error = f"Traffic transaction event error: {error}"
            self._draw_transaction_counts(annotated)
            encoded, jpeg = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
            completed_at = time.perf_counter()

            if encoded:
                with self._jpeg_condition:
                    self._jpeg_frame = jpeg.tobytes()
                    self._jpeg_version += 1
                    self._jpeg_condition.notify_all()

            zone_detections = [item for item in detections if item.get("inTrafficZone")]
            self.visible = len({item["trackId"] for item in zone_detections})
            counts = Counter(item["class"] for item in zone_detections)
            self.classes = {name: counts.get(name, 0) for name in sorted(VEHICLE_CLASSES)}
            self.processing_ms = round((completed_at - started_at) * 1000, 1)
            self.frame_age_ms = round((completed_at - captured_at) * 1000, 1)

            if last_completed_at is not None:
                completed_interval = completed_at - last_completed_at
                if completed_interval > 0:
                    self.fps = self._smoothed_fps(self.fps, 1 / completed_interval)
            last_completed_at = completed_at

            # Rate-limit inference, then fetch the newest frame on the next
            # iteration instead of holding a frame during the wait.
            processing_time = completed_at - started_at
            self._stop.wait(max(0, interval - processing_time))

    def _draw_transaction_counts(self, frame) -> None:
        incoming_ledger = getattr(self.detector, "incoming_ledger", None)
        incoming_vehicles, _ = incoming_ledger.snapshot() if incoming_ledger else ([], 0)
        live_total = len(incoming_vehicles)
        total_vehicles = live_total
        expected_vehicles = 0
        count_state = "CALCULATING"
        node_key = "nodeA" if self.camera_id == 1 else "nodeB"

        transaction = None
        if self.transaction_state_provider is not None:
            try:
                state = self.transaction_state_provider()
                transaction = state.get("active") if state else None
                if transaction is None and state:
                    excluded_gids = set(
                        state.get("nextBatchExcludedGids", {}).get(node_key, [])
                    )
                    total_vehicles = sum(
                        str(vehicle.get("gid") or "").strip() not in excluded_gids
                        for vehicle in incoming_vehicles
                    )
            except Exception as error:
                self.error = f"Traffic display state error: {error}"

        if transaction is not None:
            if transaction["sourceKey"] == node_key:
                total_vehicles = transaction["sourceRemaining"]
                count_state = "LOCKED BATCH"
            elif transaction["destinationKey"] == node_key:
                expected_vehicles = transaction["destinationRemaining"]
                count_state = "EXPECTING"

        self.total_vehicles = total_vehicles
        self.expected_vehicles = expected_vehicles
        self.vehicle_count_state = count_state
        draw_annotation_text(
            frame,
            (
                f"TOTAL VEHICLES: {total_vehicles}  "
                f"EXPECTED VEHICLES: {expected_vehicles}  {count_state}"
            ),
            (12, 52),
            0.56,
            2,
        )

    def frames(self):
        last_version = -1
        while not self._stop.is_set():
            with self._jpeg_condition:
                ready = self._jpeg_condition.wait_for(
                    lambda: self._stop.is_set()
                    or (self._jpeg_frame is not None and self._jpeg_version != last_version),
                    timeout=2,
                )
                if self._stop.is_set():
                    return
                if not ready or self._jpeg_frame is None or self._jpeg_version == last_version:
                    continue
                frame = self._jpeg_frame
                last_version = self._jpeg_version

            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"

    def telemetry(self) -> dict:
        passed = self.detector.track_state.passed if self.online and self.config.line_counting else None
        incoming_ledger = getattr(self.detector, "incoming_ledger", None)
        incoming_vehicles, incoming_points = (
            incoming_ledger.snapshot() if self.online and incoming_ledger else ([], None)
        )
        return {
            "id": self.camera_id,
            "configured": self._source_is_configured(self.source),
            "online": self.online,
            "testMirror": False,
            "captureFps": self.capture_fps if self.online else None,
            "fps": self.fps if self.online else None,
            "processingMs": self.processing_ms if self.online else None,
            "frameAgeMs": self.frame_age_ms if self.online else None,
            "tracker": "ByteTrack",
            "modelOnline": self.detector.model_online,
            "visibleVehicles": self.visible if self.online else None,
            "vehiclesPassed": passed,
            "classes": self.classes if self.online else {},
            "incomingVehicles": incoming_vehicles,
            "incomingPoints": incoming_points,
            "totalVehicles": self.total_vehicles if self.online else None,
            "expectedVehicles": self.expected_vehicles if self.online else None,
            "vehicleCountState": self.vehicle_count_state if self.online else "OFFLINE",
        }
