"""File-only dual-YOLO benchmark. Never imports app/camera/controllers or writes video."""

import argparse
from collections import Counter
from dataclasses import replace
import hashlib
from importlib.metadata import PackageNotFoundError, version
import json
import math
import os
from pathlib import Path
import platform
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def stats(values):
    ordered = sorted(float(v) for v in values if v is not None)
    if not ordered:
        return None
    return {"count": len(ordered), "mean": round(sum(ordered) / len(ordered), 4),
            "min": round(ordered[0], 4), "max": round(ordered[-1], 4),
            **{f"p{p}": round(ordered[max(0, math.ceil(len(ordered) * p / 100) - 1)], 4) for p in (50, 95, 99)}}


def package_version(name):
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def selected_frame(capture, skip):
    started = time.perf_counter()
    for _ in range(skip):
        if not capture.grab():
            raise RuntimeError("Decoder failed while advancing to a selected frame")
    ok, frame = capture.read()
    if not ok or frame is None:
        raise RuntimeError("Decoder failed to deliver the selected frame")
    return frame, (time.perf_counter() - started) * 1000


class Resources:
    """Identical one-second sampling in a thread; no process enumeration during timing."""

    def __init__(self):
        self.rows = []
        self.stop_event = threading.Event()
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        import psutil

        process = psutil.Process()
        started = previous = time.perf_counter()
        cpu = process.cpu_times()
        previous_cpu = cpu.user + cpu.system
        psutil.cpu_percent()
        self.ready.set()
        while True:
            stopping = self.stop_event.wait(1)
            now = time.perf_counter()
            cpu, memory, system = process.cpu_times(), process.memory_info(), psutil.virtual_memory()
            total = cpu.user + cpu.system
            one_core = (total - previous_cpu) / max(now - previous, 1e-9) * 100
            self.rows.append({"elapsedSeconds": now - started, "intervalSeconds": now - previous,
                              "processCpuOneCore100": one_core,
                              "processCpuHostPercent": one_core / (psutil.cpu_count() or 1),
                              "systemCpuPercent": psutil.cpu_percent(), "rssMiB": memory.rss / 1048576,
                              "processLifetimePeakMiB": getattr(memory, "peak_wset", memory.rss) / 1048576,
                              "systemMemoryPercent": system.percent, "systemUsedMiB": system.used / 1048576,
                              "systemAvailableMiB": system.available / 1048576, "processThreads": process.num_threads()})
            previous, previous_cpu = now, total
            if stopping:
                return

    def start(self):
        self.thread.start()
        if not self.ready.wait(5):
            raise RuntimeError("Resource sampler failed to start")

    def finish(self):
        self.stop_event.set()
        self.thread.join(timeout=5)
        return {"summaries": {key: stats([row[key] for row in self.rows]) for key in self.rows[0]
                              if key not in {"elapsedSeconds", "intervalSeconds"}}, "samples": self.rows}


def process_totals():
    import psutil

    result = {}
    for process in psutil.process_iter(["pid", "name", "cpu_times"], ad_value=None):
        try:
            cpu = process.info["cpu_times"]
            if cpu is not None and process.pid:
                result[process.pid] = (process.info["name"], cpu.user + cpu.system)
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            pass
    return result


def baseline(seconds):
    import psutil

    before = process_totals()
    started = time.perf_counter()
    sampler = Resources()
    sampler.start()
    time.sleep(seconds)
    result = sampler.finish()
    after = process_totals()
    elapsed = time.perf_counter() - started
    result["topConcurrentProcesses"] = sorted([
        {"pid": pid, "name": name, "cpuHostPercent": round(max(0, total - before[pid][1]) / elapsed * 100 /
                                                           (psutil.cpu_count() or 1), 3)}
        for pid, (name, total) in after.items() if pid in before
    ], key=lambda item: item["cpuHostPercent"], reverse=True)[:10]
    return result


def setup_pipeline(config, pipeline):
    from detector import Detector, ModelPool
    from vehicle_identity import GlobalVehicleRegistry

    pool = ModelPool(config)
    if not pool.online:
        raise RuntimeError(f"Models unavailable: {pool.status()}")
    for model in pool.models.values():
        model.overrides.update(device="intel:cpu" if pool.backend == "openvino" else "cpu",
                               save=False, save_txt=False, save_crop=False, show=False)
    registry = GlobalVehicleRegistry(
        local_grace_seconds=config.global_id_local_grace_seconds, cross_camera_seconds=config.global_id_cross_camera_seconds,
        match_threshold=config.global_id_match_threshold, ambiguity_margin=config.global_id_ambiguity_margin,
        minimum_sample_confidence=config.global_id_minimum_sample_confidence, maximum_samples=config.global_id_maximum_samples,
    )
    detector = Detector(config, config.line, model_pool=pool, vehicle_registry=registry)
    detector.camera_id = 1

    def run(frame):
        if pipeline == "full":
            _, detections = detector.process(frame)
            timings = detector.profiler.snapshot()
            classes = Counter(item["class"] for item in detections)
        else:
            timings, classes = {}, Counter()
            for name, session in (("local", detector.local_session), ("coco", detector.coco_session)):
                started = time.perf_counter()
                with session.inference_lock:
                    results = session.model.predict(frame, classes=session.class_ids,
                        conf=max(config.confidence, .25) if name == "coco" else config.confidence,
                        imgsz=config.image_size, verbose=False,
                        **({"predictor": session.predictor} if session.predictor else {}))
                timings[f"{name}PredictCallMs"] = (time.perf_counter() - started) * 1000
                timings[f"{name}InferenceMs"] = sum(result.speed["inference"] for result in results)
                for result in results:
                    classes.update(str(session.model.names[int(label)]).lower() for label in result.boxes.cls.cpu().tolist())
        timings["totalInferenceMs"] = timings["localInferenceMs"] + timings["cocoInferenceMs"]
        return timings, classes

    return pool, detector, run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--backend", choices=("pytorch", "openvino"), default="pytorch")
    parser.add_argument("--threads", type=int, default=0, help="PyTorch intra-op; 0 retains library defaults")
    parser.add_argument("--ov-threads", type=int, default=0)
    parser.add_argument("--frames", type=int, default=300)
    parser.add_argument("--warmup", type=int, default=10)
    parser.add_argument("--start-frame", type=int, default=0)
    parser.add_argument("--stride", type=int, default=3)
    parser.add_argument("--mode", choices=("uncapped", "target"), default="uncapped")
    parser.add_argument("--pipeline", choices=("full", "inference"), default="full")
    parser.add_argument("--baseline-seconds", type=int, default=3)
    args = parser.parse_args()
    if min(args.frames, args.warmup, args.stride, args.baseline_seconds) < 1 or min(args.start_frame, args.threads, args.ov_threads) < 0:
        parser.error("Frames, warmup, stride and baseline must be positive; offsets/thread budgets nonnegative")
    args.video = args.video.resolve()
    if not args.video.is_file():
        parser.error("--video must be an existing local file, never a camera index or URL")
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    config_dir = args.output.parent / "ultralytics"
    config_dir.mkdir(parents=True, exist_ok=True)
    os.environ["YOLO_CONFIG_DIR"] = str(config_dir)
    os.environ["YOLO_OFFLINE"] = "true"
    import cv2
    import psutil
    from config import settings
    from openvino_artifacts import digest

    config = replace(settings, inference_backend=args.backend, cpu_inference_threads=args.threads,
                     openvino_threads=args.ov_threads, openvino_streams=0, performance_profiling=True)
    capture = cv2.VideoCapture(str(args.video), cv2.CAP_FFMPEG)
    report = {"status": "initializing", "mode": args.mode, "pipeline": args.pipeline,
              "host": {"logicalCpus": psutil.cpu_count(), "physicalCpus": psutil.cpu_count(logical=False),
                       "cpu": platform.processor(), "os": platform.platform(), "ramGiB": psutil.virtual_memory().total / 1024**3},
              "settings": {"backend": args.backend, "threadsRequested": args.threads, "openvinoThreadsRequested": args.ov_threads,
                           "imageSize": config.image_size, "confidence": config.confidence, "targetFps": config.detection_fps,
                           "productionBackend": settings.inference_backend, "productionThreads": settings.cpu_inference_threads},
              "errors": {"failedFrames": 0, "decoderErrors": 0, "modelErrors": 0}, "frames": []}
    sampler = None
    try:
        if not capture.isOpened():
            raise RuntimeError("Cannot open the existing video file")
        fps, count = capture.get(cv2.CAP_PROP_FPS), int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        fourcc = int(capture.get(cv2.CAP_PROP_FOURCC))
        report["video"] = {"path": str(args.video), "bytes": args.video.stat().st_size,
                           "sha256": digest(args.video), "width": int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
                           "height": int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)), "fps": fps, "frames": count,
                           "durationSeconds": count / fps if fps else None,
                           "fourcc": "".join(chr((fourcc >> (8 * i)) & 255) for i in range(4))}
        last_index = args.start_frame + (args.warmup + args.frames - 1) * args.stride
        if count and last_index >= count:
            raise RuntimeError("Requested frame range exceeds the video; lower frame count/start/stride")
        report["baseline"] = baseline(args.baseline_seconds)
        before = time.perf_counter()
        pool, detector, run = setup_pipeline(config, args.pipeline)
        report["modelLoadSeconds"] = time.perf_counter() - before
        report["checkpoints"] = {name: {"path": str(path), "sha256": digest(path)} for name, path in pool.paths.items()}
        before = time.perf_counter()
        for index in range(args.warmup):
            frame, _ = selected_frame(capture, args.start_frame if index == 0 else args.stride - 1)
            reference = frame.copy()
            run(frame)
        report["warmupSeconds"] = time.perf_counter() - before
        report["preprocessing"] = {}
        report["classes"] = {}
        for name, session in (("local", detector.local_session), ("coco", detector.coco_session)):
            tensor = session.model.predictor.preprocess([reference]).cpu().numpy()
            report["preprocessing"][name] = {"shape": list(tensor.shape), "dtype": str(tensor.dtype),
                                               "sha256": hashlib.sha256(tensor.tobytes()).hexdigest()}
            report["classes"][name] = {str(key): value for key, value in session.model.names.items()}
        import torch
        report["torchIntraOpThreads"] = torch.get_num_threads()
        report["torchInterOpThreads"] = torch.get_num_interop_threads()
        report["versions"] = {name: package_version(name) for name in ("torch", "ultralytics", "opencv-python", "openvino")}
        if pool.compiled_models:
            report["openvinoProperties"] = {name: {key: str(model.get_property(key)) for key in (
                "INFERENCE_PRECISION_HINT", "INFERENCE_NUM_THREADS", "NUM_STREAMS", "EXECUTION_DEVICES")}
                for name, model in pool.compiled_models.items()}
        fingerprint, classes = hashlib.sha256(), Counter()
        sampler = Resources()
        sampler.start()
        process = psutil.Process()
        cpu_start = process.cpu_times()
        started = time.perf_counter()
        deadline = started
        for index in range(args.frames):
            if args.mode == "target":
                time.sleep(max(0, deadline - time.perf_counter()))
            begin = time.perf_counter()
            try:
                frame, decode_ms = selected_frame(capture, args.stride - 1)
            except RuntimeError:
                report["errors"]["decoderErrors"] += 1
                raise
            hashing_at = time.perf_counter()
            fingerprint.update(frame.tobytes())
            hash_ms = (time.perf_counter() - hashing_at) * 1000
            processing_at = time.perf_counter()
            try:
                timings, found = run(frame)
            except Exception:
                report["errors"]["modelErrors"] += 1
                raise
            completed = time.perf_counter()
            classes.update(found)
            report["frames"].append({"sourceIndex": args.start_frame + (args.warmup + index) * args.stride,
                                     "elapsedSeconds": completed - started, "decodeMs": decode_ms, "hashMs": hash_ms,
                                     "pipelineMs": (completed - processing_at) * 1000,
                                     "endToEndMs": (completed - begin) * 1000,
                                     "scheduleLatenessMs": max(0, begin - deadline) * 1000 if args.mode == "target" else None,
                                     "detections": sum(found.values()), **timings})
            # No catch-up burst after an overrun; the next frame starts at least one
            # target period after this frame started. Sleep is outside timed work.
            deadline = begin + 1 / max(config.detection_fps, .1)
        if args.mode == "target":
            time.sleep(max(0, deadline - time.perf_counter()))  # Complete the final target period.
        elapsed = time.perf_counter() - started
        cpu_end = process.cpu_times()
        report["resources"] = sampler.finish()
        sampler = None
        records = report["frames"]
        report["summary"] = {"frames": len(records), "wallSeconds": elapsed, "actualFps": len(records) / elapsed,
                             "processCpuMeanHostPercent": ((cpu_end.user + cpu_end.system - cpu_start.user - cpu_start.system) /
                                                           elapsed * 100 / (psutil.cpu_count() or 1)),
                             "selectedFramesSha256": fingerprint.hexdigest(), "stride": args.stride, "warmupFrames": args.warmup,
                             "classObservations": dict(classes), "forwardOnlyCapacityFps": len(records) * 1000 / sum(r["totalInferenceMs"] for r in records),
                             "selectedFrameDecodeCapacityFps": len(records) * 1000 / sum(r["decodeMs"] for r in records),
                             "sourceFramesAdvanceCapacityFps": len(records) * args.stride * 1000 / sum(r["decodeMs"] for r in records),
                             "latencies": {key: stats([r[key] for r in records]) for key in records[0] if key.endswith("Ms")},
                             "processingOverTargetPeriod": sum(r["endToEndMs"] > 1000 / max(config.detection_fps, .1) for r in records)}
        report["status"] = "completed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = f"{type(error).__name__}: {error}"
        report["errors"]["failedFrames"] += 1
        raise
    finally:
        if sampler:
            report["partialResources"] = sampler.finish()
        capture.release()
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "backend": args.backend, "mode": args.mode, "pipeline": args.pipeline,
                      "fps": round(report["summary"]["actualFps"], 3), "cpuHostPercent": round(report["summary"]["processCpuMeanHostPercent"], 3),
                      "processingMs": report["summary"]["latencies"]["endToEndMs"]}), flush=True)


if __name__ == "__main__":
    main()
