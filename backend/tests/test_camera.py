from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import camera as camera_module
from camera import CameraWorker


class FakeDetector:
    def __init__(self, config, line):
        self.config = config
        self.line = line
        self.model = object()
        self.track_state = SimpleNamespace(passed=12)


@pytest.fixture
def worker(monkeypatch):
    monkeypatch.setattr(camera_module, "Detector", FakeDetector)
    config = SimpleNamespace(detection_fps=5.0, line_counting=True, reconnect_seconds=0.01)
    return CameraWorker(1, "rtsp://camera.test/stream1", config, (0, 50, 100, 50))


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


def test_start_rejects_an_unconfigured_camera(monkeypatch):
    monkeypatch.setattr(camera_module, "Detector", FakeDetector)
    config = SimpleNamespace(detection_fps=5.0, line_counting=True, reconnect_seconds=1.0)
    worker = CameraWorker(1, "", config, (0, 0, 10, 0))

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

