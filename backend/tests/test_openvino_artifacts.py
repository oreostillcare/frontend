import json
from types import SimpleNamespace

import pytest
import yaml

from openvino_artifacts import digest, validate_export


def export_fixture(tmp_path):
    checkpoint = tmp_path / "original.pt"
    checkpoint.write_bytes(b"untouched checkpoint")
    artifact = tmp_path / "model_openvino_model"
    artifact.mkdir()
    (artifact / "model.xml").write_bytes(b"fake XML")
    (artifact / "model.bin").write_bytes(b"fake FP32 weights")
    (artifact / "metadata.yaml").write_text(yaml.safe_dump({
        "names": {0: "tricycle", 1: "ebike", 2: "jeepney"}, "args": {"nms": False, "dynamic": True},
    }))
    manifest = {"checkpointSha256": digest(checkpoint), "precision": "FP32", "dynamic": True, "imageSize": 640,
                "names": {"0": "tricycle", "1": "ebike", "2": "jeepney"},
                "artifacts": {file.name: digest(file) for file in artifact.iterdir()}}
    (artifact / "smartroad-export.json").write_text(json.dumps(manifest))
    return checkpoint, artifact


def test_export_integrity_and_mapping_are_verified(monkeypatch, tmp_path):
    monkeypatch.setattr("openvino_artifacts.importlib.util.find_spec", lambda name: SimpleNamespace())
    checkpoint, artifact = export_fixture(tmp_path)
    assert validate_export(artifact, checkpoint, 640) == {0: "tricycle", 1: "ebike", 2: "jeepney"}
    (artifact / "model.bin").write_bytes(b"different model")
    with pytest.raises(ValueError, match="hash mismatch"):
        validate_export(artifact, checkpoint, 640)


def test_changed_checkpoint_or_image_size_is_not_silently_accepted(monkeypatch, tmp_path):
    monkeypatch.setattr("openvino_artifacts.importlib.util.find_spec", lambda name: SimpleNamespace())
    checkpoint, artifact = export_fixture(tmp_path)
    with pytest.raises(ValueError, match="unchanged inference image size"):
        validate_export(artifact, checkpoint, 320)
    checkpoint.write_bytes(b"new checkpoint")
    with pytest.raises(ValueError, match="does not match"):
        validate_export(artifact, checkpoint, 640)


def test_missing_optional_runtime_does_not_trigger_installation(monkeypatch, tmp_path):
    monkeypatch.setattr("openvino_artifacts.importlib.util.find_spec", lambda name: None)
    with pytest.raises(RuntimeError, match="install requirements-openvino"):
        validate_export(tmp_path, tmp_path / "none.pt", 640)
