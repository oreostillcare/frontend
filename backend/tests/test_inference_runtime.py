import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest

from inference_runtime import OpenVINORequestAdapter, predictor_factory


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
    calls = fake_predictor_api(monkeypatch)
    (tmp_path / "model.xml").write_text("fake")
    compiled = SimpleNamespace(input=lambda: SimpleNamespace(get_any_name=lambda: "images"),
                               get_property=lambda key: "f32")
    graph = SimpleNamespace(get_parameters=lambda: [SimpleNamespace(set_layout=Mock())])
    compile_model = Mock(return_value=compiled)
    monkeypatch.setitem(sys.modules, "openvino", SimpleNamespace(
        Core=lambda: SimpleNamespace(read_model=lambda path: graph, compile_model=compile_model),
        Layout=lambda value: value, Type=SimpleNamespace(f32="f32"),
    ))
    config = SimpleNamespace(cpu_inference_threads=2, inference_backend="openvino", local_openvino_model=tmp_path,
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
    assert calls == [("library", 8), ("library", 8)]  # No late process-global thread retuning.


class FakeRequest:
    def __init__(self, outputs):
        self.outputs = outputs
        self.seen_inputs = []
        self.wait_for_calls = []
        self.cancel_calls = 0
        self.fail_first_wait = False

    def infer(self, inputs, share_outputs):
        assert share_outputs is False
        self.seen_inputs.append(inputs["images"])
        return {"first": self.outputs[0], "second": self.outputs[1]}

    def start_async(self, inputs):
        self.seen_inputs.append(inputs["images"])

    def wait_for(self, timeout_ms):
        self.wait_for_calls.append(timeout_ms)
        return not (self.fail_first_wait and len(self.wait_for_calls) == 1)

    def cancel(self):
        self.cancel_calls += 1

    def get_output_tensor(self, index):
        return SimpleNamespace(data=self.outputs[index])


class FakeOVTensor:
    def __init__(self, array, shared_memory=False):
        assert shared_memory is False
        self.array = np.array(array, copy=not shared_memory)

    def __array__(self, dtype=None, copy=None):
        return np.asarray(self.array, dtype=dtype)

    def __getitem__(self, key):
        return self.array[key]

    def __setitem__(self, key, value):
        self.array[key] = value


def fake_adapter(*args, **kwargs):
    kwargs.setdefault("tensor_factory", FakeOVTensor)
    return OpenVINORequestAdapter(*args, **kwargs)


def fake_graph(outputs):
    return SimpleNamespace(outputs=outputs)


def ultralytics_forward(adapter, inputs):
    """Exercise the installed OpenVINOBackend.forward mapping contract."""
    from ultralytics.nn.backends.openvino import OpenVINOBackend

    class FakeTensor:
        def cpu(self):
            return self

        def numpy(self):
            return inputs

    backend = SimpleNamespace(inference_mode="LATENCY", ov_compiled_model=adapter)
    return OpenVINOBackend.forward(backend, FakeTensor())


def test_sync_request_returns_owned_outputs_in_graph_order_and_copies_input():
    first_output = np.array([[1]], dtype=np.float32)
    second_output = np.array([[2]], dtype=np.float32)
    request = FakeRequest([first_output, second_output])
    source_input = np.array([3], dtype=np.float32)
    adapter = fake_adapter(fake_graph(["first", "second"]), request, "images")

    raw_result = adapter(source_input)
    result = list(raw_result.values())
    source_input[0] = 99
    first_output[0, 0] = 99

    assert request.seen_inputs[0] is not source_input
    assert request.seen_inputs[0][0] == 3
    assert list(raw_result) == ["first", "second"]
    assert [item[0, 0] for item in result] == [1, 2]


def test_sync_request_tensor_binding_never_mutates_or_reuses_callers_input():
    class BindingRequest:
        def infer(self, inputs, share_outputs):
            assert share_outputs is False
            value = inputs["images"]
            # Model the OpenVINO ndarray dispatcher updating existing request
            # input storage rather than copying a caller's frame buffer.
            value.array[:] = value.array * 0.8
            return {"output": value.array.copy()}

    source = np.arange(6, dtype=np.float32).reshape(1, 2, 3)
    expected_source = source.copy()
    adapter = fake_adapter(fake_graph(["output"]), BindingRequest(), "images")

    first = adapter(source)["output"]
    second = adapter(source)["output"]

    assert np.array_equal(source, expected_source)
    assert np.array_equal(first, second)
    assert np.array_equal(first, expected_source * 0.8)


def test_openvino_tensor_input_copies_callers_numpy_storage():
    ov = pytest.importorskip("openvino")

    class BindingRequest:
        def infer(self, inputs, share_outputs):
            assert share_outputs is False
            value = inputs["images"]
            assert isinstance(value, ov.Tensor)
            value.data[:] *= 0.8
            return {"output": value.data.copy()}

    source = np.arange(6, dtype=np.float32).reshape(1, 2, 3)
    expected_source = source.copy()
    adapter = OpenVINORequestAdapter(
        fake_graph(["output"]), BindingRequest(), "images", tensor_factory=ov.Tensor
    )

    first = adapter(source)["output"]
    second = adapter(source)["output"]

    assert np.array_equal(source, expected_source)
    assert np.array_equal(first, second)
    assert np.array_equal(first, expected_source * 0.8)


def test_async_request_holds_input_until_wait_and_copies_outputs():
    first_output = np.array([[4]], dtype=np.float32)
    request = FakeRequest([first_output, np.array([[5]], dtype=np.float32)])
    request.get_output_tensor = lambda index: (
        request.seen_inputs[0].__setitem__(0, 88) or SimpleNamespace(data=request.outputs[index])
        if index == 0 else SimpleNamespace(data=request.outputs[index])
    )
    adapter = fake_adapter(fake_graph(["first", "second"]), request, "images", asynchronous=True)

    result = ultralytics_forward(adapter, np.array([7], dtype=np.float32))
    first_output[0, 0] = 99

    assert request.wait_for_calls == [5000]
    assert request.seen_inputs[0][0] == 88  # Input remains writable/alive through request completion.
    assert [item[0, 0] for item in result] == [4, 5]


def test_async_timeout_is_canceled_and_boundedly_drained_before_reuse():
    request = FakeRequest([np.array([[1]]), np.array([[2]])])
    request.fail_first_wait = True
    adapter = fake_adapter(
        fake_graph(["first", "second"]), request, "images", asynchronous=True, timeout_ms=37
    )

    with pytest.raises(TimeoutError, match="37 ms"):
        adapter(np.array([1]))
    assert request.wait_for_calls == [37, 37]
    assert request.cancel_calls == 1
    assert ultralytics_forward(adapter, np.array([2]))[0][0, 0] == 1


def test_async_submission_failure_is_drained_before_request_can_be_reused():
    request = FakeRequest([np.array([[1]]), np.array([[2]])])
    request.start_async = Mock(side_effect=RuntimeError("native submission failure"))
    adapter = fake_adapter(fake_graph(["first", "second"]), request, "images", asynchronous=True)

    with pytest.raises(RuntimeError, match="native submission failure"):
        adapter(np.array([1]))
    assert request.wait_for_calls == [5000]
    assert request.cancel_calls == 1
    request.start_async = FakeRequest.start_async.__get__(request, FakeRequest)
    assert ultralytics_forward(adapter, np.array([2]))[0][0, 0] == 1


def test_sync_infer_exception_propagates_without_returning_partial_outputs():
    request = FakeRequest([])
    request.infer = Mock(side_effect=RuntimeError("native infer failure"))
    adapter = fake_adapter(fake_graph(["first", "second"]), request, "images")

    with pytest.raises(RuntimeError, match="native infer failure"):
        adapter(np.array([1]))


def test_async_request_is_poisoned_when_failed_wait_cannot_be_drained():
    request = FakeRequest([np.array([[1]]), np.array([[2]])])
    request.wait_for = Mock(side_effect=[False, False])
    adapter = fake_adapter(fake_graph(["first", "second"]), request, "images", asynchronous=True)

    with pytest.raises(TimeoutError, match="request timeout"):
        adapter(np.array([1]))
    with pytest.raises(RuntimeError, match="unusable"):
        adapter(np.array([2]))
    assert request.wait_for.call_args_list == [((5000,),), ((5000,),)]


def test_infer_request_adapter_serializes_direct_concurrent_calls():
    entered = threading.Event()
    resume = threading.Event()
    active = 0
    max_active = 0

    class ConcurrentRequest(FakeRequest):
        def infer(self, inputs, share_outputs):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            entered.set()
            resume.wait(timeout=2)
            active -= 1
            return {"first": np.array([[1]]), "second": np.array([[2]])}

    adapter = fake_adapter(fake_graph(["first", "second"]), ConcurrentRequest([]), "images")
    first = threading.Thread(target=lambda: adapter(np.array([1])))
    second = threading.Thread(target=lambda: adapter(np.array([2])))
    first.start()
    assert entered.wait(timeout=2)
    second.start()
    resume.set()
    first.join(timeout=2)
    second.join(timeout=2)
    assert not first.is_alive() and not second.is_alive()
    assert max_active == 1


def test_predictor_uses_dedicated_request_with_real_graph_and_hint(monkeypatch, tmp_path):
    fake_predictor_api(monkeypatch)
    (tmp_path / "model.xml").write_text("fake")
    requests = []
    compiled = SimpleNamespace(
        input=lambda: SimpleNamespace(get_any_name=lambda: "images"),
        outputs=["out"],
        get_property=lambda key: "f32",
        create_infer_request=lambda: requests.append(FakeRequest([np.array([[1]])])) or requests[-1],
    )
    compile_model = Mock(return_value=compiled)
    monkeypatch.setitem(sys.modules, "openvino", SimpleNamespace(
        Core=lambda: SimpleNamespace(
            read_model=lambda path: SimpleNamespace(get_parameters=lambda: [SimpleNamespace(set_layout=Mock())]),
            compile_model=compile_model,
        ),
        Layout=lambda value: value,
        Type=SimpleNamespace(f32="f32"),
    ))
    config = SimpleNamespace(
        cpu_inference_threads=0, inference_backend="openvino", local_openvino_model=tmp_path,
        openvino_threads=0, openvino_streams=0, openvino_request_mode="independent",
        openvino_performance_hint="THROUGHPUT",
    )
    cache = {}
    factory = predictor_factory(config, cache, threading.RLock(), "local")
    first, second = factory(), factory()
    first.setup_model()
    second.setup_model()

    assert compile_model.call_count == 1
    assert compile_model.call_args.args[2]["PERFORMANCE_HINT"] == "THROUGHPUT"
    assert first.model.backend.ov_compiled_model._compiled_model is cache["local"]
    assert first.model.backend.ov_compiled_model is not second.model.backend.ov_compiled_model
    assert first.model.backend.inference_mode == second.model.backend.inference_mode == "LATENCY"
    assert len(requests) == 2
