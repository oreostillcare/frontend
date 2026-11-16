"""Standalone device compatibility/latency probe. Never imports app or controllers.

Uses original IRs read-only, real stock-image input, and watchdog-bounded children.
Latency is synchronous raw inference, not camera FPS or detection accuracy.
"""

import argparse
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.benchmark_openvino_matrix import run_bounded, stats
from scripts.benchmark_openvino_models import file_sha256


def properties(target, names, device=None):
    result = {}
    for name in names:
        try:
            value = target.get_property(device, name) if device else target.get_property(name)
            result[name] = value if isinstance(value, (str, int, float, list, dict)) else str(value)
        except Exception as error:
            result[name] = {"unavailable": str(error)}
    return result


def discover():
    import openvino as ov
    import psutil

    core = ov.Core()
    return {
        "version": ov.__version__, "devices": core.available_devices,
        "properties": {device: properties(core, (
            "FULL_DEVICE_NAME", "OPTIMIZATION_CAPABILITIES", "DEVICE_ARCHITECTURE",
            "GPU_DEVICE_TOTAL_MEM_SIZE", "GPU_DEVICE_MAX_ALLOC_MEM_SIZE",
            "GPU_MEMORY_STATISTICS", "RANGE_FOR_STREAMS"), device) for device in core.available_devices},
        "logicalCpus": psutil.cpu_count(), "physicalCpus": psutil.cpu_count(logical=False),
        "systemMemory": psutil.virtual_memory()._asdict(),
    }


def probe(args):
    import cv2
    import numpy as np
    import openvino as ov
    import psutil
    from config import settings
    from openvino_artifacts import validate_export
    from ultralytics.data.augment import LetterBox

    path = Path(getattr(settings, f"{args.model}_openvino_model"))
    manifest = json.loads((path / "smartroad-export.json").read_text(encoding="utf-8"))
    validate_export(path, getattr(settings, f"{args.model}_yolo_model"), manifest["imageSize"])
    image = cv2.imread(str(args.source))
    if image is None:
        raise ValueError("Cannot decode source image")
    image = LetterBox((640, 640), auto=True, stride=32)(image=image)
    tensor = np.ascontiguousarray(image[:, :, ::-1].transpose(2, 0, 1)[None]).astype(np.float32) / 255
    core = ov.Core()
    graph = core.read_model(str(next(path.glob("*.xml"))))
    graph.get_parameters()[0].set_layout(ov.Layout("NCHW"))
    if args.static:
        graph.reshape({graph.input(): list(tensor.shape)})
    options = {"PERFORMANCE_HINT": "LATENCY", "INFERENCE_PRECISION_HINT": ov.Type.f32}
    process = psutil.Process()
    report = {"model": args.model, "device": args.device, "static": args.static,
              "inputBCHW": list(tensor.shape), "sourceSha256": file_sha256(args.source),
              "manifestSha256": file_sha256(path / "smartroad-export.json"),
              "status": "compiling", "options": {key: str(value) for key, value in options.items()}}
    args.result.write_text(json.dumps(report, indent=2), encoding="utf-8")
    started = time.perf_counter()
    try:
        compiled = core.compile_model(graph, args.device, options)
        report["compileSeconds"] = time.perf_counter() - started
        report["compiledProperties"] = properties(compiled, (
            "EXECUTION_DEVICES", "INFERENCE_PRECISION_HINT", "PERFORMANCE_HINT", "NUM_STREAMS",
            "INFERENCE_NUM_THREADS", "OPTIMAL_NUMBER_OF_INFER_REQUESTS"))
        request = compiled.create_infer_request()
        owned = ov.Tensor(tensor, shared_memory=False)
        inputs = {compiled.input(): owned}
        for _ in range(args.warmup):
            request.infer(inputs, share_outputs=False)
        before = process.cpu_times()
        system_before = psutil.cpu_times()
        started = time.perf_counter()
        latencies, rss, ram = [], [], []
        for _ in range(args.frames):
            at = time.perf_counter()
            outputs = request.infer(inputs, share_outputs=False)
            latencies.append((time.perf_counter() - at) * 1000)
            assert all(np.isfinite(value).all() for value in outputs.values()), "Nonfinite model output"
            rss.append(process.memory_info().rss / 1048576)
            ram.append(psutil.virtual_memory().percent)
        elapsed = time.perf_counter() - started
        after = process.cpu_times()
        system_after = psutil.cpu_times()
        system_total = sum(system_after) - sum(system_before)
        idle = system_after.idle - system_before.idle
        report.update(status="completed", inferenceMs=stats(latencies), measuredSeconds=elapsed,
                      processCpuHostPercent=(after.user + after.system - before.user - before.system)
                      / elapsed / psutil.cpu_count() * 100,
                      systemCpuPercent=100 * (system_total - idle) / max(system_total, 1e-9),
                      rssMiB=stats(rss), systemRamPercent=stats(ram),
                      outputShapes=[list(value.shape) for value in outputs.values()],
                      gpuAfter=properties(core, ("GPU_MEMORY_STATISTICS",), "GPU"))
    except Exception as error:
        report.update(status="failed", error=f"{type(error).__name__}: {error}",
                      elapsedSeconds=time.perf_counter() - started,
                      rssMiB=process.memory_info().rss / 1048576,
                      systemMemory=psutil.virtual_memory()._asdict())
    args.result.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0 if report["status"] == "completed" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New evidence directory")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=40)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--timeout-seconds", type=float, default=90)
    parser.add_argument("--device", choices=("CPU", "GPU"), default="CPU")
    parser.add_argument("--model", choices=("local", "coco"), default="local")
    parser.add_argument("--static", action="store_true")
    parser.add_argument("--result", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.frames < 1 or args.warmup < 0 or not 0 < args.timeout_seconds < float("inf"):
        parser.error("Positive frames/finite timeout and nonnegative warmup required")
    args.source = args.source.resolve()
    if not args.source.is_file():
        parser.error("Source must be an existing local image")
    if args.result:
        return probe(args)
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    report = {"discovery": discover(), "runs": [],
              "limitations": ["Raw model latency only; excludes preprocessing, NMS, tracking, and capture.",
                              "Stock image is not representative accuracy or calibration data.",
                              "No driver, firmware, production model or configuration changes."]}
    for device, static in (("CPU", False), ("GPU", False), ("GPU", True)):
        if device not in report["discovery"]["devices"]:
            continue
        for model in ("local", "coco"):
            result = args.output / f"{device.lower()}-{model}-{'static' if static else 'dynamic'}.json"
            command = [sys.executable, str(Path(__file__).resolve()), "--source", str(args.source),
                       "--output", str(args.output), "--result", str(result), "--device", device,
                       "--model", model, "--frames", str(args.frames), "--warmup", str(args.warmup)]
            if static:
                command.append("--static")
            at = time.perf_counter()
            try:
                child = run_bounded(command, cwd=str(ROOT), timeout=args.timeout_seconds)
                item = json.loads(result.read_text(encoding="utf-8")) if result.exists() else {}
                if child.returncode != 0 and item.get("status") != "failed":
                    item.update(status="failed", error=f"Child exit {child.returncode}")
                item.update(exitCode=child.returncode, stderr=child.stderr, stdout=child.stdout)
            except Exception as error:
                item = {"status": "failed", "error": f"{type(error).__name__}: {error}"}
            item.update(device=device, model=model, static=static, childSeconds=time.perf_counter() - at)
            report["runs"].append(item)
            (args.output / "summary.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps({key: item.get(key) for key in ("device", "model", "static", "status", "inferenceMs", "error")}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
