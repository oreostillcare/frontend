"""Offline paired-camera stage timing and preprocessing equality diagnostic.

Reuses the production Detector through the Phase 1 matrix. Instrumentation only;
does not reuse tensors or change model, tracker, callback or capture behavior.
"""

import argparse
from dataclasses import replace
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import benchmark_openvino_matrix as matrix
from scripts.benchmark_worker_timing import Trace, timed_predictor


def profile(source, frames, warmup):
    import numpy as np

    setup = matrix.setup
    read_source = matrix.read_source
    traces, decode, equality = {}, [], {}

    def measured_read(path, state):
        at = time.perf_counter()
        result = read_source(path, state)
        decode.append((time.perf_counter() - at) * 1000)
        return result

    def instrumented_setup(mode, config):
        pool, detectors = setup(mode, config)
        for detector in detectors:
            trace = Trace()
            camera = f"camera{detector.camera_id}"
            traces[camera] = trace
            equality[camera] = []

            def attach(detector, trace, camera):
                cached = {}
                calls = 0
                original = detector.process

                def predictor(base, name):
                    timed = timed_predictor(base, trace, name)

                    class Predictor(timed):
                        def preprocess(self, images):
                            result = super().preprocess(images)
                            if name == "local":
                                cached["tensor"] = result.detach().cpu().numpy().copy()
                            else:
                                other = result.detach().cpu().numpy()
                                equality[camera].append({"shape": list(other.shape),
                                    "equal": np.array_equal(cached.pop("tensor"), other)})
                            return result
                    return Predictor

                for name in ("local", "coco"):
                    session = getattr(detector, name + "_session")
                    setattr(detector, name + "_session", replace(session, predictor=predictor(session.predictor, name)))

                def process(frame):
                    nonlocal calls
                    trace.current = {}
                    result = original(frame)
                    calls += 1
                    if calls > warmup:
                        trace.record(trace.current)
                    return result
                detector.process = process

            attach(detector, trace, camera)
        return pool, detectors

    matrix.setup, matrix.read_source = instrumented_setup, measured_read
    try:
        result = matrix.worker(argparse.Namespace(
            source=source, thread_count=0, cpu_thread_count=0, stream_count=0,
            request_mode="shared", performance_hint="LATENCY", scenario="dual-camera",
            frames=frames, warmup=warmup))
    finally:
        matrix.setup, matrix.read_source = setup, read_source
    result["decodeReadMs"] = matrix.stats(decode[warmup:])
    result["stageWallMs"] = {camera: trace.stats.summary() for camera, trace in traces.items()}
    result["preprocessingEquality"] = {camera: {
        "measuredComparisons": len(items[warmup:]),
        "allExactlyEqual": all(item["equal"] for item in items[warmup:]),
        "shapes": sorted({tuple(item["shape"]) for item in items[warmup:]}),
    } for camera, items in equality.items()}
    assert len(decode[warmup:]) == frames
    assert all(item["measuredComparisons"] == frames for item in result["preprocessingEquality"].values())
    assert all(stage["count"] == frames for stages in result["stageWallMs"].values()
               for name, stage in stages.items() if name.endswith("WallMs"))
    result["limitations"].extend([
        "Tensor copies/equality checks add instrumentation overhead outside timed preprocess methods.",
        "ByteTrack wall time covers on_predict_postprocess_end callbacks; not just its assignment kernel.",
        "One recording and geometry cannot validate shared preprocessing on all camera sources.",
    ])
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=40)
    parser.add_argument("--warmup", type=int, default=5)
    args = parser.parse_args(argv)
    if args.frames < 1 or args.warmup < 0:
        parser.error("Positive frames and nonnegative warmup required")
    if args.output.exists():
        parser.error("Choose a new output path")
    source = matrix.validate_source(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result = profile(source, args.frames, args.warmup)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "status": result["status"]}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
