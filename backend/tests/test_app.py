import atexit
import importlib
from types import SimpleNamespace
import sys

import pytest

import camera as camera_module
import config as config_module


class FakeCameraWorker:
    instances = []

    def __init__(self, camera_id, url, config, line):
        self.camera_id = camera_id
        self.url = url
        self.config = config
        self.line = line
        self.started = False
        self.stopped = False
        self.detector = SimpleNamespace(model=object(), model_type="custom", weights="best.pt")
        self.__class__.instances.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def telemetry(self):
        return {
            "id": self.camera_id,
            "configured": bool(self.url),
            "online": True,
            "testMirror": False,
            "captureFps": 15.0,
            "fps": 5.0,
            "processingMs": 20.0,
            "frameAgeMs": 25.0,
            "tracker": "ByteTrack",
            "modelOnline": True,
            "visibleVehicles": 3,
            "vehiclesPassed": 8,
            "classes": {"car": 2, "bus": 1},
        }

    def frames(self):
        yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\nfake-jpeg\r\n"


@pytest.fixture
def app_module(monkeypatch):
    FakeCameraWorker.instances = []
    test_settings = SimpleNamespace(
        camera_1_url="rtsp://camera.test/stream1",
        camera_2_url="",
        detection_fps=5.0,
        frontend_origins=("http://frontend.test",),
        line=(0, 50, 100, 50),
        line_counting=True,
        test_single_camera_mode=True,
    )
    monkeypatch.setattr(camera_module, "CameraWorker", FakeCameraWorker)
    monkeypatch.setattr(config_module, "settings", test_settings)
    sys.modules.pop("app", None)
    module = importlib.import_module("app")
    module.app.config.update(TESTING=True)

    yield module

    module.stop_workers()
    atexit.unregister(module.stop_workers)
    sys.modules.pop("app", None)


@pytest.fixture
def client(app_module):
    return app_module.app.test_client()


def test_import_starts_only_the_configured_primary_worker(app_module):
    assert list(app_module.workers) == [1]
    assert len(FakeCameraWorker.instances) == 1
    assert FakeCameraWorker.instances[0].started is True


def test_root_redirects_to_local_monitor(client):
    response = client.get("/")

    assert response.status_code == 302
    assert response.headers["Location"].endswith("/local")


def test_health_endpoint(client):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_system_status_uses_current_worker_telemetry(client):
    response = client.get("/api/system/status")
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["status"] == "online"
    assert payload["yoloOnline"] is True
    assert payload["nodeA"] == {"signal": "UNKNOWN"}
    assert payload["nodeB"] == {"signal": "UNKNOWN"}
    assert [camera["id"] for camera in payload["cameras"]] == [1, 2]


def test_single_camera_mode_mirrors_camera_one_as_camera_two(client):
    response = client.get("/api/cameras")
    first, second = response.get_json()

    assert first["id"] == 1
    assert first["testMirror"] is False
    assert second["id"] == 2
    assert second["testMirror"] is True
    assert second["sourceCamera"] == 1
    assert second["configured"] is True


def test_unknown_camera_returns_404(client):
    response = client.get("/api/cameras/99")

    assert response.status_code == 404
    assert response.get_json() == {"error": "Camera not found"}


def test_vehicle_count_detail_returns_only_count_fields(client):
    response = client.get("/api/vehicle-counts/1")

    assert response.status_code == 200
    assert response.get_json() == {
        "id": 1,
        "visibleVehicles": 3,
        "vehiclesPassed": 8,
        "classes": {"car": 2, "bus": 1},
    }


def test_unknown_vehicle_count_camera_returns_404(client):
    response = client.get("/api/vehicle-counts/99")

    assert response.status_code == 404
    assert response.get_json() == {"error": "Camera not found"}


def test_model_endpoint_reports_detector_state(client):
    response = client.get("/api/model")

    assert response.status_code == 200
    assert response.get_json() == {
        "model": "custom",
        "weights": "best.pt",
        "online": True,
    }


def test_video_endpoint_streams_worker_frames(client):
    response = client.get("/video/camera/1")

    assert response.status_code == 200
    assert response.mimetype == "multipart/x-mixed-replace"
    assert b"fake-jpeg" in response.data


def test_unknown_video_camera_returns_404(client):
    response = client.get("/video/camera/99")

    assert response.status_code == 404
    assert response.get_json() == {"error": "Camera not found"}


def test_api_cors_allows_configured_frontend(client):
    response = client.get("/api/health", headers={"Origin": "http://frontend.test"})

    assert response.headers["Access-Control-Allow-Origin"] == "http://frontend.test"

