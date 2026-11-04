"""Smoke-test a built Next.js server against fake Flask cameras, never app.py.

Uses the built local rewrite destination, refuses an occupied backend port, and
terminates only its own Next.js child. No real camera, ESP32, or Firebase writes.
"""

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import cv2
from flask import Flask, Response, jsonify, render_template
import numpy as np
from werkzeug.serving import make_server

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from run_local import stop_owned_process


def main() -> None:
    if not (ROOT / ".next" / "BUILD_ID").is_file():
        raise SystemExit("Run npm run build first.")
    manifest = json.loads((ROOT / ".next" / "routes-manifest.json").read_text(encoding="utf-8"))
    rewrites = manifest["rewrites"]
    if isinstance(rewrites, dict):
        rewrites = [item for values in rewrites.values() for item in values]
    rewrite = next(item for item in rewrites if item["source"] == "/detection/:path*")
    destination = urlparse(rewrite["destination"].replace("/:path*", ""))
    if destination.scheme != "http" or destination.hostname not in {"localhost", "127.0.0.1"} or destination.path:
        raise SystemExit("Smoke test requires a loopback HTTP detection rewrite without a path prefix.")
    backend_port = destination.port or 80
    with socket.socket() as probe:
        probe.settimeout(1)
        connection = probe.connect_ex(("127.0.0.1", backend_port))
        if connection in {10013, 13}:
            raise SystemExit("Loopback access denied by sandbox; run this isolated test with local network permission.")
        if connection == 0:
            raise SystemExit(f"Backend port {backend_port} is occupied; stop it yourself before this isolated test.")
    fake = Flask("smartroad-production-smoke", template_folder=str(ROOT / "backend" / "templates"))
    cameras = [{
        "id": index, "configured": True, "online": True, "testMirror": False,
        "fps": 10, "visibleVehicles": 0, "classes": {}, "modelOnline": True,
        "sourceIndex": index - 1, "sourceName": "Recorded test camera",
    } for index in (1, 2)]
    _, jpeg = cv2.imencode(".jpg", np.zeros((100, 120, 3), dtype=np.uint8))
    chunk = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg.tobytes() + b"\r\n"

    @fake.get("/api/system/status")
    def status():
        return jsonify(status="online", cameras=cameras, cameraStatus={"online": 2, "total": 2})

    @fake.get("/api/cameras")
    def camera_status():
        return jsonify(cameras)

    @fake.get("/api/model")
    def model():
        return jsonify(online=True, model="fake", weights="no weights loaded")

    @fake.get("/video/camera/<int:camera_id>")
    def video(camera_id):
        return Response(iter([chunk, chunk]), mimetype="multipart/x-mixed-replace; boundary=frame")

    @fake.get("/local")
    def local():
        return render_template(
            "local_monitor.html", camera_devices=(), camera_sources={1: 0, 2: 1},
            detection_fps=10, line_counting=True, reset_available=False, test_reset_token="fake-only",
        )

    server = make_server("127.0.0.1", backend_port, fake, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        frontend_port = probe.getsockname()[1]
    node = shutil.which("node.exe" if os.name == "nt" else "node")
    if node is None:
        server.shutdown()
        server.server_close()
        raise SystemExit("Node.js executable not found")
    child = None
    try:
        with tempfile.TemporaryFile(mode="w+b") as log:
            env = {**os.environ, "TRAFFIC_INGEST_SECRET": "smoke-expected-no-writes"}
            child = subprocess.Popen(
                [node, str(ROOT / "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", str(frontend_port)],
                cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            base = f"http://127.0.0.1:{frontend_port}"
            for _ in range(100):
                if child.poll() is not None:
                    raise RuntimeError("Production Next.js child exited before becoming ready")
                try:
                    with urlopen(f"{base}/detection/api/system/status", timeout=1) as response:
                        assert json.load(response)["cameraStatus"]["online"] == 2
                    break
                except (URLError, TimeoutError):
                    time.sleep(0.2)
            else:
                raise RuntimeError("Production server did not become ready")
            for path in ("/detection/api/cameras", "/detection/api/model"):
                with urlopen(base + path, timeout=5) as response:
                    assert response.status == 200
            for camera_id in (1, 2):
                with urlopen(f"{base}/detection/video/camera/{camera_id}", timeout=5) as response:
                    assert "multipart/x-mixed-replace" in response.headers["Content-Type"]
                    assert b"Content-Type: image/jpeg" in response.read(100)
            with urlopen(f"http://127.0.0.1:{backend_port}/local", timeout=5) as response:
                assert b"/video/camera/1" in response.read()
            with urlopen(base + "/dashboard/monitoring", timeout=10) as response:
                assert response.status == 200
            request = Request(base + "/api/traffic/transactions", data=b"{}", headers={
                "Content-Type": "application/json", "Authorization": "Bearer intentionally-wrong",
            }, method="POST")
            try:
                urlopen(request, timeout=5)
                raise AssertionError("Unauthorized ingestion unexpectedly succeeded")
            except HTTPError as error:
                assert error.code == 401
            print("PASS: production telemetry, two MJPEG proxy feeds, local template, monitoring route, ingestion auth")
    finally:
        try:
            stop_owned_process(child)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
    print("PASS: owned production child and fake Flask server shut down")


if __name__ == "__main__":
    main()
