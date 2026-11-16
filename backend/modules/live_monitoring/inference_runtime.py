"""Optional predictor setup; leaves Ultralytics preprocessing, NMS and tracking intact."""

# Builds optional OpenVINO predictors while preserving the normal YOLO pipeline.

import threading

import numpy as np


class OpenVINORequestAdapter:
    """Ultralytics-compatible callable backed by one owned infer request."""

    def __init__(self, compiled_model, request, input_name, asynchronous=False, timeout_ms=5000, tensor_factory=None):
        if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or timeout_ms <= 0:
            raise ValueError("OpenVINO request timeout must be a positive integer in milliseconds")
        self._compiled_model = compiled_model
        self._request = request
        self._input_name = input_name
        self._asynchronous = asynchronous
        self._timeout_ms = timeout_ms
        self._tensor_factory = tensor_factory
        self._lock = threading.RLock()
        self._poisoned = False
        self._pending_input = None

    def __getattr__(self, name):
        return getattr(self._compiled_model, name)

    def input(self, *args, **kwargs):
        return self._compiled_model.input(*args, **kwargs)

    def get_property(self, *args, **kwargs):
        return self._compiled_model.get_property(*args, **kwargs)

    def _cancel_and_drain(self):
        """Cancel pending work, then wait only for a bounded cleanup interval."""
        try:
            self._request.cancel()
        except BaseException:
            # Cancellation may fail for an already completed or not-started
            # request; wait_for below determines whether reuse is safe.
            pass
        try:
            return bool(self._request.wait_for(self._timeout_ms))
        except BaseException:
            return False

    def _owned_input_tensor(self, inputs):
        factory = self._tensor_factory
        if factory is None:
            import openvino as ov

            factory = ov.Tensor
        # Passing an ndarray to InferRequest.infer can update a request's
        # existing input binding. Give the request a separate owned Tensor so
        # execution cannot mutate or retain the caller's frame buffer.
        return factory(np.asarray(inputs), shared_memory=False)

    def __call__(self, inputs):
        # Callers can invoke the native backend directly, outside Detector's
        # track lock, so request ownership is enforced here as well.
        with self._lock:
            if self._poisoned:
                raise RuntimeError("OpenVINO infer request is unusable after an incomplete async call")
            owned_input = self._owned_input_tensor(inputs)
            request_inputs = {self._input_name: owned_input}
            if self._asynchronous:
                submitted = False
                self._pending_input = owned_input
                try:
                    # Treat submission as potentially partial if the native
                    # start call raises; attempt to drain before reuse.
                    submitted = True
                    self._request.start_async(inputs=request_inputs)
                    if not self._request.wait_for(self._timeout_ms):
                        raise TimeoutError(
                            f"OpenVINO inference exceeded {self._timeout_ms} ms request timeout"
                        )
                except BaseException:
                    if submitted:
                        if self._cancel_and_drain():
                            self._pending_input = None
                        else:
                            self._poisoned = True
                    raise
                self._pending_input = None
                outputs = [
                    self._request.get_output_tensor(index).data
                    for index in range(len(self._compiled_model.outputs))
                ]
            else:
                result = self._request.infer(request_inputs, share_outputs=False)
                outputs = [result[output] for output in self._compiled_model.outputs]
            # CompiledModel.__call__ returns a mapping in compiled output
            # order. Ultralytics' OpenVINO backend consumes `.values()`.
            return {
                output: np.array(value, copy=True)
                for output, value in zip(self._compiled_model.outputs, outputs, strict=True)
            }


def predictor_factory(config, compiled_models: dict, compiled_lock: threading.RLock, name: str):
    from ultralytics.models.yolo.detect import DetectionPredictor

    threads = getattr(config, "cpu_inference_threads", 0)
    backend_name = getattr(config, "inference_backend", "pytorch")

    class ConfiguredCpuPredictor(DetectionPredictor):
        def setup_model(self, model=None, verbose=True):
            super().setup_model(model=model, verbose=verbose)
            # select_device() resets the CPU budget during lazy predictor setup.
            # Apply our opt-in budget afterwards, in the actual inference thread.
            if threads and backend_name != "openvino":
                import torch

                # PyTorch's CPU predictor applies its device defaults during
                # setup_model, so retain the late correction for that backend.
                # OpenVINO's budget is configured once by ModelPool before
                # Ultralytics import/model construction; avoid reconfiguring
                # the process-global thread pool after native backend setup.
                torch.set_num_threads(threads)
            if backend_name == "openvino":
                import openvino as ov

                native = self.model.backend
                if self.model.format != "openvino":
                    raise RuntimeError("Expected Ultralytics OpenVINO backend")
                with compiled_lock:
                    if name not in compiled_models:
                        core = ov.Core()
                        path = getattr(config, f"{name}_openvino_model")
                        xml = next(path.glob("*.xml"))
                        graph = core.read_model(str(xml))
                        graph.get_parameters()[0].set_layout(ov.Layout("NCHW"))
                        hint = getattr(config, "openvino_performance_hint", "LATENCY")
                        options = {"PERFORMANCE_HINT": hint, "INFERENCE_PRECISION_HINT": ov.Type.f32}
                        if config.openvino_threads:
                            options["INFERENCE_NUM_THREADS"] = config.openvino_threads
                        if config.openvino_streams:
                            options["NUM_STREAMS"] = config.openvino_streams
                        compiled_models[name] = core.compile_model(graph, "CPU", options)
                        if compiled_models[name].get_property("INFERENCE_PRECISION_HINT") != ov.Type.f32:
                            compiled_models.pop(name)
                            raise RuntimeError("OpenVINO CPU did not honor FP32 inference precision")
                    compiled = compiled_models[name]
                    native.input_name = compiled.input().get_any_name()
                    mode = getattr(config, "openvino_request_mode", "shared")
                    if mode in {"independent", "async"}:
                        request = compiled.create_infer_request()
                        native.ov_compiled_model = OpenVINORequestAdapter(
                            compiled,
                            request,
                            native.input_name,
                            asynchronous=mode == "async",
                            timeout_ms=getattr(config, "openvino_request_timeout_ms", 5000),
                        )
                    else:
                        native.ov_compiled_model = compiled
                    # Ultralytics uses this only to choose its per-call async
                    # queue path. Dispatch is owned by OpenVINORequestAdapter.
                    native.inference_mode = "LATENCY"

    return ConfiguredCpuPredictor
