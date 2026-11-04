# SmartRoad dual USB camera prototype

Branch: `feat/smartroad-dual-usb-camera`, based on pushed OpenVINO commit `4b4ef4e`.
The starting working tree was clean. This branch must be pushed manually; it is
not merged into `main`.

## Configuration and source selection

Install backend requirements in the existing virtual environment:

```powershell
backend\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
backend\.venv\Scripts\python.exe backend/scripts/list_usb_cameras.py
```

On Windows, `pygrabber` enumerates DirectShow video-input names and indices
without opening capture devices. This list includes virtual cameras: a virtual
device is not evidence that a physical webcam is connected. Discovery failure
is reported separately from an empty list. Other platforms retain explicit
configured indices, marked unverified; capture still uses the existing
Windows DirectShow implementation.

After connecting both physical webcams, use the actual listed indices in the
existing local backend environment file:

```dotenv
CAMERA_1_SOURCE=usb
CAMERA_2_SOURCE=usb
ENABLE_NODE_B_DISPLAY_MIRROR=false
WEB_CAMERA_INDEX=1
LOGI_C270_CAMERA_INDEX=2
INFERENCE_BACKEND=openvino
```

The indices above illustrate the existing configured slots, not detected
hardware. `WEB_CAMERA_INDEX` selects Node A; `LOGI_C270_CAMERA_INDEX` selects
Node B despite its historical device-specific name. Do not assume index 0 or
1 is a particular camera. `DV20_USB_CAMERA_INDEX` remains the existing legacy
fallback. Neither active environment files nor credentials belong in Git.

For this implementation, only the three local source/mirror settings were
changed. Existing indices and `INFERENCE_BACKEND=openvino` were preserved.
At validation time, only `OBS Virtual Camera` at index 0 was discovered, so
configured physical slots 1 and 2 remain unavailable. No virtual feed was
substituted for a physical webcam.

Restart Flask after attaching devices or changing environment settings. The
existing selectors at `http://localhost:5000/local` use the discovered catalog,
plus configured unavailable slots, Disabled, and existing RTSP sources.
`GET /api/cameras/sources` exposes the same catalog without RTSP credentials.
Select a separate source for each panel. Assigning a source already owned by
the other node returns HTTP 409; disable that node first when intentionally
moving a camera. Selector changes apply to the current session; update the
local indices for persistence across restarts.

## Observation-only protection

`SMARTROAD_OBSERVATION_ONLY=true` is a new server-side guard, enabled by default.
The previous configuration only provided mirror mode and individual subsystem
flags; it had no independent observation-mode switch. Keep this guard enabled
for all USB and simulated prototype tests, regardless of mirror mode or whether
both cameras are online.

The guard blocks every ESP32 HTTP call, skips heartbeat startup, disables
automatic signal scheduling, and disables the completed-cycle upload writer.
The signal-reset endpoint returns HTTP 409 and its console button is disabled.
Legacy control, heartbeat, and upload flags cannot override the guard. It does
not alter batching, clearance, counting, identity, or Firebase algorithms.
Existing Firebase history can still be read by the frontend.

The example environment also defaults individual physical-control and heartbeat
flags to false. Mirror mode always applies the guard, even if the independent
observation flag is false. Two cameras online must never be interpreted as
permission to operate physical traffic lights.

## Preserved pipeline and streaming

Each node retains its own capture thread, latest-frame buffer, Detector,
ByteTrack sessions, counting state, telemetry, and per-camera guide overrides:

- `CAMERA_1_GUIDE_GREEN_Y_PERCENT` / `CAMERA_1_GUIDE_RED_Y_PERCENT`
- `CAMERA_2_GUIDE_GREEN_Y_PERCENT` / `CAMERA_2_GUIDE_RED_Y_PERCENT`

The existing shared ModelPool, inference locks, FP32 compiled graphs, global-ID
registry, dual COCO/custom YOLO models, confidence/image-size settings and
PyTorch backend option remain intact. Selecting `INFERENCE_BACKEND=pytorch`
remains the explicit fallback; automatic failover was not added.

Flask `/local` retains annotated feeds at `/video/camera/1` and
`/video/camera/2`, overlays, counts, status, FPS, processing and frame-age metrics.
Camera titles show the selected source name and the existing dark layout remains.
Only explicit mirror mode shows the TEST MIRROR label and redirects B's display
to A; B has no independent detections or counts in that mode.

Next.js `/dashboard` and `/dashboard/monitoring` retain the existing shell.
Monitoring uses `/detection/video/raw/camera/1` and
`/detection/video/raw/camera/2`, backed by separate unannotated capture buffers.
The existing annotated fallback is preserved. Viewers share encoders and do not
create additional inference workers.

## Disconnects, reconnects, and limits

An unavailable camera remains offline; the other worker continues independently.
The existing retry interval and latest-frame architecture remain unchanged.
Source replacement waits for capture/processing/encoder threads to stop. If an
old worker remains blocked in its driver, HTTP 503 prevents a replacement worker
from opening the same device; retry after it stops or restart the backend.

Discovered device names are checked again before opening/reconnecting. A changed
or missing mapping is refused rather than silently capturing a different model.
Restart and enumerate again after USB topology/index changes. Discovery is a
startup catalog, not a hotplug selector refresh. Names are not serial numbers:
identical-model webcams can have identical names, and a reordering of those
devices cannot be detected by name alone. Verify each physical view after a
restart and recalibrate that camera's guide positions as necessary. There is
no automatic stable-device-ID remapping. The app prevents duplicate index
assignments in one backend process; run only one backend against these devices.

## Validation results (2026-11-04)

- Backend pytest: 188 passed, including the existing Phase 1 replay regression.
- Frontend unit tests: 152 passed across 14 files.
- TypeScript: `node_modules\.bin\tsc.cmd --noEmit` passed.
- Next.js production build: `npm.cmd run build` passed, including both dashboard
  routes and build-time type checking.
- `verify_inference_backends.py`: six FP32 tensor comparisons and five translated
  packaged-image pipeline comparisons passed. Preprocessing matched; two
  OpenVINO sessions shared compiled graphs while keeping trackers isolated.
  PyTorch comparison passed. This does not establish traffic-scene accuracy.
- Flask test client verified the console, source catalog, independent node
  metadata, raw/annotated streams, mirror behavior, unavailable-camera responses,
  duplicate rejection, blocked worker replacement, and observation safeguards.
- React tests verified separate raw URLs and vehicle metrics for two online
  nodes, plus the preserved mirror and annotated fallback cases.

No physical USB webcams were discovered. Live Flask/Next.js webcam display
verification, disconnect/reconnect testing with hardware, and per-camera FPS,
capture FPS, latency, frame age, process/system CPU, RAM, and dropped/stale/duplicate
frame measurements are **pending**. Mocked sources and packaged-image checks
are not physical camera validation. No live performance benchmark was run.

When both real webcams are connected and services are stopped, the existing
isolated benchmark can perform a short run (replace indices with discovered
physical devices):

```powershell
backend\.venv\Scripts\python.exe backend/scripts/benchmark_live.py --camera-index 1 --camera-index 2 --backend openvino --scenario none --warmup 5 --seconds 30 --diagnostics --no-prompt --output backend/runs/dual-usb/report.json
```

Use one scenario and keep warmup plus measurement below 60 seconds. This tool
blocks signal I/O/uploads and writes diagnostics only under ignored `backend/runs`.
It does not validate the authenticated dashboard or real-world detection accuracy.

## Changed files and publication

- `backend/app.py`, `backend/camera.py`, `backend/config.py`
- `backend/usb_devices.py`, `backend/scripts/list_usb_cameras.py`
- `backend/requirements.txt`, `backend/.env.example`
- `backend/templates/local_monitor.html`
- `backend/tests/test_app.py`, `backend/tests/test_camera.py`,
  `backend/tests/test_usb_devices.py`
- `src/app/(main)/dashboard/monitoring/_components/monitoring-grid.test.tsx`
- `docs/smartroad-dual-usb-camera.md`

No UI primitives, calendar components, skills, models, credentials, local videos,
or benchmark outputs are included. Commit message:
`feat(camera): enable independent dual USB camera testing`.

Push manually from the project root:

```powershell
git push -u origin feat/smartroad-dual-usb-camera
```
