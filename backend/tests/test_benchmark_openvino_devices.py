import json
from types import SimpleNamespace

import pytest

from scripts import benchmark_openvino_devices as benchmark


def test_native_crash_is_failure_without_inference_or_fallback(monkeypatch, tmp_path):
    source = tmp_path / "image.jpg"
    source.write_bytes(b"fixture")
    output = tmp_path / "new-evidence"
    commands = []
    monkeypatch.setattr(benchmark, "discover", lambda: {"devices": ["GPU"]})

    def crash(command, **kwargs):
        commands.append((command, kwargs))
        result = command[command.index("--result") + 1]
        with open(result, "w") as stream:
            json.dump({"status": "compiling"}, stream)
        return SimpleNamespace(returncode=3221225477, stderr="", stdout="")

    monkeypatch.setattr(benchmark, "run_bounded", crash)
    assert benchmark.main(["--source", str(source), "--output", str(output)]) == 0
    report = json.loads((output / "summary.json").read_text())
    assert len(commands) == len(report["runs"]) == 4
    assert all(item["status"] == "failed" for item in report["runs"])
    assert all("inferenceMs" not in item for item in report["runs"])
    assert all("3221225477" in item["error"] for item in report["runs"])
    assert all(command[command.index("--device") + 1] == "GPU" for command, _ in commands)
    assert all(kwargs["timeout"] == 90 for _, kwargs in commands)
    with pytest.raises(FileExistsError):
        benchmark.main(["--source", str(source), "--output", str(output)])


def test_timeout_retained_and_remaining_probes_continue(monkeypatch, tmp_path):
    source = tmp_path / "image.jpg"
    source.write_bytes(b"fixture")
    output = tmp_path / "evidence"
    monkeypatch.setattr(benchmark, "discover", lambda: {"devices": ["CPU"]})

    def timeout(*args, **kwargs):
        raise TimeoutError("bounded child")

    monkeypatch.setattr(benchmark, "run_bounded", timeout)
    benchmark.main(["--source", str(source), "--output", str(output)])
    report = json.loads((output / "summary.json").read_text())
    assert len(report["runs"]) == 2
    assert all(item["status"] == "failed" and "TimeoutError" in item["error"] for item in report["runs"])


def test_unsupported_property_is_explicit():
    class Target:
        def get_property(self, name):
            if name == "missing":
                raise RuntimeError("unsupported")
            return "value"

    assert benchmark.properties(Target(), ["available", "missing"]) == {
        "available": "value", "missing": {"unavailable": "unsupported"}}
