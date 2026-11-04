"""Validate optional exports against their original checkpoints; never auto-export."""

import hashlib
import importlib.util
import json
from pathlib import Path

import yaml


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def validate_export(path: Path, checkpoint: Path, image_size: int) -> dict[int, str]:
    if importlib.util.find_spec("openvino") is None:
        raise RuntimeError("Optional OpenVINO runtime missing; install requirements-openvino.txt explicitly")
    manifest = json.loads((path / "smartroad-export.json").read_text(encoding="utf-8"))
    if len(list(path.glob("*.xml"))) != 1:
        raise ValueError("Expected exactly one OpenVINO XML model")
    if manifest["checkpointSha256"] != digest(checkpoint):
        raise ValueError("OpenVINO artifact does not match the current PyTorch checkpoint")
    if manifest["precision"] != "FP32" or manifest["imageSize"] != image_size or not manifest["dynamic"]:
        raise ValueError("Expected a dynamic FP32 export at the unchanged inference image size")
    for filename, expected in manifest["artifacts"].items():
        if Path(filename).name != filename or digest(path / filename) != expected:
            raise ValueError("OpenVINO artifact hash mismatch")
    metadata = yaml.safe_load((path / "metadata.yaml").read_text(encoding="utf-8"))
    names = {int(key): str(value).lower() for key, value in metadata["names"].items()}
    if names != {int(key): value for key, value in manifest["names"].items()}:
        raise ValueError("OpenVINO class-index mapping changed")
    if metadata.get("args", {}).get("nms") or not metadata.get("args", {}).get("dynamic"):
        raise ValueError("Expected raw dynamic output with existing Ultralytics NMS")
    return names
