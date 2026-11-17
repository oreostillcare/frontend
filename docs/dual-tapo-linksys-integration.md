# Dual Tapo RTSP over Linksys LAN

## Baseline and scope

Started from `release/smartroad-v2.0.5-verified`, commit
`1d3f6cc35ee7849bf169aa1e22ba5bae46be0753`, on local feature branch
`feat/smartroad-v2.0.5-dual-tapo-rtsp`. The release branch is unchanged.
The five untracked `output/phase*-openvino/` directories are preserved reference
artifacts, not integration edit targets. No push, merge, Firebase production
write, or hardware signal operation is part of this integration.

## Inspected configuration and architecture

Inspected the actual workspace `.env` without printing its values. Neither the
checkout nor backend had a private `.env`; their `.env.example` files document
defaults. `backend/config.py` loads workspace `.env` first, otherwise checkout
`.env`, otherwise backend `.env`, with `override=True`. It does not load
`.env.local`. Next.js also reads the workspace file through `next.config.mjs`.
Private camera settings have no `NEXT_PUBLIC_` prefix and are not sent to clients.

The initial environment selects Camera A RTSP, Camera B disabled, shared stream1,
and OpenVINO. Both private URLs are present; their literal suffix is stream2,
but the shared quality setting changes the effective profile to stream1.
Observation-only defaults to true and display mirroring defaults to false.
No private environment values were changed or copied into this report.

Relevant inspected files include `backend/app.py`, `backend/config.py`,
`backend/modules/live_monitoring/{camera_capture,vehicle_detector,vehicle_identity,
inference_runtime,inference_performance,usb_camera_devices}.py`,
`backend/modules/timer_batching/timer_batch_manager.py`,
`backend/modules/traffic_decision/traffic_control.py`, camera/config/app/tracker/
identity/scheduler tests, `backend/scripts/{check_usb_capture,smoke_camera_views,
smoke_production,benchmark_live}.py`, `package.json`, `next.config.mjs`,
`playwright.config.ts`, and `src/modules/live-monitoring/camera-card.tsx`.

Existing architecture already assigns Camera 1 to Node A and Camera 2 to Node B.
Each worker owns its capture, newest-frame buffer, detector and tracker sessions.
Model weights and configured OpenVINO request scheduling remain shared as before.
The registry intentionally supports vehicle handoff between cameras, while local
track bindings include camera identity. Monitoring encodes the same decoded
frames rather than opening additional RTSP sessions for viewers.

## Server-side configuration

Reuse these existing keys:

| Key | Purpose |
| --- | --- |
| `CAMERA_1_SOURCE`, `CAMERA_2_SOURCE` | `usb`, `disabled`, or `rtsp` independently |
| `CAMERA_1_RTSP_URL`, `CAMERA_2_RTSP_URL` | Independent private endpoints |
| `CAMERA_STREAM_QUALITY` | Shared `stream1`/`stream2` override |
| `RTSP_TIMEOUT_MS` | FFmpeg open/read timeout |
| `CAMERA_RECONNECT_SECONDS` | Initial retry delay |
| `RAW_STREAM_FPS`, `DETECTION_FPS` | Existing viewer and inference pacing |
| `ENABLE_NODE_B_DISPLAY_MIRROR` | Explicit development display-only mode |
| `SMARTROAD_OBSERVATION_ONLY` | Blocks ESP32 I/O and automatic operation |

New optional keys:

| Key | Default/purpose |
| --- | --- |
| `CAMERA_1_STREAM_QUALITY`, `CAMERA_2_STREAM_QUALITY` | Override shared quality per camera; absent uses shared |
| `CAMERA_1_USERNAME`, `CAMERA_1_PASSWORD` | Optional raw Camera Account fields for Camera A |
| `CAMERA_2_USERNAME`, `CAMERA_2_PASSWORD` | Optional raw Camera Account fields for Camera B |
| `RTSP_TRANSPORT` | `tcp` (default) or `udp`, shared process setting |
| `CAMERA_STALE_SECONDS` | 5 seconds without a fresh capture/result |
| `CAMERA_REPEAT_SECONDS` | 10 seconds of identical RTSP image content |
| `CAMERA_RECONNECT_MAX_SECONDS` | 30-second upper retry delay |

Keep separate username/password fields absent when retaining authenticated URLs.
When using the separate fields, configure both for that camera; the backend
percent-encodes the raw values, including reserved characters. Existing encoded
URL credentials remain supported. Never put a private endpoint into browser
configuration, command-line arguments, issue reports, or Git. URLs are excluded
from settings representations. Native FFmpeg/OpenCV logs are disabled because
they can contain private URLs; application diagnostics use sanitized fault text.
Transport options are set once before workers start, so changing them requires
restarting the backend. This intentionally replaces externally inherited
`OPENCV_FFMPEG_CAPTURE_OPTIONS` with the configured RTSP transport.

## Connect the actual Linksys network

1. Verify each physical model supports RTSP. Create a separate **Camera Account**
   in the Tapo application; do not assume TP-Link cloud credentials work.
2. Join both cameras to the Linksys local Wi-Fi. Connect the computer's physical
   Ethernet adapter to the same router LAN. Avoid guest/client isolation.
3. Obtain the actual camera addresses from the router lease list and reserve
   them with DHCP. Do not carry over old-network addresses without checking.
4. Configure each private endpoint with its verified host, port 554 and supported
   stream path. Set both `CAMERA_1_SOURCE=rtsp` and `CAMERA_2_SOURCE=rtsp`.
5. Set `ENABLE_NODE_B_DISPLAY_MIRROR=false`,
   `SMARTROAD_OBSERVATION_ONLY=true`, `ENABLE_ESP32_POINT_CONTROL=false`,
   `ESP32_HEARTBEAT_ENABLED=false`, and `ENABLE_TRAFFIC_FIRESTORE_UPLOAD=false`
   for supervised integration. Restart the backend after editing configuration.
6. Check both monitoring feeds and physically distinguish A and B by covering or
   moving one view at a time. The source selector remains available; preserve
   `rtsp-1` for Node A and `rtsp-2` for Node B during this validation.

TP-Link documents stream1 as high quality, stream2 as lower quality, and the
Camera Account requirement in its [RTSP setup guide](https://www.tp-link.com/us/support/faq/2680/).
Model support and exceptions are in its [RTSP FAQ](https://www.tp-link.com/us/support/faq/4465/).
The physical camera models are not yet established here; endpoint support still
needs confirmation. No public forwarding is required for this LAN topology.
Once provisioned, video capture uses the local RTSP connection; online Firebase
features may separately require internet access.

## Diagnostics

From the checkout root, run:

```powershell
.\backend\.venv\Scripts\python.exe backend/scripts/check_tapo_cameras.py
.\backend\.venv\Scripts\python.exe backend/scripts/check_tapo_cameras.py --live
```

The first command performs no network I/O and reports source selection, profile,
credential presence, mapping and observation mode. `dualRtspReady` means only
configuration readiness. `--live` runs isolated camera probes concurrently with
hard child-process deadlines. It checks name resolution, TCP connectivity to the
configured RTSP port, DESCRIBE/Basic or Digest authentication, initialization and
first decoded frame. Authentication errors remain distinct from port failures.
Unsupported authentication challenges are explicit; decoder exceptions and child
output are never forwarded. The live command exits nonzero unless both selected
cameras decode a frame. It never imports the traffic-control application.

The existing `/api/cameras` and `/api/system/status` expose per-camera status,
frame/result ages, capture/detection FPS and processing health. Enable
`ENABLE_PERFORMANCE_PROFILING=true` for existing CPU/memory and stage timing
instrumentation. Local frame age measures host receive/decode time, not camera
sensor age or glass-to-glass latency.

Capture status additionally includes `captureError`, `observationFresh`, and
`reconnectAttempts`. Retry delays double after failed opens up to the configured
maximum and reset after successful capture. Open/read timeouts, the latest-frame
buffer and stop-aware waits bound normal software retries and shutdown.
Per-connection generations reject inference and JPEG work from an earlier
session. Stale inference results are discarded before transaction callbacks;
their camera-local state is reset before further observations.

Reconnect resets clear only that camera's ByteTrack history, class locks, queue
ledger and registry bindings. A small ByteTrack subclass preserves the existing
tracking algorithm while preventing Ultralytics constructor/reset calls from
rewinding its process-wide ID counter and corrupting the other camera's IDs.
No inference weights, OpenVINO precision, request mode or scheduling policy changed.

The repeated-image watchdog uses a small pixel sample, not sensor timestamps.
It conservatively faults an unchanged scene as well as a frozen camera; motion
outside sampled pixels may be missed. Tune its interval during supervised scene
validation. No software-only check here proves sensor freshness. A cold native
model initialization that exceeds the freshness limit can also latch a fault;
discarding that old result is intentional, and monitoring can recover while
movement remains inhibited.

## Dashboard and safety

The existing raw `/video/raw/camera/1` and `/video/raw/camera/2` routes and annotated
`/video/camera/1` and `/video/camera/2` routes remain compatible. Next.js proxies
them through `/detection`; no private endpoint is returned. Existing dashboard
cards independently show offline/retrying status and reconnect using these routes.
No UI redesign or unrelated frontend code changes are needed.

Source identity checks reject using one RTSP host for both nodes even with
different accounts/profiles. Host aliases still require physical identity checks.
Readiness also checks worker freshness in addition to the existing queue freshness
and model checks. The existing priority controller inhibits new authorization
when either node is unready and faults an active batch for operator review.
An outage is not evidence that the roadway has cleared. Keep physical signals
disconnected/disabled during these tests and perform separate supervised
interlock, clearance, communication-loss and all-red validation before actuation.
Camera discontinuities and runtime source changes clear the affected queue view
and latch a manager fault, even if reconnection happens between controller polls.
Video recovery does not clear that fault. Existing supervised state reset clears
the latch and consumed track state; observation-only mode intentionally blocks
the hardware reset endpoint. Restart only the monitoring/simulation backend when
starting a fresh lab trial; never interpret a restart as verified road clearance.

## Changed files

| File | Change |
| --- | --- |
| `backend/config.py` | Independent profiles, encoded optional credentials, transport/bounds, URL redaction and source identity |
| `backend/.env.example` | Document new optional settings without private values |
| `backend/app.py` | Freshness readiness, same-host rejection, fault callback and source-change invalidation |
| `backend/modules/live_monitoring/camera_capture.py` | Capture generations, stale/repeated-frame faults, bounded retries, sanitized status and atomic publication |
| `backend/modules/live_monitoring/vehicle_detector.py` | Camera-local tracker reset and monotonic ByteTrack IDs |
| `backend/modules/live_monitoring/vehicle_identity.py` | Camera-scoped registry cleanup |
| `backend/modules/timer_batching/timer_batch_manager.py` | Latched camera faults and queue invalidation |
| `backend/scripts/check_tapo_cameras.py` | Offline check and explicit bounded live/auth/decode probes |
| `backend/tests/test_{app,camera,config,detector,vehicle_identity,tapo_diagnostics}.py` | Focused regressions |
| `docs/dual-tapo-linksys-integration.md` | This report |

Frontend source, Firebase production configuration/data, model artifacts and
the 247 preserved generated files were not changed.

## Executed validation (2026-11-17)

| Check | Actual result |
| --- | --- |
| `backend/.venv/Scripts/python.exe -m pytest backend/tests -q` | **328 passed**, final run |
| `npm.cmd run test:unit` | **179 passed** |
| `node_modules/.bin/tsc.cmd --noEmit --incremental false` | Passed |
| `npm.cmd run lint` | Exit 0; 27 warnings and 20 informational findings in unchanged files/artifacts |
| `npm.cmd run build` | Passed, 61 pages generated |
| `npm.cmd run test:e2e`, existing workspace browser cache | **9 passed**, fresh-server run |
| Existing isolated `run_firebase.py` runner, `demo-smartroad` | **10 emulator rules/lifecycle tests passed**; browser stage **7 passed, 4 failed**, suite exit 1 |
| Native deployed OpenVINO models | Both camera detector sessions processed packaged `bus.jpg` before/after tracker reset, one detection each; separate predictors/track states and reused compiled models verified |
| `backend/scripts/smoke_production.py` | Passed real Next.js-to-fake-Flask telemetry, two annotated MJPEG feeds, local template, monitoring route and ingestion authentication; clean owned-server shutdown |
| Offline camera diagnostic | Passed; reports Camera B disabled and dual-RTSP configuration not ready |
| Explicit live camera diagnostic | Exit 1: Camera A port unavailable; Camera B disabled; no physical frame success |
| Original preservation-manifest SHA-256 audit | **247 files checked, zero changed/missing** |
| Private-value scan of changed/new integration files | Zero matches for actual local secret/RTSP URL values |
| `git diff --check` | Passed |

The Firebase browser failures are: login/protected staff data navigation timeout;
staff-page heading missing during invitation creation; email-change timeout
verification state missing; and the login/logout activity and route-protection
flow. They occur in unchanged frontend/Firebase paths. Their cause has not been
established by this integration, and they prevent claiming that the complete
previous baseline is freshly green. The isolated runner's log is
`../../.tools/post-merge-verification-20261116/firebase-suite-1794900003.log`.
No live Firebase suite or `test:all` was run because the latter includes live
tests. Emulator runs use loopback endpoints, demo project and inert credentials.

Earlier attempts are not counted as passes: PowerShell blocked `npm.ps1` (used
`npm.cmd` instead); the first browser run lacked the default browser-cache path;
a subsequent run had two session-loading assertion failures before the fresh
server run passed all nine. The first emulator attempt passed its ten rule tests
but its browser server hit Next.js's shared development lock while the regular
suite was running. The sequential emulator rerun produced the 7/4 result above.
The first production proxy smoke passed HTTP checks but sandbox permissions
blocked child termination; its exact owned process was stopped with escalation,
then the smoke passed with clean teardown. Intermediate backend failures exposed
test stop fixtures that stopped before the new publication guard; corrected
fixtures and final regressions pass. No assertions or freshness limits were
weakened to obtain these results.

## Git handoff

The implementation was prepared on the feature branch based on the verified
release commit. On 2026-11-17, the user requested publication on the new
`release/smartroad-v2.0.6` branch. Only the fifteen integration files are included;
private environment files and preserved generated outputs are excluded.
The verified v2.0.5 release reference remains unchanged. No merge, reset or
generated-file edit is part of publication. Full baseline signoff still requires
resolving the four Firebase browser failures and supervised physical validation.
Do not treat this branch as road deployment approval.

## Physical validation still required

The inspected physical Ethernet adapter had a link-local address; the active
default route used the MIFI adapter. No Linksys LAN route was verified.
An actual bounded probe against the configured Camera A endpoint resolved its
hostname but could not connect to its RTSP port. Camera B was skipped because
its source was disabled. No frame decode, camera authentication success or
physical dual-camera performance is claimed.

After connecting the final LAN, repeat `--live`, compare stream1 and stream2
using the same scenes, measure both workers' CPU/memory and sustained inference
FPS, verify local operation with WAN disconnected, then disconnect/reconnect
each camera separately. Test incorrect Camera Account credentials, blocked port,
stalled frames, node identity, tracker reset and absence of duplicate crossing
events. Confirm that the healthy camera remains available and faults inhibit
movement. Synthetic/mocked checks do not establish field traffic safety.
