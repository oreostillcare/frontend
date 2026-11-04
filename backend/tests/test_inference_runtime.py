import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock

from inference_runtime import predictor_factory


def fake_predictor_api(monkeypatch):
    calls = []

    class Predictor:
        def setup_model(self, model=None, verbose=True):
            calls.append(("library", 8))
            self.model = SimpleNamespace(format="openvino", backend=SimpleNamespace())
            self.trackers = []

    monkeypatch.setitem(sys.modules, "ultralytics.models.yolo.detect", SimpleNamespace(DetectionPredictor=Predictor))
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(set_num_threads=lambda n: calls.append(("budget", n))))
    return calls


def test_thread_budget_is_applied_after_library_lazy_initialization(monkeypatch):
    calls = fake_predictor_api(monkeypatch)
    factory = predictor_factory(SimpleNamespace(cpu_inference_threads=2, inference_backend="pytorch"), {}, threading.RLock(), "local")
    factory().setup_model()
    assert calls == [("library", 8), ("budget", 2)]


def test_zero_budget_preserves_library_thread_policy(monkeypatch):
    calls = fake_predictor_api(monkeypatch)
    factory = predictor_factory(SimpleNamespace(cpu_inference_threads=0, inference_backend="pytorch"), {}, threading.RLock(), "local")
    factory().setup_model()
    assert calls == [("library", 8)]


def test_openvino_uses_fp32_cpu_and_shares_compile_without_sharing_tracker_state(monkeypatch, tmp_path):
    fake_predictor_api(monkeypatch)
    (tmp_path / "model.xml").write_text("fake")
    compiled = SimpleNamespace(input=lambda: SimpleNamespace(get_any_name=lambda: "images"),
                               get_property=lambda key: "f32")
    graph = SimpleNamespace(get_parameters=lambda: [SimpleNamespace(set_layout=Mock())])
    compile_model = Mock(return_value=compiled)
    monkeypatch.setitem(sys.modules, "openvino", SimpleNamespace(
        Core=lambda: SimpleNamespace(read_model=lambda path: graph, compile_model=compile_model),
        Layout=lambda value: value, Type=SimpleNamespace(f32="f32"),
    ))
    config = SimpleNamespace(cpu_inference_threads=0, inference_backend="openvino", local_openvino_model=tmp_path,
                             openvino_threads=2, openvino_streams=1)
    cache = {}
    factory = predictor_factory(config, cache, threading.RLock(), "local")
    first, second = factory(), factory()
    first.setup_model()
    second.setup_model()
    assert compile_model.call_count == 1
    assert compile_model.call_args.args[1:] == ("CPU", {
        "PERFORMANCE_HINT": "LATENCY", "INFERENCE_PRECISION_HINT": "f32",
        "INFERENCE_NUM_THREADS": 2, "NUM_STREAMS": 1,
    })
    assert first.model.backend.ov_compiled_model is second.model.backend.ov_compiled_model
    assert first.trackers is not second.trackers
