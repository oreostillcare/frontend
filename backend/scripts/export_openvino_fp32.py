"""Export copies of both existing checkpoints; original files are never overwritten."""

import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "models/openvino")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("YOLO_CONFIG_DIR", str(ROOT / "runs/phase3"))
    from config import settings
    from openvino_artifacts import digest
    import openvino as ov
    from ultralytics import YOLO

    if settings.image_size != 640:
        raise SystemExit("This FP32 export requires the existing configured image size to be 640")
    for checkpoint in (settings.local_yolo_model, settings.coco_yolo_model):
        before = digest(checkpoint)
        destination = args.output / f"{checkpoint.stem}_openvino_model"
        if destination.exists():
            raise SystemExit(f"Refusing to overwrite existing export: {destination}")
        with tempfile.TemporaryDirectory(dir=args.output) as directory:
            copied = Path(directory) / checkpoint.name
            shutil.copy2(checkpoint, copied)
            model = YOLO(str(copied))
            names = {int(key): str(value).lower() for key, value in model.names.items()}
            exported = Path(model.export(
                format="openvino", quantize=32, imgsz=640, batch=1,
                dynamic=True, nms=False, device="cpu",
            ))
            xml = next(exported.glob("*.xml"))
            graph = ov.Core().read_model(str(xml))
            for operation in graph.get_ops():
                if operation.get_type_name() == "FakeQuantize":
                    raise RuntimeError("Unexpected quantization in FP32 export")
                if operation.get_type_name() == "Constant" and operation.get_output_element_type(0) in {
                    ov.Type.f16, ov.Type.bf16,
                }:
                    raise RuntimeError("Unexpected reduced-precision weights")
            artifacts = {file.name: digest(file) for file in exported.iterdir() if file.is_file()}
            manifest = {
                "precision": "FP32", "imageSize": 640, "dynamic": True,
                "checkpointSha256": before, "names": names, "artifacts": artifacts,
                "openvinoVersion": ov.__version__,
            }
            (exported / "smartroad-export.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            shutil.copytree(exported, destination)
        if digest(checkpoint) != before:
            raise RuntimeError("Original checkpoint changed during export")
        print(f"FP32 export verified: {destination}; original checkpoint SHA256 unchanged", flush=True)


if __name__ == "__main__":
    main()
