import sys

import pytest

from scripts import benchmark_phase1


@pytest.mark.parametrize("relocated", [False, True])
def test_revision_replay_returns_historical_classes_and_preserves_current_modules(monkeypatch, relocated):
    prefix = "backend/modules/live_monitoring/" if relocated else "backend/"
    detector_path = prefix + ("vehicle_detector.py" if relocated else "detector.py")
    camera_path = prefix + ("camera_capture.py" if relocated else "camera.py")
    detector_import = "modules.live_monitoring.vehicle_detector" if relocated else "detector"
    sources = {
        detector_path: "class ModelPool:\n    revision_marker = 'historical'\n",
        camera_path: (
            f"from {detector_import} import ModelPool\n"
            f"import {detector_import} as detector\n"
            "class CameraWorker:\n    pool = ModelPool\n    imported_pool = detector.ModelPool\n"
        ),
    }

    def git_output(command, **kwargs):
        assert kwargs["cwd"] == benchmark_phase1.ROOT.parent
        if "rev-parse" in command:
            return "resolved-sha\n"
        if "ls-tree" in command:
            return "\n".join(sources)
        return sources[command[-1].split(":", 1)[1]]

    monkeypatch.setattr(benchmark_phase1.subprocess, "check_output", git_output)
    before = dict(sys.modules)
    camera, pool, revision = benchmark_phase1.load_pipeline("baseline")
    assert revision == "resolved-sha"
    assert pool.revision_marker == "historical"
    assert camera.pool is camera.imported_pool is pool
    for name in ("detector", "camera", "_smartroad_replay_detector", "_smartroad_replay_camera"):
        assert sys.modules.get(name) is before.get(name)


def test_revision_replay_cleans_up_modules_on_load_failure(monkeypatch):
    def git_output(command, **kwargs):
        assert kwargs["cwd"] == benchmark_phase1.ROOT.parent
        if "rev-parse" in command:
            return "resolved-sha\n"
        if "ls-tree" in command:
            return "backend/detector.py\nbackend/camera.py"
        return "raise RuntimeError('bad historical source')"

    monkeypatch.setattr(benchmark_phase1.subprocess, "check_output", git_output)
    with pytest.raises(RuntimeError, match="bad historical source"):
        benchmark_phase1.load_pipeline("baseline")
    assert "_smartroad_replay_detector" not in sys.modules
    assert "_smartroad_replay_camera" not in sys.modules


def test_working_tree_replay_uses_current_relocated_modules():
    from modules.live_monitoring.camera_capture import CameraWorker
    from modules.live_monitoring.vehicle_detector import ModelPool

    assert benchmark_phase1.load_pipeline(None) == (CameraWorker, ModelPool, "working-tree")
