import atexit
import importlib
import sys
from types import SimpleNamespace

import pytest

import camera as camera_module
import config as config_module
import detector as detector_module


class FakeModelPool:
    def __init__(self, _settings):
        self.online = True

    def status(self):
        return {
            "local": {"weights": "trained_local.pt", "online": self.online, "error": None},
            "coco": {"weights": "yolov8n.pt", "online": self.online, "error": None},
        }


class FakeCameraWorker:
    instances = []

    def __init__(self, camera_id, source, config, line, model_pool=None):
        self.camera_id = camera_id
        self.source = source
        self.config = config
        self.line = line
        self.model_pool = model_pool
        self.started = False
        self.stopped = False
        self.online = True
        self.detector = SimpleNamespace(model_online=True, model_type="dual", weights="trained_local.pt + yolov8n.pt")
        self.__class__.instances.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def telemetry(self):
        return {
            "id": self.camera_id,
            "configured": self.source is not None and self.source != "",
            "online": self.online,
            "testMirror": False,
            "captureFps": 15.0 if self.online else None,
            "fps": 5.0 if self.online else None,
            "processingMs": 20.0 if self.online else None,
            "frameAgeMs": 25.0 if self.online else None,
            "tracker": "ByteTrack",
            "modelOnline": True,
            "visibleVehicles": 3 if self.online else None,
            "vehiclesPassed": 8 if self.online else None,
            "classes": {"car": 2, "bus": 1} if self.online else {},
        }

    def frames(self):
        yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\nfake-jpeg\r\n"


@pytest.fixture
def app_module(monkeypatch):
    FakeCameraWorker.instances = []
    test_settings = SimpleNamespace(
        dv20_camera_index=2,
        web_camera_index=1,
        camera_1_url="rtsp://camera-a.test/stream1",
        camera_2_url="rtsp://camera-b.test/stream1",
        detection_fps=5.0,
        frontend_origins=("http://frontend.test",),
        line=(0, 50, 100, 50),
        line_counting=True,
    )
    monkeypatch.setattr(camera_module, "CameraWorker", FakeCameraWorker)
    monkeypatch.setattr(detector_module, "ModelPool", FakeModelPool)
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


def test_import_starts_two_independent_usb_workers(app_module):
    assert list(app_module.workers) == [1, 2]
    assert [worker.source for worker in FakeCameraWorker.instances] == [2, 1]
    assert all(worker.started for worker in FakeCameraWorker.instances)
    assert FakeCameraWorker.instances[0].model_pool is FakeCameraWorker.instances[1].model_pool


def test_root_redirects_to_local_monitor(client):
    response = client.get("/")
    assert response.status_code == 302
    assert response.headers["Location"].endswith("/local")


def test_health_endpoint(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_system_status_maps_each_node_to_its_own_camera(client):
    payload = client.get("/api/system/status").get_json()
    assert payload["status"] == "online"
    assert payload["yoloOnline"] is True
    assert payload["cameraStatus"] == {"online": 2, "total": 2}
    assert payload["nodeA"]["cameraId"] == 1
    assert payload["nodeA"]["nodeId"] == "node-a"
    assert payload["nodeA"]["laneId"] == "lane-a"
    assert payload["nodeB"]["cameraId"] == 2
    assert payload["nodeB"]["nodeId"] == "node-b"
    assert payload["nodeB"]["laneId"] == "lane-b"


def test_one_failed_camera_only_marks_its_node_offline(app_module, client):
    app_module.workers[1].online = False
    payload = client.get("/api/system/status").get_json()
    assert payload["cameraStatus"] == {"online": 1, "total": 2}
    assert payload["nodeA"]["online"] is False
    assert payload["nodeB"]["online"] is True


def test_both_failed_cameras_report_zero_of_two_and_offline(app_module, client):
    app_module.workers[1].online = False
    app_module.workers[2].online = False
    payload = client.get("/api/system/status").get_json()
    assert payload["status"] == "offline"
    assert payload["cameraStatus"] == {"online": 0, "total": 2}


def test_camera_payloads_are_not_mirrors(client):
    first, second = client.get("/api/cameras").get_json()
    assert first["id"] == 1
    assert first["nodeId"] == "node-a"
    assert second["id"] == 2
    assert second["nodeId"] == "node-b"
    assert first["testMirror"] is False
    assert second["testMirror"] is False


def test_unknown_camera_returns_404(client):
    response = client.get("/api/cameras/99")
    assert response.status_code == 404
    assert response.get_json() == {"error": "Camera not found"}


def test_vehicle_count_detail_includes_node_mapping(client):
    response = client.get("/api/vehicle-counts/1")
    assert response.status_code == 200
    assert response.get_json() == {
        "id": 1,
        "nodeId": "node-a",
        "laneId": "lane-a",
        "visibleVehicles": 3,
        "vehiclesPassed": 8,
        "classes": {"car": 2, "bus": 1},
    }


def test_unknown_vehicle_count_camera_returns_404(client):
    response = client.get("/api/vehicle-counts/99")
    assert response.status_code == 404
    assert response.get_json() == {"error": "Camera not found"}


def test_model_endpoint_reports_both_models(client):
    payload = client.get("/api/model").get_json()
    assert payload["model"] == "dual"
    assert payload["weights"] == "trained_local.pt + yolov8n.pt"
    assert payload["online"] is True
    assert set(payload["models"]) == {"local", "coco"}


def test_video_endpoint_streams_each_worker(client):
    response = client.get("/video/camera/2")
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
