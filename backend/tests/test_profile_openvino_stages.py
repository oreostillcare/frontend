import pytest

from scripts import profile_openvino_stages as benchmark


def test_instrumentation_restores_matrix_functions_after_failure(monkeypatch, tmp_path):
    original_setup = benchmark.matrix.setup
    original_read = benchmark.matrix.read_source

    def fail(_args):
        assert benchmark.matrix.setup is not original_setup
        assert benchmark.matrix.read_source is not original_read
        raise RuntimeError("worker failed")

    monkeypatch.setattr(benchmark.matrix, "worker", fail)
    with pytest.raises(RuntimeError, match="worker failed"):
        benchmark.profile(tmp_path / "source.avi", 1, 0)
    assert benchmark.matrix.setup is original_setup
    assert benchmark.matrix.read_source is original_read


def test_profile_refuses_existing_evidence(tmp_path):
    output = tmp_path / "existing.json"
    output.write_text("preserved")
    with pytest.raises(SystemExit):
        benchmark.main(["--source", "unused.avi", "--output", str(output)])
    assert output.read_text() == "preserved"
