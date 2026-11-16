# OpenVINO Phase 5: maximum safe detection FPS investigation

Measured on 2026-11-16, Asia/Singapore. **Keep dual FP32/640, CPU,
shared requests and LATENCY. No production optimization is promoted.** Intel GPU
enumeration succeeds, but both original models crash in standalone GPU probes.
The exact native failure stage is unknown. Smaller inputs already showed class
and crossing drift in Phase 3.
No repeatable, accuracy-qualified increase in sustained dual-camera FPS has been
established. This is a completed investigation with blocked promotion, not a
claim that the hardware has reached a proven maximum.

## Scope and reused evidence

The main agent used Ponytail Lite, Caveman and the project RTK wrapper for
read-only Git status. One native `critical_reviewer` performed independent
read-only review of these experiment tools and this report. No nested agents.

Read and reused [Phase 1](openvino-phase1.md), [Phase 2](openvino-phase2.md),
[Phase 3](openvino-phase3.md) and [Phase 4](openvino-phase4.md):

- Phase 1 identified dual network passes and CPU contention; capture already has
  one overwrite slot. Its benchmark definitions and measurement limits apply.
- Phase 2's three final shared/independent latest-frame comparisons showed
  changes of -59.9%, -13.1% and +1.3% under changing background load. Independent
  requests and THROUGHPUT were not promoted; do not repeat that matrix without a
  new hypothesis or controlled load.
- Phase 3 tested 416/512 and audited calibration, labels and checkpoints.
  Those experiments are reused below rather than repeated.
- Phase 4 measured physical USB capture and raw HTTP delivery. Its final direct
  raw FPS was 23.72/19.60; proxied raw was 23.78/19.64. AI telemetry averaged
  1.46/0.98 FPS with about 1000 ms processing. Raw and AI measurements are
  different. The current user baseline of about 1.4 detection FPS per camera is
  an observation, not a new Phase 5 live measurement.

Phase 5 ran only original-model standalone device probes and one paired CPU
stage/equality diagnostic. No Flask, browser, USB capture, controller or upload
service was started. Live USB streaming was not repeated because no candidate
passed the prerequisite GPU/accuracy gates. Ordinary source settings still select
the workspace environment described in Phase 4; benchmarks do not enable cameras
in production or persist launcher overrides.

## Available acceleration devices

Read-only Windows CIM discovery needed sandbox escalation; it completed after
approval. Hardware results are retained in
`output/phase5-openvino/context.json`. OpenVINO discovery and raw properties are
in `output/phase5-openvino/devices/summary.json`.

| Device | Verified identity | Installed Windows driver | Installed OpenVINO result |
| --- | --- | --- | --- |
| CPU | Intel Core i5-7200U, 2 physical cores / 4 logical CPUs | n/a | CPU enumerated; FP32 inference succeeds |
| Intel GPU | Intel HD Graphics 620, integrated | 24.20.100.6292 | GPU enumerated; real-model probes crash |
| NVIDIA GPU | **GeForce 940MX**, Windows-reported 2 GiB AdapterRAM | 25.21.14.1735 | Not enumerated by installed OpenVINO |

OpenVINO is `2026.4.1-22982-e213a147257-releases/2026/4`. No NPU or other
inference device was enumerated. CPU advertises FP32/INT8/BIN; Intel GPU
advertises FP32/FP16/BIN, not INT8. Capabilities are discovery metadata, not a
successful model-execution test. Installed PyTorch is CPU-only; this phase did
not install CUDA, an NVIDIA plugin or another runtime.

Windows reports 1 GiB AdapterRAM for Intel GPU. OpenVINO reports
`GPU_DEVICE_TOTAL_MEM_SIZE=3383427072` (3226.69 MiB) and
`GPU_DEVICE_MAX_ALLOC_MEM_SIZE=1691713536` (1613.34 MiB). These are reported
plugin limits, not measured free or dedicated VRAM. Initial plugin memory
statistics were all zero before compilation. Host physical memory totals
8066.72 MiB; discovery found 70.6% used, with about 2374.86 MiB available.

The [OpenVINO GPU guide](https://docs.openvino.ai/2026/openvino-workflow/running-inference/inference-devices-and-modes/gpu-device.html)
documents GPU properties and shape-dependent compilation. Intel also documents
[GPU crashes with older graphics drivers](https://www.intel.com/content/www/us/en/support/articles/000103062/software/development-software.html).
That makes a driver/runtime compatibility problem plausible here; this is an
inference, not a diagnosed cause. No BIOS, firmware, driver or dependency changed.

## Standalone model latency and GPU compatibility

`benchmark_openvino_devices.py` validates original export manifests, reads IRs
without modifying them, and launches one fresh subprocess per model/device/shape
case, bounded to 90 seconds. Five warmup requests precede 40 measured requests.
The input is the installed stock bus photograph, RGB float32 / 255, BCHW
`1,3,640,480`. Static probes reshape only the in-memory graph to that same shape.
The request uses LATENCY and an FP32 precision hint; successful CPU compilation
reports CPU execution and FP32. No AUTO fallback can count a failed GPU as CPU
success. Raw latency includes synchronous request execution and output copies;
it excludes preprocessing, NMS, ByteTrack, decoding and camera scheduling.

| Model / target | Shape policy | Mean / p50 / p95 inference ms | Process CPU, host % | System CPU % | Mean RSS MiB | Mean system RAM % |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Local / CPU | Original dynamic graph | 70.14 / 69.14 / 82.04 | 44.51 | 56.01 | 307.53 | 73.75 |
| COCO / CPU | Original dynamic graph | 82.51 / 73.95 / 166.89 | 43.25 | 62.20 | 316.62 | 73.73 |
| Local / GPU | Dynamic and static, separately | No completed latency report: native crash | n/a | n/a | n/a | n/a |
| COCO / GPU | Dynamic and static, separately | No completed latency report: native crash | n/a | n/a | n/a | n/a |

All four GPU children exited `3221225477`, hexadecimal `0xC0000005` (Windows
access violation). Child lifetimes were
15.88/10.61 seconds for dynamic local/COCO and 10.78/9.37 seconds for static
local/COCO; **these are not inference latencies**. Individual result files retain
the last `compiling` marker; the supervisor summary records each as failed.
The worker writes that marker before compilation and writes its next report only
after measured inference completes. Thus the crash could be during compilation,
request creation, warmup or inference; the evidence does not locate it further.
No benchmark child timed out. No GPU output or accuracy comparison exists.
Discovery alone does not establish usable HD 620 inference compatibility.

| Local allocation | COCO allocation | Outcome / FPS per camera |
| --- | --- | --- |
| CPU | CPU | Successful paired pipeline diagnostic: 3.04/3.04 replay FPS; live evidence reused from Phase 4 |
| GPU | GPU | Blocked by both standalone native failures; FPS unavailable |
| CPU | GPU | Blocked by COCO GPU native failure; FPS unavailable |
| GPU | CPU | Blocked by local GPU native failure; FPS unavailable |

Running combined GPU allocations after their individual graphs crash would not
provide a meaningful performance comparison. No split-allocation throughput,
GPU utilization, GPU peak memory, or concurrent CPU/GPU contention result is
claimed. Static shape did not resolve the native failure. No allocation error or OOM
diagnostic was returned; the access violation does not establish memory
exhaustion. Shared host RAM and bandwidth remain possible contention sources
for future working iGPU trials, not measured causes here. Avoid increasing
streams or concurrent GPU requests on the strength of nominal memory limits.

## CPU stage costs and repeated preprocessing

New evidence: `output/phase5-openvino/stages.json`. The existing matrix worker
ran two independent Detector/ByteTrack sessions through both original models,
shared/LATENCY, automatic budgets resolving to 2 OpenVINO threads and 1 stream
per graph, and one PyTorch intra-op thread. It decoded the existing synthetic
translated-bus AVI, excluded five warmup pairs and measured 40 synchronized
pairs. This is a short, instrumented compute diagnostic, not a sustained live
comparison. Each stage below has 40 samples per camera.

| Mean wall stage ms | Camera A | Camera B |
| --- | ---: | ---: |
| Local preprocessing, method body | 5.64 | 4.93 |
| Local inference | 136.09 | 73.53 |
| Local postprocessing, method body | 1.46 | 1.38 |
| Local ByteTrack callback group | 1.20 | 1.31 |
| COCO preprocessing, method body | 5.35 | 5.73 |
| COCO inference | 78.11 | 144.44 |
| COCO postprocessing, method body | 1.66 | 1.72 |
| COCO ByteTrack callback group | 0.96 | 1.00 |
| Python model-lock waits, sum | 91.94 | 0.003 |
| Crossing / line tracking | 0.057 | 0.061 |
| Global identity | 0.293 | 0.665 |
| Incoming ledger | 0.026 | 0.029 |
| Annotation | 0.327 | 0.496 |
| Full detector wall | 327.21 | 240.24 |

AVI read/decode averaged 4.17 ms, p95 4.80 ms, once per pair, outside detector
timers. This is file decoding, not USB delivery. Phase 4's concurrent physical
USB read/decode means were 33.67/47.59 ms, including waiting for frames and
conversion. Those capture threads run independently; neither decode measurement
is an additive prediction of live detection FPS. Sensor/firmware/driver stages
were not separately measured.

The paired diagnostic completed 6.075 aggregate FPS, **3.038 per session** over
13.17 measured seconds. Pair latency p95 was 344.36 ms. Process CPU was 180.23%
using one logical core as 100%, or 45.06% normalized over this host; system CPU
was 55.65%. Mean process RSS was 579.08 MiB and system used RAM about 5902.9 MiB
(73.2%). Different lock ownership explains asymmetric session timings; neither
reciprocal detector wall time nor aggregate FPS is per-camera live FPS. Previous
free-running Phase 2 results remain the better evidence for scheduler effects.

Instrumentation wraps predictor methods and the postprocess-end callback group;
the latter includes tracker callback overhead, not only ByteTrack's assignment
kernel. Native inference timing includes scheduling inside OpenVINO. Ultralytics
outer speed timers are also retained in JSON; they include wrapper overhead and
must not be added again to method-body timings. Extra tensor copies and equality
checks occur outside the method-body preprocess timer and inflate detector wall
time. No speedup claim compares this instrumented run with earlier phases.

Both models produced **exactly equal preprocessed tensors on all 40 measured
frames for each session**, actual BCHW `1,3,480,640`. Both need the same
letterbox, BGR-to-RGB conversion, transpose, normalization and contiguous input
at this geometry. Sharing that work per frame is a concrete opportunity. One
COCO preprocess body costs about 5.35/5.73 ms here: roughly 1.6%/2.4% of each
session's detector wall time as a simple subtraction, not a throughput estimate.
That potential saving excludes additional copy/binding costs and changed overlap.

No preprocessing cache was connected to production. Safe sharing needs guards
for frame identity, geometry, stride, dtype, normalization, padding and ownership;
invalidate on reconnect, new generation or setting changes. Retain each model's
original-image postprocessing, class filtering and ByteTrack callbacks. Equality
on one synthetic sequence cannot establish those conditions for every source.
Implementing and promoting such a cache without a repeatable win would add
complexity for an unqualified benefit.

Other computation findings:

- Installed Ultralytics compiles a backend during each lazy predictor setup;
  `predictor_factory` subsequently substitutes the pool's explicitly configured
  compiled graph. Extra initial compilation is startup work, not evidence of a
  duplicated steady-state inference pass. Removing it is a separate adapter
  change needing backend metadata/warmup and lifecycle validation.
- The two differently trained graphs cannot share their learned backbone
  activations merely because preprocessing matches. Neither model is disabled,
  skipped on alternate frames, or used only when the other returns empty.
- Class filtering and fusion do not eliminate either network's forward pass.
  Deleting ByteTrack/crossing/identity work would violate requirements and target
  stages much smaller than inference. Existing independent raw JPEG streaming
  already avoids inference-driven raw-frame delivery.

## Classes, calibration, 416/512 accuracy and tracking

Re-read local IR metadata and manifest: `0=tricycle`, `1=ebike`, `2=jeepney`.
Production also retains COCO car, motorcycle, truck, bicycle and bus. The separate
`best.pt` has 13 classes, as inspected safely in Phase 3; it is not the deployed
three-class local IR and is not substituted. Original `trained_local.pt` and
`yolov8n.pt` remain absent. Existing IRs and `best.pt` are preserved; no checkpoint
was retrained, unpickled or overwritten.

Rechecked `backend/datasets/`: only `.gitkeep`. A repository file inventory
found no new road dataset or recording. Reused Phase 3's broader workspace and
named-backup audit; no duplicate backup scan. Existing stock images, dashboard
screenshots and synthetic replay are not representative calibration data.
**Calibration can use unlabeled representative images. Accuracy validation
requires independent labels; tracking/count validation also needs identities and
events.** Neither requirement is met for both viewpoints and Philippine classes.
INT8 remains blocked for both models; no quantizer installation or fake
stock-image calibration was performed. Phase 3 documents IR-based post-training
quantization, which does not require retraining or recovering the original PT.

Reused Phase 3's successful 126-frame, same-sequence CPU replay:

| FP32 requested size | Actual landscape H x W | Replay FPS A/B | Local inference A/B ms | COCO inference A/B ms | Mean RSS MiB |
| --- | --- | --- | --- | --- | ---: |
| 640 | 480 x 640 | 2.00 / 2.00 | 216.4 / 222.2 | 232.4 / 225.6 | 629.6 |
| 512 | 384 x 512 | 3.02 / 3.02 | 141.1 / 137.6 | 147.5 / 150.8 | 579.7 |
| 416 | 320 x 416 | 4.93 / 4.93 | 83.8 / 85.1 | 88.3 / 87.4 | 555.0 |

These are previously measured exploratory results, not newly validated settings.
Against 640, each smaller candidate had 12 unmatched reference and 12 unmatched
candidate observations, zero final passed-count drift, but **34 crossing-flag
mismatches and 6 intermediate ledger-membership and 6 ledger-point mismatches**
across both sessions. Mean matched-box IoU was 0.972 at 512 and 0.968 at 416.
The 640 output included 12 bus and 146 jeepney labels; 512/416 instead had zero
bus and 158 jeepney labels. Agreement is not labeled precision/recall.
Matching final counts does not validate intermediate traffic observations.

Even original versus isolated 640 replay had the previously reported global-ID
equivalence failure at sequences 40/45. No Phase 5 change repairs it. No new
accuracy, track-ID, crossing, count or Philippine vehicle recall result is
claimed. Both 416 and 512 execute successfully but **remain experiment-only**.

## Implemented work, validation and preservation

Added experiment-only tools:

- `backend/scripts/benchmark_openvino_devices.py`: device/property discovery,
  original-export validation, bounded standalone CPU/GPU compilation and latency,
  static in-memory compatibility checks, explicit native failure evidence.
- `backend/scripts/profile_openvino_stages.py`: existing paired matrix with
  method/callback timing, file decode timing and cross-model tensor equality.
- Matching tests and retained evidence under `output/phase5-openvino/`.

There is **no production performance patch**. No verified candidate justified
promotion. Defaults, both exports, class selection, ByteTrack, crossing logic,
one-frame capture overwrite, raw streaming, timestamp/freshness checks and
physical traffic-light behavior remain intact. The known downstream callback-
arrival timestamp limitation from Phases 1–4 remains; this investigation is not
a freshness or traffic-safety fix. No hardware-control validation is claimed.

Targeted tests: **77 passed in 7.22 seconds**. Command from checkout root:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest backend/tests/test_benchmark_openvino_devices.py backend/tests/test_profile_openvino_stages.py backend/tests/test_benchmark_openvino_matrix.py backend/tests/test_benchmark_worker_timing.py backend/tests/test_inference_runtime.py backend/tests/test_detector.py backend/tests/test_tracking.py backend/tests/test_benchmark_openvino_models.py -q
```

Coverage includes crash classification without fallback or fabricated latency,
watchdog dispatch, continued failed-case reporting, existing-evidence protection,
unsupported properties and restoration of instrumented functions on failure.
Existing runtime, detector, tracking and benchmark tests remain passing. No full
suite or frontend tests were needed for these isolated diagnostic additions.
Python compilation and `git diff --check` passed. Explicit whitespace checks also
cover the new untracked files. Evidence-consistency assertions passed: two CPU
successes, four GPU failures without fabricated latency, 40 measured frames and
stage samples per session, and exact tensor equality. All **24 protected files**
match before/after SHA256 snapshots: existing model artifacts and `best.pt`,
workspace environment, inference/camera/configuration, tracking/identity/traffic
modules and custom-agent configuration. Snapshots were taken after diagnostic
file creation; those operations did not edit protected files. Earlier workspace
changes and Phase 1–4 artifacts were preserved.

The native critical reviewer found one reporting error: the original progress
marker could not establish that GPU crashes happened during compilation.
The report and context now state the exact native stage is unknown. The reviewer
found no other material blocker, did not rerun benchmarks/tests and did not
validate hardware or diagnose the GPU root cause. No additional native benchmark
was needed to correct that claim. Validation summary:
`output/phase5-openvino/validation.json`.

## Recommendation and reproduction

Retain **both original FP32/640 CPU models, shared/LATENCY**, existing thread and
stream defaults, capture freshness safeguards and independent raw-video path.
No persistent environment edits are required; current production is the rollback.
Keep the Phase 4 raw-video improvements and distinguish raw FPS from AI FPS.

Next useful input is representative footage from both deployed viewpoints,
including tricycle, ebike, jeepney and retained COCO classes under varied lighting,
distance and occlusion. Split unlabeled calibration from labeled evaluation and
annotate identities/crossings/counts. Only then qualify 512/416 or isolated INT8.
GPU work needs a separately authorized compatible driver/runtime investigation;
do not retry allocations in production on the current failing GPU stack. No
automatic driver/firmware/BIOS update is part of this recommendation.

Reproduction uses new paths; retain failed attempts. Run only one native
experiment at a time. The device supervisor supplies its own watchdog:

```powershell
.\backend\.venv\Scripts\python.exe backend/scripts/benchmark_openvino_devices.py --source backend/.venv/Lib/site-packages/ultralytics/assets/bus.jpg --output output/phase5-openvino/recheck-devices --frames 40 --warmup 5 --timeout-seconds 90
# Bounded stage profiler; no application/controller imports:
.\backend\.venv\Scripts\python.exe -c "import sys; sys.path.insert(0,'backend'); from scripts.benchmark_openvino_matrix import run_bounded; r=run_bounded([sys.executable,'backend/scripts/profile_openvino_stages.py','--source','output/phase2-openvino/fixtures/translated-bus-episodes.avi','--output','output/phase5-openvino/recheck-stages.json','--frames','40','--warmup','5'],cwd='.',timeout=180); print(r.stdout); print(r.stderr); sys.exit(r.returncode)"
```

Remove only Phase 5 diagnostic additions if rollback of tooling is wanted. Do not
reset existing workspace edits or delete earlier evidence/checkpoints. No service
restart or production model restoration is necessary for this phase.
