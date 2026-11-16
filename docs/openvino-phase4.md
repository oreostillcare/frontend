# OpenVINO Phase 4: physical dual-USB video

Measured on 2026-11-16, Asia/Singapore. Two physical USB inputs captured
simultaneously. RTSP hardware was unavailable and was not required for these
checks. Original dual FP32 exports, image size 640, shared requests and LATENCY
remain selected. No physical signal control was exercised.

## Effective configuration and device discovery

The shared workspace `.env` initially selected Camera A as `rtsp` and Camera B
as `disabled`, with mirror off, observation-only on, raw stream target 10 FPS,
capture request 60 FPS, `WEB_CAMERA_INDEX=1` and `LOGI_C270_CAMERA_INDEX=2`.
Those settings do not enable today's two USB cameras. The environment file was
not edited; ordinary startup still uses those original source settings.

Initial DirectShow and Windows device queries exposed only `Web Camera` at 0.
The subsequent physical capture check found both devices. This transient
discovery discrepancy is retained rather than assuming a cable or driver fault.
DirectShow indices are discovery order and must be rechecked after reconnecting.

| Physical input | DirectShow index | Actual decoded resolution | Concurrent raw capture FPS | Mean read/decode ms | Maximum read/decode ms |
| --- | ---: | --- | ---: | ---: | ---: |
| Web Camera | 0 | 640 x 480 | 29.33 | 33.67 | 240.69 |
| DV20 USB CAMERA | 1 | 640 x 480 | 20.80 | 47.59 | 219.06 |

Both handles were open together during the eight-second check. Indices 2 and 3
did not open. Both cameras returned changing decoded images; average small-frame
pixel differences were 2.01 and 7.52. Changing pixels do not establish unique
sensor exposure timestamps. Both reported FOURCC YUY2 and rejected
`CAP_PROP_BUFFERSIZE=1`. FPS properties initially returned -1; the application
later reported about 60 after requesting 60, while measured delivery remained
about 30/21. Requested/reported FPS is therefore not a measured capture rate.

Evidence: `output/phase4-openvino/usb-capture-before.json`.

## Streaming measurements

The real Flask app ran through an opt-in launcher with temporary USB sources 0/1,
mirror disabled, observation-only enabled, ESP32 control and heartbeat disabled,
and Firestore upload disabled. All sampled status responses confirmed
`observationOnly=true`. No model or scheduler setting changed.

Baseline ten-second receipt checks with the original 10 FPS raw target measured
9.24/9.25 FPS directly and 9.38/9.31 through the existing Next.js rewrite.
Annotated delivery was about 1.3-1.5 FPS. The first measurement script used the
wrong telemetry path (`/api/system`); its HTTP video measurements remain valid,
but its telemetry samples are 404 errors. This was corrected to
`/api/system/status` before subsequent measurements.

After the pacing change, the existing 10 FPS target still delivered about
9.3 FPS, with mean raw capture-to-receipt age 27/32 ms. This does not establish
a measured speed improvement from pacing alone. Raising the target was a
temporary launcher argument, not a persistent environment or default change.

The final ten-second run used a 30 FPS raw target and waited for both detectors
to complete inference before starting. Eight HTTP consumers exercised both
cameras, direct/proxied and raw/annotated, concurrently; viewers shared encoders.

| Path, final warmed run | Camera A FPS | Camera B FPS | Mean age A/B ms | p95 age A/B ms |
| --- | ---: | ---: | --- | --- |
| Direct Flask raw | 23.72 | 19.60 | 21.48 / 7.05 | 40.12 / 27.65 |
| Next.js proxy raw | 23.78 | 19.64 | 26.71 / 12.66 | 51.63 / 41.70 |
| Direct Flask annotated | 0.91 | 0.81 | 1087.75 / 1211.60 | 2949.13 / 3125.06 |
| Next.js proxy annotated | 1.12 | 1.00 | 888.42 / 999.29 | 2040.59 / 2413.66 |

FPS counts completed JPEG parts over their actual first-to-last receipt interval.
The slower annotated readers can finish a blocking read beyond the nominal
window; their accepted frame subsets and intervals differ. All eight received
source-sequence lists were strictly increasing. Neither a repeated cached JPEG
nor a source-sequence gap was counted as additional AI work.

These ages start **after OpenCV read/decode** and end at HTTP receipt in another
process on the same host monotonic clock. They exclude exposure, camera firmware,
USB/driver queue age and browser presentation. Maximum raw ages were 187/115 ms
direct and 364/256 ms proxied. No glass-to-glass latency claim is made.

Telemetry sampled capture delivery at means 29.99/20.78 FPS. The legacy smoothed
AI FPS field averaged 1.46/0.98; it is distinct from measured JPEG receipt FPS.
Detection completion ages averaged 1013/1013 ms and processing times about
1001/995 ms. Raw JPEG encoding samples averaged 4.21/2.59 ms. Process CPU averaged
110.2% under psutil's one-logical-core convention (about 27.5% of four logical
CPUs); RSS averaged 670 MiB. System CPU samples returned 0 and are not interpreted
as idle-host evidence. Final memory use was about 78%, versus 95-96% during an
earlier dashboard compilation attempt. These are short, uncontrolled-load checks,
not a causal speedup benchmark or a sustained 30 FPS guarantee.

An earlier cold 30 FPS run timed out waiting for annotated frames while native
models initialized; capture/raw streaming continued. Both inference workers
subsequently produced results. Its failed annotated requests remain in
`streams-after-30fps.json`. The final readiness-gated report is
`streams-final-30fps.json`; aggregate telemetry and sequence audits are in
`final-summary.json`.

## Browser and dashboard limits

Installed Edge rendered both physical feeds with native `img` elements, using
the dashboard's existing raw URLs and rendering approach. A four-image diagnostic
observed pixel-change rates 9.40/9.65 FPS direct and 2.41/2.41 proxied. A bounded
follow-up with only the two proxy images observed 9.58/9.41 pixel changes/second,
first pixels after 3.25/3.57 seconds, and no image errors. RequestAnimationFrame
sampling, unchanged pixels, loading time and CPU contention limit these estimates;
they are not exact decoded/display FPS or sensor latency measurements.

Proxy browser responses were HTTP 200, multipart/chunked, `no-store,
no-transform`, `X-Accel-Buffering: no`, and had no Content-Encoding. Gzip was not
present in that probe. Native image load events fired within 3.7 seconds, before
the dashboard's ten-second annotated fallback deadline. The initial diagnostic
used a page origin outside the configured CORS allowlist; it was corrected to
the allowed localhost origin without editing `.env`.

The authenticated monitoring page initially exceeded a 60-second compilation
timeout. The later page rendered `Checking session...` with zero camera images
and no page JavaScript errors. No credentials or session were supplied, and
authentication was preserved. **Actual authenticated dashboard video was not
verified.** Separate native-image probes verify the browser/proxy path only.
Artifacts: `browser-30fps.json`, its dashboard screenshot, and
`browser-proxy-only.json`. Browser startup/rendering delays remain a limitation
despite near-equal direct/proxy HTTP throughput.

## Changes and delay diagnosis

- Raw encoding remains a viewer-only thread reading a one-frame overwrite
  buffer. All raw viewers share one JPEG encode; no inference or traffic
  transaction callback runs in the raw path.
- Raw pacing includes capture wait/copy/encoding time in each period instead
  of adding a full period after encoding. Capture continues independently.
- Capture/raw FPS now count frames over windows of at least one second.
  Instantaneous reciprocal smoothing had reported over 1000 capture FPS and
  over 50 raw FPS during driver catch-up bursts. These were metric artifacts.
  Raw counters reset between viewer generations and reconnects.
- Both multipart outputs include Content-Length and source-frame sequence,
  capture and encoded monotonic timestamps. Each metadata tuple is published
  atomically with its own JPEG, so telemetry cannot relabel another frame.
- Video responses discourage transformation/proxy buffering. This cannot
  eliminate TCP or browser queues for a slow client. A generator backpressure
  test confirms it resumes at the latest cache rather than replaying a Python
  frame queue; network-level slow-client latency was not established.
- `telemetry.video` separates raw FPS, encoder time, cached raw age, dimensions,
  reported FPS, buffer acceptance and source sequence from existing AI metrics.
  `frameAgeMs` remains detection completion age; the dashboard's existing FPS
  and Frame age labels still refer to AI, not raw video. No frontend code changed.

The evidence establishes independent fast capture/raw streaming alongside much
older annotated results. Detector computation and lock waits dominate annotated
age; JPEG encoding alone does not explain one-second results. A recent telemetry
arrival or responsive box update does not prove that its source image is recent.
Annotated boxes stay baked into the frame actually processed. Raw images have no
boxes; latest detection results must not be drawn onto newer raw frames without
matching the source sequence. This phase adds that diagnostic identity but does
not introduce a frontend overlay or fix the previously documented traffic
callback-arrival freshness issue.

USB read time includes delivery/conversion/decode and was not split into those
driver stages. Buffer-size rejection means a one-slot application cache does not
prove a one-slot driver queue. Sensor timestamps or a camera-visible clock are
still needed to measure driver age and glass-to-glass latency. CPU/memory pressure
and browser rendering remain plausible contributors; no single browser root
cause was established.

## Offline validation and compatibility

Recording inventory found the existing Phase 2 translated-bus AVI fixtures, not
representative road-camera recordings or independently labeled vehicle events.
Phase 3's existing complete-sequence results and accuracy limitations remain
applicable: synthetic diagnostics cannot establish roadside precision/recall,
identity accuracy or counting error. No model replay benchmark was repeated for
these streaming changes. Targeted detector/tracking tests were run; no new
offline road-accuracy claim is made.

Reused Phase 3 evidence includes the complete 126-frame FP32/640 replay: semantic
detection/track/crossing parity passed against the original path, but global
identity equivalence failed at sequences 40 and 45. That unresolved timing-based
identity limitation remains; streaming metadata is not an accuracy fix.

USB DirectShow discovery/reconnect checks and RTSP FFmpeg timeouts, masked
credentials, configured sources and existing routes remain intact. RTSP unit
coverage passed; physical RTSP operation was not tested. Physical signal timing,
interlocks, controllers and detection/counting algorithms were not altered.

## Validation, preservation and reproduction

Targeted camera, API, configuration, USB discovery, detector and tracking tests
finished with **142 passed in 8.22 seconds**. Python compilation, JavaScript
syntax and `git diff --check` also passed. No full suite or model benchmark ran.
New coverage
checks exact multipart metadata, inference independence, encoder pacing, viewer
generation resets, latest-frame backpressure and burst-resistant FPS. One native
critical reviewer performed read-only inspection, identified three issues which
were corrected, and found no material blocker in the final reviewed delta. It
did not perform independent hardware validation. No other subagent was spawned.

Protected SHA256 snapshots cover the workspace environment, model artifacts,
inference/configuration/control files and all four custom agent definitions plus
their configuration. All **19 protected files matched** before/after. Existing unrelated edits and Phase 1-3 evidence were
preserved. Test Flask/Next.js processes were stopped after measurement.
Socket checks confirmed ports 3000 and 5000 were no longer listening.

From the checkout root, use new output paths to preserve evidence:

```powershell
.\backend\.venv\Scripts\python.exe backend/scripts/check_usb_capture.py --indices 0 1 2 3 --seconds 8 --output output/phase4-openvino/recheck-capture.json
# Separate terminal; temporary settings only, observation-only and no hardware I/O:
.\backend\.venv\Scripts\python.exe backend/scripts/phase4_usb_server.py --indices 0 1 --raw-fps 30
# Separate terminal, existing frontend command; then measure after readiness:
npm.cmd run dev -- --hostname 127.0.0.1
.\backend\.venv\Scripts\python.exe backend/scripts/measure_usb_streams.py --seconds 10 --output output/phase4-openvino/recheck-streams.json
node backend/scripts/check_usb_browser.mjs output/phase4-openvino/recheck-browser.json
.\backend\.venv\Scripts\python.exe -m pytest backend/tests/test_camera.py backend/tests/test_app.py backend/tests/test_config.py backend/tests/test_usb_devices.py backend/tests/test_detector.py backend/tests/test_tracking.py -q
```

The optional server launcher overrides only the running Python Settings instance;
normal `.env` loading deliberately overrides shell variables. Recheck device
names/order before reuse. Stop each test server with Ctrl+C. Rollback means
reverting only the Phase 4 camera/header/test delta and removing the opt-in scripts
and report if desired; do not reset pre-existing workspace changes. Persistent
source configuration still requires selecting USB and discovered indices for
both cameras. Preserve observation-only operation for camera development.
