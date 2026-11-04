"""Camera-free FP32 numerical and detection-pipeline checks, never hardware/control."""

import json
import os
from dataclasses import replace
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("YOLO_CONFIG_DIR", str(ROOT / "runs/phase3"))


def main():
    import cv2
    import numpy as np
    import openvino as ov
    import torch
    from ultralytics import YOLO
    from ultralytics.utils import ASSETS
    from config import settings
    from detector import Detector, ModelPool
    from openvino_artifacts import validate_export
    from vehicle_identity import GlobalVehicleRegistry

    torch.set_num_threads(2)
    report = {"rawTensorChecks": [], "pipelineChecks": [], "accuracyValidated": False}
    for name in ("local", "coco"):
        checkpoint = getattr(settings, f"{name}_yolo_model")
        artifact = getattr(settings, f"{name}_openvino_model")
        validate_export(artifact, checkpoint, settings.image_size)
        native = YOLO(str(checkpoint)).model.float().fuse(verbose=False).eval()
        compiled = ov.Core().compile_model(str(next(artifact.glob("*.xml"))), "CPU", {
            "INFERENCE_PRECISION_HINT": ov.Type.f32, "INFERENCE_NUM_THREADS": 2, "NUM_STREAMS": 1,
        })
        for height, width in ((480, 640), (640, 480), (640, 640)):
            image = torch.rand((1, 3, height, width), generator=torch.Generator().manual_seed(42))
            with torch.inference_mode():
                expected = native(image)
            if isinstance(expected, tuple):
                expected = expected[0]
            expected = expected.cpu().numpy()
            actual = next(iter(compiled(image.numpy()).values()))
            np.testing.assert_allclose(actual, expected, rtol=1e-3, atol=1e-3)
            report["rawTensorChecks"].append({
                "model": name, "input": [height, width], "maxAbsoluteError": float(np.max(np.abs(actual - expected))),
                "rtol": 1e-3, "atol": 1e-3, "passed": True,
            })

    image = cv2.imread(str(ASSETS / "bus.jpg"))
    if image is None:
        raise RuntimeError("Installed Ultralytics bus.jpg test asset is unavailable")
    results = {}
    preprocessing = {}
    for backend in ("pytorch", "openvino"):
        config = replace(settings, inference_backend=backend, cpu_inference_threads=2,
                         openvino_threads=2, openvino_streams=1)
        pool = ModelPool(config)
        if not pool.online:
            raise RuntimeError(pool.status())
        detector = Detector(config, config.line, model_pool=pool, vehicle_registry=GlobalVehicleRegistry())
        detector.camera_id = 1
        sequence = []
        for offset in (0, 12, 24, 36, 48):
            translated = cv2.warpAffine(image, np.float32([[1, 0, 0], [0, 1, offset]]), (image.shape[1], image.shape[0]))
            _, detections = detector.process(translated.copy())
            sequence.append(detections)
        results[backend] = sequence
        preprocessing[backend] = detector.coco_session.model.predictor.preprocess([image]).cpu().numpy()
        if backend == "openvino":
            # A second test-image session checks isolation; it is not a second road observation.
            second = Detector(config, config.line, model_pool=pool, vehicle_registry=GlobalVehicleRegistry())
            second.camera_id = 2
            second.process(image.copy())
            for name in ("local", "coco"):
                first_model = getattr(detector, f"{name}_session").model
                second_model = getattr(second, f"{name}_session").model
                assert first_model.predictor is not second_model.predictor
                assert first_model.callbacks is not second_model.callbacks
                assert first_model.predictor.trackers[0] is not second_model.predictor.trackers[0]
                assert (first_model.predictor.model.backend.ov_compiled_model is
                        second_model.predictor.model.backend.ov_compiled_model)
            report["openvinoSessionIsolation"] = True
    np.testing.assert_array_equal(preprocessing["pytorch"], preprocessing["openvino"])
    positive_detections = 0
    for frame_index, (expected, actual) in enumerate(zip(results["pytorch"], results["openvino"])):
        assert len(expected) == len(actual), (frame_index, expected, actual)
        expected = sorted(expected, key=lambda item: item["trackId"])
        actual = sorted(actual, key=lambda item: item["trackId"])
        for left, right in zip(expected, actual):
            positive_detections += 1
            for key in ("class", "trackId", "vehicleId", "trafficRole", "greenTransition", "redTransition",
                        "redLineTouched", "outgoingRouteTransition", "inTrafficZone"):
                assert left.get(key) == right.get(key), (frame_index, key, left, right)
            np.testing.assert_allclose(left["boundingBox"], right["boundingBox"], rtol=0, atol=1)
            assert abs(left["confidence"] - right["confidence"]) <= .001
        report["pipelineChecks"].append({"frame": frame_index, "detections": len(actual), "passed": True})
    assert positive_detections > 0, "Positive detection parity was not exercised"
    report["preprocessingIdentical"] = True
    report["scope"] = "FP32 tensor parity and translated packaged bus.jpg; not Philippine traffic accuracy"
    output = ROOT / "runs/phase3/backend-parity.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
