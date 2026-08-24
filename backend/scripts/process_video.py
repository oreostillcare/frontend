from argparse import ArgumentParser
from dataclasses import replace
from pathlib import Path
import sys

import cv2


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config import settings  # noqa: E402
from detector import Detector  # noqa: E402


def main():
    parser = ArgumentParser(description="Run the combined custom and COCO detector on a video.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path)
    model_group = parser.add_mutually_exclusive_group()
    model_group.add_argument(
        "--custom-only",
        action="store_true",
        help="Use only the custom checkpoint and all of its trained classes.",
    )
    model_group.add_argument(
        "--coco-only",
        action="store_true",
        help="Use only the default COCO checkpoint.",
    )
    args = parser.parse_args()

    source = args.source.resolve()
    output = (args.output or source.with_name(f"{source.stem}-dual.avi")).resolve()
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise SystemExit(f"Unable to open video: {source}")

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    codec = "mp4v" if output.suffix.lower() == ".mp4" else "XVID"
    writer = cv2.VideoWriter(str(output), cv2.VideoWriter_fourcc(*codec), fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise SystemExit(f"Unable to create output video: {output}")
    detector_settings = (
        replace(settings, confidence=max(settings.confidence, 0.25))
        if args.coco_only
        else settings
    )
    detector = Detector(
        detector_settings,
        detector_settings.line,
        use_coco_fallback=not args.custom_only,
        use_custom_model=not args.coco_only,
    )
    seen: dict[str, set[int]] = {}
    frame_number = 0

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            rendered, detections = detector.process(frame)
            for item in detections:
                seen.setdefault(item["class"], set()).add(item["trackId"])
            writer.write(rendered)
            frame_number += 1
            if frame_number % 100 == 0 or frame_number == total:
                print(f"Processed {frame_number}/{total} frames", flush=True)
    finally:
        capture.release()
        writer.release()

    print(f"Saved: {output}")
    print("Tracked objects:", {name: len(ids) for name, ids in sorted(seen.items())})


if __name__ == "__main__":
    main()
