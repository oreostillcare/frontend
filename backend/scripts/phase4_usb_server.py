"""Run the real Flask app with temporary dual-USB, observation-only settings.

Never writes .env. No ESP32 calls, heartbeat, or Firestore writes are enabled.
Inference precision, geometry and scheduling are inherited unchanged.
"""

import argparse
from dataclasses import replace
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--indices', type=int, nargs=2, default=[0, 1])
    parser.add_argument('--raw-fps', type=float)
    parser.add_argument('--port', type=int, default=5000)
    args = parser.parse_args()
    if min(args.indices) < 0 or len(set(args.indices)) != 2:
        parser.error('Two distinct nonnegative physical indices are required')
    import config

    overrides = dict(camera_1_source='usb', camera_2_source='usb',
                     web_camera_index=args.indices[0], logi_c270_camera_index=args.indices[1],
                     node_b_display_mirror=False, observation_only=True,
                     esp32_control_enabled=False, esp32_heartbeat_enabled=False,
                     traffic_firestore_enabled=False, performance_profiling=True)
    if args.raw_fps is not None:
        overrides['raw_stream_fps'] = args.raw_fps
    config.settings = replace(config.settings, **overrides)
    print(json.dumps({'temporary_overrides': overrides, 'image_size': config.settings.image_size,
                      'backend': config.settings.inference_backend,
                      'request_mode': config.settings.openvino_request_mode,
                      'performance_hint': config.settings.openvino_performance_hint}), flush=True)
    import app

    try:
        app.app.run(host='127.0.0.1', port=args.port, threaded=True, use_reloader=False)
    finally:
        app.stop_workers()
        for worker in app.workers.values():
            worker.wait_until_stopped()


if __name__ == '__main__':
    main()
