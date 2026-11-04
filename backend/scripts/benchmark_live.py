"""Live USB benchmark with process-local hardware/upload isolation; never records footage."""

import argparse
from collections import deque
from dataclasses import replace
import json
import multiprocessing
import os
from pathlib import Path
import platform
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))


def observation_settings(settings, indices, always_encode=False):
    return replace(
        settings,
        web_camera_index=indices[0],
        logi_c270_camera_index=indices[1] if len(indices) > 1 else -1,
        camera_1_source="usb",
        camera_2_source="usb",
        node_b_display_mirror=False,
        esp32_control_enabled=False,
        esp32_heartbeat_enabled=False,
        traffic_firestore_enabled=False,
        performance_profiling=True,
        viewer_aware_jpeg=not always_encode,
    )


def probe_cameras(indices):
    import cv2

    results = []
    for index in indices:
        capture = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        try:
            opened = capture.isOpened()
            ok, frame = capture.read() if opened else (False, None)
            results.append({
                "usbIndex": index, "available": bool(ok and frame is not None),
                "width": int(frame.shape[1]) if ok and frame is not None else None,
                "height": int(frame.shape[0]) if ok and frame is not None else None,
                "reportedCameraFps": capture.get(cv2.CAP_PROP_FPS) if opened else None,
            })
        finally:
            capture.release()
    return results


def install_isolation(diagnostics=False):
    import camera
    import detector
    import traffic_control
    import traffic_transactions

    class ObservationSignals(traffic_control.Esp32SignalController):
        def _call(self, *args, **kwargs):
            raise RuntimeError("Physical ESP32 I/O is blocked by the live benchmark")

    class ObservationWriter(traffic_transactions.FirestoreTransactionWriter):
        def write(self, payload):
            raise RuntimeError("Firebase uploads are blocked by the live benchmark")

    class CpuModelPool(detector.ModelPool):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            for model in self.models.values():
                if model is not None:
                    device = "intel:cpu" if self.backend == "openvino" else "cpu"
                    model.overrides.update(device=device, save=False, save_txt=False, save_crop=False, show=False)

    class ObservedWorker(camera.CameraWorker):
        def __init__(self, *args, **kwargs):
            self.benchmark_frame_lock = threading.Lock()
            self.benchmark_frames = deque(maxlen=256)
            self.benchmark_dropped_frames = 0
            self.benchmark_latest = {}
            self.benchmark_completed = 0
            self.benchmark_torch_threads = None
            super().__init__(*args, **kwargs)

        @property
        def _performance(self):
            return self.benchmark_latest

        @_performance.setter
        def _performance(self, value):
            self.benchmark_latest = value
            # Observe the existing completed timing publication; do not alter processing.
            if diagnostics and "processingMs" in value:
                with self.benchmark_frame_lock:
                    if len(self.benchmark_frames) == self.benchmark_frames.maxlen:
                        self.benchmark_dropped_frames += 1
                    self.benchmark_frames.append({"completedMonotonic": time.perf_counter(), **value})

        def benchmark_drain_frames(self):
            with self.benchmark_frame_lock:
                values = list(self.benchmark_frames)
                self.benchmark_frames.clear()
                return values
        def _encode_frame(self, frame):
            published = super()._encode_frame(frame)
            if self.benchmark_torch_threads is None:
                import torch

                self.benchmark_torch_threads = torch.get_num_threads()
            self.benchmark_completed += 1
            return published

    traffic_control.Esp32SignalController = ObservationSignals
    traffic_transactions.FirestoreTransactionWriter = ObservationWriter
    detector.ModelPool = CpuModelPool
    camera.CameraWorker = ObservedWorker


def camera_sample(worker):
    with worker._raw_condition:
        resolution = list(worker._raw_frame.shape[1::-1]) if worker._raw_frame is not None else None
        captured = worker._raw_version
    with worker._jpeg_condition:
        viewers = worker._viewer_count
    return {
        "online": worker.online, "error": worker.error, "resolution": resolution,
        "captureFrames": captured, "completedFrames": worker.benchmark_completed,
        "captureFpsSmoothed": worker.capture_fps, "detectionFpsSmoothed": worker.fps,
        "viewers": viewers, "lastFrameTimings": dict(worker._performance),
        "visibleVehicles": worker.visible,
        "processingThreadAlive": bool(worker._processing_thread and worker._processing_thread.is_alive()),
        "inferenceThreadTorchThreads": worker.benchmark_torch_threads,
        "passed": worker.detector.track_state.passed,
    }


def summarize(values):
    values = sorted(value for value in values if isinstance(value, (float, int)) and not isinstance(value, bool))
    if not values:
        return None
    return {"mean": round(sum(values) / len(values), 3), "min": round(values[0], 3),
            "max": round(values[-1], 3), "p95": round(values[min(len(values) - 1, int(len(values) * .95))], 3),
            "p99": round(values[min(len(values) - 1, int(len(values) * .99))], 3), "count": len(values)}


class ProcessLoadMonitor:
    """CPU-times scans for the helper; names/PIDs only, no command lines or network I/O."""

    def __init__(self):
        self.previous = {}
        self.sample()

    def sample(self):
        import psutil

        now = time.perf_counter()
        cpu_started = time.process_time()
        previous_time = getattr(self, "sampled_at", now)
        current, loads = {}, []
        inaccessible = 0
        for process in psutil.process_iter(["pid", "name", "cpu_times", "create_time"], ad_value=None):
            try:
                info = process.info
                cpu = info["cpu_times"]
                if cpu is None:
                    inaccessible += 1
                    continue
                identity = (info["pid"], info["create_time"])
                total = cpu.user + cpu.system
                current[identity] = total
                if identity in self.previous and now > previous_time and info["pid"] != 0:
                    percent = max(0, total - self.previous[identity]) / (now - previous_time) * 100
                    loads.append({"pid": info["pid"], "name": info["name"],
                                  "cpuPercentHostNormalized": round(percent / (psutil.cpu_count() or 1), 3)})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                inaccessible += 1
        self.previous, self.sampled_at = current, now
        return {"topProcesses": sorted(loads, key=lambda value: value["cpuPercentHostNormalized"], reverse=True)[:8],
                "inaccessibleProcesses": inaccessible, "scanMs": round((time.perf_counter() - now) * 1000, 3),
                "scanCpuMs": round((time.process_time() - cpu_started) * 1000, 3),
                "sampledMonotonic": now, "windowSeconds": round(now - previous_time, 3), "monitorPid": os.getpid()}


def process_monitor_child(output, stop):
    monitor = ProcessLoadMonitor()
    while not stop.wait(5):
        result = monitor.sample()
        try:
            output.put_nowait(result)
        except queue.Full:
            pass


class BackgroundProcessMonitor:
    """Slow process enumeration runs in an owned helper, outside the inference GIL."""

    def __init__(self):
        context = multiprocessing.get_context("spawn")
        self.output = context.Queue(maxsize=1)
        self.stop = context.Event()
        self.process = context.Process(target=process_monitor_child, args=(self.output, self.stop), daemon=True)
        self.process.start()
        self.latest = {"topProcesses": [], "status": "waiting for first 5-second process CPU interval"}

    def sample(self):
        try:
            self.latest = self.output.get_nowait()
        except queue.Empty:
            pass
        return {**self.latest, "ageSeconds": round(time.perf_counter() - self.latest["sampledMonotonic"], 3)
                if "sampledMonotonic" in self.latest else None}

    def close(self):
        self.stop.set()
        self.process.join(timeout=3)
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=3)
        self.output.close()


def measure(runtime, seconds, scenario, frontend, diagnostics=False):
    import psutil

    process = psutil.Process()
    process.cpu_percent()
    psutil.cpu_percent()
    initial = {key: camera_sample(worker) for key, worker in runtime.workers.items()}
    rows = []
    monitor = BackgroundProcessMonitor() if diagnostics else None
    if diagnostics:
        for worker in runtime.workers.values():
            worker.benchmark_drain_frames()
            worker.benchmark_dropped_frames = 0
    started = time.perf_counter()
    next_progress = 60
    while time.perf_counter() - started < seconds:
        time.sleep(min(1.0, max(0.0, seconds - (time.perf_counter() - started))))
        rows.append({
            "timestampUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "elapsedSeconds": time.perf_counter() - started,
            "pythonCpuPercentOneCore100": process.cpu_percent(),
            "systemCpuPercent": psutil.cpu_percent(),
            "pythonRssMb": process.memory_info().rss / 1048576,
            "systemMemoryPercent": psutil.virtual_memory().percent,
            "systemAvailableMiB": psutil.virtual_memory().available / 1048576,
            "nodeRssMb": psutil.Process(frontend.pid).memory_info().rss / 1048576 if frontend else None,
            "cameras": {key: camera_sample(worker) for key, worker in runtime.workers.items()},
        })
        if diagnostics:
            rows[-1]["processLoad"] = monitor.sample()
            rows[-1]["completedFrames"] = {
                key: [{"elapsedSeconds": frame.pop("completedMonotonic") - started, **frame}
                      for frame in worker.benchmark_drain_frames()]
                for key, worker in runtime.workers.items()
            }
        if rows[-1]["elapsedSeconds"] >= next_progress:
            print(f"Progress {rows[-1]['elapsedSeconds']:.0f}s: system CPU {rows[-1]['systemCpuPercent']:.1f}%, "
                  f"Python RSS {rows[-1]['pythonRssMb']:.1f} MiB", flush=True)
            next_progress += 60
    elapsed = time.perf_counter() - started
    if monitor:
        monitor.close()
    expected_viewers = {"none": 0, "local": 1, "online": 1, "both": 2}[scenario]
    summaries = {}
    for key, worker in runtime.workers.items():
        last = camera_sample(worker)
        samples = [row["cameras"][key] for row in rows]
        timings = {name for sample in samples for name in sample["lastFrameTimings"]}
        completed = last["completedFrames"] - initial[key]["completedFrames"]
        summaries[key] = {
            "usbIndex": worker.source, "onlineAtEnd": last["online"], "resolution": last["resolution"],
            "completedFrames": completed,
            "effectiveDetectionFps": round(completed / elapsed, 3) if completed else None,
            "effectiveCaptureFps": round((last["captureFrames"] - initial[key]["captureFrames"]) / elapsed, 3),
            "viewerCounts": sorted({sample["viewers"] for sample in samples}),
            "visibleVehicleCounts": sorted({sample["visibleVehicles"] for sample in samples}),
            "inferenceThreadTorchThreads": last["inferenceThreadTorchThreads"],
            "runtimeStable": all(sample["online"] and sample["processingThreadAlive"] for sample in samples),
            "viewerConditionMatched": all(sample["viewers"] == expected_viewers for sample in samples),
            "timingsLatestFrameSampledAt1Hz": {name: summarize([sample["lastFrameTimings"].get(name) for sample in samples]) for name in sorted(timings)},
            "passedAtStart": initial[key]["passed"], "passedAtEnd": last["passed"],
            "error": last["error"],
        }
        if diagnostics:
            frames = [frame for row in rows for frame in row["completedFrames"][key] if frame["elapsedSeconds"] >= 0]
            names = {name for frame in frames for name in frame if name != "elapsedSeconds"}
            summaries[key]["perFrameTimings"] = {name: summarize([frame.get(name) for frame in frames]) for name in sorted(names)}
            summaries[key]["perFrameSamples"] = len(frames)
            summaries[key]["droppedTimingRecords"] = worker.benchmark_dropped_frames
    return {
        "scenario": scenario, "seconds": round(elapsed, 3),
        "validViewerCondition": any(value["completedFrames"] for value in summaries.values())
        and all(value["viewerConditionMatched"] for value in summaries.values() if value["completedFrames"]),
        "pythonCpuPercentOneCore100": summarize([row["pythonCpuPercentOneCore100"] for row in rows]),
        "pythonCpuPercentHostNormalized": summarize([row["pythonCpuPercentOneCore100"] / (psutil.cpu_count() or 1) for row in rows]),
        "systemCpuPercent": summarize([row["systemCpuPercent"] for row in rows]),
        "pythonRssMb": summarize([row["pythonRssMb"] for row in rows]),
        "pythonRssChangeMb": round(rows[-1]["pythonRssMb"] - rows[0]["pythonRssMb"], 3),
        "systemAvailableMiB": summarize([row["systemAvailableMiB"] for row in rows]),
        "nodeRssMb": summarize([row["nodeRssMb"] for row in rows]),
        "cameras": summaries, "samples": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera-index", type=int, action="append", help="One or two distinct USB indices; default: configured indices")
    parser.add_argument("--scenario", choices=("none", "local", "online", "both", "all"), default="all")
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--warmup", type=int, default=15)
    parser.add_argument("--always-encode", action="store_true", help="Encoder-only comparison; not a full original-implementation baseline")
    parser.add_argument("--cpu-threads", type=int, default=0, help="0 keeps library defaults; applied after lazy setup")
    parser.add_argument("--backend", choices=("pytorch", "openvino"), default="pytorch")
    parser.add_argument("--ov-threads", type=int, default=0)
    parser.add_argument("--ov-streams", type=int, default=0)
    parser.add_argument("--no-prompt", action="store_true", help="For unattended no-viewer measurement or preflight")
    parser.add_argument("--diagnostics", action="store_true", help="Per-frame timings, 1 Hz resources, separate 5-second process CPU scans; no footage")
    parser.add_argument("--output", type=Path, default=ROOT / "backend/runs/live/report.json")
    args = parser.parse_args()
    if min(args.cpu_threads, args.ov_threads, args.ov_streams) < 0:
        parser.error("Thread/stream budgets must be nonnegative")
    if not 1 <= args.seconds <= 3600 or not 0 <= args.warmup <= 120:
        parser.error("seconds must be 1..3600 and warmup 0..120")
    import config
    import psutil

    indices = args.camera_index or [config.settings.web_camera_index, config.settings.logi_c270_camera_index]
    if not 1 <= len(indices) <= 2 or len(set(indices)) != len(indices) or min(indices) < 0:
        parser.error("Provide one or two distinct nonnegative USB indices; never mirror a physical input")
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "mode": "live USB observation only; no recording; no signal commands; no uploads",
        "host": {"name": platform.node(), "cpu": platform.processor(), "logicalCpus": psutil.cpu_count(),
                 "os": platform.platform(), "python": platform.python_version(),
                 "physicalCpus": psutil.cpu_count(logical=False), "ramGiB": round(psutil.virtual_memory().total / 1024**3, 2)},
        "settings": {"confidence": config.settings.confidence, "imageSize": config.settings.image_size,
                     "targetDetectionFps": config.settings.detection_fps, "viewerAwareJpeg": not args.always_encode,
                     "backend": args.backend, "cpuThreadsRequested": args.cpu_threads,
                     "openvinoThreadsRequested": args.ov_threads, "openvinoStreamsRequested": args.ov_streams},
        "probe": probe_cameras(indices), "measurements": [],
        "limitations": ["Live scenes differ between phases; not an accuracy/parity test",
                        "perFrameTimings requires --diagnostics; timingsLatestFrameSampledAt1Hz always samples at 1 Hz",
                        "Frame age excludes sensor/driver buffering and browser display latency", "ByteTrack time is included in model.track; lineTrackingMs is custom line/trajectory processing",
                        "Browser process memory is not attributed; system CPU includes unrelated applications"],
    }
    if not any(camera["available"] for camera in report["probe"]):
        report["status"] = "unavailable: no configured USB camera delivered a frame"
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2), flush=True)
        return 2
    scenarios = ["none", "local", "online", "both"] if args.scenario == "all" else [args.scenario]
    from run_local import port_is_available, stop_owned_process

    if not port_is_available(5000) or (any(s in {"online", "both"} for s in scenarios) and not port_is_available(3000)):
        raise SystemExit("Required port 5000/3000 is occupied. Stop existing services yourself; this tool never kills them.")
    # Override only this process after dotenv loading; active .env files are not edited.
    effective = [index if probe["available"] else -1 for index, probe in zip(indices, report["probe"])]
    config.settings = replace(
        observation_settings(config.settings, effective, args.always_encode),
        inference_backend=args.backend, cpu_inference_threads=args.cpu_threads,
        openvino_threads=args.ov_threads, openvino_streams=args.ov_streams,
    )
    os.environ.setdefault("YOLO_CONFIG_DIR", str(args.output.parent))
    install_isolation(diagnostics=args.diagnostics)
    import app as runtime
    from flask import jsonify, request
    from werkzeug.serving import make_server
    from werkzeug.serving import WSGIRequestHandler

    @runtime.app.before_request
    def read_only():
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            return jsonify(error="Observation-only benchmark: writes/reset/source changes are disabled"), 405

    @runtime.app.get("/benchmark/proxy-viewer")
    def proxy_viewer():
        return (
            "<!doctype html><title>SmartRoad proxy transport benchmark</title>"
            "<h1>Production MJPEG proxy viewer</h1>"
            "<p>Transport-only test, not the authenticated React dashboard. No recording.</p>"
            '<img src="http://127.0.0.1:3000/detection/video/camera/1" '
            'alt="Live camera 1 through production Next.js" width="640" height="480">'
        )

    class QuietHandler(WSGIRequestHandler):
        def log_request(self, *args, **kwargs):
            pass

    server = None
    frontend = None
    try:
        if not runtime.model_pool.online:
            raise RuntimeError(f"Inference models unavailable: {runtime.model_pool.status()}")
        server = make_server("127.0.0.1", 5000, runtime.app, threaded=True, request_handler=QuietHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        if any(s in {"online", "both"} for s in scenarios):
            if not (ROOT / ".next/BUILD_ID").is_file():
                raise SystemExit("Run npm run build first for production Next.js viewing")
            manifest = json.loads((ROOT / ".next/routes-manifest.json").read_text())
            if "http://127.0.0.1:5000/:path*" not in json.dumps(manifest.get("rewrites")):
                raise SystemExit("Build Next.js with DETECTION_BACKEND_URL=http://127.0.0.1:5000")
            node = shutil.which("node.exe" if os.name == "nt" else "node")
            if node is None:
                raise SystemExit("Node.js executable not found")
            frontend = subprocess.Popen(
                [node, str(ROOT / "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3000"],
                cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        import torch
        report["startupMainThreadTorchThreads"] = torch.get_num_threads()
        for scenario in scenarios:
            print(f"Scenario {scenario}: close previous viewer tabs. Local: http://127.0.0.1:5000/local ; online: http://127.0.0.1:3000/dashboard/monitoring", flush=True)
            if not args.no_prompt:
                input("Open only the requested dashboard(s), then press Enter. For none, keep all dashboards closed: ")
            print(f"Warming up {args.warmup}s, then sampling {args.seconds}s at 1 Hz", flush=True)
            time.sleep(args.warmup)
            for worker in runtime.workers.values():
                if worker.online and not worker._processing_thread.is_alive():
                    raise RuntimeError("Inference worker stopped during warmup; benchmark is invalid")
            if frontend and frontend.poll() is not None:
                raise RuntimeError("Production Next.js exited; viewer comparison cannot proceed")
            report["measurements"].append(measure(runtime, args.seconds, scenario, frontend, args.diagnostics))
            if args.backend == "openvino":
                report["openvinoCompiledProperties"] = {
                    name: {key: str(compiled.get_property(key)) for key in (
                        "INFERENCE_PRECISION_HINT", "INFERENCE_NUM_THREADS", "NUM_STREAMS", "EXECUTION_DEVICES",
                    )} for name, compiled in runtime.model_pool.compiled_models.items()
                }
            report["status"] = "measured; inspect viewer-condition validity and camera availability"
            args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"Saved {scenario} statistics to {args.output}", flush=True)
    except Exception as error:
        report["status"] = "failed; not a valid performance result"
        report["error"] = str(error)
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
        raise
    finally:
        runtime.stop_workers()
        for worker in runtime.workers.values():
            worker.wait_until_stopped(timeout=5)
        try:
            stop_owned_process(frontend)
        finally:
            if server:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
