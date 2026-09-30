import atexit
import os
import secrets
import threading
from urllib.error import URLError
from urllib.request import Request, urlopen

from flask import Flask, Response, jsonify, redirect, render_template, request, url_for
from flask_cors import CORS

from camera import CameraWorker
from config import settings
from detector import ModelPool
from traffic_control import Esp32SignalController, PointComparisonController
from traffic_transactions import FirestoreTransactionWriter, TrafficTransactionManager
from vehicle_identity import GlobalVehicleRegistry

app = Flask(__name__)
runtime_id = secrets.token_hex(8)
reset_lock = threading.Lock()
test_reset_lock = threading.Lock()
test_reset_token = secrets.token_urlsafe(32)
CORS(
    app,
    resources={
        r"/api/*": {"origins": settings.frontend_origins},
        r"/video/*": {"origins": settings.frontend_origins},
    },
)

NODE_CAMERA_MAP = {"nodeA": 1, "nodeB": 2}
CAMERA_NODE_MAP = {
    1: {"nodeId": "node-a", "node": "Node A", "laneId": "lane-a", "lane": "Lane A"},
    2: {"nodeId": "node-b", "node": "Node B", "laneId": "lane-b", "lane": "Lane B"},
}
CAMERA_DEVICES = (
    {
        "index": getattr(settings, "logi_c270_camera_index", settings.dv20_camera_index),
        "name": "Logi C270 HD WebCam",
    },
    {"index": settings.web_camera_index, "name": "Web Camera"},
)
CAMERA_DEVICE_NAMES = {device["index"]: device["name"] for device in CAMERA_DEVICES}

# Camera Source = USB Cameras
camera_sources: dict[int, int | str] = {
    1: settings.web_camera_index,  # Node A / Lane A -> Web Camera
    2: getattr(settings, "logi_c270_camera_index", settings.dv20_camera_index),  # Node B -> Logi C270
}

# RTSP - FOR FUTURE USE
# Keep these source assignments disabled until the deployment switches from USB.
# camera_sources = {
#     1: settings.camera_1_url,
#     2: settings.camera_2_url,
# }

model_pool = ModelPool(settings)
transaction_manager = TrafficTransactionManager(
    outgoing_confirmation_frames=getattr(settings, "traffic_outgoing_confirmation_frames", 3),
    outgoing_confirmation_seconds=getattr(
        settings,
        "traffic_outgoing_confirmation_seconds",
        1.0,
    ),
    outgoing_id_switch_grace_seconds=getattr(
        settings,
        "traffic_outgoing_id_switch_grace_seconds",
        1.0,
    ),
)
vehicle_registry = GlobalVehicleRegistry(
    local_grace_seconds=settings.global_id_local_grace_seconds,
    cross_camera_seconds=settings.global_id_cross_camera_seconds,
    match_threshold=settings.global_id_match_threshold,
    ambiguity_margin=settings.global_id_ambiguity_margin,
    minimum_sample_confidence=settings.global_id_minimum_sample_confidence,
    maximum_samples=settings.global_id_maximum_samples,
)


def create_camera_worker(camera_id: int, source: int | str) -> CameraWorker:
    return CameraWorker(
        camera_id,
        source,
        settings,
        settings.line,
        model_pool=model_pool,
        vehicle_registry=vehicle_registry,
        detection_handler=transaction_manager.observe_detections,
        transaction_state_provider=transaction_manager.snapshot,
    )


def reset_detection_state() -> None:
    """Recreate both detector pipelines and clear all session-wide test state."""
    with workers_lock:
        replacement_workers = {
            camera_id: create_camera_worker(camera_id, worker.source)
            for camera_id, worker in workers.items()
        }
        active_workers = list(workers.values())
        for worker in active_workers:
            worker.stop()
        for worker in active_workers:
            wait_until_stopped = getattr(worker, "wait_until_stopped", None)
            if wait_until_stopped:
                wait_until_stopped()

        transaction_manager.reset()
        vehicle_registry.reset()
        workers.update(replacement_workers)
        camera_sources.update(
            {camera_id: worker.source for camera_id, worker in replacement_workers.items()}
        )
        for worker in replacement_workers.values():
            worker.start()


workers_lock = threading.RLock()
workers: dict[int, CameraWorker] = {
    camera_id: create_camera_worker(camera_id, source)
    for camera_id, source in camera_sources.items()
}
for worker in workers.values():
    worker.start()


def read_node_points() -> dict:
    node_scores = {}
    for node_name, camera_id in NODE_CAMERA_MAP.items():
        worker = workers[camera_id]
        ledger = getattr(worker.detector, "incoming_ledger", None)
        vehicles, _ = ledger.snapshot() if ledger else ([], 0)
        vehicles = transaction_manager.next_batch_candidates(node_name, vehicles)
        points = sum(int(vehicle.get("points") or 0) for vehicle in vehicles)
        node_scores[node_name] = {
            "points": points,
            "vehicles": vehicles,
            "ready": bool(worker.online and worker.detector.model_online),
        }
    return node_scores


signal_controller = Esp32SignalController(
    node_a_ip=getattr(settings, "esp32_node_a_ip", "192.168.1.220"),
    node_b_ip=getattr(settings, "esp32_node_b_ip", "192.168.1.221"),
    timeout_seconds=getattr(settings, "esp32_timeout_seconds", 1.25),
    request_attempts=getattr(settings, "esp32_request_attempts", 2),
    heartbeat_interval_seconds=getattr(settings, "esp32_heartbeat_interval_seconds", 2.0),
    heartbeat_timeout_seconds=getattr(settings, "esp32_heartbeat_timeout_seconds", 5.0),
)
if getattr(settings, "esp32_heartbeat_enabled", False):
    signal_controller.start_heartbeat()
transaction_writer = FirestoreTransactionWriter(
    endpoint=getattr(
        settings,
        "traffic_firestore_url",
        "http://127.0.0.1:3000/api/traffic/transactions",
    ),
    secret=getattr(settings, "traffic_ingest_secret", ""),
    timeout_seconds=getattr(settings, "traffic_firestore_timeout_seconds", 5.0),
    enabled=getattr(settings, "traffic_firestore_enabled", False),
)
priority_controller = PointComparisonController(
    read_points=read_node_points,
    signal_controller=signal_controller,
    interval_seconds=getattr(settings, "traffic_comparison_interval_seconds", 1.0),
    enabled=getattr(settings, "esp32_control_enabled", False),
    transaction_manager=transaction_manager,
    transaction_writer=transaction_writer,
)
priority_controller.start()


def stop_workers():
    signal_controller.stop_heartbeat()
    priority_controller.stop()
    with workers_lock:
        active_workers = list(workers.values())
    for worker in active_workers:
        worker.stop()


atexit.register(stop_workers)


@app.get("/")
def index():
    return redirect(url_for("local_monitor"))


@app.get("/local")
def local_monitor():
    return render_template(
        "local_monitor.html",
        camera_devices=CAMERA_DEVICES,
        camera_sources=camera_sources,
        detection_fps=settings.detection_fps,
        line_counting=settings.line_counting,
        reset_available=bool(os.getenv("LOCAL_SUPERVISOR_URL") and os.getenv("LOCAL_RESET_PIN")),
        test_reset_token=test_reset_token,
    )


def camera_worker(camera_id: int) -> CameraWorker | None:
    with workers_lock:
        return workers.get(camera_id)


def camera_payload(camera_id: int):
    worker = camera_worker(camera_id)
    if worker is None:
        return None
    payload = worker.telemetry()
    payload.update(
        {
            "id": camera_id,
            "sourceIndex": worker.source if isinstance(worker.source, int) else None,
            "sourceName": CAMERA_DEVICE_NAMES.get(worker.source, "Unknown camera"),
            **CAMERA_NODE_MAP[camera_id],
        }
    )
    return payload


def node_payload(node_name: str, camera: dict | None = None) -> dict:
    camera_id = NODE_CAMERA_MAP[node_name]
    camera = camera or camera_payload(camera_id)
    control = priority_controller.snapshot()
    node_control = control[node_name]
    return {
        "signal": node_control["signal"],
        "cameraId": camera_id,
        "nodeId": camera["nodeId"],
        "laneId": camera["laneId"],
        "online": camera["online"],
        "visibleVehicles": camera["visibleVehicles"],
        "vehiclesPassed": camera["vehiclesPassed"],
        "classes": camera["classes"],
        "incomingVehicles": camera["incomingVehicles"],
        "incomingPoints": camera["incomingPoints"],
        "totalVehicles": camera["totalVehicles"],
        "expectedVehicles": camera["expectedVehicles"],
        "vehicleCountState": camera["vehicleCountState"],
        "mode": control["mode"],
        "status": control["commandedState"],
    }


@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.get("/api/local/runtime")
def local_runtime():
    return jsonify({"runtimeId": runtime_id})


@app.post("/api/local/reset-test-state")
def reset_test_state():
    origin = request.headers.get("Origin")
    if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
        return jsonify({"error": "Reset must be requested from this console"}), 403
    supplied_token = request.headers.get("X-Test-Reset-Token", "")
    if not secrets.compare_digest(supplied_token, test_reset_token):
        return jsonify({"error": "Invalid test reset token"}), 403

    if not test_reset_lock.acquire(blocking=False):
        return jsonify({"error": "A test reset is already running"}), 409
    try:
        control = priority_controller.reset_for_testing(reset_detection_state)
    finally:
        test_reset_lock.release()
    if control["commandedState"] != "BOTH RED" or control["lastError"]:
        return (
            jsonify(
                {
                    "error": control["lastError"] or "Both ESP32 nodes did not confirm RED",
                    "trafficControl": control,
                }
            ),
            503,
        )
    return jsonify(
        {
            "status": "neutral",
            "cameras": [camera_payload(camera_id) for camera_id in sorted(workers)],
            "trafficControl": control,
        }
    )


@app.post("/api/local/reset")
def reset_local_system():
    supervisor_url = os.getenv("LOCAL_SUPERVISOR_URL", "")
    supervisor_token = os.getenv("LOCAL_SUPERVISOR_TOKEN", "")
    reset_pin = os.getenv("LOCAL_RESET_PIN", "")
    if not (supervisor_url and supervisor_token and reset_pin):
        return jsonify({"error": "Start backend/run_local.py to enable system reset"}), 503

    origin = request.headers.get("Origin")
    if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
        return jsonify({"error": "Reset must be requested from this console"}), 403
    body = request.get_json(silent=True)
    pin = body.get("pin") if isinstance(body, dict) else None
    if not isinstance(pin, str) or not secrets.compare_digest(pin.strip().upper(), reset_pin):
        return jsonify({"error": "Invalid reset PIN"}), 403

    if not reset_lock.acquire(blocking=False):
        return jsonify({"error": "A reset is already pending"}), 409
    try:
        reset_request = Request(
            supervisor_url,
            data=b"",
            headers={"X-Reset-Token": supervisor_token},
            method="POST",
        )
        with urlopen(reset_request, timeout=3) as response:
            if response.status != 202:
                return jsonify({"error": "The launcher did not accept the reset"}), 503
    except (URLError, TimeoutError, OSError) as error:
        return jsonify({"error": f"Local launcher unavailable: {error}"}), 503
    finally:
        reset_lock.release()
    return jsonify({"status": "restarting", "runtimeId": runtime_id}), 202


@app.post("/api/local/prepare-reset")
def prepare_local_reset():
    expected_token = os.getenv("LOCAL_SUPERVISOR_TOKEN", "")
    supplied_token = request.headers.get("X-Reset-Token", "")
    if (
        request.remote_addr != "127.0.0.1"
        or not expected_token
        or not secrets.compare_digest(supplied_token, expected_token)
    ):
        return jsonify({"error": "Not authorized"}), 403

    stop_workers()
    with workers_lock:
        active_workers = list(workers.values())
    for worker in active_workers:
        wait_until_stopped = getattr(worker, "wait_until_stopped", None)
        if wait_until_stopped:
            wait_until_stopped()
    return jsonify({"status": "ready"})


@app.get("/api/system/status")
def system_status():
    cameras = [camera_payload(camera_id) for camera_id in sorted(workers)]
    cameras_by_id = {camera["id"]: camera for camera in cameras}
    online_count = sum(bool(camera["online"]) for camera in cameras)
    return jsonify(
        {
            "status": "online" if online_count else "offline",
            "powerSource": "Unknown",
            "batteryPercent": None,
            "charging": None,
            "yoloOnline": model_pool.online,
            "cameraStatus": {"online": online_count, "total": len(cameras)},
            "cameras": cameras,
            "nodeA": node_payload("nodeA", cameras_by_id[NODE_CAMERA_MAP["nodeA"]]),
            "nodeB": node_payload("nodeB", cameras_by_id[NODE_CAMERA_MAP["nodeB"]]),
            "esp32Status": signal_controller.heartbeat_snapshot(),
            "trafficControl": priority_controller.snapshot(),
        }
    )


@app.get("/api/traffic-priority")
def traffic_priority():
    return jsonify(priority_controller.snapshot())


@app.get("/api/cameras")
def cameras():
    return jsonify([camera_payload(camera_id) for camera_id in sorted(workers)])


@app.post("/api/cameras/<int:camera_id>/source")
def select_camera_source(camera_id: int):
    if camera_id not in CAMERA_NODE_MAP:
        return jsonify({"error": "Camera not found"}), 404

    body = request.get_json(silent=True) or {}
    source_index = body.get("sourceIndex")
    allowed_sources = set(CAMERA_DEVICE_NAMES)
    if type(source_index) is not int or source_index not in allowed_sources:
        return jsonify({"error": "Select either Logi C270 HD WebCam or Web Camera"}), 400

    with workers_lock:
        current_worker = workers[camera_id]
        if current_worker.source == source_index:
            return jsonify({"cameras": [camera_payload(item) for item in sorted(workers)]})

        replacement_sources = {camera_id: source_index}
        for other_id, other_worker in workers.items():
            if other_id != camera_id and other_worker.source == source_index:
                replacement_sources[other_id] = current_worker.source

        replacement_workers = {
            item: create_camera_worker(item, source)
            for item, source in replacement_sources.items()
        }
        for item in replacement_workers:
            workers[item].stop()
        for item in replacement_workers:
            wait_until_stopped = getattr(workers[item], "wait_until_stopped", None)
            if wait_until_stopped:
                wait_until_stopped()
        workers.update(replacement_workers)
        camera_sources.update(replacement_sources)
        for worker in replacement_workers.values():
            worker.start()

    return jsonify({"cameras": [camera_payload(item) for item in sorted(workers)]})


@app.get("/api/cameras/<int:camera_id>")
def camera(camera_id: int):
    payload = camera_payload(camera_id)
    return (jsonify(payload), 200) if payload else (jsonify({"error": "Camera not found"}), 404)


@app.get("/api/vehicle-counts")
def vehicle_counts():
    return jsonify([camera_payload(camera_id) for camera_id in sorted(workers)])


@app.get("/api/vehicle-counts/<int:camera_id>")
def vehicle_count(camera_id: int):
    payload = camera_payload(camera_id)
    if not payload:
        return jsonify({"error": "Camera not found"}), 404
    keys = (
        "id",
        "nodeId",
        "laneId",
        "visibleVehicles",
        "vehiclesPassed",
        "classes",
        "incomingVehicles",
        "incomingPoints",
        "totalVehicles",
        "expectedVehicles",
        "vehicleCountState",
    )
    return jsonify({key: payload[key] for key in keys})


@app.get("/api/model")
def model():
    return jsonify(
        {
            "model": "dual",
            "weights": "trained_local.pt + yolov8n.pt",
            "online": model_pool.online,
            "models": model_pool.status(),
        }
    )


@app.get("/video/camera/<int:camera_id>")
def video(camera_id: int):
    worker = camera_worker(camera_id)
    if worker is None:
        return jsonify({"error": "Camera not found"}), 404
    return Response(worker.frames(), mimetype="multipart/x-mixed-replace; boundary=frame")


if __name__ == "__main__":
    print("Local detection console: http://127.0.0.1:5000/local")
    print(f"Allowed frontend origins: {', '.join(settings.frontend_origins)}")
    app.run(host="0.0.0.0", port=5000, threaded=True)
