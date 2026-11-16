"""Offline free-running dual-session OpenVINO scheduling and parity benchmark.

Only local image/video sources are accepted. This tool imports detector/model
code and never starts the Flask app, cameras, controllers, or network clients.
"""

import argparse
from dataclasses import replace
import hashlib
import json
import math
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.benchmark_openvino_matrix import digest_path, package_version, run_bounded, stats, validate_source
from scripts.scheduling_replay import FrameEnvelope, LatestFrameMailbox


IMAGE_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}


def load_manifest(path):
    if path is None:
        return None
    result = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise ValueError("Manifest must be a JSON object")
    return result


def worker(args):
    import cv2
    import psutil
    from config import settings
    from modules.live_monitoring.vehicle_detector import Detector, ModelPool
    from modules.live_monitoring.vehicle_identity import GlobalVehicleRegistry

    # Configuration is replaced only after config import has completed .env loading.
    config = replace(
        settings,
        inference_backend="openvino",
        openvino_threads=args.threads,
        openvino_streams=args.streams,
        openvino_request_mode=args.request_mode,
        openvino_performance_hint=args.performance_hint,
        performance_profiling=True,
        line_counting=True if args.line_counting else settings.line_counting,
        guide_green_y_percent=args.guide_green,
        guide_red_y_percent=args.guide_red,
        camera_1_guide_green_y_percent=None,
        camera_1_guide_red_y_percent=None,
        camera_2_guide_green_y_percent=None,
        camera_2_guide_red_y_percent=None,
    )
    source = validate_source(args.source)
    pool = None
    producers = []
    consumers = []
    stop = threading.Event()
    errors = []
    error_lock = threading.Lock()
    mailboxes = {cid: LatestFrameMailbox(cid) for cid in (1, 2)}
    results = {cid: [] for cid in (1, 2)}
    metrics = {cid: {"latencyMs": [], "captureAgeAtStartMs": [], "captureAgeAtCompletionMs": [],
                     "lockWaitMs": [], "rssMiB": [], "systemRamUsedMiB": [], "systemRamAvailableMiB": [],
                     "stages": {}, "completionTimes": []} for cid in (1, 2)}
    torch_threads = {}
    process = psutil.Process()
    source_hash = digest_path(source)
    raw_digest = hashlib.sha256()
    with source.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            raw_digest.update(chunk)
    raw_source_hash = raw_digest.hexdigest()
    manifest = load_manifest(args.manifest)
    if manifest and manifest.get("videoSha256") and manifest["videoSha256"] != raw_source_hash:
        raise ValueError("Manifest video hash does not match --source")
    source_state = {"capture": None}
    try:
        pool = ModelPool(config, load_local=True, load_coco=True)
        missing = [name for name in ("local", "coco") if pool.models[name] is None]
        if missing:
            raise RuntimeError(f"Required models unavailable: {pool.status()}")
        for model in pool.models.values():
            model.overrides.update(device="intel:cpu", save=False, save_txt=False, save_crop=False, show=False)
        registry = GlobalVehicleRegistry(
            local_grace_seconds=config.global_id_local_grace_seconds,
            cross_camera_seconds=config.global_id_cross_camera_seconds,
            match_threshold=config.global_id_match_threshold,
            ambiguity_margin=config.global_id_ambiguity_margin,
            minimum_sample_confidence=config.global_id_minimum_sample_confidence,
            maximum_samples=config.global_id_maximum_samples,
        )
        detectors = []
        for cid in (1, 2):
            detector = Detector(config, config.line, use_coco_fallback=True, use_custom_model=True,
                                model_pool=pool, vehicle_registry=registry)
            detector.camera_id = cid
            detectors.append(detector)

        # Ultralytics ByteTrack's BaseTrack ID counter is process-global. Initialize
        # all four model trackers before any real new-track births, serially.
        if source.suffix.lower() in IMAGE_EXTENSIONS:
            blank = cv2.imread(str(source), cv2.IMREAD_COLOR)
            if blank is None:
                raise RuntimeError(f"Could not decode image {source}")
            blank = blank.copy() * 0
        else:
            cap = cv2.VideoCapture(str(source), cv2.CAP_FFMPEG)
            if not cap.isOpened():
                cap.release()
                raise RuntimeError(f"Could not open video {source}")
            ok, blank = cap.read()
            cap.release()
            if not ok:
                raise RuntimeError(f"Video has no decodable frame: {source}")
            blank = blank * 0
        for detector in detectors:
            detector.process(blank.copy())

        if source.suffix.lower() in IMAGE_EXTENSIONS:
            source_fps = args.source_fps or 10.0
        else:
            probe = cv2.VideoCapture(str(source), cv2.CAP_FFMPEG)
            source_fps = args.source_fps or (probe.get(cv2.CAP_PROP_FPS) or 10.0)
            probe.release()
        source_fps = max(0.1, source_fps)

        def producer(cid):
            cap = None
            try:
                if source.suffix.lower() not in IMAGE_EXTENSIONS:
                    cap = cv2.VideoCapture(str(source), cv2.CAP_FFMPEG)
                    if not cap.isOpened():
                        raise RuntimeError(f"camera{cid}: could not open video")
                for sequence in range(args.frames):
                    if stop.is_set():
                        break
                    mailbox = mailboxes[cid]
                    if args.delivery == "all" and not mailbox.wait_for_capacity(timeout=args.timeout_seconds):
                        if stop.is_set():
                            break
                        raise TimeoutError(f"camera{cid}: mailbox capacity deadline exceeded")
                    if source.suffix.lower() in IMAGE_EXTENSIONS:
                        frame = cv2.imread(str(source), cv2.IMREAD_COLOR)
                    else:
                        ok, frame = cap.read()
                        if not ok:
                            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                            ok, frame = cap.read()
                        if not ok:
                            raise RuntimeError(f"camera{cid}: source could not deliver frame")
                    captured_at = time.monotonic()
                    envelope = FrameEnvelope(cid, 1, sequence + 1, sequence, captured_at, frame)
                    if not mailbox.publish(envelope):
                        raise RuntimeError(f"camera{cid}: mailbox rejected frame {sequence}")
                    if sequence + 1 < args.frames:
                        time.sleep(1 / source_fps)
            except Exception as error:
                with error_lock:
                    errors.append(f"producer camera{cid}: {type(error).__name__}: {error}")
                stop.set()
                for queue in mailboxes.values():
                    queue.fail(error)
            finally:
                if cap is not None:
                    cap.release()
                mailboxes[cid].close()

        def consumer(cid, detector):
            canonical = {}
            last_sequence = -1
            mailbox = mailboxes[cid]
            try:
                while not stop.is_set():
                    envelope = mailbox.take(args.max_age_ms / 1000, timeout=0.1)
                    if envelope is None:
                        if mailbox.closed:
                            break
                        continue
                    if envelope.camera_id != cid or envelope.sequence <= last_sequence:
                        raise RuntimeError(f"camera{cid}: mixed or duplicate frame envelope")
                    last_sequence = envelope.sequence
                    started = time.monotonic()
                    start_age = (started - envelope.captured_at) * 1000
                    annotated, detections = detector.process(envelope.frame)
                    completed = time.monotonic()
                    completion_age = (completed - envelope.captured_at) * 1000
                    completion_status = mailbox.completion_status(
                        envelope, args.max_age_ms / 1000, stopped=stop.is_set()
                    )
                    profiler = detector.profiler.snapshot()
                    if cid not in torch_threads:
                        import torch
                        torch_threads[cid] = torch.get_num_threads()
                    clean_detections = []
                    for item in detections:
                        raw_id = int(item["trackId"])
                        canonical.setdefault(raw_id, len(canonical) + 1)
                        clean_detections.append({
                            "rawTrackId": raw_id, "canonicalTrackId": canonical[raw_id],
                            "vehicleId": item.get("vehicleId"), "class": item.get("class"),
                            "confidence": item.get("confidence"), "boundingBox": item.get("boundingBox"),
                            "trafficRole": item.get("trafficRole"), "inTrafficZone": item.get("inTrafficZone"),
                            "greenCrossed": item.get("greenCrossed"), "redCrossed": item.get("redCrossed"),
                            "redLineTouched": item.get("redLineTouched"),
                            "greenTransition": item.get("greenTransition"),
                            "redTransition": item.get("redTransition"),
                            "redEntryTransition": item.get("redEntryTransition"),
                            "greenExitTransition": item.get("greenExitTransition"),
                            "outgoingRouteStarted": item.get("outgoingRouteStarted"),
                            "outgoingRouteComplete": item.get("outgoingRouteComplete"),
                            "outgoingRouteTransition": item.get("outgoingRouteTransition"),
                            "outgoingConfirmationY": item.get("outgoingConfirmationY"),
                        })
                    raw_to_canonical = {str(raw): canonical_id for raw, canonical_id in canonical.items()}
                    ledger, points = detector.incoming_ledger.snapshot()
                    ledger = [{"canonicalTrackId": raw_to_canonical.get(str(item.get("trackId"))),
                               "gid": item.get("gid"),
                               "class": item.get("class"), "confidence": item.get("confidence"),
                               "points": item.get("points")} for item in ledger]
                    row = {
                        "cameraId": cid, "generation": envelope.generation, "sequence": envelope.sequence,
                        "sourceTimestampSeconds": envelope.sequence / source_fps,
                        "captureTimeMonotonic": envelope.captured_at,
                        "captureAgeAtStartMs": start_age, "captureAgeAtCompletionMs": completion_age,
                        "processingWallMs": (completed - started) * 1000,
                        "status": completion_status, "publishedCurrent": completion_status == "current",
                        "detections": clean_detections, "passed": detector.track_state.passed,
                        "ledger": ledger, "ledgerPoints": points, "completionTimeMonotonic": completed,
                    }
                    results[cid].append(row)
                    metrics[cid]["latencyMs"].append(row["processingWallMs"])
                    metrics[cid]["captureAgeAtStartMs"].append(start_age)
                    metrics[cid]["captureAgeAtCompletionMs"].append(completion_age)
                    metrics[cid]["lockWaitMs"].append(sum(value for key, value in profiler.items()
                                                            if key.endswith("LockWaitMs")))
                    metrics[cid]["rssMiB"].append(process.memory_info().rss / 1048576)
                    metrics[cid]["completionTimes"].append(completed)
                    memory = psutil.virtual_memory()
                    metrics[cid]["systemRamUsedMiB"].append(memory.used / 1048576)
                    metrics[cid]["systemRamAvailableMiB"].append(memory.available / 1048576)
                    for stage, value in profiler.items():
                        metrics[cid]["stages"].setdefault(stage, []).append(value)
                    # No annotated publication is made for stale completions.
                    _ = annotated
            except Exception as error:
                with error_lock:
                    errors.append(f"consumer camera{cid}: {type(error).__name__}: {error}")
                stop.set()
                for queue in mailboxes.values():
                    queue.fail(error)

        barrier = threading.Barrier(5)

        def start_gate(target):
            barrier.wait()
            target()

        for cid, detector in zip((1, 2), detectors):
            consumer_thread = threading.Thread(target=lambda c=cid, d=detector: start_gate(lambda: consumer(c, d)),
                                               name=f"schedule-consumer-{cid}")
            producer_thread = threading.Thread(target=lambda c=cid: start_gate(lambda: producer(c)),
                                               name=f"schedule-producer-{cid}")
            consumers.append(consumer_thread)
            producers.append(producer_thread)
        for thread in consumers + producers:
            thread.start()
        cpu_before = process.cpu_times()
        system_before = psutil.cpu_times()
        started_at = time.monotonic()
        barrier.wait()  # One common start barrier, not a per-frame synchronization barrier.
        for thread in producers + consumers:
            thread.join(timeout=args.timeout_seconds)
        if any(thread.is_alive() for thread in producers + consumers):
            stop.set()
            for queue in mailboxes.values():
                queue.close()
            raise RuntimeError("Scheduling workers did not shut down before timeout")
        elapsed = time.monotonic() - started_at
        cpu_after = process.cpu_times()
        system_after = psutil.cpu_times()
        process_cpu_seconds = cpu_after.user + cpu_after.system - cpu_before.user - cpu_before.system
        system_cpu_elapsed = sum(system_after) - sum(system_before)
        system_cpu_busy = system_cpu_elapsed - (system_after.idle - system_before.idle)
        if errors:
            raise RuntimeError("; ".join(errors))

        actual_properties = {}
        for name, compiled in pool.compiled_models.items():
            values = {}
            for key in ("INFERENCE_PRECISION_HINT", "INFERENCE_NUM_THREADS", "NUM_STREAMS", "EXECUTION_DEVICES",
                        "PERFORMANCE_HINT", "PERFORMANCE_HINT_NUM_REQUESTS"):
                try:
                    values[key] = str(compiled.get_property(key))
                except Exception as error:
                    values[key] = {"unavailable": str(error)}
            actual_properties[name] = values
        cameras = {}
        for cid in (1, 2):
            camera_rows = results[cid]
            gaps = [(right["completionTimeMonotonic"] - left["completionTimeMonotonic"]) * 1000
                    for left, right in zip(camera_rows, camera_rows[1:])]
            cameras[f"camera{cid}"] = {
                "acceptedFrames": len(camera_rows),
                "completionThroughputFps": len(camera_rows) / max(elapsed, 1e-9),
                "activeCompletionThroughputFps": (
                    len(camera_rows) / max(camera_rows[-1]["completionTimeMonotonic"] - started_at, 1e-9)
                    if camera_rows else 0.0
                ),
                "currentPublications": sum(row["publishedCurrent"] for row in camera_rows),
                "currentThroughputFps": sum(row["publishedCurrent"] for row in camera_rows) / max(elapsed, 1e-9),
                "staleCompletions": sum(row["status"] == "stale" for row in camera_rows),
                "supersededCompletions": sum(row["status"] == "superseded_generation" for row in camera_rows),
                "detections": sum(len(row["detections"]) for row in camera_rows),
                "passedAtEnd": camera_rows[-1]["passed"] if camera_rows else None,
                "latencyMs": stats(metrics[cid]["latencyMs"]),
                "captureAgeAtStartMs": stats(metrics[cid]["captureAgeAtStartMs"]),
                "captureAgeAtCompletionMs": stats(metrics[cid]["captureAgeAtCompletionMs"]),
                "modelLockWaitMs": stats(metrics[cid]["lockWaitMs"]),
                "stagesMs": {stage: stats(values) for stage, values in metrics[cid]["stages"].items()},
                "completionGapMs": stats(gaps), "longestCompletionGapMs": max(gaps, default=None),
                "torchIntraOpThreadsInInferenceWorker": torch_threads.get(cid),
                "resources": {key: stats(metrics[cid][key]) for key in
                              ("rssMiB", "systemRamUsedMiB", "systemRamAvailableMiB")},
                "mailbox": {"published": mailboxes[cid].published, "replaced": mailboxes[cid].replaced,
                            "expiredBeforeInference": mailboxes[cid].expired},
                "canonicalRawTrackIds": {str(row["rawTrackId"]): row["canonicalTrackId"]
                                          for result in camera_rows for row in result["detections"]},
            }
        model_hashes = {name: {"path": str(pool.runtime_path(name)), "sha256": digest_path(pool.runtime_path(name))}
                        for name in ("local", "coco")}
        report = {
            "status": "completed", "settings": {"requestModeRequested": args.request_mode,
                         "requestModeResolved": config.openvino_request_mode,
                         "performanceHintRequested": args.performance_hint, "threadsRequested": args.threads,
                         "performanceHintResolved": config.openvino_performance_hint,
                         "streamsRequested": args.streams, "maxAgeMs": args.max_age_ms,
                         "guideGreenPercent": args.guide_green, "guideRedPercent": args.guide_red,
                         "sourceFps": source_fps, "delivery": args.delivery,
                         "lineCountingEnabled": config.line_counting,
                         "nativeRequestTimeoutMs": config.openvino_request_timeout_ms},
            "source": {"path": str(source), "sha256": source_hash, "bytes": source.stat().st_size,
                       "rawFileSha256": raw_source_hash,
                       "sha256Scheme": "Legacy digest includes basename; rawFileSha256 hashes only content",
                       "kind": "image" if source.suffix.lower() in IMAGE_EXTENSIONS else "video",
                       "framesRequestedPerCamera": args.frames},
            "models": model_hashes,
            "versions": {"python": platform.python_version(), **{
                name: package_version(package) for name, package in
                (("ultralytics", "ultralytics"), ("torch", "torch"), ("openvino", "openvino"),
                 ("opencv", "opencv-python"), ("psutil", "psutil"))}},
            "elapsedSeconds": elapsed, "completionThroughputFpsPerCamera": {
                f"camera{cid}": len(results[cid]) / elapsed for cid in (1, 2)},
            "resources": {"processCpuSeconds": process_cpu_seconds,
                          "processCpuOneCorePercent": process_cpu_seconds / max(elapsed, 1e-9) * 100,
                          "processCpuHostPercent": process_cpu_seconds / max(elapsed, 1e-9) / (psutil.cpu_count() or 1) * 100,
                          "systemCpuPercent": max(0, min(100, system_cpu_busy / max(system_cpu_elapsed, 1e-9) * 100)),
                          "logicalCpus": psutil.cpu_count() or 1,
                          "systemRamTotalMiB": psutil.virtual_memory().total / 1048576},
            "cameras": cameras, "frames": {f"camera{cid}": results[cid] for cid in (1, 2)},
            "openvinoCompiledProperties": actual_properties,
            "manifest": manifest,
            "measurementWindow": "Common start until both sessions drained; active rates also end at each session's last completion",
            "limitations": ["Offline synthetic/moving fixture is not representative road footage or ground truth.",
                            "Image repeat is a compute diagnostic, not road traffic or camera FPS evidence.",
                            "Each camera has independent capture/replay timing; no per-frame pair barrier is used.",
                            "Cross-camera GlobalVehicleRegistry ID allocation can vary with thread completion order.",
                            "Post-inference publication rejection cannot undo tracker state; the mailbox policy is offline only.",
                            "No benchmark winner is promoted automatically."],
        }
        return report
    finally:
        stop.set()
        for queue in mailboxes.values():
            queue.close()
        for thread in producers + consumers:
            if thread.is_alive():
                thread.join(timeout=2)
        capture = source_state.get("capture")
        if capture is not None:
            capture.release()


def parity(baseline, candidate):
    def indexed(report):
        return {(int(camera.removeprefix("camera")), row.get("generation", 1), row["sequence"]): row
                for camera, rows in report["frames"].items() for row in rows}
    def sequences(report):
        return {camera: [(row.get("generation", 1), row["sequence"]) for row in rows]
                for camera, rows in report["frames"].items()}
    first, second = indexed(baseline), indexed(candidate)
    same_sequences = sequences(baseline) == sequences(candidate)
    keys = first.keys() & second.keys()
    differences = []
    identity_differences = []
    identity_forward, identity_reverse = {}, {}
    for key in sorted(keys):
        left = {item.get("canonicalTrackId"): item for item in first[key]["detections"]}
        right = {item.get("canonicalTrackId"): item for item in second[key]["detections"]}
        for track in left.keys() & right.keys():
            a, b = left[track].get("vehicleId"), right[track].get("vehicleId")
            if (bool(a) != bool(b) or (a and a in identity_forward and identity_forward[a] != b)
                    or (b and b in identity_reverse and identity_reverse[b] != a)):
                identity_differences.append({"cameraId": key[0], "sequence": key[2], "track": track,
                                             "baselineGid": a, "candidateGid": b})
            elif a and b:
                identity_forward[a], identity_reverse[b] = b, a
    for key in sorted(keys):
        def signature(row):
            return {
                "detections": [{name: item.get(name) for name in (
                    "canonicalTrackId", "class", "confidence", "boundingBox", "trafficRole",
                    "inTrafficZone", "greenCrossed", "redCrossed", "redLineTouched", "greenTransition",
                    "redTransition", "redEntryTransition", "greenExitTransition", "outgoingRouteStarted",
                    "outgoingRouteComplete", "outgoingRouteTransition", "outgoingConfirmationY")}
                    for item in row["detections"]],
                "passed": row["passed"], "ledgerPoints": row["ledgerPoints"],
                "ledger": sorted(
                    [{name: item.get(name) for name in ("class", "points", "canonicalTrackId")}
                     for item in row["ledger"]],
                    key=lambda item: (str(item["canonicalTrackId"]), str(item["class"])),
                ),
            }
        if signature(first[key]) != signature(second[key]):
            differences.append({"cameraId": key[0], "generation": key[1], "sequence": key[2],
                                "baseline": signature(first[key]), "candidate": signature(second[key])})
        left_ledger = {item.get("canonicalTrackId"): item for item in first[key]["ledger"]}
        right_ledger = {item.get("canonicalTrackId"): item for item in second[key]["ledger"]}
        for track in left_ledger.keys() & right_ledger.keys():
            a, b = left_ledger[track].get("gid"), right_ledger[track].get("gid")
            if (a or b) and (not a or not b or identity_forward.get(a) != b):
                identity_differences.append({"cameraId": key[0], "sequence": key[2],
                                             "ledgerTrack": track, "baselineGid": a, "candidateGid": b})
    def coverage(report):
        cameras = {}
        for camera in ("camera1", "camera2"):
            rows = report["frames"].get(camera, [])
            items = [item for row in rows for item in row["detections"]]
            cameras[camera] = {
                "nonzeroDetections": bool(items),
                "globalIdentityObserved": any(item.get("vehicleId") for item in items),
                "crossingObserved": any(item.get("greenCrossed") or item.get("redCrossed")
                                         or item.get("redLineTouched") for item in items),
                "trafficRoleObserved": any(item.get("trafficRole") in {"INCOMING", "OUTGOING"}
                                            for item in items),
                "uniqueTracksPerFrame": all(
                    len(row["detections"]) == len({item.get("canonicalTrackId") for item in row["detections"]})
                    for row in rows),
            }
        return cameras
    coverage_pair = {"baseline": coverage(baseline), "candidate": coverage(candidate)}
    gates_complete = all(all(values.values()) for cameras in coverage_pair.values() for values in cameras.values())
    passed = same_sequences and not differences and not identity_differences and gates_complete
    return {"status": "passed" if passed else "not_passed",
            "baselineAcceptedFrameCount": len(first), "candidateAcceptedFrameCount": len(second),
            "identicalAcceptedFrameSequences": same_sequences, "commonFrameCount": len(keys),
            "semanticDifferences": differences,
            "rawIdDifferenceFrames": sum(
                [item.get("rawTrackId") for item in first[key]["detections"]]
                != [item.get("rawTrackId") for item in second[key]["detections"]] for key in keys),
            "behavioralCoverageGate": coverage_pair,
            "globalIdentityEquivalence": {
                "status": "passed" if not identity_differences else "not_passed",
                "observedIdentities": len(identity_forward),
                "bijectiveRenaming": identity_forward, "differences": identity_differences,
            },
            "accuracyEvaluation": "unavailable: no ground-truth labels for this synthetic fixture",
            "compares": ["class/confidence/boxes", "per-camera canonical raw track IDs", "traffic roles/zones",
                         "green/red crossing flags", "passed counter", "incoming ledger class/points"],
            "excludes": ["Literal vehicleId string equality; a complete bijective correspondence is required instead"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Local image/video only")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--request-mode", choices=("shared", "fair", "independent", "async"), action="append")
    parser.add_argument("--performance-hint", choices=("LATENCY", "THROUGHPUT"), action="append")
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--streams", type=int, default=0)
    parser.add_argument("--frames", type=int, default=80)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=float, default=180,
                        help="Wall-clock limit per isolated configuration, including initialization")
    parser.add_argument("--source-fps", type=float, default=0, help="Override local replay pacing rate")
    parser.add_argument("--delivery", choices=("latest", "all"), default="latest",
                        help="latest overwrites the one-slot mailbox; all backpressures to preserve every frame")
    parser.add_argument("--line-counting", action="store_true",
                        help="Exercise line counters in this offline process only; otherwise preserve deployment settings")
    parser.add_argument("--max-age-ms", type=float, default=2500)
    parser.add_argument("--guide-green", type=float, default=15)
    parser.add_argument("--guide-red", type=float, default=80)
    parser.add_argument("--_worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--_mode", choices=("shared", "fair", "independent", "async"), help=argparse.SUPPRESS)
    parser.add_argument("--_hint", choices=("LATENCY", "THROUGHPUT"), help=argparse.SUPPRESS)
    parser.add_argument("--_result", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.frames < 1 or args.repeats < 1 or args.max_age_ms <= 0:
        parser.error("--frames and --repeats must be positive; --max-age-ms must be positive")
    if (not math.isfinite(args.timeout_seconds) or args.timeout_seconds <= 0
            or not math.isfinite(args.max_age_ms) or not math.isfinite(args.source_fps)
            or args.source_fps < 0 or args.threads < 0 or args.streams < 0):
        parser.error("Timeout, age, rate and resource budgets must be finite and valid")
    try:
        args.source = validate_source(args.source)
        if args.manifest:
            args.manifest = args.manifest.expanduser().resolve()
            load_manifest(args.manifest)  # Fail before loading models if provenance is missing or malformed.
    except ValueError as error:
        parser.error(str(error))
    except (OSError, json.JSONDecodeError) as error:
        parser.error(f"Invalid --manifest: {error}")
    if args._worker:
        try:
            result = worker(argparse.Namespace(**{**vars(args), "request_mode": args._mode,
                                                   "performance_hint": args._hint}))
            args._result.write_text(json.dumps(result, indent=2), encoding="utf-8")
        except Exception as error:
            if args._result:
                args._result.write_text(json.dumps({"status": "failed", "error": f"{type(error).__name__}: {error}"},
                                                   indent=2), encoding="utf-8")
            print(f"scheduling worker failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            return 1
        return 0

    modes, hints = args.request_mode or ["shared", "fair", "independent", "async"], args.performance_hint or ["LATENCY"]
    candidates = [(mode, hint) for mode in modes for hint in hints]
    plan = []
    for _ in range(args.repeats):
        plan.append(("shared", "LATENCY", "baseline"))
        plan.extend((mode, hint, "candidate") for mode, hint in candidates if (mode, hint) != ("shared", "LATENCY"))
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"status": "running", "requested": {"requestModes": modes, "performanceHints": hints,
               "frames": args.frames, "repeats": args.repeats, "maxAgeMs": args.max_age_ms},
              "runs": [], "comparisons": [], "failures": []}
    baselines = []
    with tempfile.TemporaryDirectory(prefix="openvino-scheduling-") as temporary:
        for index, (mode, hint, label) in enumerate(plan):
            result_path = Path(temporary) / f"run-{index}.json"
            command = [sys.executable, str(Path(__file__).resolve()), "--source", str(args.source),
                       "--output", str(output), "--frames", str(args.frames), "--max-age-ms", str(args.max_age_ms),
                       "--threads", str(args.threads), "--streams", str(args.streams), "--source-fps", str(args.source_fps),
                       "--delivery", args.delivery, "--timeout-seconds", str(args.timeout_seconds),
                       "--guide-green", str(args.guide_green), "--guide-red", str(args.guide_red), "--_worker",
                       "--_mode", mode, "--_hint", hint, "--_result", str(result_path)]
            if args.manifest:
                command.extend(("--manifest", str(args.manifest)))
            if args.line_counting:
                command.append("--line-counting")
            run_info = {"index": index, "label": label, "requestMode": mode, "performanceHint": hint}
            try:
                child = run_bounded(command, cwd=str(ROOT), timeout=args.timeout_seconds)
                result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else {}
                run_info["result"] = result
                run_info["exitCode"] = child.returncode
                report["runs"].append(run_info)
                if child.returncode != 0 or result.get("status") != "completed":
                    raise RuntimeError(result.get("error") or child.stderr.strip() or f"child exited {child.returncode}")
                if label == "baseline":
                    baselines.append(result)
                else:
                    baseline = baselines[-1]
                    report["comparisons"].append({"requestMode": mode, "performanceHint": hint,
                                                   "repeat": len(baselines), "parity": parity(baseline, result)})
                output.write_text(json.dumps(report, indent=2), encoding="utf-8")
                print(json.dumps({"run": index, "label": label, "requestMode": mode, "performanceHint": hint,
                                  "status": result.get("status")}), flush=True)
            except Exception as error:
                report["failures"].append({**run_info, "error": f"{type(error).__name__}: {error}"})
                report["status"] = "failed"
                output.write_text(json.dumps(report, indent=2), encoding="utf-8")
                return 1
    report["status"] = "completed" if not report["failures"] else "failed"
    report["automaticPromotion"] = False
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
