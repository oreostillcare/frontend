import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace


def test_relocated_training_utility_keeps_backend_data_model_and_run_paths(monkeypatch):
    backend = Path(__file__).resolve().parents[1]
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(YOLO=object()))
    spec = importlib.util.spec_from_file_location(
        "training_path_test", backend / "modules/live_monitoring/model_training.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.ROOT == backend
    assert module.DATA == backend / "datasets/combined/data.yaml"
    assert module.BASE_MODEL == backend / "models/trained_local.pt"
