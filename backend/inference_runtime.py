"""Optional predictor setup; leaves Ultralytics preprocessing, NMS and tracking intact."""

import threading


def predictor_factory(config, compiled_models: dict, compiled_lock: threading.RLock, name: str):
    from ultralytics.models.yolo.detect import DetectionPredictor

    threads = getattr(config, "cpu_inference_threads", 0)
    backend_name = getattr(config, "inference_backend", "pytorch")

    class ConfiguredCpuPredictor(DetectionPredictor):
        def setup_model(self, model=None, verbose=True):
            super().setup_model(model=model, verbose=verbose)
            # select_device() resets the CPU budget during lazy predictor setup.
            # Apply our opt-in budget afterwards, in the actual inference thread.
            if threads:
                import torch

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
                        options = {"PERFORMANCE_HINT": "LATENCY", "INFERENCE_PRECISION_HINT": ov.Type.f32}
                        if config.openvino_threads:
                            options["INFERENCE_NUM_THREADS"] = config.openvino_threads
                        if config.openvino_streams:
                            options["NUM_STREAMS"] = config.openvino_streams
                        compiled_models[name] = core.compile_model(graph, "CPU", options)
                        if compiled_models[name].get_property("INFERENCE_PRECISION_HINT") != ov.Type.f32:
                            compiled_models.pop(name)
                            raise RuntimeError("OpenVINO CPU did not honor FP32 inference precision")
                    native.ov_compiled_model = compiled_models[name]
                    native.input_name = native.ov_compiled_model.input().get_any_name()
                    native.inference_mode = "LATENCY"

    return ConfiguredCpuPredictor
