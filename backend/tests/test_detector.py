import sys
import threading
from collections import defaultdict, deque
from types import SimpleNamespace
from unittest.mock import Mock, call

import pytest

import detector as detector_module
from detector import (
    CLASS_LOCK_OBSERVATIONS,
    COCO_TRACK_ID_OFFSET,
    COCO_VEHICLES,
    LOCAL_VEHICLES,
    VEHICLE_CLASSES,
    Detector,
    ModelPool,
    ModelSession,
    box_iou,
)


def bare_detector():
    instance = Detector.__new__(Detector)
    instance.class_history = defaultdict(lambda: deque(maxlen=CLASS_LOCK_OBSERVATIONS))
    instance.locked_classes = {}
    instance.class_last_seen = {}
    instance.frame_index = 0
    return instance


def fake_yolo(names):
    return SimpleNamespace(
        names=names,
        predictor=None,
        callbacks={"on_predict_start": [], "on_predict_postprocess_end": []},
        overrides={},
        shared_weights=object(),
    )


def test_model_pool_loads_only_the_two_selected_checkpoints(monkeypatch, tmp_path):
    local_path = tmp_path / "trained_local.pt"
    coco_path = tmp_path / "yolov8n.pt"
    local_path.write_bytes(b"local")
    coco_path.write_bytes(b"coco")
    local_model = fake_yolo({0: "tricycle", 1: "ebike", 2: "jeepney"})
    coco_model = fake_yolo({0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"})
    yolo = Mock(side_effect=[local_model, coco_model])
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(YOLO=yolo))
    config = SimpleNamespace(local_yolo_model=local_path, coco_yolo_model=coco_path)

    pool = ModelPool(config)

    assert yolo.call_args_list == [call(str(local_path)), call(str(coco_path))]
    assert pool.class_ids == {"local": [0, 1, 2], "coco": [1, 2, 3, 5, 7]}
    assert pool.online is True


def test_model_sessions_share_weights_but_not_predictors(monkeypatch, tmp_path):
    local_path = tmp_path / "trained_local.pt"
    coco_path = tmp_path / "yolov8n.pt"
    local_path.write_bytes(b"local")
    coco_path.write_bytes(b"coco")
    local_model = fake_yolo({0: "tricycle", 1: "ebike", 2: "jeepney"})
    coco_model = fake_yolo({1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"})
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(YOLO=Mock(side_effect=[local_model, coco_model])))
    pool = ModelPool(SimpleNamespace(local_yolo_model=local_path, coco_yolo_model=coco_path))

    first = pool.create_session("local")
    second = pool.create_session("local")

    assert first.model is not second.model
    assert first.model.shared_weights is second.model.shared_weights
    assert first.model.predictor is None
    assert second.model.predictor is None
    assert first.inference_lock is second.inference_lock


def test_active_vehicle_classes_exclude_etrike_and_unrelated_coco_classes():
    assert VEHICLE_CLASSES == {
        "car",
        "motorcycle",
        "truck",
        "bicycle",
        "bus",
        "ebike",
        "jeepney",
        "tricycle",
    }
    assert "etrike" not in VEHICLE_CLASSES


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [
        ([0, 0, 10, 10], [0, 0, 10, 10], 1.0),
        ([0, 0, 10, 10], [5, 5, 15, 15], 25 / 175),
        ([0, 0, 10, 10], [10, 0, 20, 10], 0.0),
    ],
)
def test_box_iou_boundaries(first, second, expected):
    assert box_iou(first, second) == pytest.approx(expected)


def test_class_stabilization_uses_running_majority_then_locks():
    instance = bare_detector()
    observed = ["car", "truck", "car", "truck", "car"]
    displayed = []
    for frame_index, class_name in enumerate(observed, start=1):
        instance.frame_index = frame_index
        item = {"trackId": 10, "class": class_name}
        instance.stabilize_classes([item])
        displayed.append(item["class"])
    assert displayed == ["car", "car", "car", "car", "car"]
    assert instance.locked_classes[10] == "car"


class FakeVector:
    def __init__(self, values):
        self.values = values

    def cpu(self):
        return self

    def int(self):
        return self

    def tolist(self):
        return self.values


def test_tracked_detections_filters_to_the_session_allowlist():
    boxes = SimpleNamespace(
        xyxy=FakeVector([[0.2, 1.8, 10.9, 13.1], [20, 20, 30, 30], [40, 10, 60, 30]]),
        id=FakeVector([3, 4, 5]),
        cls=FakeVector([0, 1, 2]),
        conf=FakeVector([0.87654, 0.99, 0.5549]),
    )
    model = SimpleNamespace(
        names={0: "car", 1: "person", 2: "bus"},
        track=Mock(return_value=[SimpleNamespace(boxes=boxes)]),
    )
    session = ModelSession(model=model, inference_lock=threading.RLock(), class_ids=[0, 2])
    instance = bare_detector()
    instance.config = SimpleNamespace(confidence=0.35, image_size=640)

    detections = instance.tracked_detections(session, "frame", {"car", "bus"}, COCO_TRACK_ID_OFFSET)

    model.track.assert_called_once_with(
        "frame",
        persist=True,
        tracker="bytetrack.yaml",
        classes=[0, 2],
        conf=0.35,
        imgsz=640,
        verbose=False,
    )
    assert [item["class"] for item in detections] == ["car", "bus"]
    assert [item["trackId"] for item in detections] == [COCO_TRACK_ID_OFFSET + 3, COCO_TRACK_ID_OFFSET + 5]


def test_process_returns_unchanged_frame_when_both_models_are_unavailable():
    instance = bare_detector()
    instance.local_session = None
    instance.coco_session = None
    frame = object()
    rendered, detections = instance.process(frame)
    assert rendered is frame
    assert detections == []
    assert instance.frame_index == 0


def test_process_merges_local_and_coco_and_suppresses_overlap(monkeypatch):
    instance = bare_detector()
    instance.config = SimpleNamespace(confidence=0.35, image_size=640, line_counting=True)
    instance.local_session = ModelSession(object(), threading.RLock(), [0, 1, 2])
    instance.coco_session = ModelSession(object(), threading.RLock(), [1, 2, 3, 5, 7])
    instance.track_state = SimpleNamespace(line=(0, 50, 100, 50), passed=0, update=Mock())

    def tracked(session, frame, allowed, track_offset=0, confidence=None):
        if allowed == LOCAL_VEHICLES:
            return [
                {
                    "trackId": 1,
                    "class": "tricycle",
                    "confidence": 0.8,
                    "boundingBox": [0, 0, 10, 10],
                    "centerPoint": [5, 5],
                }
            ]
        assert allowed == COCO_VEHICLES
        return [
            {
                "trackId": COCO_TRACK_ID_OFFSET + 1,
                "class": "motorcycle",
                "confidence": 0.9,
                "boundingBox": [1, 1, 9, 9],
                "centerPoint": [5, 5],
            },
            {
                "trackId": COCO_TRACK_ID_OFFSET + 2,
                "class": "bus",
                "confidence": 0.7,
                "boundingBox": [20, 20, 30, 30],
                "centerPoint": [25, 25],
            },
        ]

    instance.tracked_detections = tracked
    monkeypatch.setattr(detector_module.cv2, "rectangle", Mock())
    monkeypatch.setattr(detector_module.cv2, "putText", Mock())
    monkeypatch.setattr(detector_module.cv2, "line", Mock())

    frame = object()
    rendered, detections = instance.process(frame)

    assert rendered is frame
    assert [item["class"] for item in detections] == ["tricycle", "bus"]
    instance.track_state.update.assert_called_once_with(detections)
