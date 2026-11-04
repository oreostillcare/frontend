"""File-only replay microbenchmark. Never imports app.py or creates a signal controller.

Viewer modes model presentation consumers; they do not measure browser/proxy
transport. Use separate processes for baseline/current so trackers and resources
start fresh. No ground-truth counting accuracy is inferred from model output.
"""

import argparse
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import types

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import cv2
import psutil

from config import settings
from vehicle_identity import GlobalVehicleRegistry


def load_pipeline(revision: str | None):
    if revision:
        revision = subprocess.check_output(
            ["git", "rev-parse", "--verify", f"{revision}^{{commit}}"], cwd=ROOT, text=True
        ).strip()
        # Only the camera/detector pipeline is loaded from the chosen revision.
        # Domain rules/config/weights use this checkout; app.py is never loaded.
        for name in ("detector", "camera"):
            source = subprocess.check_output(
                ["git", "show", f"{revision}:backend/{name}.py"], cwd=ROOT, text=True, encoding="utf-8"
            )
            module = types.ModuleType(name)
            module.__file__ = str(ROOT / f"{name}.py")
            sys.modules[name] = module
            exec(compile(source, module.__file__, "exec"), module.__dict__)
    from camera import CameraWorker
    from detector import ModelPool

    return CameraWorker, ModelPool, revision or "working-tree"


def summary(values: list[float]) -> dict:
    ordered = sorted(values)
    if not ordered:
        return {}
    return {
        "mean": round(sum(ordered) / len(ordered), 3),
        "p50": round(ordered[len(ordered) // 2], 3),
        "p95": round(ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))], 3),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-a", required=True, type=Path)
    parser.add_argument("--source-b", type=Path)
    parser.add_argument("--revision", help="Baseline camera/detector commit, e.g. 4a113ba")
    parser.add_argument("--viewers", choices=("none", "local", "online", "both"), default="none")
    parser.add_argument("--frames", type=int, default=100, help="Selected frames per camera, excluding warmup")
    parser.add_argument("--warmup", type=int, default=10)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.frames < 1 or args.warmup < 0:
        parser.error("frames must be positive and warmup must be nonnegative")
    sources = [source.resolve() for source in (args.source_a, args.source_b) if source]
    if any(not source.is_file() for source in sources):
        parser.error("Every source must be an existing local video file; camera URLs/indices are not accepted")
    CameraWorker, ModelPool, revision = load_pipeline(args.revision)
    config = replace(settings, performance_profiling=True, viewer_aware_jpeg=True)
    pool = ModelPool(config)
    if not pool.online:
        raise SystemExit(f"Models unavailable: {pool.status()}")
    registry = GlobalVehicleRegistry(
        local_grace_seconds=config.global_id_local_grace_seconds,
        cross_camera_seconds=config.global_id_cross_camera_seconds,
        match_threshold=config.global_id_match_threshold,
        ambiguity_margin=config.global_id_ambiguity_margin,
        minimum_sample_confidence=config.global_id_minimum_sample_confidence,
        maximum_samples=config.global_id_maximum_samples,
    )
    viewer_count = {"none": 0, "local": 1, "online": 1, "both": 2}[args.viewers]
    samples: dict[str, list[float]] = {}
    fingerprints = [hashlib.sha256() for _ in sources]
    counts = [0] * len(sources)
    process = psutil.Process()
    cpu_start = None
    started = None
    peak_rss = 0
    captures = []
    workers = []
    try:
        for index, source in enumerate(sources):
            capture = cv2.VideoCapture(str(source))
            captures.append(capture)
            if not capture.isOpened():
                raise SystemExit(f"Cannot decode local video: {source}")
            worker = CameraWorker(index + 1, None, config, config.line, model_pool=pool, vehicle_registry=registry)
            # Benchmark the stated CPU-only target without changing live settings.
            for session in (worker.detector.local_session, worker.detector.coco_session):
                if session is not None:
                    session.model.overrides["device"] = "cpu"
            worker._viewer_count = viewer_count
            workers.append(worker)
        for frame_index in range(args.frames + args.warmup):
            for index, (worker, capture) in enumerate(zip(workers, captures)):
                stride = max(1, round((capture.get(cv2.CAP_PROP_FPS) or config.detection_fps) / config.detection_fps))
                frame = None
                for _ in range(stride):
                    ok, frame = capture.read()
                    if not ok:
                        raise SystemExit("Footage ended before requested samples; lower --frames/--warmup")
                captured_at = time.perf_counter()
                if frame_index == args.warmup and index == 0:
                    started = captured_at
                    cpu_start = process.cpu_times()
                annotated, detections = worker.detector.process(frame)
                worker._draw_transaction_counts(annotated)
                encode_started = time.perf_counter()
                if hasattr(worker, "_encode_frame"):
                    encoded = worker._encode_frame(annotated)
                else:
                    encoded, jpeg = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
                    if encoded:
                        worker._jpeg_frame = jpeg.tobytes()
                completed = time.perf_counter()
                if frame_index < args.warmup:
                    continue
                values = {
                    "processingMs": (completed - captured_at) * 1000,
                    "jpegMs": (completed - encode_started) * 1000 if encoded else 0.0,
                    "frameAgeMs": (completed - captured_at) * 1000,
                }
                profiler = getattr(worker.detector, "profiler", None)
                if profiler:
                    values.update(profiler.snapshot())
                for name, value in values.items():
                    samples.setdefault(f"camera{index + 1}.{name}", []).append(value)
                fingerprints[index].update(json.dumps(detections, sort_keys=True).encode())
                counts[index] += 1
                peak_rss = max(peak_rss, process.memory_info().rss)
        elapsed = time.perf_counter() - started
        cpu_end = process.cpu_times()
        cpu_seconds = (cpu_end.user + cpu_end.system) - (cpu_start.user + cpu_start.system)
        result = {
            "scope": "serialized file replay; simulated viewer demand; excludes HTTP/browser and physical control",
            "revision": revision,
            "device": "cpu",
            "viewers": args.viewers,
            "sources": [str(source) for source in sources],
            "selectedFramesPerCamera": counts,
            "configuredDetectionFps": config.detection_fps,
            "wallSeconds": round(elapsed, 3),
            "processCpuPercentOneCore100": round(cpu_seconds / elapsed * 100, 2),
            "peakSampledProcessRssMb": round(peak_rss / 1048576, 2),
            "replayThroughputFpsPerCamera": [round(count / elapsed, 3) for count in counts],
            "timings": {name: summary(values) for name, values in samples.items()},
            "detectionFingerprints": [digest.hexdigest() for digest in fingerprints],
            "passedPerCamera": [worker.detector.track_state.passed for worker in workers],
            "countingAccuracy": "not measured: requires labeled ground truth",
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
    finally:
        for capture in captures:
            capture.release()


if __name__ == "__main__":
    main()
