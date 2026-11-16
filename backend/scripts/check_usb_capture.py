"""Bounded simultaneous USB capture check; never imports app or traffic control."""

import argparse
import json
from pathlib import Path
import statistics
import sys
import threading
import time

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from modules.live_monitoring.usb_camera_devices import enumerate_usb_devices


def measure(index, seconds, start, result):
    capture = cv2.VideoCapture(index, cv2.CAP_DSHOW)
    try:
        result.update(index=index, opened=capture.isOpened())
        if not capture.isOpened():
            return
        result.update(
            backend=capture.getBackendName(),
            reported_fps=capture.get(cv2.CAP_PROP_FPS),
            buffer_size_accepted=bool(capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)),
            reported_buffer_size=capture.get(cv2.CAP_PROP_BUFFERSIZE),
            fourcc=int(capture.get(cv2.CAP_PROP_FOURCC)),
        )
        start.wait()
        began = time.perf_counter()
        reads, times, differences = [], [], []
        previous = None
        while time.perf_counter() - began < seconds:
            before = time.perf_counter()
            ok, frame = capture.read()
            now = time.perf_counter()
            if not ok or frame is None:
                result['read_error'] = True
                break
            reads.append((now - before) * 1000)
            times.append(now)
            result['resolution'] = [frame.shape[1], frame.shape[0]]
            thumbnail = cv2.resize(frame, (32, 24))
            if previous is not None:
                differences.append(float(cv2.absdiff(previous, thumbnail).mean()))
            previous = thumbnail
        result.update(
            frames=len(times), elapsed_seconds=time.perf_counter() - began,
            measured_fps=(len(times) - 1) / (times[-1] - times[0]) if len(times) > 1 else 0,
            read_ms_mean=statistics.mean(reads) if reads else None,
            read_ms_max=max(reads) if reads else None,
            thumbnail_difference_mean=statistics.mean(differences) if differences else None,
            age_scope='Read/decode duration only; sensor/driver and glass-to-glass age unknown',
        )
    finally:
        capture.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--indices', type=int, nargs='+', default=list(range(4)))
    parser.add_argument('--seconds', type=float, default=8)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output already exists; choose a new evidence path')
    rows = [{} for _ in args.indices]
    start = threading.Event()
    threads = [threading.Thread(target=measure, args=(index, args.seconds, start, row), daemon=True)
               for index, row in zip(args.indices, rows)]
    for thread in threads:
        thread.start()
    # All opens happen independently. Release the common measurement window.
    time.sleep(2)
    start.set()
    for thread in threads:
        thread.join(args.seconds + 10)
    report = dict(devices=enumerate_usb_devices(), cameras=rows,
                  hung_threads=[index for index, thread in zip(args.indices, threads) if thread.is_alive()])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
