import threading
import time
from collections import Counter

import cv2

from config import Settings, mask_rtsp_url
from detector import Detector


class CameraWorker:
    """Owns one RTSP capture and one detector pipeline for a physical camera."""

    def __init__(self, camera_id: int, url: str, config: Settings, line: tuple[int, int, int, int]):
        self.camera_id = camera_id
        self.url = url
        self.config = config
        self.detector = Detector(config, line)

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
        self.error: str | None = None

    def start(self) -> None:
        if self._capture_thread and self._capture_thread.is_alive():
            return
        if not self.url:
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

    @staticmethod
    def _smoothed_fps(previous: float, instant: float) -> float:
        value = instant if previous <= 0 else (previous * 0.8) + (instant * 0.2)
        return round(value, 1)

    def _capture_loop(self) -> None:
        last_capture_at: float | None = None

        while not self._stop.is_set():
            capture = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            if not capture.isOpened():
                self.online = False
                self.error = f"Unable to connect to {mask_rtsp_url(self.url)}"
                capture.release()
                self._stop.wait(self.config.reconnect_seconds)
                continue

            try:
                while not self._stop.is_set():
                    ok, frame = capture.read()
                    captured_at = time.perf_counter()
                    if not ok:
                        self.online = False
                        self.error = "Camera stream interrupted; reconnecting"
                        with self._raw_condition:
                            self._raw_frame = None
                            self._raw_condition.notify_all()
                        break

                    if last_capture_at is not None:
                        elapsed = captured_at - last_capture_at
                        if elapsed > 0:
                            self.capture_fps = self._smoothed_fps(self.capture_fps, 1 / elapsed)
                    last_capture_at = captured_at

                    # This is intentionally a one-frame overwrite buffer. The
                    # detector always receives the newest frame and old RTSP
                    # frames never form a processing queue.
                    with self._raw_condition:
                        self._raw_frame = frame
                        self._raw_captured_at = captured_at
                        self._raw_version += 1
                        self._raw_condition.notify_all()

                    self.online = True
                    self.error = None
            finally:
                capture.release()

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
            encoded, jpeg = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
            completed_at = time.perf_counter()

            if encoded:
                with self._jpeg_condition:
                    self._jpeg_frame = jpeg.tobytes()
                    self._jpeg_version += 1
                    self._jpeg_condition.notify_all()

            self.visible = len({item["trackId"] for item in detections})
            self.classes = dict(Counter(item["class"] for item in detections))
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
        return {
            "id": self.camera_id,
            "configured": bool(self.url),
            "online": self.online,
            "testMirror": False,
            "captureFps": self.capture_fps if self.online else None,
            "fps": self.fps if self.online else None,
            "processingMs": self.processing_ms if self.online else None,
            "frameAgeMs": self.frame_age_ms if self.online else None,
            "tracker": "ByteTrack",
            "modelOnline": self.detector.model is not None,
            "visibleVehicles": self.visible if self.online else None,
            "vehiclesPassed": passed,
            "classes": self.classes if self.online else {},
        }
