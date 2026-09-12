import atexit

from flask import Flask, Response, jsonify, redirect, render_template, url_for
from flask_cors import CORS

from camera import CameraWorker
from config import settings
from detector import ModelPool

app = Flask(__name__)
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

# Camera Source = USB Cameras
camera_sources: dict[int, int | str] = {
    1: settings.dv20_camera_index,  # Node A / Lane A -> DV20 USB CAMERA
    2: settings.web_camera_index,  # Node B / Lane B -> Web Camera
}

# RTSP - FOR FUTURE USE
# Keep these source assignments disabled until the deployment switches from USB.
# camera_sources = {
#     1: settings.camera_1_url,
#     2: settings.camera_2_url,
# }

model_pool = ModelPool(settings)
workers: dict[int, CameraWorker] = {
    camera_id: CameraWorker(camera_id, source, settings, settings.line, model_pool=model_pool)
    for camera_id, source in camera_sources.items()
}
for worker in workers.values():
    worker.start()


def stop_workers():
    for worker in workers.values():
        worker.stop()


atexit.register(stop_workers)


@app.get("/")
def index():
    return redirect(url_for("local_monitor"))


@app.get("/local")
def local_monitor():
    return render_template(
        "local_monitor.html",
        detection_fps=settings.detection_fps,
        line_counting=settings.line_counting,
    )


def camera_worker(camera_id: int) -> CameraWorker | None:
    return workers.get(camera_id)


def camera_payload(camera_id: int):
    worker = camera_worker(camera_id)
    if worker is None:
        return None
    payload = worker.telemetry()
    payload.update({"id": camera_id, **CAMERA_NODE_MAP[camera_id]})
    return payload


def node_payload(node_name: str, camera: dict | None = None) -> dict:
    camera_id = NODE_CAMERA_MAP[node_name]
    camera = camera or camera_payload(camera_id)
    return {
        "signal": "UNKNOWN",
        "cameraId": camera_id,
        "nodeId": camera["nodeId"],
        "laneId": camera["laneId"],
        "online": camera["online"],
        "visibleVehicles": camera["visibleVehicles"],
        "vehiclesPassed": camera["vehiclesPassed"],
        "classes": camera["classes"],
    }


@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


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
        }
    )


@app.get("/api/cameras")
def cameras():
    return jsonify([camera_payload(camera_id) for camera_id in sorted(workers)])


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
    keys = ("id", "nodeId", "laneId", "visibleVehicles", "vehiclesPassed", "classes")
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
