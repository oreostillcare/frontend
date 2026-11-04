"""Isolated RTSP observation benchmark: no app import, servers, callbacks or footage."""

import argparse
from array import array
from collections import deque
from dataclasses import replace
import csv
import json
import os
from pathlib import Path
import platform
import sys
import threading
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class Metrics:
    """Compact numeric distributions; never retains camera images."""

    def __init__(self):
        self.values = {}

    def add(self, name, value):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            self.values.setdefault(name, array("d")).append(value)

    def summary(self):
        from scripts.benchmark_video import stats
        return {name: stats(values) for name, values in self.values.items()}


def camera_details(source):
    parsed = urlparse(source)
    return {"host": parsed.hostname, "port": parsed.port or 554, "path": parsed.path, "scheme": parsed.scheme}


def connections(host):
    import psutil
    return [{"pid": item.pid, "status": item.status, "remotePort": item.raddr.port}
            for item in psutil.net_connections(kind="tcp")
            if item.raddr and item.raddr.ip == host and item.raddr.port == 554
            and item.status in {"ESTABLISHED", "SYN_SENT", "SYN_RECV"}]


def worker_class():
    from camera import CameraWorker

    class ObservedWorker(CameraWorker):
        def __init__(self, *args, **kwargs):
            self.recording = False
            self.records = deque(maxlen=256)
            self.record_lock = threading.Lock()
            self.record_drops = 0
            self.completed = 0
            self.consumed_version = 0
            self.latest_performance = {}
            self.detection_count = 0
            self.capture_metrics = Metrics()
            self.open_attempts = self.open_successes = self.read_failures = self.read_exceptions = 0
            self.offline_transitions = 0
            self.capture_metadata = {}
            super().__init__(*args, **kwargs)
            process = self.detector.process

            def observed_process(frame):
                result = process(frame)
                self.detection_count = len(result[1])
                return result

            self.detector.process = observed_process

        @property
        def _raw_version(self):
            value = self.raw_version_value
            # The production processing loop reads this under its raw-buffer lock
            # after copying the exact frame it will process. Capture/main reads do
            # not update this observation. No scheduler or frame-buffer changes.
            if threading.current_thread() is self._processing_thread:
                self.consumed_version = value
            return value

        @_raw_version.setter
        def _raw_version(self, value):
            self.raw_version_value = value

        @property
        def _performance(self):
            return self.latest_performance

        @_performance.setter
        def _performance(self, value):
            self.latest_performance = value
            if "processingMs" in value:
                self.completed += 1
                if self.recording:
                    with self.record_lock:
                        if len(self.records) == self.records.maxlen:
                            self.record_drops += 1
                        self.records.append({"completedAt": time.perf_counter(), "sourceVersion": self.consumed_version,
                                             "detections": self.detection_count,
                                             "totalInferenceMs": value.get("localInferenceMs", 0) + value.get("cocoInferenceMs", 0), **value})

        def drain(self):
            with self.record_lock:
                result = list(self.records)
                self.records.clear()
                return result

        def _mark_offline(self, error):
            if self.recording and self.online:
                self.offline_transitions += 1
            super()._mark_offline(error)

        def _open_capture(self):
            self.open_attempts += 1
            capture = super()._open_capture()
            worker = self

            class Probe:
                def __getattr__(self, name):
                    return getattr(capture, name)

                def isOpened(self):
                    opened = capture.isOpened()
                    if opened:
                        import cv2
                        worker.open_successes += 1
                        worker.capture_metadata = {"reportedFps": capture.get(cv2.CAP_PROP_FPS),
                                                   "width": capture.get(cv2.CAP_PROP_FRAME_WIDTH),
                                                   "height": capture.get(cv2.CAP_PROP_FRAME_HEIGHT)}
                    return opened

                def read(self):
                    started, cpu_started = time.perf_counter(), time.thread_time()
                    try:
                        result = capture.read()
                    except Exception:
                        worker.read_exceptions += 1
                        raise
                    if not result[0] or result[1] is None:
                        worker.read_failures += 1
                    if worker.recording:
                        worker.capture_metrics.add("readBlockingWallMs", (time.perf_counter() - started) * 1000)
                        worker.capture_metrics.add("readCallingThreadCpuMs", (time.thread_time() - cpu_started) * 1000)
                    return result

            return Probe()

    return ObservedWorker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--seconds", type=int, default=300)
    parser.add_argument("--output", type=Path, default=ROOT / "runs/phase6c/live-openvino.json")
    args = parser.parse_args()
    if not 1 <= args.seconds <= 3600 or not 5 <= args.warmup <= 120:
        parser.error("seconds 1..3600; warmup 5..120")
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    config_dir = args.output.parent / "ultralytics"
    config_dir.mkdir(exist_ok=True)
    os.environ["YOLO_CONFIG_DIR"] = str(config_dir)
    os.environ["YOLO_OFFLINE"] = "true"
    # Native FFmpeg errors may echo authenticated URLs. Suppress native stderr;
    # public failure counters/type-only thread errors remain in the numeric report.
    os.environ["OPENCV_LOG_LEVEL"] = "SILENT"
    os.dup2(os.open(os.devnull, os.O_WRONLY), 2)
    import psutil
    from config import settings
    from detector import ModelPool
    from vehicle_identity import GlobalVehicleRegistry
    from scripts.benchmark_video import Resources, baseline, package_version

    source = settings.camera_1_url
    public_camera = camera_details(source)
    if public_camera["host"] != "192.168.1.2" or public_camera["path"] != "/stream1" or public_camera["scheme"] != "rtsp":
        raise RuntimeError("Expected the existing Tapo stream1 configuration; configuration was not changed")
    if settings.image_size != 640:
        raise RuntimeError("Configured inference size differs from the requested 640")
    existing = connections(public_camera["host"])
    if existing:
        args.output.write_text(json.dumps({"status": "not run: existing Tapo connection; quiet window required",
                                         "camera": public_camera, "existingConnections": existing}, indent=2))
        print("Existing Tapo connection detected; no benchmark camera was opened.", flush=True)
        return 2
    report = {"status": "initializing", "label": "empty-scene RTSP performance benchmark; not an accuracy validation",
              "camera": public_camera, "existingConnectionsBeforeStart": existing,
              "host": {"cpu": platform.processor(), "physicalCpus": psutil.cpu_count(logical=False),
                       "logicalCpus": psutil.cpu_count(), "ramGiB": psutil.virtual_memory().total / 1024**3,
                       "os": platform.platform(), "python": platform.python_version()},
              "versions": {name: package_version(name) for name in ("torch", "ultralytics", "opencv-python", "openvino")},
              "settings": {"backend": "openvino", "precision": "FP32", "imageSize": settings.image_size,
                           "confidence": settings.confidence, "targetFps": 10, "warmupSeconds": args.warmup,
                           "productionBackend": settings.inference_backend, "viewers": 0},
              "threadErrors": [], "samples": []}
    report["baseline"] = baseline(5)
    config = replace(settings, inference_backend="openvino", cpu_inference_threads=0, openvino_threads=0,
                     openvino_streams=0, detection_fps=10, performance_profiling=True, viewer_aware_jpeg=True,
                     esp32_control_enabled=False, esp32_heartbeat_enabled=False, traffic_firestore_enabled=False)
    worker = sampler = None
    previous_hook = threading.excepthook
    threading.excepthook = lambda error: report["threadErrors"].append(
        {"thread": error.thread.name, "type": error.exc_type.__name__})
    try:
        pool = ModelPool(config)
        if not pool.online:
            raise RuntimeError("Both validated model artifacts must load before measurement")
        for model in pool.models.values():
            model.overrides.update(device="intel:cpu", save=False, save_txt=False, save_crop=False, show=False)
        registry = GlobalVehicleRegistry(local_grace_seconds=config.global_id_local_grace_seconds,
            cross_camera_seconds=config.global_id_cross_camera_seconds, match_threshold=config.global_id_match_threshold,
            ambiguity_margin=config.global_id_ambiguity_margin, minimum_sample_confidence=config.global_id_minimum_sample_confidence,
            maximum_samples=config.global_id_maximum_samples)
        # Recheck immediately before opening; never take over an existing stream.
        if connections(public_camera["host"]):
            raise RuntimeError("A Tapo connection appeared during setup; benchmark did not open the camera")
        worker = worker_class()(1, source, config, config.line, model_pool=pool, vehicle_registry=registry,
                                detection_handler=None, transaction_state_provider=None)
        worker.start()
        print(f"Isolated OpenVINO CPU: warming up {args.warmup}s, then measuring {args.seconds}s", flush=True)
        time.sleep(args.warmup)
        if not worker.online or not worker.completed or not worker._processing_thread.is_alive():
            raise RuntimeError("Camera/model warmup did not complete successfully")
        with worker._raw_condition:
            resolution = list(worker._raw_frame.shape[1::-1])
            initial_capture = worker._raw_version
        report["camera"].update(resolution=resolution, **worker.capture_metadata)
        report["openvinoProperties"] = {name: {key: str(model.get_property(key)) for key in (
            "INFERENCE_PRECISION_HINT", "INFERENCE_NUM_THREADS", "NUM_STREAMS", "EXECUTION_DEVICES")}
            for name, model in pool.compiled_models.items()}
        initial_completed = worker.completed
        initial_counts = {name: getattr(worker, name) for name in ("open_attempts", "open_successes", "read_failures", "read_exceptions")}
        process = psutil.Process()
        cpu_start = process.cpu_times()
        sampler = Resources()
        sampler.start()
        started = time.perf_counter()
        worker.recording = True
        timings, frame_count, over100, age_over100, skipped, duplicates = Metrics(), 0, 0, 0, 0, 0
        last_version = None
        detected_counts = set()
        fields = ["elapsedSeconds", "sourceVersion", "detections", "processingMs", "frameAgeMs", "localInferenceMs",
                  "cocoInferenceMs", "totalInferenceMs", "localTrackCallMs", "cocoTrackCallMs", "lineTrackingMs", "identityMs", "ledgerMs",
                  "annotationMs", "jpegMs", "transactionMs", "transactionOverlayMs", "localLockWaitMs", "cocoLockWaitMs"]
        with args.output.with_suffix(".frames.csv").open("w", newline="", encoding="utf-8") as output:
            writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()

            def drain():
                nonlocal frame_count, over100, age_over100, skipped, duplicates, last_version
                for record in worker.drain():
                    record["elapsedSeconds"] = record.pop("completedAt") - started
                    writer.writerow(record)
                    frame_count += 1
                    detected_counts.add(record["detections"])
                    over100 += record["processingMs"] > 100
                    age_over100 += record["frameAgeMs"] > 100
                    if last_version is not None:
                        skipped += max(0, record["sourceVersion"] - last_version - 1)
                        duplicates += record["sourceVersion"] <= last_version
                    last_version = record["sourceVersion"]
                    for name, value in record.items():
                        if name.endswith("Ms"):
                            timings.add(name, value)
                output.flush()

            next_progress = 60
            while time.perf_counter() - started < args.seconds:
                time.sleep(min(1, max(0, args.seconds - (time.perf_counter() - started))))
                drain()
                with worker._raw_condition:
                    captured = worker._raw_version
                elapsed = time.perf_counter() - started
                sample = {"elapsedSeconds": elapsed, "cameraOnline": worker.online,
                          "captureThreadAlive": worker._capture_thread.is_alive(),
                          "processingThreadAlive": worker._processing_thread.is_alive(),
                          "capturedFrames": captured - initial_capture, "completedFrames": worker.completed - initial_completed,
                          "latestProcessingMs": worker.processing_ms, "latestFrameAgeMs": worker.frame_age_ms}
                report["samples"].append(sample)
                if elapsed >= next_progress:
                    print(f"Progress {elapsed:.0f}s: {sample['completedFrames']/elapsed:.2f} detection FPS, "
                          f"{sample['capturedFrames']/elapsed:.2f} capture FPS, RSS {process.memory_info().rss/1048576:.1f} MiB", flush=True)
                    next_progress += 60
                if not sample["processingThreadAlive"]:
                    raise RuntimeError("Inference worker stopped; measurement invalid")
            worker.recording = False
            drain()
        elapsed = time.perf_counter() - started
        cpu_end = process.cpu_times()
        with worker._raw_condition:
            captured = worker._raw_version - initial_capture
        report["resources"] = sampler.finish()
        sampler = None
        report["summary"] = {"seconds": elapsed, "completedFrameCounter": worker.completed - initial_completed,
            "recordedFrames": frame_count, "detectionFps": frame_count / elapsed, "capturedFrames": captured,
            "captureDecodePublishFps": captured / elapsed,
            "processCpuMeanHostPercent": (cpu_end.user + cpu_end.system - cpu_start.user - cpu_start.system) / elapsed * 100 / (psutil.cpu_count() or 1),
            "timings": timings.summary(), "processingFramesOver100ms": over100, "frameAgeOver100ms": age_over100,
            "intentionalUnprocessedCaptureVersionsBetweenProcessedFrames": skipped, "repeatedOrBackwardsSourceVersions": duplicates,
            "droppedTimingRecords": worker.record_drops, "detectedVehicleCounts": sorted(detected_counts),
            "workerStable": all(s["cameraOnline"] and s["captureThreadAlive"] and s["processingThreadAlive"] for s in report["samples"]),
            "offlineTransitions": worker.offline_transitions,
            **{name: getattr(worker, name) - value for name, value in initial_counts.items()}}
        rss = report["resources"]["samples"]
        report["summary"]["rssFirstToLastMiB"] = rss[-1]["rssMiB"] - rss[0]["rssMiB"]
        report["summary"]["cameraReadTiming"] = worker.capture_metrics.summary()
        report["otherCameraConnectionsAtMeasurementEnd"] = [item for item in connections(public_camera["host"]) if item["pid"] != os.getpid()]
        report["status"] = "completed"
    except Exception as error:
        report["status"] = "failed"
        report["errorType"] = type(error).__name__  # Never persist native exceptions containing authenticated URLs.
        print(f"Benchmark failed: {type(error).__name__}; no credentials logged", flush=True)
    finally:
        if worker:
            worker.recording = False
            worker.stop()
            worker.wait_until_stopped()
            report["workersStopped"] = not worker._capture_thread.is_alive() and not worker._processing_thread.is_alive()
        if sampler:
            report["partialResources"] = sampler.finish()
        threading.excepthook = previous_hook
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Saved {report['status']} numeric report: {args.output}", flush=True)
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
