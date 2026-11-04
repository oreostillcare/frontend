import ast
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace

from scripts.benchmark_rtsp import Metrics, camera_details, worker_class


def test_camera_metadata_never_includes_credentials():
    details = camera_details("rtsp://private-user:private-secret@192.168.1.2:554/stream1")
    assert details == {"host": "192.168.1.2", "port": 554, "path": "/stream1", "scheme": "rtsp"}
    assert "private" not in json.dumps(details)


def test_numeric_observer_records_consumed_version_without_replacing_camera_loop(monkeypatch):
    class Base:
        def __init__(self):
            self._processing_thread = None
            self._raw_version = 0
            self._performance = {}
            self.detector = SimpleNamespace(process=lambda frame: (frame, []))

    monkeypatch.setitem(sys.modules, "camera", SimpleNamespace(CameraWorker=Base))
    worker = worker_class()()
    worker._raw_version = 5
    assert worker._raw_version == 5 and worker.consumed_version == 0
    worker._processing_thread = threading.current_thread()
    assert worker._raw_version == 5 and worker.consumed_version == 5
    worker.recording = True
    worker._performance = {"processingMs": 30, "localInferenceMs": 10, "cocoInferenceMs": 12}
    result = worker.drain()
    assert worker.completed == 1 and result[0]["sourceVersion"] == 5
    assert result[0]["totalInferenceMs"] == 22
    assert worker.drain() == []


def test_compact_metrics_exclude_images_and_keep_latency_tail():
    metric = Metrics()
    for value in [10] * 98 + [100, 200]:
        metric.add("processingMs", value)
    metric.add("image", b"no image storage")
    result = metric.summary()
    assert "image" not in result
    assert result["processingMs"]["p99"] == 100 and result["processingMs"]["max"] == 200


def test_rtsp_benchmark_does_not_import_startup_or_external_actuation_modules():
    source = Path(__file__).parents[1] / "scripts/benchmark_rtsp.py"
    tree = ast.parse(source.read_text())
    forbidden = {"app", "flask", "traffic_control", "traffic_transactions", "firebase_admin"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert not {alias.name.split(".")[0] for alias in node.names} & forbidden
        elif isinstance(node, ast.ImportFrom):
            assert (node.module or "").split(".")[0] not in forbidden
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            assert node.func.attr not in {"imshow", "imwrite", "VideoWriter"}
