from collections import defaultdict, deque
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import detector as detector_module
from detector import (
    CLASS_LOCK_OBSERVATIONS,
    COCO_TRACK_ID_OFFSET,
    Detector,
    box_iou,
)


def bare_detector():
    instance = Detector.__new__(Detector)
    instance.class_history = defaultdict(lambda: deque(maxlen=CLASS_LOCK_OBSERVATIONS))
    instance.locked_classes = {}
    instance.class_last_seen = {}
    instance.frame_index = 0
    return instance


@pytest.mark.parametrize(
    ("first", "second", "expected"),
    [
        ([0, 0, 10, 10], [0, 0, 10, 10], 1.0),
        ([0, 0, 10, 10], [5, 5, 15, 15], 25 / 175),
        ([0, 0, 10, 10], [10, 0, 20, 10], 0.0),
        ([0, 0, 10, 10], [20, 20, 30, 30], 0.0),
        ([0, 0, 0, 10], [0, 0, 0, 10], 0.0),
    ],
)
def test_box_iou_boundaries(first, second, expected):
    assert box_iou(first, second) == pytest.approx(expected)
    assert box_iou(second, first) == pytest.approx(expected)


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


def test_locked_class_overrides_later_observations():
    instance = bare_detector()
    instance.locked_classes[4] = "bus"
    instance.frame_index = 8
    item = {"trackId": 4, "class": "truck"}

    instance.stabilize_classes([item])

    assert item["class"] == "bus"
    assert list(instance.class_history[4]) == []


def test_class_state_is_independent_for_each_track():
    instance = bare_detector()
    instance.frame_index = 1
    detections = [
        {"trackId": 1, "class": "car"},
        {"trackId": 2, "class": "bus"},
    ]

    instance.stabilize_classes(detections)

    assert list(instance.class_history[1]) == ["car"]
    assert list(instance.class_history[2]) == ["bus"]


def test_stale_class_state_is_removed_after_150_frames():
    instance = bare_detector()
    instance.frame_index = 1
    instance.stabilize_classes([{"trackId": 9, "class": "car"}])
    instance.locked_classes[9] = "car"

    instance.frame_index = 151
    instance.stabilize_classes([])
    assert 9 in instance.class_history

    instance.frame_index = 152
    instance.stabilize_classes([])
    assert 9 not in instance.class_history
    assert 9 not in instance.locked_classes
    assert 9 not in instance.class_last_seen


class FakeVector:
    def __init__(self, values):
        self.values = values

    def cpu(self):
        return self

    def int(self):
        return self

    def tolist(self):
        return self.values


def test_tracked_detections_filters_classes_and_maps_model_output():
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
    instance = bare_detector()
    instance.config = SimpleNamespace(confidence=0.35, image_size=640)

    detections = instance.tracked_detections(
        model,
        frame="frame",
        class_ids=[0, 1, 2],
        allowed={"car", "bus"},
        track_offset=COCO_TRACK_ID_OFFSET,
    )

    model.track.assert_called_once_with(
        "frame",
        persist=True,
        tracker="bytetrack.yaml",
        classes=[0, 1, 2],
        conf=0.35,
        imgsz=640,
        verbose=False,
    )
    assert detections == [
        {
            "trackId": COCO_TRACK_ID_OFFSET + 3,
            "class": "car",
            "confidence": 0.877,
            "boundingBox": [0, 1, 10, 13],
            "centerPoint": [5, 7],
        },
        {
            "trackId": COCO_TRACK_ID_OFFSET + 5,
            "class": "bus",
            "confidence": 0.555,
            "boundingBox": [40, 10, 60, 30],
            "centerPoint": [50, 20],
        },
    ]


@pytest.mark.parametrize(
    "boxes",
    [None, SimpleNamespace(id=None)],
)
def test_tracked_detections_ignores_results_without_track_ids(boxes):
    model = SimpleNamespace(names={}, track=Mock(return_value=[SimpleNamespace(boxes=boxes)]))
    instance = bare_detector()
    instance.config = SimpleNamespace(confidence=0.35, image_size=640)

    assert instance.tracked_detections(model, "frame", [], set()) == []


def test_process_returns_unchanged_frame_when_model_is_unavailable():
    instance = bare_detector()
    instance.model = None
    frame = object()

    rendered, detections = instance.process(frame)

    assert rendered is frame
    assert detections == []
    assert instance.frame_index == 0


def test_process_merges_models_and_suppresses_overlapping_coco_boxes(monkeypatch):
    instance = bare_detector()
    instance.config = SimpleNamespace(confidence=0.35, image_size=640, line_counting=True)
    instance.model = object()
    instance.coco_model = object()
    instance.model_type = "custom"
    instance.use_coco_fallback = True
    instance.allowed_class_ids = [1]
    instance.coco_class_ids = [2]
    instance.track_state = SimpleNamespace(line=(0, 50, 100, 50), passed=0, update=Mock())
    calls = []

    def tracked(model, frame, class_ids, allowed, track_offset=0, confidence=None):
        calls.append((model, class_ids, track_offset, confidence))
        if model is instance.model:
            return [
                {
                    "trackId": 1,
                    "class": "etrike",
                    "confidence": 0.8,
                    "boundingBox": [0, 0, 10, 10],
                    "centerPoint": [5, 5],
                }
            ]
        return [
            {
                "trackId": COCO_TRACK_ID_OFFSET + 1,
                "class": "car",
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
    assert [item["trackId"] for item in detections] == [1, COCO_TRACK_ID_OFFSET + 2]
    assert calls[0][2:] == (0, 0.12)
    assert calls[1][2:] == (COCO_TRACK_ID_OFFSET, 0.35)
    instance.track_state.update.assert_called_once_with(detections)
    detector_module.cv2.line.assert_called_once()

