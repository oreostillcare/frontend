import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from scripts import benchmark_openvino_matrix as benchmark


def test_stats_reports_order_statistics_and_sample_count():
    assert benchmark.stats([100, 10, 20, 30]) == {
        "count": 4, "mean": 40.0, "p50": 20.0, "p95": 100.0,
    }
    assert benchmark.stats([None]) is None


def test_integer_lists_reject_negative_and_malformed_values():
    assert benchmark.parse_integer_list("0, 2,2", "--threads") == [0, 2]
    with pytest.raises(Exception, match="nonnegative"):
        benchmark.parse_integer_list("0,-1", "--streams")
    with pytest.raises(Exception, match="integers"):
        benchmark.parse_integer_list("1,nope", "--threads")


def test_source_guard_accepts_existing_file_and_rejects_missing_or_url(tmp_path):
    source = tmp_path / "road.mp4"
    source.write_bytes(b"video")
    assert benchmark.validate_source(source) == source.resolve()
    with pytest.raises(ValueError, match="existing local"):
        benchmark.validate_source(tmp_path / "missing.mp4")
    with pytest.raises(ValueError):
        benchmark.validate_source("https://example.test/road.mp4")


def test_dual_camera_setup_creates_independent_detectors_with_shared_pool(monkeypatch):
    import detector

    detector_calls = []

    class FakePool:
        models = {"local": SimpleNamespace(overrides={}), "coco": SimpleNamespace(overrides={})}
        errors = {}

        def status(self):
            return {"local": {"online": True}, "coco": {"online": True}}

    class FakeDetector:
        def __init__(self, config, line, **kwargs):
            detector_calls.append((config, line, kwargs))
            self.camera_id = None

    pool = FakePool()
    monkeypatch.setattr(detector, "ModelPool", lambda *a, **kw: pool)
    monkeypatch.setattr(detector, "Detector", FakeDetector)
    config = SimpleNamespace(
        line=(1, 2, 3, 4), global_id_local_grace_seconds=1, global_id_cross_camera_seconds=2,
        global_id_match_threshold=0.5, global_id_ambiguity_margin=0.1,
        global_id_minimum_sample_confidence=0.4, global_id_maximum_samples=5,
    )

    result_pool, detectors = benchmark.setup("dual-camera", config)

    assert result_pool is pool
    assert len(detectors) == 2 and detectors[0] is not detectors[1]
    assert [item.camera_id for item in detectors] == [1, 2]
    assert all(call[2]["model_pool"] is pool for call in detector_calls)
    assert all(call[2]["use_custom_model"] and call[2]["use_coco_fallback"] for call in detector_calls)


def test_matrix_saves_failure_and_returns_nonzero_when_child_fails(monkeypatch, tmp_path):
    source = tmp_path / "road.mp4"
    source.write_bytes(b"video")
    output = tmp_path / "report.json"
    monkeypatch.setattr(benchmark, "run_bounded", Mock(return_value=SimpleNamespace(returncode=2, stderr="model unavailable")))

    exit_code = benchmark.main([
        "--source", str(source), "--threads", "0", "--streams", "0", "--cpu-threads", "0",
        "--mode", "dual", "--frames", "1", "--warmup", "0", "--output", str(output),
    ])

    report = json.loads(output.read_text(encoding="utf-8"))
    assert exit_code == 1
    assert report["status"] == "failed"
    assert report["failures"][0]["error"].endswith("model unavailable")


def test_matrix_forwards_repeated_request_mode_and_hint_axes(monkeypatch, tmp_path):
    source = tmp_path / "still.jpg"
    source.write_bytes(b"image")
    output = tmp_path / "matrix.json"
    commands = []

    def run(command, **_kwargs):
        commands.append(command)
        result = Path(command[command.index("--_result") + 1])
        result.write_text(json.dumps({"combined": {"throughputFps": 1.0}}), encoding="utf-8")
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(benchmark, "run_bounded", run)
    assert benchmark.main([
        "--source", str(source), "--threads", "0", "--streams", "0", "--cpu-threads", "0",
        "--mode", "dual", "--frames", "1", "--warmup", "0", "--output", str(output),
        "--request-mode", "shared", "--request-mode", "async",
        "--performance-hint", "LATENCY", "--performance-hint", "THROUGHPUT",
    ]) == 0
    assert len(commands) == 4
    assert all("--_request-mode" in command and "--_performance-hint" in command for command in commands)
    assert {command[command.index("--_request-mode") + 1] for command in commands} == {"shared", "async"}
    assert {command[command.index("--_performance-hint") + 1] for command in commands} == {"LATENCY", "THROUGHPUT"}


def test_script_does_not_import_application_or_network_entrypoints():
    source = Path(benchmark.__file__).read_text(encoding="utf-8")
    forbidden = {"app", "camera", "traffic_control", "traffic_transactions", "flask", "socket", "urllib", "requests"}
    import ast
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert not {alias.name.split(".")[0] for alias in node.names} & forbidden
        if isinstance(node, ast.ImportFrom):
            assert (node.module or "").split(".")[0] not in forbidden


def test_matrix_records_watchdog_timeout_without_claiming_success(monkeypatch, tmp_path):
    source = tmp_path / "still.jpg"
    source.write_bytes(b"image")
    output = tmp_path / "timeout.json"
    monkeypatch.setattr(benchmark, "run_bounded", Mock(side_effect=subprocess.TimeoutExpired(["child"], 0.1)))
    assert benchmark.main([
        "--source", str(source), "--threads", "0", "--streams", "0", "--mode", "dual",
        "--timeout-seconds", "0.1", "--output", str(output),
    ]) == 1
    report = json.loads(output.read_text())
    assert report["status"] == "failed"
    assert report["results"] == []
    assert "TimeoutExpired" in report["failures"][0]["error"]


def test_watchdog_terminates_its_child_tree(tmp_path):
    import psutil

    code = (
        "import subprocess,sys,time,json; "
        "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
        "print(json.dumps({'child':p.pid}),flush=True); time.sleep(30)"
    )
    with pytest.raises(subprocess.TimeoutExpired) as raised:
        benchmark.run_bounded([sys.executable, "-c", code], cwd=str(tmp_path), timeout=2)
    pid = json.loads(raised.value.output.strip().splitlines()[-1])["child"]
    assert not psutil.pid_exists(pid)
