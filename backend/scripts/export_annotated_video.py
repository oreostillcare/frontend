"""Offline dual-model visual export; no cameras, controllers, services or uploads."""

import argparse
from collections import Counter
from dataclasses import replace
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

COLORS = {
    "car": (90, 220, 90), "motorcycle": (255, 190, 60), "truck": (220, 130, 240),
    "bus": (60, 210, 255), "bicycle": (230, 220, 80), "tricycle": (70, 140, 255),
    "jeepney": (200, 100, 255), "ebike": (210, 230, 70),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=60)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if not source.is_file() or source == output or not 0 < args.seconds <= 60:
        parser.error("Provide an existing input, distinct output, and duration <= 60 seconds")
    if output.exists():
        parser.error("Output already exists; refusing to overwrite")
    output.parent.mkdir(parents=True, exist_ok=True)
    (output.parent / "ultralytics").mkdir(exist_ok=True)
    os.environ.update(YOLO_OFFLINE="true", YOLO_CONFIG_DIR=str(output.parent / "ultralytics"))
    import cv2
    from config import settings
    from detector import (Detector, ModelPool, LOCAL_VEHICLES, COCO_VEHICLES,
                          COCO_TRACK_ID_OFFSET, box_iou)
    from scripts.benchmark_video import stats

    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise RuntimeError("Input could not be decoded")
    fps = capture.get(cv2.CAP_PROP_FPS)
    width, height = (int(capture.get(p)) for p in (cv2.CAP_PROP_FRAME_WIDTH, cv2.CAP_PROP_FRAME_HEIGHT))
    if fps <= 0 or width <= 0 or height <= 0:
        raise RuntimeError("Invalid input metadata")
    frame_limit = math.floor(args.seconds * fps)
    config = replace(settings, inference_backend="openvino", image_size=640, line_counting=False,
                     esp32_control_enabled=False, esp32_heartbeat_enabled=False, traffic_firestore_enabled=False,
                     performance_profiling=True)
    pool = ModelPool(config)
    if not pool.online:
        raise RuntimeError("Both existing OpenVINO FP32 models must load")
    for model in pool.models.values():
        model.overrides.update(device="intel:cpu", save=False, save_txt=False, save_crop=False, show=False)
    detector = Detector(config, config.line, model_pool=pool)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg with an MP4 encoder is required")
    encoders = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, check=True).stdout
    codec = "libx264" if "libx264" in encoders else "mpeg4"
    codec_args = ["-c:v", codec, "-preset", "fast", "-crf", "20"] if codec == "libx264" else ["-c:v", codec, "-q:v", "3"]
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-n", "-f", "rawvideo", "-pix_fmt", "bgr24",
               "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0", "-an", *codec_args,
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)]
    counts, seen, empty_frames, latencies, rows = Counter(), {}, [], [], []
    previous_seen, reappearances = {}, 0
    started = time.perf_counter()
    with (output.parent / "encoder.log").open("w") as log:
        encoder = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=log)
        try:
            for index in range(frame_limit):
                ok, frame = capture.read()
                if not ok:
                    break
                at = time.perf_counter()
                # Same model sessions, ByteTrack, confidence, fusion and class votes
                # as Detector.process. No uncalibrated region/traffic event calculations.
                detector.profiler.reset()
                detector.frame_index += 1
                local = detector.tracked_detections(detector.local_session, frame, LOCAL_VEHICLES)
                coco = detector.tracked_detections(detector.coco_session, frame, COCO_VEHICLES,
                    COCO_TRACK_ID_OFFSET, max(config.confidence, .25))
                detections = local + [d for d in coco if not any(box_iou(d["boundingBox"], l["boundingBox"]) >= .35 for l in local)]
                detector.stabilize_classes(detections)
                detector.track_state.update(detections)  # Disabled crossing; existing bounded trail history.
                infer_ms = (time.perf_counter() - at) * 1000
                latencies.append(infer_ms)
                trail_count = 0
                for item in detections:
                    name, tid = item["class"], item["trackId"]
                    counts[name] += 1
                    seen.setdefault(name, set()).add(tid)
                    if tid in previous_seen and index - previous_seen[tid] > 1:
                        reappearances += 1
                    previous_seen[tid] = index
                    color = COLORS.get(name, (230, 230, 230))
                    points = list(detector.track_state.history[tid])[-20:]
                    if len(points) >= 2:
                        trail_count += 1
                    for a, b in zip(points, points[1:]):
                        cv2.line(frame, a, b, color, 1, cv2.LINE_AA)
                    x1, y1, x2, y2 = item["boundingBox"]
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 1, cv2.LINE_AA)
                    label_id = f"C{tid - COCO_TRACK_ID_OFFSET}" if tid >= COCO_TRACK_ID_OFFSET else f"L{tid}"
                    text = f"{name} {item['confidence']:.2f} | {label_id}"
                    (tw, th), baseline = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, .4, 1)
                    x = max(0, min(x1, width - tw - 5))
                    y = min(height - baseline - 3, max(th + 4, y1 - 4))
                    cv2.rectangle(frame, (x, y - th - 3), (min(width-1, x+tw+4), y+baseline+2), (20, 20, 20), -1)
                    cv2.putText(frame, text, (x+2, y), cv2.FONT_HERSHEY_SIMPLEX, .4, color, 1, cv2.LINE_AA)
                if not detections:
                    empty_frames.append(index)
                rolling_ms = sum(latencies[-30:]) / len(latencies[-30:])
                text = f"Compute {1000/rolling_ms:.1f} FPS | {infer_ms:.1f} ms | video {index/fps:.1f}s / {fps:g} FPS"
                cv2.rectangle(frame, (0, height-22), (width-1, height-1), (20,20,20), -1)
                cv2.putText(frame, text, (6, height-7), cv2.FONT_HERSHEY_SIMPLEX, .42, (245,245,245), 1, cv2.LINE_AA)
                encoder.stdin.write(frame.tobytes())
                rows.append({"frame": index, "sourceSeconds": index/fps, "detections": len(detections),
                             "tracksWithTrails": trail_count, "processingMs": infer_ms,
                             "ids": [d["trackId"] for d in detections]})
                if (index + 1) % 300 == 0:
                    print(f"Exported {index+1}/{frame_limit} frames", flush=True)
        finally:
            capture.release()
            encoder.stdin.close()
            result = encoder.wait()
        if result:
            raise RuntimeError("Encoder failed; inspect local encoder.log")
    if digest != hashlib.sha256(source.read_bytes()).hexdigest():
        raise RuntimeError("Input hash changed")
    report = {"source": str(source), "sourceSha256": digest, "output": str(output), "codec": codec,
              "width": width, "height": height, "playbackFps": fps, "frames": len(rows),
              "durationSeconds": len(rows)/fps, "exportWallSeconds": time.perf_counter()-started,
              "inferenceBackend": "OpenVINO FP32 CPU", "imageSize": config.image_size, "confidence": config.confidence,
              "processingMs": stats(latencies), "classDetectionObservations": dict(counts),
              "uniqueTrackerIdsByClass": {n: len(ids) for n, ids in seen.items()},
              "framesWithoutDetections": empty_frames, "trackReappearancesAfterGap": reappearances,
              "lines": "omitted: no video-specific calibration", "crossingEvents": "disabled/not exported",
              "audio": "omitted", "inputUnchanged": True,
              "precision": {n:str(m.get_property("INFERENCE_PRECISION_HINT")) for n,m in pool.compiled_models.items()},
              "limitations": "IDs are tracker hypotheses, not unique vehicle counts; no accuracy ground truth"}
    output.with_suffix(".json").write_text(json.dumps(report, indent=2))
    with output.with_suffix(".frames.jsonl").open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
