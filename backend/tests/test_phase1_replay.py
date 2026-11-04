"""Recorded synthetic frames + deterministic model outputs; no hardware/network.

This checks pipeline parity, not real-model accuracy or deployment performance.
"""

from copy import deepcopy
from types import SimpleNamespace
import threading

import cv2
import numpy as np

import camera as camera_module
from camera import CameraWorker
from detector import Detector, ModelSession
from test_camera import FakeDetector
from test_detector import FakeVector
from test_traffic_control import FakeSignalController, FakeTransactionWriter
from traffic_control import PointComparisonController
from traffic_transactions import TrafficTransactionManager
from vehicle_identity import GlobalVehicleRegistry


def test_recorded_replay_preserves_ids_annotations_counts_signals_and_completed_cycle(monkeypatch, tmp_path):
    path = tmp_path / "synthetic-road.avi"
    video = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 10, (120, 100))
    assert video.isOpened()
    for index in range(14):
        video.write(np.full((100, 120, 3), 80 + index, dtype=np.uint8))
    video.release()
    capture = cv2.VideoCapture(str(path))
    frames = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frames.append(frame)
    capture.release()
    assert len(frames) == 14

    def replay(viewer_aware, viewers, profiling):
        clock = [100.0]
        scheduler_clock = [0.0]
        monkeypatch.setattr(camera_module.time, "perf_counter", lambda: scheduler_clock[0])
        monkeypatch.setattr("traffic_transactions.time.monotonic", lambda: clock[0])
        monkeypatch.setattr("traffic_transactions.utc_timestamp", lambda: f"t-{clock[0]:.1f}")
        monkeypatch.setattr("scoring.utc_timestamp", lambda: f"t-{clock[0]:.1f}")
        monkeypatch.setattr("traffic_transactions.uuid.uuid4", lambda: SimpleNamespace(hex="fixed-test-id"))
        config = SimpleNamespace(
            confidence=0.5, image_size=640, detection_fps=10, line_counting=True,
            reconnect_seconds=0.01, viewer_aware_jpeg=viewer_aware, performance_profiling=profiling,
        )
        manager = TrafficTransactionManager()
        registry = GlobalVehicleRegistry()
        observations = []
        rendered = []
        positions = [5, 95]
        factory_index = [0]

        def factory(config, line, **kwargs):
            camera_index = factory_index[0]
            factory_index[0] += 1

            def track(*_args, **_kwargs):
                y = positions[camera_index]
                boxes = SimpleNamespace(
                    xyxy=FakeVector([[40, y - 5, 60, y + 5]]),
                    id=FakeVector([1]), cls=FakeVector([0]), conf=FakeVector([0.9]),
                )
                return [SimpleNamespace(boxes=boxes)]

            local = SimpleNamespace(names={0: "tricycle"}, track=lambda *_a, **_kw: [])
            coco = SimpleNamespace(names={0: "car"}, track=track)
            pool = SimpleNamespace(
                create_session=lambda name: ModelSession(
                    local if name == "local" else coco, threading.RLock(), [0]
                ),
                paths={"local": path, "coco": path}, errors={},
            )
            detector = Detector(config, line, model_pool=pool, vehicle_registry=registry)
            process = detector.process

            def observe_frame(frame):
                annotated, detections = process(frame)
                rendered.append(annotated.copy())
                return annotated, detections

            detector.process = observe_frame
            return detector

        monkeypatch.setattr(camera_module, "Detector", factory)

        def observe(camera_id, detections):
            observations.append((camera_id, deepcopy(detections)))
            manager.observe_detections(camera_id, detections)

        workers = [CameraWorker(
            camera_id, camera_id - 1, config, (0, 50, 120, 50),
            vehicle_registry=registry, detection_handler=observe, transaction_state_provider=manager.snapshot,
        ) for camera_id in (1, 2)]
        signals = FakeSignalController()
        writer = FakeTransactionWriter()

        def points():
            result = {}
            for node, worker in zip(("nodeA", "nodeB"), workers):
                vehicles, _ = worker.detector.incoming_ledger.snapshot()
                vehicles = manager.next_batch_candidates(node, vehicles)
                result[node] = {"ready": True, "vehicles": vehicles, "points": sum(v["points"] for v in vehicles)}
            return result

        controller = PointComparisonController(points, signals, transaction_manager=manager, transaction_writer=writer)
        incoming = [5, 20, 35, 60, 75, 85, 90, 95, 95, 95, 95, 95, 95, 95]
        outgoing = [95, 95, 95, 95, 95, 95, 95, 90, 75, 65, 50, 40, 30, 20]
        for index, frame in enumerate(frames):
            positions[:] = incoming[index], outgoing[index]
            clock[0] = 100 + index * 0.3
            for worker in workers:
                worker._viewer_count = viewers  # Presentation consumers only; no duplicate camera state.
                worker._raw_frame = frame.copy()
                worker._raw_version += 1
                worker._raw_captured_at = camera_module.time.perf_counter()
                worker._stop = threading.Event()

                def stop_after_sleep(seconds, current_worker=worker):
                    assert 0 < seconds <= 0.01
                    scheduler_clock[0] += seconds
                    current_worker.stop()

                monkeypatch.setattr(camera_module.time, "sleep", stop_after_sleep)
                worker.online = True
                observations_before = len(observations)
                rendered_before = len(rendered)
                worker._processing_loop()
                assert worker._stop.is_set()
                assert len(observations) == observations_before + 1
                assert len(rendered) == rendered_before + 1
            controller.evaluate_once()
        return observations, rendered, signals.commands, writer.payloads, workers

    baseline = replay(False, 0, False)
    assert len(baseline[3]) == 1
    assert baseline[3][0]["sourceRemaining"] == baseline[3][0]["destinationRemaining"] == 0
    assert baseline[4][0].detector.track_state.passed == 1
    for viewers in (0, 1, 2):
        optimized = replay(True, viewers, True)
        assert optimized[0] == baseline[0]  # Boxes, TIDs, GIDs, roles and crossing flags.
        assert optimized[2:4] == baseline[2:4]  # Exact fake signal commands and persistence payloads.
        assert all(np.array_equal(a, b) for a, b in zip(optimized[1], baseline[1]))
        assert optimized[4][0].detector.track_state.passed == 1
        assert optimized[4][0]._jpeg_version == (0 if viewers == 0 else len(frames))


def test_replay_worker_stops_cleanly_while_waiting_for_a_frame(monkeypatch):
    monkeypatch.setattr(camera_module, "Detector", FakeDetector)
    config = SimpleNamespace(detection_fps=10, line_counting=True, reconnect_seconds=0.01)
    worker = CameraWorker(1, 0, config, (0, 50, 120, 50))
    waiting = threading.Event()
    original_wait_for = worker._raw_condition.wait_for

    def wait_for(predicate, timeout=None):
        waiting.set()
        return original_wait_for(predicate, timeout)

    monkeypatch.setattr(worker._raw_condition, "wait_for", wait_for)
    worker._processing_thread = threading.Thread(target=worker._processing_loop, daemon=True)
    worker._processing_thread.start()
    try:
        assert waiting.wait(timeout=1), "Worker did not reach the frame wait"
        worker.stop()
        worker.wait_until_stopped(timeout=1)
        assert not worker._processing_thread.is_alive(), "Stopped worker failed to terminate"
        assert worker._raw_frame is None
    finally:
        worker.stop()
        worker.wait_until_stopped(timeout=1)
