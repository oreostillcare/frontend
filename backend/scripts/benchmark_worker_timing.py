"""Test-only live-worker tracing and deadline pacing. Never imports app.py."""

import argparse
from array import array
from collections import deque
from dataclasses import replace
import csv
import json
import math
import os
from pathlib import Path
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class Moments:
    def __init__(self):
        self.count = 0
        self.total = 0.0
        self.low = math.inf
        self.high = -math.inf

    def add(self, value):
        self.count += 1
        self.total += value
        self.low, self.high = min(self.low, value), max(self.high, value)

    def summary(self):
        return {"count": self.count, "mean": self.total / self.count, "min": self.low, "max": self.high} if self.count else None


class BoundedMetrics:
    """Fixed histogram per metric, 0.1 ms bins to 1000 ms; exact mean/min/max."""

    def __init__(self):
        self.values = {}

    def add(self, name, value):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return
        if name not in self.values:
            self.values[name] = (Moments(), array("I", [0]) * 10002)
        moment, bins = self.values[name]
        moment.add(value)
        bins[min(10001, max(0, int(value * 10)))] += 1

    def summary(self):
        result = {}
        for name, (moment, bins) in self.values.items():
            item = moment.summary()
            for percentile in (50, 95, 99):
                target, count = math.ceil(moment.count * percentile / 100), 0
                for index, frequency in enumerate(bins):
                    count += frequency
                    if count >= target:
                        item[f"p{percentile}BinUpper"] = (index + 1) / 10 if index < 10001 else None
                        break
            result[name] = item
        return result


def high_resolution_wait(event, deadline, clock=time.perf_counter, sleep=time.sleep):
    """No spinning or catch-up; stop polling bounded by 10 ms sleep chunks."""
    while not event.is_set():
        remaining = deadline - clock()
        if remaining <= 0:
            break
        sleep(min(.01, remaining))
    return event.is_set()


class Trace:
    def __init__(self):
        self.current = {}
        self.source_times = {}
        self.decode_end = None
        self.last_capture = None
        self.last_publication = None
        self.enabled = False
        self.stats = BoundedMetrics()
        self.records = deque(maxlen=256)
        self.lock = threading.Lock()
        self.dropped = 0

    def stamp(self, name):
        self.current[name] = time.perf_counter()

    def start_iteration(self, at):
        previous = self.current
        if previous.get("completedAt") is not None and self.enabled:
            previous["actualNextIterationAt"] = at
            self.record(previous)
        self.current = {"iterationStartAt": at}

    def record(self, data):
        pairs = {
            "rawLockAcquireMs": ("rawLockRequestedAt", "rawLockAcquiredAt"),
            "frameWaitMs": ("frameWaitStartedAt", "workerWakeupAt"),
            "frameCopyMs": ("frameAcquiredAt", "frameCopyDoneAt"),
            "detectorWallMs": ("detectorStartedAt", "detectorDoneAt"),
            "postDetectorMs": ("detectorDoneAt", "completedAt"),
            "iterationWorkMs": ("iterationStartAt", "completedAt"),
            "sleepActualMs": ("sleepStartedAt", "sleepDoneAt"),
            "startIntervalMs": ("iterationStartAt", "actualNextIterationAt"),
            "captureToPublicationMs": ("decodeDoneAt", "publishedAt"),
        }
        for model in ("local", "coco"):
            for stage in ("Preprocess", "Inference", "Postprocess", "ByteTrack"):
                pairs[f"{model}{stage}WallMs"] = (f"{model}{stage}StartedAt", f"{model}{stage}DoneAt")
        durations = {}
        for name, (start, end) in pairs.items():
            if start in data and end in data:
                durations[name] = (data[end] - data[start]) * 1000
        for name in ("processingMs", "frameAgeMs", "localInferenceMs", "cocoInferenceMs", "lineTrackingMs", "identityMs", "ledgerMs", "annotationMs", "jpegMs"):
            if name in data:
                durations[name] = data[name]
        durations["instrumentationBeforeLockMs"] = data.get("instrumentationBeforeLockMs", 0)
        if "sleepRequestedMs" in data and "sleepActualMs" in durations and not data.get("sleepInterrupted"):
            durations["sleepOvershootMs"] = durations["sleepActualMs"] - data["sleepRequestedMs"]
        if "actualNextIterationAt" in data and "scheduledDeadlineAt" in data:
            durations["schedulingLatenessMs"] = (data["actualNextIterationAt"] - data["scheduledDeadlineAt"]) * 1000
        parts = ("rawLockAcquireMs", "frameWaitMs", "frameCopyMs", "detectorWallMs", "postDetectorMs", "instrumentationBeforeLockMs")
        if all(name in durations for name in (*parts, "iterationWorkMs")):
            durations["unaccountedWorkMs"] = durations["iterationWorkMs"] - sum(durations[name] for name in parts)
        for name, value in durations.items():
            self.stats.add(name, value)
        if "sleepRequestedMs" in data and not data.get("sleepInterrupted"):
            self.stats.add("sleepRequestedMs", data["sleepRequestedMs"])
        with self.lock:
            if len(self.records) == self.records.maxlen:
                self.dropped += 1
            self.records.append({**data, **durations})

    def drain(self):
        with self.lock:
            result = list(self.records)
            self.records.clear()
            return result


def timed_predictor(base, trace, model):
    class Predictor(base):
        def preprocess(self, *args, **kwargs):
            trace.stamp(model + "PreprocessStartedAt")
            result = super().preprocess(*args, **kwargs)
            trace.stamp(model + "PreprocessDoneAt")
            return result

        def inference(self, *args, **kwargs):
            trace.stamp(model + "InferenceStartedAt")
            result = super().inference(*args, **kwargs)
            trace.stamp(model + "InferenceDoneAt")
            return result

        def postprocess(self, *args, **kwargs):
            trace.stamp(model + "PostprocessStartedAt")
            result = super().postprocess(*args, **kwargs)
            trace.stamp(model + "PostprocessDoneAt")
            return result

        def run_callbacks(self, event):
            if event == "on_predict_postprocess_end":
                trace.stamp(model + "ByteTrackStartedAt")
            result = super().run_callbacks(event)
            if event == "on_predict_postprocess_end":
                trace.stamp(model + "ByteTrackDoneAt")
            return result
    return Predictor


def traced_worker_class(policy):
    from scripts.benchmark_rtsp import worker_class
    base = worker_class()

    class Worker(base):
        def __init__(self, *args, **kwargs):
            self.trace = Trace()
            super().__init__(*args, **kwargs)
            self.capture_metrics = BoundedMetrics()
            worker = self

            def processing():
                return threading.current_thread() is worker._processing_thread

            class RawCondition(threading.Condition):
                def __enter__(condition):
                    before = time.perf_counter()
                    if processing():
                        worker.trace.start_iteration(before)
                        requested = time.perf_counter()
                        worker.trace.current["instrumentationBeforeLockMs"] = (requested - before) * 1000
                        worker.trace.current["rawLockRequestedAt"] = requested
                    result = super().__enter__()
                    if processing():
                        worker.trace.stamp("rawLockAcquiredAt")
                    return result

                def wait_for(condition, predicate, timeout=None):
                    if processing():
                        worker.trace.stamp("frameWaitStartedAt")
                    result = super().wait_for(predicate, timeout)
                    if processing():
                        worker.trace.stamp("workerWakeupAt")
                    return result

                def notify_all(condition):
                    if threading.current_thread() is worker._capture_thread:
                        at = time.perf_counter()
                        trace = worker.trace
                        trace.source_times[worker.raw_version_value] = {
                            "decodeDoneAt": trace.decode_end, "publishedAt": at,
                        }
                        if trace.enabled and trace.last_publication is not None:
                            trace.stats.add("capturePublicationIntervalMs", (at - trace.last_publication) * 1000)
                        trace.last_publication = at
                        if len(trace.source_times) > 64:
                            del trace.source_times[next(iter(trace.source_times))]
                    return super().notify_all()

            original_event = self._stop

            class PacingEvent:
                def is_set(event):
                    return original_event.is_set()

                def set(event):
                    return original_event.set()

                def wait(event, timeout=None):
                    if not processing():
                        return original_event.wait(timeout)
                    record = worker.trace.current
                    now = time.perf_counter()
                    record["sleepStartedAt"] = now
                    record["productionRequestedSleepMs"] = timeout * 1000
                    if policy == "original":
                        record["sleepRequestedMs"] = timeout * 1000
                        record["scheduledDeadlineAt"] = now + timeout
                        result = original_event.wait(timeout)
                    else:
                        # Test-only per-iteration absolute deadline, including raw
                        # wait/copy. Reanchor every start: no catch-up burst.
                        deadline = record["iterationStartAt"] + 1 / worker.config.detection_fps
                        record["scheduledDeadlineAt"] = deadline
                        record["sleepRequestedMs"] = max(0, deadline - now) * 1000
                        result = high_resolution_wait(original_event, deadline)
                    record["sleepDoneAt"] = time.perf_counter()
                    record["sleepInterrupted"] = result
                    return result

            self._raw_condition = RawCondition()
            self._stop = PacingEvent()
            original_process = self.detector.process

            def process(frame):
                worker.trace.current.update(worker.trace.source_times.get(worker.consumed_version, {}))
                worker.trace.stamp("detectorStartedAt")
                result = original_process(frame)
                worker.trace.stamp("detectorDoneAt")
                return result

            self.detector.process = process
            for model in ("local", "coco"):
                session = getattr(self.detector, model + "_session")
                setattr(self.detector, model + "_session", replace(session, predictor=timed_predictor(session.predictor, self.trace, model)))

        @property
        def _raw_frame(self):
            if threading.current_thread() is self._processing_thread:
                self.trace.stamp("frameAcquiredAt")
            return self.raw_frame_value

        @_raw_frame.setter
        def _raw_frame(self, value):
            self.raw_frame_value = value

        @property
        def _raw_captured_at(self):
            if threading.current_thread() is self._processing_thread:
                self.trace.stamp("frameCopyDoneAt")
            return self.raw_timestamp_value

        @_raw_captured_at.setter
        def _raw_captured_at(self, value):
            self.raw_timestamp_value = value

        @property
        def _performance(self):
            return self.latest_performance

        @_performance.setter
        def _performance(self, value):
            base._performance.fset(self, value)
            if "processingMs" in value:
                self.trace.current.update(value, sourceVersion=self.consumed_version)
                self.trace.stamp("completedAt")

        def _open_capture(self):
            capture = super()._open_capture()
            trace = self.trace

            class Capture:
                def __getattr__(self, name):
                    return getattr(capture, name)

                def read(self):
                    result = capture.read()
                    at = time.perf_counter()
                    if trace.enabled and trace.last_capture is not None:
                        trace.stats.add("captureIntervalMs", (at - trace.last_capture) * 1000)
                    trace.last_capture, trace.decode_end = at, at
                    return result

            return Capture()

    return Worker


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", choices=("original", "deadline"), default="original")
    parser.add_argument("--seconds", type=int, default=120)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--details", action="store_true", help="Stream numeric timestamp JSONL; no image data")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 7200 or not 5 <= args.warmup <= 120:
        parser.error("Invalid duration")
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    cfg_dir = args.output.parent / "ultralytics"
    cfg_dir.mkdir(exist_ok=True)
    os.environ.update(YOLO_CONFIG_DIR=str(cfg_dir), YOLO_OFFLINE="true", OPENCV_LOG_LEVEL="SILENT")
    os.dup2(os.open(os.devnull, os.O_WRONLY), 2)
    import psutil
    from config import settings
    from detector import ModelPool
    from vehicle_identity import GlobalVehicleRegistry
    from scripts.benchmark_rtsp import connections, camera_details
    from scripts.benchmark_video import baseline

    camera = camera_details(settings.camera_1_url)
    if camera["host"] != "192.168.1.2" or camera["path"] != "/stream1" or settings.image_size != 640:
        raise RuntimeError("Expected existing Tapo stream1 and size 640; configuration unchanged")
    if connections(camera["host"]):
        print("Existing camera connection; no benchmark started", flush=True)
        return 2
    report = {"status": "initializing", "policy": args.policy, "camera": camera,
              "baseline": baseline(5), "threadErrors": [],
              "measurement": "observation-only; no viewers, recording, controllers or upload callbacks",
              "percentiles": "0.1 ms histogram-bin upper bounds; mean/min/max exact; >1000ms overflow has no quantile bound"}
    config = replace(settings, inference_backend="openvino", cpu_inference_threads=0, openvino_threads=0, openvino_streams=0,
                     detection_fps=10, performance_profiling=True, viewer_aware_jpeg=True,
                     esp32_control_enabled=False, esp32_heartbeat_enabled=False, traffic_firestore_enabled=False)
    worker = None
    old_hook = threading.excepthook
    threading.excepthook = lambda error: report["threadErrors"].append({"thread": error.thread.name, "type": error.exc_type.__name__})
    try:
        pool = ModelPool(config)
        if not pool.online:
            raise RuntimeError("Both validated FP32 models are required")
        for model in pool.models.values():
            model.overrides.update(device="intel:cpu", save=False, save_txt=False, save_crop=False, show=False)
        registry = GlobalVehicleRegistry(local_grace_seconds=config.global_id_local_grace_seconds,
            cross_camera_seconds=config.global_id_cross_camera_seconds, match_threshold=config.global_id_match_threshold,
            ambiguity_margin=config.global_id_ambiguity_margin, minimum_sample_confidence=config.global_id_minimum_sample_confidence,
            maximum_samples=config.global_id_maximum_samples)
        if connections(camera["host"]):
            raise RuntimeError("Camera became occupied during setup")
        worker = traced_worker_class(args.policy)(1, settings.camera_1_url, config, config.line, model_pool=pool,
            vehicle_registry=registry, detection_handler=None, transaction_state_provider=None)
        worker.start()
        print(f"{args.policy}: warmup {args.warmup}s, measurement {args.seconds}s", flush=True)
        report["warmupResources"] = []
        warmup_process = psutil.Process()
        for second in range(args.warmup):
            time.sleep(1)
            report["warmupResources"].append({"elapsedSeconds": second + 1,
                "rssMiB": warmup_process.memory_info().rss / 1048576, "completedFrames": worker.completed})
        if not worker.online or not worker.completed or not worker._processing_thread.is_alive():
            raise RuntimeError("Warmup failed")
        with worker._raw_condition:
            initial_capture = worker._raw_version
            report["camera"]["resolution"] = list(worker._raw_frame.shape[1::-1])
        report["openvinoProperties"] = {name: {key: str(model.get_property(key)) for key in (
            "INFERENCE_PRECISION_HINT", "INFERENCE_NUM_THREADS", "NUM_STREAMS", "EXECUTION_DEVICES")}
            for name, model in pool.compiled_models.items()}
        count_start = worker.completed
        error_start = {name: getattr(worker, name) for name in ("read_failures", "read_exceptions", "open_attempts", "open_successes")}
        process = psutil.Process()
        cpu_start = process.cpu_times()
        psutil.cpu_percent()
        started = last_time = time.perf_counter()
        last_cpu = cpu_start.user + cpu_start.system
        worker.recording = worker.trace.enabled = True
        moments, windows = {}, {}
        trend = {"n": 0, "x": 0., "y": 0., "xx": 0., "xy": 0.}
        late_trend = dict(trend)
        first_rss = last_rss = None
        stable = True
        trace_count = 0
        native_deadlines_missed = 0
        decoded_counts = set()
        fields = ["elapsedSeconds", "processCpuHostPercent", "systemCpuPercent", "rssMiB", "peakWorkingSetMiB",
                  "availableMiB", "systemMemoryPercent", "completedFrames", "capturedFrames", "online", "captureAlive", "processingAlive"]
        with args.output.with_suffix(".resources.csv").open("w", newline="") as output, args.output.with_suffix(".timing.jsonl").open("w") as details:
            writer = csv.DictWriter(output, fieldnames=fields)
            writer.writeheader()
            progress = 60
            while time.perf_counter() - started < args.seconds:
                time.sleep(min(1, max(0, args.seconds - (time.perf_counter() - started))))
                for record in worker.drain():
                    native_deadlines_missed += record["processingMs"] > 100
                    decoded_counts.add(record["detections"])
                traced = worker.trace.drain()
                trace_count += len(traced)
                if args.details:
                    for record in traced:
                        details.write(json.dumps({k: (v - started if k.endswith("At") and isinstance(v, float) else v)
                                                  for k, v in record.items()}) + "\n")
                    details.flush()
                now = time.perf_counter()
                cpu, memory, system = process.cpu_times(), process.memory_info(), psutil.virtual_memory()
                total_cpu = cpu.user + cpu.system
                with worker._raw_condition:
                    captured = worker._raw_version - initial_capture
                row = {"elapsedSeconds": now - started, "processCpuHostPercent": (total_cpu - last_cpu) / (now - last_time) * 100 / (psutil.cpu_count() or 1),
                       "systemCpuPercent": psutil.cpu_percent(), "rssMiB": memory.rss / 1048576,
                       "peakWorkingSetMiB": getattr(memory, "peak_wset", memory.rss) / 1048576,
                       "availableMiB": system.available / 1048576, "systemMemoryPercent": system.percent,
                       "completedFrames": worker.completed - count_start, "capturedFrames": captured,
                       "online": worker.online, "captureAlive": worker._capture_thread.is_alive(), "processingAlive": worker._processing_thread.is_alive()}
                last_time, last_cpu = now, total_cpu
                writer.writerow(row)
                output.flush()
                for key, value in row.items():
                    if isinstance(value, (float, int)) and not isinstance(value, bool):
                        moments.setdefault(key, Moments()).add(value)
                first_rss = row["rssMiB"] if first_rss is None else first_rss
                last_rss = row["rssMiB"]
                window = min(int(row["elapsedSeconds"] // 300), (args.seconds - 1) // 300)
                windows.setdefault(window, Moments()).add(last_rss)
                x = row["elapsedSeconds"] / 60
                for regression in ([trend, late_trend] if row["elapsedSeconds"] >= 300 else [trend]):
                    regression["n"] += 1
                    regression["x"] += x
                    regression["y"] += last_rss
                    regression["xx"] += x*x
                    regression["xy"] += x*last_rss
                stable = stable and row["online"] and row["captureAlive"] and row["processingAlive"]
                if row["elapsedSeconds"] >= progress:
                    print(f"{args.policy} {row['elapsedSeconds']:.0f}s: {row['completedFrames']/row['elapsedSeconds']:.3f} FPS, "
                          f"RSS {last_rss:.1f} MiB, system CPU {row['systemCpuPercent']:.1f}%", flush=True)
                    progress += 60
                if not row["processingAlive"]:
                    raise RuntimeError("Inference thread stopped")
            elapsed = time.perf_counter() - started
            cpu_end = process.cpu_times()
            end_count = worker.completed - count_start
            worker.recording = worker.trace.enabled = False
        report["summary"] = {"seconds": elapsed, "frames": end_count, "fps": end_count / elapsed,
            "captureFps": captured / elapsed, "processCpuMeanHostPercent":
            (cpu_end.user+cpu_end.system-cpu_start.user-cpu_start.system)/elapsed*100/(psutil.cpu_count() or 1),
            "resources": {key: value.summary() for key, value in moments.items()},
            "rssChangeMiB": last_rss-first_rss, "rssFiveMinuteWindows": {key:value.summary() for key,value in windows.items()},
            "workerStable": stable, "tracedIterations": trace_count, "processingOver100ms": native_deadlines_missed,
            "detectedVehicleCounts": sorted(decoded_counts)}
        for name, reg in (("rssSlopeMiBPerMinute",trend),("rssSlopeAfterFiveMinutesMiBPerMinute",late_trend)):
            denom = reg["n"] * reg["xx"] - reg["x"]**2
            report["summary"][name] = (reg["n"]*reg["xy"]-reg["x"]*reg["y"])/denom if denom else None
        report["errors"] = {name:getattr(worker,name)-value for name,value in error_start.items()}
        report["errors"]["offlineTransitions"] = worker.offline_transitions
        report["status"] = "completed"
    except Exception as error:
        report["status"] = "failed"
        report["errorType"] = type(error).__name__
        print(f"Benchmark failed: {type(error).__name__}; no credentials logged", flush=True)
    finally:
        if worker:
            worker.recording = worker.trace.enabled = False
            worker.stop()
            worker.wait_until_stopped()
            report["workersStopped"] = not worker._capture_thread.is_alive() and not worker._processing_thread.is_alive()
            report["timing"] = worker.trace.stats.summary()
            report["captureRead"] = worker.capture_metrics.summary()
            report["droppedTraceRecords"] = worker.trace.dropped
        threading.excepthook = old_hook
        args.output.write_text(json.dumps(report, indent=2))
    print(f"Saved {report['status']}: {args.output}", flush=True)
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(run())
