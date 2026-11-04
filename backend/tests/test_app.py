import atexit
import importlib
import sys
from types import SimpleNamespace

import pytest

import camera as camera_module
import config as config_module
import detector as detector_module
import usb_devices


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

    def __init__(
        self,
        camera_id,
        source,
        config,
        line,
        model_pool=None,
        vehicle_registry=None,
        detection_handler=None,
        transaction_state_provider=None,
    ):
        self.camera_id = camera_id
        self.source = source
        self.config = config
        self.line = line
        self.model_pool = model_pool
        self.vehicle_registry = vehicle_registry
        self.detection_handler = detection_handler
        self.transaction_state_provider = transaction_state_provider
        self.started = False
        self.stopped = False
        self.online = source not in (None, "", -1)
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
            "incomingVehicles": (
                [{"gid": "VEH-0001", "class": "car", "detectedAt": "2026-09-14T08:00:00Z", "points": 4}]
                if self.online
                else []
            ),
            "incomingPoints": 4 if self.online else None,
            "totalVehicles": 1 if self.online else None,
            "expectedVehicles": 0 if self.online else None,
            "vehicleCountState": "CALCULATING" if self.online else "OFFLINE",
        }

    def frames(self):
        yield f"--frame\r\nContent-Type: image/jpeg\r\n\r\nfake-jpeg-{self.camera_id}\r\n".encode()

    def raw_frames(self):
        yield f"--frame\r\nContent-Type: image/jpeg\r\n\r\nraw-jpeg-{self.camera_id}\r\n".encode()


@pytest.fixture
def app_module(monkeypatch, request):
    FakeCameraWorker.instances = []
    test_settings = SimpleNamespace(
        observation_only=True,
        node_b_display_mirror=getattr(request, "param", False),
        camera_1_source="rtsp" if getattr(request, "param", False) else "usb",
        # Deliberately unsafe legacy flags: the independent test guard must win.
        esp32_control_enabled=True,
        esp32_heartbeat_enabled=True,
        traffic_firestore_enabled=True,
        dv20_camera_index=2,
        logi_c270_camera_index=2,
        web_camera_index=1,
        camera_1_url="rtsp://camera-a.test/stream1",
        camera_2_url="rtsp://camera-b.test/stream1",
        detection_fps=5.0,
        frontend_origins=("http://frontend.test",),
        line=(0, 50, 100, 50),
        line_counting=True,
        global_id_local_grace_seconds=6.0,
        global_id_cross_camera_seconds=60.0,
        global_id_match_threshold=0.55,
        global_id_ambiguity_margin=0.08,
        global_id_minimum_sample_confidence=0.45,
        global_id_maximum_samples=8,
    )
    monkeypatch.setattr(camera_module, "CameraWorker", FakeCameraWorker)
    monkeypatch.setattr(detector_module, "ModelPool", FakeModelPool)
    monkeypatch.setattr(config_module, "settings", test_settings)
    monkeypatch.setattr(usb_devices, "enumerate_usb_devices", lambda: [
        {"index": 1, "name": "Webcam A"}, {"index": 2, "name": "Webcam B"},
    ])
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
    assert [worker.source for worker in FakeCameraWorker.instances] == [1, 2]
    assert all(worker.started for worker in FakeCameraWorker.instances)
    assert FakeCameraWorker.instances[0].model_pool is FakeCameraWorker.instances[1].model_pool
    assert FakeCameraWorker.instances[0].vehicle_registry is FakeCameraWorker.instances[1].vehicle_registry


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
        "incomingVehicles": [
            {"gid": "VEH-0001", "class": "car", "detectedAt": "2026-09-14T08:00:00Z", "points": 4}
        ],
        "incomingPoints": 4,
        "totalVehicles": 1,
        "expectedVehicles": 0,
        "vehicleCountState": "CALCULATING",
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


@pytest.mark.parametrize("app_module", [True], indirect=True)
def test_display_mirror_never_activates_node_b_or_signal_io(app_module, client, monkeypatch):
    import traffic_control
    from unittest.mock import Mock

    network = Mock(side_effect=AssertionError("Physical signal I/O reached"))
    monkeypatch.setattr(traffic_control, "urlopen", network)
    assert app_module.workers[1].source == "rtsp://camera-a.test/stream1"
    assert app_module.workers[2].source == -1
    assert not app_module.priority_controller.enabled
    assert app_module.signal_controller._heartbeat_thread is None
    assert not app_module.signal_controller._call("nodeA", "POST", "/command")["ok"]
    payload = client.get("/api/system/status").get_json()
    assert payload["cameraStatus"] == {"online": 1, "total": 2}
    second = payload["cameras"][1]
    assert second["testMirror"] and second["displayOnline"]
    assert not second["online"] and not second["classes"] and not second["incomingVehicles"]
    assert not app_module.read_node_points()["nodeB"]["ready"]
    assert client.post("/api/cameras/2/source", json={"sourceIndex": 1}).status_code == 409
    assert client.post("/api/local/reset-test-state").status_code == 409
    assert b"fake-jpeg-1" in client.get("/video/camera/2").data
    assert b"raw-jpeg-1" in client.get("/video/raw/camera/2").data
    assert len(FakeCameraWorker.instances) == 2
    html = client.get("/local").data
    assert b"TEST ONLY: Camera A display mirror" in html
    assert b"rtsp://camera-a.test" not in html
    network.assert_not_called()


def test_raw_video_is_separate_and_requires_online_camera(app_module, client):
    assert b"raw-jpeg-1" in client.get("/video/raw/camera/1").data
    assert b"fake-jpeg-1" in client.get("/video/camera/1").data
    assert client.get("/video/raw/camera/99").status_code == 404
    app_module.workers[1].online = False
    assert client.get("/video/raw/camera/1").status_code == 503


def test_source_switch_rejects_duplicate_instead_of_silently_swapping(app_module, client):
    assert client.post("/api/cameras/1/source", json={"sourceId": "rtsp://untrusted/stream"}).status_code == 400
    response = client.post("/api/cameras/1/source", json={"sourceId": "rtsp-1"})
    assert response.status_code == 200
    assert app_module.workers[1].source == "rtsp://camera-a.test/stream1"
    assert b"rtsp://" not in response.data
    assert response.get_json()["cameras"][0]["sourceName"] == "Tapo CCTV 1 (RTSP)"
    response = client.post("/api/cameras/1/source", json={"sourceIndex": 2})
    assert response.status_code == 409
    assert app_module.workers[1].source == "rtsp://camera-a.test/stream1"
    assert app_module.workers[2].source == 2
    assert client.post("/api/cameras/2/source", json={"sourceIndex": -1}).status_code == 200
    assert client.post("/api/cameras/1/source", json={"sourceIndex": 2}).status_code == 200
    assert app_module.workers[1].source == 2
    assert app_module.workers[2].source == -1


def test_dual_usb_observation_guard_blocks_all_signal_and_upload_paths(app_module, client, monkeypatch):
    from unittest.mock import Mock
    import traffic_control
    import traffic_transactions

    network = Mock(side_effect=AssertionError("External write attempted"))
    monkeypatch.setattr(traffic_control, "urlopen", network)
    monkeypatch.setattr(traffic_transactions, "urlopen", network)
    assert not app_module.display_mirror
    assert app_module.observation_only
    assert not app_module.priority_controller.enabled
    assert not app_module.transaction_writer.enabled
    assert app_module.signal_controller._heartbeat_thread is None
    for node in ("nodeA", "nodeB"):
        assert not app_module.signal_controller._call(node, "POST", "/command")["ok"]
    assert not app_module.signal_controller.apply("nodeA")["success"]
    app_module.signal_controller.heartbeat_once()
    app_module.transaction_writer.write({"test": True})
    assert client.post("/api/local/reset-test-state").status_code == 409
    assert client.get("/api/system/status").get_json()["observationOnly"] is True
    network.assert_not_called()


def test_discovered_sources_and_dual_usb_console(client):
    catalog = client.get("/api/cameras/sources").get_json()["sources"]
    assert catalog[:2] == [
        {"index": 1, "name": "Webcam A", "available": True},
        {"index": 2, "name": "Webcam B", "available": True},
    ]
    html = client.get("/local").data
    assert b"TEST ONLY: Camera A display mirror" not in html
    assert b"Observation only" in html
    assert b"/video/camera/1" in html and b"/video/camera/2" in html
    assert b"fake-jpeg-1" in client.get("/video/camera/1").data
    assert b"fake-jpeg-2" in client.get("/video/camera/2").data
    assert b"raw-jpeg-2" in client.get("/video/raw/camera/2").data


def test_source_switch_waits_for_capture_release(app_module, client):
    from unittest.mock import Mock

    original = app_module.workers[1]
    original.is_stopped = Mock(return_value=False)
    response = client.post("/api/cameras/1/source", json={"sourceId": "rtsp-1"})
    assert response.status_code == 503
    assert app_module.workers[1] is original
    assert not FakeCameraWorker.instances[-1].started


@pytest.mark.parametrize("body", [[], [1], "usb", True, None])
def test_invalid_source_selection_body(client, body):
    assert client.post("/api/cameras/1/source", json=body).status_code == 400
