import json
from dataclasses import replace
from types import SimpleNamespace

import yaml

from scripts import benchmark_openvino_models as benchmark


def export_fixture(root, name):
    source = root / f"{name}-production"
    source.mkdir()
    checkpoint = root / f"{name}.pt"
    checkpoint.write_bytes(b"checkpoint")
    (source / "model.xml").write_bytes(b"unchanged graph")
    (source / "model.bin").write_bytes(b"unchanged weights")
    (source / "metadata.yaml").write_text(yaml.safe_dump({
        "names": {0: "car"}, "imgsz": 640,
        "args": {"imgsz": 640, "dynamic": True, "nms": False},
    }), encoding="utf-8")
    manifest = {"checkpointSha256": benchmark.file_sha256(checkpoint), "precision": "FP32", "dynamic": True,
                "imageSize": 640, "names": {"0": "car"}, "artifacts": {
                    filename: benchmark.file_sha256(source / filename)
                    for filename in ("model.xml", "model.bin", "metadata.yaml")}}
    (source / "smartroad-export.json").write_text(json.dumps(manifest), encoding="utf-8")
    return source, checkpoint


def test_clone_changes_only_experiment_metadata_and_preserves_production(monkeypatch, tmp_path):
    import openvino_artifacts

    sources = {name: export_fixture(tmp_path, name) for name in benchmark.MODELS}
    before = {path: path.read_bytes() for source, _ in sources.values() for path in source.iterdir()}
    monkeypatch.setattr(openvino_artifacts.importlib.util, "find_spec", lambda _name: object())
    settings = SimpleNamespace(**{
        attr: path for name, (source, checkpoint) in sources.items()
        for attr, path in ((f"{name}_openvino_model", source), (f"{name}_yolo_model", checkpoint))
    })

    clones, originals = benchmark.clone_experiment_exports(settings, tmp_path / "workspace", 416)

    assert set(clones) == set(benchmark.MODELS)
    assert all(path.read_bytes() == data for path, data in before.items())
    for name, clone in clones.items():
        assert clone.name == f"{name}_openvino_model"
        assert (clone / "model.xml").read_bytes() == b"unchanged graph"
        assert (clone / "model.bin").read_bytes() == b"unchanged weights"
        metadata = yaml.safe_load((clone / "metadata.yaml").read_text())
        manifest = json.loads((clone / "smartroad-export.json").read_text())
        assert metadata["args"]["imgsz"] == manifest["imageSize"] == 416
        assert metadata["imgsz"] == 416
        assert manifest["dynamic"] is True and manifest["precision"] == "FP32"
        assert (clone / "EXPERIMENT_PROVENANCE.json").exists()
        assert originals[name]["imageSize"] == 640


def test_clone_refuses_workspace_inside_production_before_writing(monkeypatch, tmp_path):
    sources = {name: export_fixture(tmp_path, name) for name in benchmark.MODELS}
    settings = SimpleNamespace(**{
        attr: path for name, (source, checkpoint) in sources.items()
        for attr, path in ((f"{name}_openvino_model", source), (f"{name}_yolo_model", checkpoint))
    })
    workspace = sources["local"][0] / "nested-experiment"
    import pytest
    with pytest.raises(ValueError, match="inside a production export"):
        benchmark.clone_experiment_exports(settings, workspace, 512)
    assert not workspace.exists()


def test_child_config_override_is_process_local_and_reaches_existing_worker(monkeypatch, tmp_path):
    import config

    monkeypatch.setattr(config, "settings", config.settings)
    observed = {}
    monkeypatch.setattr(benchmark, "_instrument_preprocessing", lambda: [{"bchw": [1, 3, 416, 416]}])

    def fake_worker(_args):
        observed["size"] = config.settings.image_size
        observed["local"] = config.settings.local_openvino_model
        observed["scenario"] = _args.scenario
        return {"status": "completed", "frames": {"camera1": [{"sequence": 1}]}}

    monkeypatch.setattr(benchmark.matrix, "worker", fake_worker)
    result = benchmark._child_worker(SimpleNamespace(
        kind="matrix", image_size=416, local_export=tmp_path / "local", coco_export=tmp_path / "coco",
        source=tmp_path / "video.mp4", threads=0, streams=0, request_mode="shared", frames=1,
        warmup=0, timeout_seconds=1, manifest=None, source_fps=0, delivery="latest",
        line_counting=False, max_age_ms=2500, guide_green=35, guide_red=55,
    ))

    assert observed == {"size": 416, "local": (tmp_path / "local"), "scenario": "dual-camera"}
    assert config.settings.image_size == 416
    assert result["inputGeometry"]["observations"][0]["bchw"] == [1, 3, 416, 416]
    assert result["experimentFixedSettings"]["confidence"]["coco"] == max(config.settings.confidence, 0.25)
    assert result["experimentFixedSettings"]["detectionFps"] == config.settings.detection_fps
    assert result["experimentFixedSettings"]["openvino"] == {
        "requestMode": "shared", "performanceHint": "LATENCY", "threads": 0, "streams": 0,
        "cpuInferenceThreads": 0,
    }


def test_run_plan_keeps_one_baseline_for_explicit_640_and_interleaves_repeats():
    assert benchmark.run_plan([640, 512, 416, 320], 2) == [
        (640, "baseline", 1), (512, "candidate", 1), (416, "candidate", 1), (320, "candidate", 1),
        (640, "baseline", 2), (512, "candidate", 2), (416, "candidate", 2), (320, "candidate", 2),
    ]
    assert benchmark.run_plan([640], 1) == [(640, "baseline", 1)]


def test_main_rejects_report_path_in_production_export_before_writing(monkeypatch, tmp_path):
    import pytest
    import config

    production = tmp_path / "production-export"
    production.mkdir()
    monkeypatch.setattr(config, "settings", replace(config.settings, local_openvino_model=production))
    source = tmp_path / "source.jpg"
    source.write_bytes(b"image")
    output = production / "smartroad-export.json"

    with pytest.raises(SystemExit):
        benchmark.main(["--source", str(source), "--output", str(output)])
    assert not output.exists()
