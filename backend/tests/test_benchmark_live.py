from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest

from config import settings
from scripts import benchmark_live


def test_observation_settings_disable_hardware_without_changing_detection():
    original = replace(settings, esp32_control_enabled=True, esp32_heartbeat_enabled=True, traffic_firestore_enabled=True)
    observed = benchmark_live.observation_settings(original, [0])
    assert not observed.esp32_control_enabled
    assert not observed.esp32_heartbeat_enabled
    assert not observed.traffic_firestore_enabled
    assert observed.web_camera_index == 0 and observed.logi_c270_camera_index == -1
    assert observed.performance_profiling and observed.viewer_aware_jpeg
    for name in ("confidence", "image_size", "detection_fps", "camera_capture_fps", "line_counting", "line"):
        assert getattr(observed, name) == getattr(original, name)
    assert original.esp32_control_enabled and original.traffic_firestore_enabled


def test_hardware_and_upload_boundaries_are_blocked_even_if_called(monkeypatch):
    import camera
    import detector
    import traffic_control
    import traffic_transactions

    for module, name in (
        (camera, "CameraWorker"), (detector, "ModelPool"),
        (traffic_control, "Esp32SignalController"), (traffic_transactions, "FirestoreTransactionWriter"),
    ):
        monkeypatch.setattr(module, name, getattr(module, name))  # Restore all process-local substitutions after test.
    network = Mock(side_effect=AssertionError("network boundary reached"))
    monkeypatch.setattr(traffic_control, "urlopen", network)
    monkeypatch.setattr(traffic_transactions, "urlopen", network)
    benchmark_live.install_isolation()
    signals = traffic_control.Esp32SignalController("unused-a", "unused-b")
    with pytest.raises(RuntimeError, match="blocked"):
        signals._call("nodeA", "POST", "/command")
    writer = traffic_transactions.FirestoreTransactionWriter("http://unused")
    with pytest.raises(RuntimeError, match="blocked"):
        writer.write({})
    network.assert_not_called()


def test_probe_releases_camera_and_does_not_write_frames(monkeypatch):
    import cv2

    capture = Mock()
    capture.isOpened.return_value = True
    capture.read.return_value = (True, np.zeros((100, 120, 3), dtype=np.uint8))
    capture.get.return_value = 30
    monkeypatch.setattr(cv2, "VideoCapture", Mock(return_value=capture))
    save = Mock(side_effect=AssertionError("recording is prohibited"))
    monkeypatch.setattr(cv2, "imwrite", save)
    result = benchmark_live.probe_cameras([0])
    assert result == [{"usbIndex": 0, "available": True, "width": 120, "height": 100, "reportedCameraFps": 30}]
    capture.release.assert_called_once()
    save.assert_not_called()


def test_numeric_frame_recorder_is_bounded_and_attached_to_camera_worker(monkeypatch):
    import camera
    import detector
    import traffic_control
    import traffic_transactions

    for module, name in (
        (camera, "CameraWorker"), (detector, "ModelPool"),
        (traffic_control, "Esp32SignalController"), (traffic_transactions, "FirestoreTransactionWriter"),
    ):
        monkeypatch.setattr(module, name, getattr(module, name))
    monkeypatch.setattr(camera.CameraWorker, "__init__", lambda self: None)
    benchmark_live.install_isolation(diagnostics=True)
    worker = camera.CameraWorker()
    for index in range(300):
        worker._performance = {"processingMs": index}
    assert worker._performance == {"processingMs": 299}
    assert worker.benchmark_dropped_frames == 44
    assert len(worker.benchmark_drain_frames()) == 256
    assert worker.benchmark_drain_frames() == []


@pytest.mark.parametrize("diagnostics", [False, True])
def test_invalid_viewer_conditions_are_reported_instead_of_claiming_a_comparison(monkeypatch, diagnostics):
    import psutil
    import time

    clock = [0.0]
    monkeypatch.setattr(benchmark_live, "time", SimpleNamespace(
        perf_counter=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
        strftime=time.strftime, gmtime=time.gmtime,
    ))
    process = SimpleNamespace(cpu_percent=lambda: 100, memory_info=lambda: SimpleNamespace(rss=1048576))
    monkeypatch.setattr(psutil, "Process", lambda: process)
    monkeypatch.setattr(psutil, "cpu_percent", lambda: 25)
    worker = SimpleNamespace(source=0, benchmark_dropped_frames=0, benchmark_drain_frames=lambda: [
        {"completedMonotonic": clock[0] - .1, "localInferenceMs": 200},
        {"completedMonotonic": clock[0], "localInferenceMs": 12},
    ])
    monkeypatch.setattr(benchmark_live, "BackgroundProcessMonitor", lambda: SimpleNamespace(
        sample=lambda: {"topProcesses": []}, close=lambda: None,
    ))

    def sample(_worker):
        return {
            "online": True, "error": None, "resolution": [120, 100], "captureFrames": int(clock[0] * 30),
            "completedFrames": int(clock[0] * 10), "viewers": 0,
            "visibleVehicles": 0, "inferenceThreadTorchThreads": 8,
            "processingThreadAlive": True,
            "lastFrameTimings": {"localInferenceMs": 12}, "passed": 0,
        }

    monkeypatch.setattr(benchmark_live, "camera_sample", sample)
    report = benchmark_live.measure(SimpleNamespace(workers={1: worker}), 2, "both", None, diagnostics)
    assert report["validViewerCondition"] is False
    assert report["cameras"][1]["effectiveDetectionFps"] == 10
    assert report["cameras"][1]["effectiveCaptureFps"] == 30
    if diagnostics:
        assert report["cameras"][1]["perFrameTimings"]["localInferenceMs"]["p99"] == 200
        assert report["cameras"][1]["timingsLatestFrameSampledAt1Hz"]["localInferenceMs"]["p95"] == 12
