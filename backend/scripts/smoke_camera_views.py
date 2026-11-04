"""Real configured RTSP/view smoke check. Blocks signal/upload I/O; saves no footage."""

import argparse
from dataclasses import replace
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))


def check_frame(url):
    import cv2
    import numpy as np

    with urlopen(url, timeout=10) as response:
        data = b""
        while b"\xff\xd9" not in data:
            block = response.read(8192)
            if not block or len(data) > 8 * 1024 * 1024:
                raise RuntimeError("MJPEG did not deliver a bounded JPEG frame")
            data += block
        start, end = data.index(b"\xff\xd8"), data.index(b"\xff\xd9") + 2
        image = cv2.imdecode(np.frombuffer(data[start:end], dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError("Invalid JPEG")
        return {"status": response.status, "resolution": list(image.shape[1::-1]), "decoded": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--production", action="store_true")
    parser.add_argument("--hold-seconds", type=int, default=0, choices=range(0, 601), metavar="0..600")
    args = parser.parse_args()
    import config
    from run_local import port_is_available, stop_owned_process
    from scripts.benchmark_live import install_isolation

    if config.settings.camera_1_source != "rtsp" or not config.settings.camera_1_url:
        raise SystemExit("Configure Camera A RTSP before this camera-only smoke check")
    if not port_is_available(5000) or (args.production and not port_is_available(3000)):
        raise SystemExit("Ports occupied; this tool never stops unrelated services")
    config.settings = replace(config.settings, node_b_display_mirror=True, camera_2_source="disabled",
                              esp32_control_enabled=False, esp32_heartbeat_enabled=False, traffic_firestore_enabled=False)
    output = ROOT / "backend/runs/phase5"
    output.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("YOLO_CONFIG_DIR", str(output))
    install_isolation()
    import app as runtime
    from flask import jsonify, request
    from werkzeug.serving import make_server, WSGIRequestHandler

    @runtime.app.before_request
    def read_only():
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            return jsonify(error="Observation-only smoke check"), 405

    class QuietHandler(WSGIRequestHandler):
        def log_request(self, *args, **kwargs):
            pass

    server, frontend = None, None
    report = {"mode": "RTSP observation-only; no recording; physical I/O and uploads blocked", "checks": {}}
    try:
        server = make_server("127.0.0.1", 5000, runtime.app, threaded=True, request_handler=QuietHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        if args.production:
            manifest = json.loads((ROOT / ".next/routes-manifest.json").read_text())
            if "http://127.0.0.1:5000/:path*" not in json.dumps(manifest.get("rewrites")):
                raise RuntimeError("Build production Next.js with DETECTION_BACKEND_URL=http://127.0.0.1:5000")
            frontend = subprocess.Popen([
                shutil.which("node"), str(ROOT / "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3000",
            ], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        deadline = time.monotonic() + 25
        while not runtime.workers[1].online and time.monotonic() < deadline:
            time.sleep(.2)
        if not runtime.workers[1].online:
            raise RuntimeError("Configured RTSP did not deliver a frame")
        if frontend:
            time.sleep(3)
            if frontend.poll() is not None:
                raise RuntimeError("Production Next.js exited")
        for port in ([5000, 3000] if frontend else [5000]):
            prefix = "/detection" if port == 3000 else ""
            for path in ("/video/raw/camera/1", "/video/raw/camera/2", "/video/camera/1", "/video/camera/2"):
                report["checks"][f"{port}{path}"] = check_frame(f"http://127.0.0.1:{port}{prefix}{path}")
        with urlopen("http://127.0.0.1:5000/api/system/status", timeout=5) as response:
            snapshot = json.load(response)
        assert not snapshot["trafficControl"]["enabled"]
        assert snapshot["cameraStatus"] == {"online": 1, "total": 2}
        assert snapshot["cameras"][1]["testMirror"] and not snapshot["nodeB"]["online"]
        assert not snapshot["cameras"][1]["incomingVehicles"]
        assert runtime.workers[2]._capture_thread is None and runtime.workers[2]._processing_thread is None
        report.update(passed=True, independentCaptureWorkers=1, independentDetectionWorkers=1,
                      mirrorCreatesNodeBEvents=False, nodeBOnline=False, signalControlEnabled=False)
        (output / "views-smoke.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2), flush=True)
        print(f"Observation-only views available for {args.hold_seconds}s on ports 5000/3000", flush=True)
        time.sleep(args.hold_seconds)
    finally:
        runtime.stop_workers()
        for worker in runtime.workers.values():
            worker.wait_until_stopped()
        stop_owned_process(frontend)
        if server:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
