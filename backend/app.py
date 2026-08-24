import atexit
from flask import Flask, Response, jsonify, redirect, render_template, url_for
from flask_cors import CORS
from camera import CameraWorker
from config import settings

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": settings.frontend_origins}, r"/video/*": {"origins": settings.frontend_origins}})

workers: dict[int, CameraWorker] = {1: CameraWorker(1, settings.camera_1_url, settings, settings.line)}
if not settings.test_single_camera_mode:
    workers[2] = CameraWorker(2, settings.camera_2_url, settings, settings.line)
for worker in workers.values(): worker.start()

def stop_workers():
    for worker in workers.values():
        worker.stop()

atexit.register(stop_workers)

@app.get("/")
def index(): return redirect(url_for("local_monitor"))

@app.get("/local")
def local_monitor():
    return render_template(
        "local_monitor.html",
        single_camera_mode=settings.test_single_camera_mode,
        detection_fps=settings.detection_fps,
        line_counting=settings.line_counting,
    )

def camera_worker(camera_id: int) -> CameraWorker | None:
    if camera_id == 2 and settings.test_single_camera_mode: return workers[1]
    return workers.get(camera_id)

def camera_payload(camera_id: int):
    worker = camera_worker(camera_id)
    if worker is None: return None
    payload = worker.telemetry(); payload["id"] = camera_id
    if camera_id == 2 and settings.test_single_camera_mode: payload.update({"configured": bool(settings.camera_1_url), "testMirror": True, "sourceCamera": 1})
    return payload

@app.get("/api/health")
def health(): return jsonify({"status": "ok"})

@app.get("/api/system/status")
def system_status():
    cameras = [camera_payload(1), camera_payload(2)]; online = any(item and item["online"] for item in cameras)
    return jsonify({"status": "online" if online else "initializing", "powerSource": "Unknown", "batteryPercent": None, "charging": None, "yoloOnline": workers[1].detector.model is not None, "cameras": cameras, "nodeA": {"signal": "UNKNOWN"}, "nodeB": {"signal": "UNKNOWN"}})

@app.get("/api/cameras")
def cameras(): return jsonify([camera_payload(1), camera_payload(2)])

@app.get("/api/cameras/<int:camera_id>")
def camera(camera_id: int):
    payload = camera_payload(camera_id); return (jsonify(payload), 200) if payload else (jsonify({"error": "Camera not found"}), 404)

@app.get("/api/vehicle-counts")
def vehicle_counts(): return jsonify([camera_payload(1), camera_payload(2)])

@app.get("/api/vehicle-counts/<int:camera_id>")
def vehicle_count(camera_id: int):
    payload = camera_payload(camera_id)
    if not payload: return jsonify({"error": "Camera not found"}), 404
    return jsonify({key: payload[key] for key in ("id", "visibleVehicles", "vehiclesPassed", "classes")})

@app.get("/api/model")
def model():
    detector = workers[1].detector
    return jsonify({"model": detector.model_type, "weights": detector.weights, "online": detector.model is not None})

@app.get("/video/camera/<int:camera_id>")
def video(camera_id: int):
    worker = camera_worker(camera_id)
    if worker is None: return jsonify({"error": "Camera not found"}), 404
    return Response(worker.frames(), mimetype="multipart/x-mixed-replace; boundary=frame")

if __name__ == "__main__":
    print("Local detection console: http://127.0.0.1:5000/local")
    print(f"Allowed frontend origins: {', '.join(settings.frontend_origins)}")
    app.run(host="0.0.0.0", port=5000, threaded=True)
