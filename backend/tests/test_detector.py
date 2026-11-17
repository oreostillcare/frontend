import sys
import threading
from collections import defaultdict, deque
from types import SimpleNamespace
from unittest.mock import Mock, call

import pytest

from modules.live_monitoring import vehicle_detector as detector_module
from modules.live_monitoring.vehicle_detector import (
    CLASS_LOCK_OBSERVATIONS,
    COCO_TRACK_ID_OFFSET,
    COCO_VEHICLES,
    LOCAL_VEHICLES,
    VEHICLE_CLASSES,
    Detector,
    ModelPool,
    ModelSession,
    box_iou,
    draw_annotation_text,
    draw_vehicle_trail,
    vehicle_label_lines,
)
from modules.live_monitoring.inference_performance import StageProfiler


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


@pytest.mark.parametrize("mode", ["independent", "async"])
def test_openvino_request_flags_do_not_change_pytorch_model_locks(monkeypatch, tmp_path, mode):
    local_path = tmp_path / "trained_local.pt"
    coco_path = tmp_path / "yolov8n.pt"
    local_path.write_bytes(b"local")
    coco_path.write_bytes(b"coco")
    model = fake_yolo({0: "tricycle", 1: "ebike", 2: "jeepney"})
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(YOLO=Mock(return_value=model)))
    config = SimpleNamespace(
        local_yolo_model=local_path,
        coco_yolo_model=coco_path,
        openvino_request_mode=mode,
    )
    pool = ModelPool(config, load_coco=False)

    first = pool.create_session("local")
    second = pool.create_session("local")

    assert first.inference_lock is second.inference_lock


@pytest.mark.parametrize("mode", ["independent", "async"])
def test_openvino_independent_modes_use_one_lock_per_session(monkeypatch, tmp_path, mode):
    monkeypatch.setitem(
        sys.modules,
        "ultralytics.models.yolo.detect",
        SimpleNamespace(DetectionPredictor=type("Predictor", (), {})),
    )
    config = SimpleNamespace(
        inference_backend="openvino",
        local_yolo_model=tmp_path / "source.pt",
        coco_yolo_model=tmp_path / "coco.pt",
        local_openvino_model=tmp_path / "local-export",
        coco_openvino_model=tmp_path / "coco-export",
        image_size=640,
        openvino_request_mode=mode,
    )
    pool = ModelPool(config, load_local=False, load_coco=False)
    pool.models["local"] = fake_yolo({0: "tricycle", 1: "ebike", 2: "jeepney"})
    pool.class_ids["local"] = [0, 1, 2]

    first = pool.create_session("local")
    second = pool.create_session("local")

    assert first.inference_lock is not second.inference_lock


def test_openvino_pool_selects_export_directories_without_source_checkpoints(monkeypatch, tmp_path):
    local_path = tmp_path / "trained_local.pt"
    coco_path = tmp_path / "yolov8n.pt"
    local_export = tmp_path / "trained_local_openvino_model"
    coco_export = tmp_path / "yolov8n_openvino_model"
    local_names = {0: "tricycle", 1: "ebike", 2: "jeepney"}
    coco_names = {1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
    yolo = Mock(side_effect=[fake_yolo(local_names), fake_yolo(coco_names)])
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(YOLO=yolo))
    monkeypatch.setattr("modules.live_monitoring.openvino_model_artifacts.validate_export", Mock(side_effect=[local_names, coco_names]))
    config = SimpleNamespace(
        inference_backend="openvino",
        local_yolo_model=local_path,
        coco_yolo_model=coco_path,
        local_openvino_model=local_export,
        coco_openvino_model=coco_export,
        image_size=640,
    )

    pool = ModelPool(config)

    assert pool.online is True
    assert yolo.call_args_list == [
        call(str(local_export), task="detect"),
        call(str(coco_export), task="detect"),
    ]
    assert pool.status()["local"]["weights"] == local_export.name
    assert pool.status()["coco"]["weights"] == coco_export.name
    assert pool.runtime_path("local") == local_export
    assert pool.runtime_path("coco") == coco_export


def test_openvino_cpu_budget_is_set_before_ultralytics_load_and_keeps_cpu_device(monkeypatch, tmp_path):
    calls = []
    local_names = {0: "tricycle", 1: "ebike", 2: "jeepney"}
    model = fake_yolo(local_names)
    model.overrides["device"] = "intel:cpu"

    def load_yolo(path, **kwargs):
        calls.append(("yolo", path))
        return model

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(set_num_threads=lambda count: calls.append(("threads", count))))
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(YOLO=load_yolo))
    monkeypatch.setattr("modules.live_monitoring.openvino_model_artifacts.validate_export", Mock(return_value=local_names))
    class Predictor:
        pass
    monkeypatch.setitem(sys.modules, "ultralytics.models.yolo.detect", SimpleNamespace(DetectionPredictor=Predictor))
    config = SimpleNamespace(
        inference_backend="openvino", cpu_inference_threads=2, openvino_threads=0, openvino_streams=0,
        local_yolo_model=tmp_path / "source.pt", coco_yolo_model=tmp_path / "coco.pt",
        local_openvino_model=tmp_path / "local-export", coco_openvino_model=tmp_path / "coco-export",
        image_size=640,
    )

    pool = ModelPool(config, load_coco=False)
    session = pool.create_session("local")

    assert calls == [("threads", 2), ("yolo", str(config.local_openvino_model))]
    assert session.model.overrides["device"] == "intel:cpu"


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


def test_annotation_text_draws_cyan_without_outline(monkeypatch):
    put_text = Mock()
    monkeypatch.setattr(detector_module.cv2, "putText", put_text)
    frame = object()

    draw_annotation_text(frame, "GID:VEH-0001", (10, 20), 0.5, 1)

    put_text.assert_called_once()
    assert put_text.call_args.args[5:7] == ((255, 255, 0), 1)


def test_vehicle_trail_connects_centroid_history(monkeypatch):
    draw_line = Mock()
    monkeypatch.setattr(detector_module.cv2, "line", draw_line)

    draw_vehicle_trail(object(), [(10, 10), (12, 20), (14, 30)])

    assert draw_line.call_count == 2
    assert draw_line.call_args_list[0].args[1:3] == ((10, 10), (12, 20))
    assert draw_line.call_args_list[1].args[1:3] == ((12, 20), (14, 30))


def test_vehicle_label_separates_detection_details_into_two_lines():
    item = {
        "trackId": COCO_TRACK_ID_OFFSET + 39,
        "class": "car",
        "confidence": 0.639,
        "trafficRole": "INCOMING",
        "vehicleId": "VEH-0001",
    }

    assert vehicle_label_lines(item) == ("CAR  I  0.64", "TID:39  GID:VEH-0001")


def test_outgoing_vehicle_label_does_not_show_gid():
    item = {
        "trackId": 39,
        "class": "car",
        "confidence": 0.639,
        "trafficRole": "OUTGOING",
        "vehicleId": None,
    }

    assert vehicle_label_lines(item) == ("CAR  O  0.64", "TID:39")


def test_vehicle_label_reports_completed_red_crossing():
    item = {
        "trackId": 39,
        "class": "car",
        "confidence": 0.639,
        "trafficRole": "INCOMING",
        "vehicleId": "VEH-0001",
        "redCrossed": True,
    }

    assert vehicle_label_lines(item)[2] == "RED: CROSSED"


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


def test_optional_model_profile_keeps_inference_arguments_and_reports_result_speed():
    instance = bare_detector()
    instance.profiler = StageProfiler(True)
    instance.config = SimpleNamespace(confidence=0.5, image_size=640)
    model = SimpleNamespace(track=Mock(return_value=[SimpleNamespace(
        boxes=None, speed={"preprocess": 2.0, "inference": 12.5, "postprocess": 3.0}
    )]))
    session = ModelSession(model, threading.RLock(), [0])
    instance.local_session = session
    assert instance.tracked_detections(session, "frame", LOCAL_VEHICLES) == []
    assert instance.profiler.snapshot()["localInferenceMs"] == 12.5
    assert instance.profiler.snapshot()["localPreprocessMs"] == 2.0
    assert instance.profiler.snapshot()["localPostprocessMs"] == 3.0
    assert instance.profiler.snapshot()["localLockWaitMs"] >= 0
    assert instance.profiler.snapshot()["localTrackCallMs"] >= 0
    model.track.assert_called_once_with(
        "frame", persist=True, tracker="bytetrack.yaml", classes=[0], conf=0.5, imgsz=640, verbose=False
    )


def test_optional_model_profile_sums_stage_timings_across_results():
    instance = bare_detector()
    instance.profiler = StageProfiler(True)
    instance.config = SimpleNamespace(confidence=0.5, image_size=640)
    model = SimpleNamespace(track=Mock(return_value=[
        SimpleNamespace(boxes=None, speed={"preprocess": 1, "inference": 4, "postprocess": 2}),
        SimpleNamespace(boxes=None, speed={"preprocess": 3, "inference": 5, "postprocess": 6}),
    ]))
    session = ModelSession(model, threading.RLock(), [0])
    instance.local_session = session

    instance.tracked_detections(session, "frame", LOCAL_VEHICLES)

    assert instance.profiler.snapshot() == {
        "localLockWaitMs": instance.profiler.snapshot()["localLockWaitMs"],
        "localTrackCallMs": instance.profiler.snapshot()["localTrackCallMs"],
        "localPreprocessMs": 4,
        "localInferenceMs": 9,
        "localPostprocessMs": 8,
    }


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


def test_reset_tracking_state_clears_camera_state_and_predictor_tracker():
    detector = bare_detector()
    from modules.live_monitoring.vehicle_tracking import TrackState
    from modules.traffic_decision.scoring import IncomingVehicleLedger

    tracker = Mock()
    predictor = SimpleNamespace(trackers=[tracker])
    session_model = SimpleNamespace(predictor=predictor)
    detector.track_state = TrackState((0, 1, 10, 1), True)
    detector.track_state.passed = 3
    detector.incoming_ledger = IncomingVehicleLedger()
    detector.local_session = ModelSession(session_model, Mock(), [], None)
    detector.coco_session = None
    detector.class_history[9].append("car")
    detector.locked_classes[9] = "car"
    detector.class_last_seen[9] = 1
    detector.frame_index = 5

    detector.reset_tracking_state()

    assert detector.track_state.passed == 0
    assert detector.frame_index == 0
    assert not detector.class_history and not detector.locked_classes and not detector.class_last_seen
    tracker.reset.assert_called_once_with()
    assert session_model.predictor is predictor


def test_bytetracker_construction_and_reset_preserve_global_id_counter(monkeypatch):
    import ultralytics.trackers.track as tracker_module
    from ultralytics.trackers.basetrack import BaseTrack
    from modules.live_monitoring.vehicle_detector import install_monotonic_byte_tracker

    install_monotonic_byte_tracker()
    tracker_class = tracker_module.TRACKER_MAP["bytetrack"]
    previous_count = BaseTrack._count
    try:
        BaseTrack._count = 42
        first = tracker_class(args=SimpleNamespace(track_buffer=30))
        second = tracker_class(args=SimpleNamespace(track_buffer=30))
        assert BaseTrack._count == 42
        first.tracked_stracks.append(object())
        first.reset()
        assert first.tracked_stracks == []
        assert first.frame_id == 0
        assert BaseTrack._count == 42
        BaseTrack.next_id()
        assert BaseTrack._count == 43
        assert second.tracked_stracks == []
    finally:
        BaseTrack._count = previous_count
