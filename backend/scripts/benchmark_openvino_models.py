"""Experiment-only dynamic FP32 OpenVINO image-size benchmark.

Production exports are validated first, then copied into a marked workspace
with only the metadata image size changed. Every measurement uses a fresh,
watchdog-bounded child and the existing matrix or scheduling worker.
"""

import argparse
from dataclasses import replace
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import benchmark_openvino_matrix as matrix
from scripts import benchmark_openvino_scheduling as scheduling

SIZES = (640, 512, 416, 320)
MODELS = ("local", "coco")


def run_plan(sizes, repeats):
    unique_sizes = list(dict.fromkeys(sizes))
    return [item for repeat in range(repeats)
            for item in [(640, "baseline", repeat + 1)]
            + [(size, "candidate", repeat + 1) for size in unique_sizes if size != 640]]


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clone_experiment_exports(settings, output_root, image_size):
    """Create validated, provenance-marked copies; refuse production paths."""
    output_root = Path(output_root).expanduser().resolve()
    source_paths = {name: Path(getattr(settings, f"{name}_openvino_model")).expanduser().resolve()
                    for name in MODELS}
    checkpoints = {name: Path(getattr(settings, f"{name}_yolo_model")).expanduser().resolve()
                   for name in MODELS}
    for source in source_paths.values():
        if output_root == source or source in output_root.parents:
            raise ValueError(f"Experiment workspace cannot be inside a production export: {output_root}")

    from openvino_artifacts import digest, validate_export

    # Validate original manifests against their own declared export size before
    # making any experimental copies. This preserves validate_export semantics.
    originals = {}
    for name, source in source_paths.items():
        manifest_path = source / "smartroad-export.json"
        original_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        validate_export(source, checkpoints[name], original_manifest["imageSize"])
        originals[name] = {
            "path": str(source), "imageSize": original_manifest["imageSize"],
            "manifest": original_manifest,
            "manifestSha256": file_sha256(manifest_path),
            "xmlBinSha256": {suffix: digest(next(source.glob(f"*.{suffix}"))) for suffix in ("xml", "bin")},
        }

    output_root.mkdir(parents=True, exist_ok=True)
    descriptor = output_root / "EXPERIMENT_ONLY.json"
    descriptor.write_text(json.dumps({
        "purpose": "isolated inference image-size benchmark",
        "productionExportsModified": False,
        "imageSizeChange": "metadata inference size only; dynamic FP32 graph unchanged",
        "candidateImageSize": image_size,
    }, indent=2), encoding="utf-8")

    paths = {}
    for name, source in source_paths.items():
        target = (output_root / f"imgsz-{image_size}" / f"{name}_openvino_model").resolve()
        if target == source or source in target.parents or target in source.parents:
            raise ValueError(f"Refusing to clone over or inside an export directory: {target}")
        if target.exists():
            raise FileExistsError(f"Experiment export already exists; choose a new output workspace: {target}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target)
        candidate_xml_bin = {suffix: digest(next(target.glob(f"*.{suffix}"))) for suffix in ("xml", "bin")}
        if candidate_xml_bin != originals[name]["xmlBinSha256"]:
            raise ValueError(f"Copied XML/BIN hashes differ from production export for {name}")
        metadata_path = target / "metadata.yaml"
        metadata = yaml.safe_load(metadata_path.read_text(encoding="utf-8"))
        metadata.setdefault("args", {})["imgsz"] = image_size
        if "imgsz" in metadata:
            metadata["imgsz"] = image_size
        metadata_path.write_text(yaml.safe_dump(metadata, sort_keys=False), encoding="utf-8")
        manifest_path = target / "smartroad-export.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["imageSize"] = image_size
        manifest["artifacts"] = {filename: digest(target / filename) for filename in manifest["artifacts"]}
        manifest["experimentOnly"] = {
            "descriptor": "EXPERIMENT_ONLY.json",
            "change": "metadata inference size only; dynamic FP32 graph unchanged",
            "sourceManifestSha256": originals[name]["manifestSha256"],
        }
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        provenance = {
            "experimentOnly": True, "candidateImageSize": image_size,
            "graphChanged": False, "dynamic": manifest["dynamic"], "precision": manifest["precision"],
            "originalExport": originals[name],
            "candidateManifestSha256": file_sha256(manifest_path),
        }
        (target / "EXPERIMENT_PROVENANCE.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
        validate_export(target, checkpoints[name], image_size)
        paths[name] = target
    return paths, originals


def _instrument_preprocessing():
    """Record actual tensor BCHW and source H/W without changing preprocessing."""
    from ultralytics.models.yolo.detect import DetectionPredictor

    observations = []
    original = DetectionPredictor.preprocess

    def measured(self, image):
        result = original(self, image)
        shape = tuple(int(dimension) for dimension in result.shape)
        source_shapes = [tuple(int(dimension) for dimension in frame.shape[:2]) for frame in image]
        model = getattr(self, "model", None)
        args_model = getattr(getattr(self, "args", None), "model", None)
        weights = getattr(model, "weights", None) if model is not None else None
        label = args_model or weights
        if isinstance(label, (list, tuple)):
            label = ",".join(map(str, label))
        if label is not None:
            label = str(label)
        geometry = []
        if len(shape) == 4:
            target_h, target_w = shape[-2:]
            for source_h, source_w in source_shapes:
                scale = min(target_h / source_h, target_w / source_w)
                geometry.append({"sourceHeightWidth": [source_h, source_w],
                    "derivedLetterboxScale": scale,
                    "derivedPaddingXY": [(target_w - source_w * scale) / 2,
                                         (target_h - source_h * scale) / 2]})
        observations.append({"bchw": shape, "modelLabel": label, "sourceHeightWidth": source_shapes,
                             "derivedLetterboxGeometry": geometry})
        return result

    DetectionPredictor.preprocess = measured
    return observations


def _child_worker(args):
    import config

    # config imports and .env loading complete before this process-local override.
    config.settings = replace(config.settings, image_size=args.image_size,
                              local_openvino_model=args.local_export, coco_openvino_model=args.coco_export)
    preprocess = _instrument_preprocessing()
    if args.kind == "matrix":
        result = matrix.worker(argparse.Namespace(
            source=args.source, thread_count=args.threads, cpu_thread_count=0, stream_count=args.streams,
            request_mode=args.request_mode, performance_hint="LATENCY", scenario="dual-camera",
            frames=args.frames, warmup=args.warmup,
        ))
    else:
        result = scheduling.worker(argparse.Namespace(
            source=args.source, manifest=args.manifest, threads=args.threads, streams=args.streams,
            request_mode=args.request_mode, performance_hint="LATENCY", frames=args.frames,
            timeout_seconds=args.timeout_seconds, source_fps=args.source_fps, delivery=args.delivery,
            line_counting=args.line_counting, max_age_ms=args.max_age_ms,
            guide_green=args.guide_green, guide_red=args.guide_red,
        ))
    result["experimentFixedSettings"] = {
        "imageSize": args.image_size,
        "confidence": {"local": config.settings.confidence,
                       "coco": max(config.settings.confidence, 0.25)},
        "detectionFps": config.settings.detection_fps,
        "openvino": {"requestMode": args.request_mode, "performanceHint": "LATENCY",
                     "threads": args.threads, "streams": args.streams,
                     "cpuInferenceThreads": 0 if args.kind == "matrix" else config.settings.cpu_inference_threads},
    }
    result["inputGeometry"] = {
        "imageSizeRequested": args.image_size, "observations": preprocess,
        "interpretation": "BCHW is the actual predictor preprocessed tensor; source H/W are original frames.",
    }
    result["experimentOnly"] = True
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("matrix", "replay"), default="matrix")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="New experiment workspace/report JSON")
    parser.add_argument("--sizes", type=int, nargs="+", choices=SIZES, default=list(SIZES))
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--frames", type=int, default=10)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=float, default=180)
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--streams", type=int, default=0)
    parser.add_argument("--request-mode", choices=("shared",), default="shared")
    parser.add_argument("--source-fps", type=float, default=0)
    parser.add_argument("--delivery", choices=("latest", "all"), default="latest")
    parser.add_argument("--line-counting", action="store_true")
    parser.add_argument("--max-age-ms", type=float, default=2500)
    parser.add_argument("--guide-green", type=float, default=35)
    parser.add_argument("--guide-red", type=float, default=55)
    parser.add_argument("--_worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--_image-size", type=int, choices=SIZES, help=argparse.SUPPRESS)
    parser.add_argument("--_local-export", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--_coco-export", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--_result", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args._worker:
        try:
            result = _child_worker(argparse.Namespace(**{**vars(args), "image_size": args._image_size,
                "local_export": args._local_export, "coco_export": args._coco_export}))
            args._result.write_text(json.dumps(result, indent=2), encoding="utf-8")
            return 0
        except Exception as error:
            if args._result:
                args._result.write_text(json.dumps({"status": "failed", "error": f"{type(error).__name__}: {error}"},
                                                   indent=2), encoding="utf-8")
            print(f"worker failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            return 1
    if (args.repeats < 1 or args.frames < 1 or args.warmup < 0 or args.threads < 0 or args.streams < 0
            or not math.isfinite(args.timeout_seconds) or args.timeout_seconds <= 0):
        parser.error("repeats, frames, timeout and resource values must be valid")
    try:
        args.source = matrix.validate_source(args.source)
        if args.kind == "replay" and args.manifest:
            args.manifest = args.manifest.expanduser().resolve()
            scheduling.load_manifest(args.manifest)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        parser.error(str(error))

    import config
    production_paths = [Path(getattr(config.settings, f"{name}_openvino_model")).expanduser().resolve()
                        for name in MODELS]
    output = args.output.expanduser().resolve()
    workspace = output.parent / (output.stem + "-experiment")
    for target in (output, workspace):
        for production in production_paths:
            if target == production or production in target.parents:
                parser.error(f"report and experiment workspace must be outside production exports: {production}")
    if output.exists():
        parser.error("--output must name a new report path")
    if workspace.exists():
        parser.error(f"experiment workspace already exists: {workspace}")
    output.parent.mkdir(parents=True, exist_ok=True)
    sizes = list(dict.fromkeys(args.sizes))
    plans = run_plan(sizes, args.repeats)
    report = {"status": "running", "kind": args.kind, "requestedSizes": sizes, "repeats": args.repeats,
              "source": {"path": str(args.source), "sha256": matrix.digest_path(args.source)},
              "originalExports": {}, "runs": [], "failures": [], "accuracyClaims": False,
              "automaticPromotion": False}
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="openvino-imgsz-") as temporary:
        for index, (size, label, repeat) in enumerate(plans):
            try:
                exports, originals = clone_experiment_exports(config.settings, workspace / f"run-{index}", size)
                report["originalExports"] = originals
                result_path = Path(temporary) / f"run-{index}.json"
                command = [sys.executable, str(Path(__file__).resolve()), "--kind", args.kind,
                    "--source", str(args.source), "--output", str(output), "--frames", str(args.frames),
                    "--warmup", str(args.warmup), "--timeout-seconds", str(args.timeout_seconds),
                    "--threads", str(args.threads), "--streams", str(args.streams), "--request-mode", args.request_mode,
                    "--_worker", "--_image-size", str(size), "--_local-export", str(exports["local"]),
                    "--_coco-export", str(exports["coco"]), "--_result", str(result_path)]
                if args.manifest:
                    command.extend(("--manifest", str(args.manifest)))
                if args.kind == "replay":
                    command.extend(("--source-fps", str(args.source_fps), "--delivery", args.delivery,
                                    "--max-age-ms", str(args.max_age_ms), "--guide-green", str(args.guide_green),
                                    "--guide-red", str(args.guide_red)))
                    if args.line_counting:
                        command.append("--line-counting")
                import psutil
                background_cpu = psutil.cpu_percent(interval=0.2)
                child = matrix.run_bounded(command, cwd=str(ROOT), timeout=args.timeout_seconds)
                result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else {}
                run = {"index": index, "size": size, "label": label, "repeat": repeat,
                       "backgroundSystemCpuPercentBefore": background_cpu, "exitCode": child.returncode,
                       "result": result}
                report["runs"].append(run)
                if child.returncode or result.get("status") != "completed":
                    raise RuntimeError(result.get("error") or child.stderr.strip() or "worker failed")
            except Exception as error:
                report["failures"].append({"index": index, "size": size,
                    "error": f"{type(error).__name__}: {error}"})
                report["status"] = "failed"
                output.write_text(json.dumps(report, indent=2), encoding="utf-8")
                return 1
            output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    report["status"] = "completed"
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
