"""File-only OpenVINO thread/stream matrix using the production Detector pipeline.

Each configuration and scenario runs in a clean subprocess. No camera, Flask,
controller, upload, or live application modules are imported.
"""

import argparse
from dataclasses import replace
import hashlib
from importlib.metadata import PackageNotFoundError, version
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def stats(values):
    values = sorted(float(value) for value in values if value is not None)
    if not values:
        return None
    return {
        "count": len(values), "mean": round(sum(values) / len(values), 4),
        "p50": round(values[max(0, math.ceil(len(values) * 0.50) - 1)], 4),
        "p95": round(values[max(0, math.ceil(len(values) * 0.95) - 1)], 4),
    }


def parse_integer_list(value, label):
    try:
        items = [int(item.strip()) for item in value.split(",")]
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"{label} must be comma-separated integers") from error
    if not items or any(item < 0 for item in items):
        raise argparse.ArgumentTypeError(f"{label} must contain nonnegative integers")
    return list(dict.fromkeys(items))


def validate_source(path):
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise ValueError("--source must be an existing local image or video file")
    if "://" in str(path):
        raise ValueError("URLs are not supported; use an existing local file")
    return path


def digest_path(path):
    digest = hashlib.sha256()
    if path.is_file():
        files = [path]
    elif path.is_dir():
        files = sorted(item for item in path.rglob("*") if item.is_file())
    else:
        return None
    for file_path in files:
        digest.update(str(file_path.relative_to(path) if path.is_dir() else file_path.name).encode())
        with file_path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def package_version(name):
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def run_bounded(command, *, cwd, timeout):
    """Bound a benchmark child and its Windows venv-launcher descendants."""
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", errors="replace")
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        import psutil

        # Only descendants of the process created above belong to this run.
        # Killing only the venv launcher can leave its native Python child alive.
        try:
            children = psutil.Process(process.pid).children(recursive=True)
        except psutil.NoSuchProcess:
            children = []
        for child in reversed(children):
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass
        process.kill()
        stdout, stderr = process.communicate(timeout=10)
        raise subprocess.TimeoutExpired(command, timeout, output=stdout, stderr=stderr) from error
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def read_source(path, capture_state):
    import cv2

    image_extensions = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
    if path.suffix.lower() in image_extensions:
        frame = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if frame is None:
            raise RuntimeError(f"Could not decode local image: {path}")
        return frame
    capture = capture_state.get("capture")
    if capture is None:
        capture = cv2.VideoCapture(str(path), cv2.CAP_FFMPEG)
        capture_state["capture"] = capture
        if not capture.isOpened():
            capture.release()
            raise RuntimeError(f"Could not open local video: {path}")
    ok, frame = capture.read()
    if not ok or frame is None:
        capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
        ok, frame = capture.read()
    if not ok or frame is None:
        raise RuntimeError(f"Video could not deliver a frame: {path}")
    return frame


def setup(mode, config):
    from detector import Detector, ModelPool
    from vehicle_identity import GlobalVehicleRegistry

    dual_camera = mode == "dual-camera"
    need_local = mode in {"local", "dual", "dual-camera"}
    need_coco = mode in {"coco", "dual", "dual-camera"}
    pool = ModelPool(config, load_local=need_local, load_coco=need_coco)
    missing = [name for name, needed in (("local", need_local), ("coco", need_coco))
               if needed and pool.models[name] is None]
    if missing:
        raise RuntimeError(f"Required model(s) unavailable: {pool.status()}")
    for model in pool.models.values():
        if model is not None:
            model.overrides.update(device="intel:cpu", save=False, save_txt=False, save_crop=False, show=False)

    registry = GlobalVehicleRegistry(
        local_grace_seconds=config.global_id_local_grace_seconds,
        cross_camera_seconds=config.global_id_cross_camera_seconds,
        match_threshold=config.global_id_match_threshold,
        ambiguity_margin=config.global_id_ambiguity_margin,
        minimum_sample_confidence=config.global_id_minimum_sample_confidence,
        maximum_samples=config.global_id_maximum_samples,
    )
    detectors = []
    for camera_index in range(2 if dual_camera else 1):
        detector = Detector(config, config.line, use_coco_fallback=need_coco,
                            use_custom_model=need_local, model_pool=pool, vehicle_registry=registry)
        detector.camera_id = camera_index + 1
        detectors.append(detector)
    return pool, detectors


def worker(args):
    import cv2
    import psutil
    from config import settings

    # Config import intentionally precedes replace: config.py loads .env with
    # override=True and must remain the source for all non-matrix settings.
    config = replace(settings, inference_backend="openvino", cpu_inference_threads=args.cpu_thread_count,
                     openvino_threads=args.thread_count, openvino_streams=args.stream_count,
                     openvino_request_mode=args.request_mode, openvino_performance_hint=args.performance_hint,
                     performance_profiling=True)
    path = validate_source(args.source)
    source_state = {}
    pool = None
    capture = None
    executor = None
    process = psutil.Process()
    try:
        pool, detectors = setup(args.scenario, config)
        dual_camera = len(detectors) == 2
        barrier = threading.Barrier(len(detectors), timeout=60) if dual_camera else None
        if dual_camera:
            from concurrent.futures import ThreadPoolExecutor
            executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="matrix-camera")

        inference_thread_budgets = {}

        def process_frame(detector, frame):
            if barrier is not None:
                barrier.wait()
            started = time.perf_counter()
            detector.process(frame)
            completed = time.perf_counter()
            # Inspect the actual inference thread, not only the coordinator.
            # Capture once during warmup where possible, outside the wall timer.
            camera_key = f"camera{detector.camera_id}"
            if camera_key not in inference_thread_budgets:
                inference_thread_budgets[camera_key] = __import__("torch").get_num_threads()
            return (completed - started) * 1000, detector.profiler.snapshot()

        for _ in range(args.warmup):
            frame = read_source(path, source_state)
            if dual_camera:
                futures = [executor.submit(process_frame, detector, frame.copy()) for detector in detectors]
                for future in futures:
                    future.result(timeout=120)
            else:
                process_frame(detectors[0], frame)

        rows = {f"camera{index + 1}": [] for index in range(len(detectors))}
        combined_durations = []
        process_cpu_seconds = 0.0
        system_cpu_busy = system_cpu_elapsed = 0.0
        sample_wall = 0.0
        for _ in range(args.frames):
            frame = read_source(path, source_state)
            work_started = time.perf_counter()
            cpu_before = process.cpu_times()
            system_before = psutil.cpu_times()
            if dual_camera:
                futures = [executor.submit(process_frame, detector, frame.copy()) for detector in detectors]
                completions = [future.result(timeout=120) for future in futures]
                duration = (time.perf_counter() - work_started) * 1000
            else:
                completions = [process_frame(detectors[0], frame)]
                duration = completions[0][0]
            sample_wall += duration / 1000
            combined_durations.append(duration)
            cpu_after = process.cpu_times()
            system_after = psutil.cpu_times()
            process_cpu_seconds += cpu_after.user + cpu_after.system - cpu_before.user - cpu_before.system
            system_elapsed = sum(system_after) - sum(system_before)
            system_idle = system_after.idle - system_before.idle
            system_cpu_elapsed += system_elapsed
            system_cpu_busy += system_elapsed - system_idle
            for index, (wall_ms, timings) in enumerate(completions):
                row = {"processingWallMs": wall_ms, **timings}
                row["lockWaitMs"] = sum(value for name, value in timings.items() if name.endswith("LockWaitMs"))
                row["rssMiB"] = process.memory_info().rss / 1048576
                row["systemRamUsedMiB"] = psutil.virtual_memory().used / 1048576
                row["systemRamAvailableMiB"] = psutil.virtual_memory().available / 1048576
                rows[f"camera{index + 1}"].append(row)
        logical_cpus = psutil.cpu_count() or 1
        system_cpu_percent = max(0, min(100, system_cpu_busy / max(system_cpu_elapsed, 1e-9) * 100))
        if executor is not None:
            executor.shutdown(wait=True)
            executor = None

        compiled_properties = {}
        for name, compiled in pool.compiled_models.items():
            properties = {}
            for key in ("INFERENCE_PRECISION_HINT", "INFERENCE_NUM_THREADS", "NUM_STREAMS", "EXECUTION_DEVICES",
                        "PERFORMANCE_HINT", "PERFORMANCE_HINT_NUM_REQUESTS"):
                try:
                    properties[key] = str(compiled.get_property(key))
                except Exception as error:
                    properties[key] = {"unavailable": str(error)}
            compiled_properties[name] = properties

        models = {}
        for name, required in (("local", args.scenario in {"local", "dual", "dual-camera"}),
                               ("coco", args.scenario in {"coco", "dual", "dual-camera"})):
            if required:
                model_path = pool.runtime_path(name)
                models[name] = {"path": str(model_path), "sha256": digest_path(model_path)}
        metrics = {}
        for camera, camera_rows in rows.items():
            keys = sorted({key for row in camera_rows for key in row})
            metrics[camera] = {
                "completedFrames": len(camera_rows),
                "torchIntraOpThreadsInInferenceThread": inference_thread_budgets[camera],
                "completionThroughputFps": len(camera_rows) / sample_wall,
                "processingWallMs": stats([row["processingWallMs"] for row in camera_rows]),
                "stagesMs": {key: stats([row.get(key) for row in camera_rows]) for key in keys
                             if key.endswith("Ms") and key != "processingWallMs"},
                "resources": {key: stats([row[key] for row in camera_rows]) for key in
                              ("rssMiB", "systemRamUsedMiB", "systemRamAvailableMiB")},
            }
        return {
            "status": "completed", "scenario": args.scenario,
            "settings": {"backend": "openvino", "threadsRequested": args.thread_count,
                         "cpuInferenceThreadsRequested": args.cpu_thread_count,
                         "streamsRequested": args.stream_count, "resolvedThreads": config.openvino_threads,
                         "resolvedStreams": config.openvino_streams, "requestModeRequested": args.request_mode,
                         "requestModeResolved": config.openvino_request_mode,
                         "performanceHintRequested": args.performance_hint,
                         "performanceHintResolved": config.openvino_performance_hint,
                         "imageSize": config.image_size,
                         "confidence": config.confidence},
            "models": models,
            "source": {"path": str(path), "sha256": digest_path(path), "bytes": path.stat().st_size,
                       "kind": "image" if path.suffix.lower() in {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"} else "video"},
            "versions": {"python": platform.python_version(), **{
                name: package_version(package) for name, package in
                (("ultralytics", "ultralytics"), ("torch", "torch"), ("openvino", "openvino"),
                 ("opencv", "opencv-python"), ("psutil", "psutil"))}},
            "host": {"os": platform.platform(), "cpu": platform.processor(), "logicalCpus": logical_cpus,
                     "systemRamTotalMiB": psutil.virtual_memory().total / 1048576},
            "warmupFramesPerCamera": args.warmup, "measuredSamplesPerCamera": args.frames,
            "combined": {"samples": args.frames, "wallSeconds": sample_wall,
                         "throughputFps": args.frames * len(detectors) / sample_wall,
                         "perIterationLatencyMs": stats(combined_durations),
                         "processCpuOneCorePercent": process_cpu_seconds / sample_wall * 100,
                         "processCpuNormalizedHostPercent": process_cpu_seconds / sample_wall / logical_cpus * 100,
                         "systemCpuPercent": system_cpu_percent,
                         "torchIntraOpThreadsResolved": __import__("torch").get_num_threads()},
            "cameras": metrics, "openvinoCompiledProperties": compiled_properties,
            "limitations": ["Stock file replay has no real camera frame age or capture scheduling.",
                            "Video decode is excluded from measured detector wall time and throughput.",
                            "Compiled OpenVINO properties are reported only when a predictor compiled a model.",
                            "No benchmark winner is promoted automatically."],
        }
    finally:
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)
        capture = source_state.get("capture")
        if capture is not None:
            capture.release()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Existing local image or video; URLs/camera indices are rejected")
    parser.add_argument("--threads", type=lambda value: parse_integer_list(value, "--threads"), default=[0, 1, 2, 4])
    parser.add_argument("--cpu-threads", type=lambda value: parse_integer_list(value, "--cpu-threads"), default=[0],
                        help="PyTorch CPU intra-op budget configured before OpenVINO model loading; 0 retains defaults")
    parser.add_argument("--streams", type=lambda value: parse_integer_list(value, "--streams"), default=[0, 1, 2])
    parser.add_argument("--request-mode", choices=("shared", "fair", "independent", "async"), action="append",
                        help="OpenVINO request scheduling mode(s); defaults to shared")
    parser.add_argument("--performance-hint", choices=("LATENCY", "THROUGHPUT"), action="append",
                        help="OpenVINO performance hint(s); defaults to LATENCY")
    parser.add_argument("--frames", type=int, default=10, help="Measured samples per camera and child process")
    parser.add_argument("--warmup", type=int, default=3, help="Excluded warmup samples per camera")
    parser.add_argument("--timeout-seconds", type=float, default=180,
                        help="Wall-clock limit per isolated configuration, including initialization")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=("local", "coco", "dual", "dual-camera"), action="append",
                        help="Scenario(s); defaults to all four")
    parser.add_argument("--_worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--_thread-count", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--_cpu-thread-count", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--_stream-count", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--_request-mode", choices=("shared", "fair", "independent", "async"),
                        default="shared", help=argparse.SUPPRESS)
    parser.add_argument("--_performance-hint", choices=("LATENCY", "THROUGHPUT"),
                        default="LATENCY", help=argparse.SUPPRESS)
    parser.add_argument("--_scenario", choices=("local", "coco", "dual", "dual-camera"), help=argparse.SUPPRESS)
    parser.add_argument("--_result", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.frames < 1 or args.warmup < 0:
        parser.error("--frames must be positive and --warmup nonnegative")
    if not math.isfinite(args.timeout_seconds) or args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be finite and positive")
    try:
        args.source = validate_source(args.source)
    except ValueError as error:
        parser.error(str(error))
    if args._worker:
        if args._result is None or args._scenario is None:
            parser.error("Internal worker arguments are incomplete")
        try:
            report = worker(argparse.Namespace(source=args.source, thread_count=args._thread_count,
                                               cpu_thread_count=args._cpu_thread_count,
                                               stream_count=args._stream_count, request_mode=args._request_mode,
                                               performance_hint=args._performance_hint, scenario=args._scenario,
                                               frames=args.frames, warmup=args.warmup))
            args._result.write_text(json.dumps(report, indent=2), encoding="utf-8")
        except Exception as error:
            print(f"benchmark worker failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            return 1
        return 0

    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    modes = args.mode or ["local", "coco", "dual", "dual-camera"]
    request_modes = args.request_mode or ["shared"]
    performance_hints = args.performance_hint or ["LATENCY"]
    matrix = {"status": "running", "source": str(args.source), "requested": {
        "threads": args.threads, "cpuThreads": args.cpu_threads, "streams": args.streams, "modes": modes,
        "requestModes": request_modes, "performanceHints": performance_hints,
        "frames": args.frames, "warmup": args.warmup}, "results": [], "failures": []}
    with tempfile.TemporaryDirectory(prefix="openvino-matrix-") as temporary:
        temp_path = Path(temporary)
        for mode in modes:
            for threads in args.threads:
                for streams in args.streams:
                    for cpu_threads in args.cpu_threads:
                        for request_mode in request_modes:
                            for performance_hint in performance_hints:
                                result_path = temp_path / "result.json"
                                command = [sys.executable, str(Path(__file__).resolve()), "--source", str(args.source),
                                           "--output", str(result_path), "--frames", str(args.frames),
                                           "--warmup", str(args.warmup), "--_worker", "--_thread-count", str(threads),
                                           "--_cpu-thread-count", str(cpu_threads), "--_stream-count", str(streams),
                                           "--_request-mode", request_mode, "--_performance-hint", performance_hint,
                                           "--_scenario", mode, "--_result", str(result_path)]
                                try:
                                    child = run_bounded(command, cwd=str(ROOT), timeout=args.timeout_seconds)
                                    if child.returncode != 0:
                                        raise RuntimeError(child.stderr.strip() or f"child exited {child.returncode}")
                                    result = json.loads(result_path.read_text(encoding="utf-8"))
                                    matrix["results"].append(result)
                                    output.write_text(json.dumps(matrix, indent=2), encoding="utf-8")
                                    print(json.dumps({"mode": mode, "threads": threads, "streams": streams,
                                                      "requestMode": request_mode,
                                                      "performanceHint": performance_hint,
                                                      "cpuThreads": cpu_threads,
                                                      "throughputFps": result["combined"]["throughputFps"]}),
                                          flush=True)
                                except Exception as error:
                                    matrix["failures"].append({"mode": mode, "threads": threads, "streams": streams,
                                                               "requestMode": request_mode,
                                                               "performanceHint": performance_hint,
                                                               "cpuThreads": cpu_threads,
                                                               "error": f"{type(error).__name__}: {error}"})
                                    matrix["status"] = "failed"
                                    output.write_text(json.dumps(matrix, indent=2), encoding="utf-8")
                                    print(f"matrix configuration failed ({mode}, threads={threads}, streams={streams}, "
                                          f"requestMode={request_mode}, performanceHint={performance_hint}, "
                                          f"cpuThreads={cpu_threads}): {error}", file=sys.stderr, flush=True)
                                    return 1
    matrix["status"] = "completed"
    output.write_text(json.dumps(matrix, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output), "completedConfigurations": len(matrix["results"]),
                      "status": matrix["status"]}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
