from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import camera as camera_module
from camera import CameraWorker


class FakeDetector:
    def __init__(self, config, line, use_coco_fallback=True, model_pool=None, vehicle_registry=None):
        self.config = config
        self.line = line
        self.use_coco_fallback = use_coco_fallback
        self.vehicle_registry = vehicle_registry
        self.model = object()
        self.model_online = True
        self.track_state = SimpleNamespace(passed=12)
        self.incoming_ledger = Mock()
        self.incoming_ledger.snapshot.return_value = (
            [{"gid": "VEH-0001", "class": "car", "detectedAt": "2026-09-14T08:00:00Z", "points": 4}],
            4,
        )


class StopAfterRetry:
    stopped = False

    def is_set(self):
        return self.stopped

    def wait(self, _timeout):
        self.stopped = True
        return True


@pytest.fixture
def worker(monkeypatch):
    monkeypatch.setattr(camera_module, "Detector", FakeDetector)
    config = SimpleNamespace(detection_fps=5.0, line_counting=True, reconnect_seconds=0.01)
    return CameraWorker(1, 0, config, (0, 50, 100, 50))


@pytest.mark.parametrize(
    ("previous", "instant", "expected"),
    [
        (0.0, 10.04, 10.0),
        (10.0, 20.0, 12.0),
        (12.5, 12.5, 12.5),
    ],
)
def test_smoothed_fps(previous, instant, expected):
    assert CameraWorker._smoothed_fps(previous, instant) == expected


def test_camera_worker_enables_dual_model_detection(worker):
    assert worker.detector.use_coco_fallback is True


def test_start_rejects_an_unconfigured_camera(monkeypatch):
    monkeypatch.setattr(camera_module, "Detector", FakeDetector)
    config = SimpleNamespace(detection_fps=5.0, line_counting=True, reconnect_seconds=1.0)
    worker = CameraWorker(1, None, config, (0, 0, 10, 0))

    worker.start()

    assert worker.error == "Camera source not configured"
    assert worker._capture_thread is None
    assert worker._processing_thread is None


def test_start_creates_capture_and_processing_threads_once(monkeypatch, worker):
    threads = []

    class FakeThread:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.started = False
            threads.append(self)

        def start(self):
            self.started = True

        def is_alive(self):
            return self.started

    monkeypatch.setattr(camera_module.threading, "Thread", FakeThread)

    worker.start()
    worker.start()

    assert len(threads) == 2
    assert {thread.kwargs["name"] for thread in threads} == {"camera-capture-1", "camera-detection-1"}
    assert all(thread.started for thread in threads)


def test_open_capture_uses_configured_directshow_index(monkeypatch, worker):
    capture = object()
    video_capture = Mock(return_value=capture)
    monkeypatch.setattr(camera_module.cv2, "VideoCapture", video_capture)

    assert worker._open_capture() is capture
    video_capture.assert_called_once_with(0, camera_module.cv2.CAP_DSHOW)


def test_capture_loop_marks_unavailable_webcam_offline_without_crashing(monkeypatch, worker):
    capture = Mock()
    capture.isOpened.return_value = False
    monkeypatch.setattr(camera_module.cv2, "VideoCapture", Mock(return_value=capture))
    worker._stop = StopAfterRetry()

    worker._capture_loop()

    assert worker.online is False
    assert worker.error == "USB camera 1 unavailable"
    assert worker._raw_frame is None
    capture.release.assert_called_once()


def test_capture_loop_handles_webcam_driver_error_without_crashing(monkeypatch, worker):
    monkeypatch.setattr(
        camera_module.cv2,
        "VideoCapture",
        Mock(side_effect=camera_module.cv2.error("camera unavailable")),
    )
    worker._stop = StopAfterRetry()

    worker._capture_loop()

    assert worker.online is False
    assert worker.error == "USB camera 1 unavailable"


@pytest.mark.parametrize("read_result", [(False, None), (True, None)])
def test_capture_loop_marks_webcam_read_failure_offline(monkeypatch, worker, read_result):
    capture = Mock()
    capture.isOpened.return_value = True
    capture.read.return_value = read_result
    monkeypatch.setattr(camera_module.cv2, "VideoCapture", Mock(return_value=capture))
    worker._stop = StopAfterRetry()
    worker._raw_frame = object()
    worker._jpeg_frame = b"stale-jpeg"

    worker._capture_loop()

    assert worker.online is False
    assert worker.error == "USB camera 1 interrupted; reconnecting"
    assert worker._raw_frame is None
    assert worker._jpeg_frame is None
    capture.release.assert_called_once()


def test_capture_loop_publishes_webcam_frame_and_marks_camera_online(monkeypatch, worker):
    class StopAfterFrame:
        checks = 0

        def is_set(self):
            self.checks += 1
            return self.checks >= 3

        def wait(self, _timeout):
            return True

    frame = object()
    capture = Mock()
    capture.isOpened.return_value = True
    capture.read.return_value = (True, frame)
    monkeypatch.setattr(camera_module.cv2, "VideoCapture", Mock(return_value=capture))
    worker._stop = StopAfterFrame()

    worker._capture_loop()

    assert worker.online is True
    assert worker.error is None
    assert worker._raw_frame is frame
    assert worker._raw_version == 1
    capture.release.assert_called_once()


def test_offline_telemetry_hides_stale_detection_values(worker):
    worker.online = False
    worker.capture_fps = 15.0
    worker.fps = 5.0
    worker.processing_ms = 30.0
    worker.frame_age_ms = 50.0
    worker.visible = 4
    worker.classes = {"car": 4}

    payload = worker.telemetry()

    assert payload == {
        "id": 1,
        "configured": True,
        "online": False,
        "testMirror": False,
        "captureFps": None,
        "fps": None,
        "processingMs": None,
        "frameAgeMs": None,
        "tracker": "ByteTrack",
        "modelOnline": True,
        "visibleVehicles": None,
        "vehiclesPassed": None,
        "classes": {},
        "incomingVehicles": [],
        "incomingPoints": None,
        "totalVehicles": None,
        "expectedVehicles": None,
        "vehicleCountState": "OFFLINE",
    }


def test_online_telemetry_exposes_current_counts(worker):
    worker.online = True
    worker.capture_fps = 15.0
    worker.fps = 5.0
    worker.processing_ms = 30.0
    worker.frame_age_ms = 50.0
    worker.visible = 3
    worker.classes = {"car": 2, "bus": 1}

    payload = worker.telemetry()

    assert payload["visibleVehicles"] == 3
    assert payload["vehiclesPassed"] == 12
    assert payload["classes"] == {"car": 2, "bus": 1}
    assert payload["incomingVehicles"] == [
        {"gid": "VEH-0001", "class": "car", "detectedAt": "2026-09-14T08:00:00Z", "points": 4}
    ]
    assert payload["incomingPoints"] == 4
    assert payload["totalVehicles"] == 0
    assert payload["expectedVehicles"] == 0
    assert payload["vehicleCountState"] == "CALCULATING"
    assert payload["captureFps"] == 15.0
    assert payload["fps"] == 5.0


def test_line_counting_disabled_hides_passed_total(worker):
    worker.online = True
    worker.config.line_counting = False

    assert worker.telemetry()["vehiclesPassed"] is None


def test_frames_yields_multipart_jpeg_payload(worker):
    worker._jpeg_frame = b"jpeg-data"
    worker._jpeg_version = 1

    stream = worker.frames()

    assert next(stream) == b"--frame\r\nContent-Type: image/jpeg\r\n\r\njpeg-data\r\n"
    stream.close()

