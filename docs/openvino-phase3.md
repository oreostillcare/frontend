# OpenVINO Phase 3: model computation experiments

## Scope and production boundary

Phase 3 investigates model computation on the existing Intel i5-7200U (two
physical cores, four logical CPUs, about 8 GiB RAM). Production remains on both
original FP32 exports, image size 640, shared requests and LATENCY. No application,
camera, controller, environment, traffic-light, Firebase or frontend setting is
changed. The native `fast_explorer`, `deep_thinker`, `critical_reviewer` and
`code_worker` roles performed separate investigations, tool implementation and
review. Independent investigations ran in parallel.

All measurements are offline CPU inference. They do not establish live-camera
FPS, sensor exposure age, RTSP buffering, browser latency or hardware safety.
The Phase 1 and 2 reports remain the reference for previous measurements and the
known callback-arrival freshness limitation.

## Available artifacts and missing data

Both deployed OpenVINO XML/BIN pairs are present and have dynamic FP32 inputs
`?,3,?,?`. The local model has three classes: tricycle, ebike and jeepney. COCO
has 80 classes, of which production retains car, motorcycle, truck, bicycle and
bus. Both execute for every selected frame; fusion, NMS, ByteTrack, identity,
counting and line processing remain in the offline detector path.

`backend/datasets/` contains only `.gitkeep`. Workspace and named-backup inspection
found no representative roadwork calibration images, labeled detection split,
recorded road-camera footage or identity/crossing ground truth. The local model
metadata refers to an absent `local_vehicle_3class/data.yaml`. The selected source
checkpoints `trained_local.pt` and `yolov8n.pt` are absent, although their validated
standalone IR exports are usable.

The installed Ultralytics stock `bus.jpg` and the Phase 2 translated-bus fixture
are explicitly **compute and implementation diagnostics**. They are not roadwork
calibration data or labeled accuracy evidence. Both offline sessions receive the
same recording; this does not reproduce two physical camera viewpoints.

## INT8 investigation and decision

Neither model was quantized. For **both local and COCO**, the result is
`blocked_missing_representative_calibration`; labeled accuracy is
`not_evaluated_missing_labels`. NNCF and ONNX are absent from the installed
Python 3.13.17 environment. Installing a quantizer would not resolve the missing
data, so the working environment and production requirements were retained.

NNCF supports post-training quantization of existing OpenVINO IRs, avoiding a
need to recover the source checkpoints. Its basic flow requires representative
calibration samples; accuracy control additionally needs a validation dataset
and metric. See the official [basic quantization flow](https://docs.openvino.ai/2026/openvino-workflow/model-optimization-guide/quantizing-models-post-training/basic-quantization-flow.html)
and [YOLOv8 accuracy-control example](https://github.com/openvinotoolkit/nncf/blob/develop/examples/post_training_quantization/openvino/yolov8_quantize_with_accuracy_control/README.md).
The example's downloaded COCO dataset is not a substitute for SmartRoad roadwork
data.

The installed Ultralytics exporter uses `nncf.Dataset`, the MIXED preset and an
ignored detection-head scope. A future isolated experiment must verify that scope
against **each** IR, preserve RGB/BCHW/float32 normalization and rectangular
letterboxing, record calibration sample hashes/order, save without FP16 weight
compression, and evaluate independently labeled road footage. Calibrate at the
tested geometry or explicitly qualify calibration reuse. Check actual execution
graphs rather than inferring INT8 execution from filenames or an FP32 inference
precision hint. No INT8 latency, CPU, RAM or accuracy result is claimed here.

## Unified-model investigation

Safe checkpoint ZIP/pickle-opcode inspection, without loading/unpickling weights,
found these `best.pt` classes: etrike, ebike, bicycle, bus, jeepney, motorcycle,
van, pickup, suv, sedan, truck, ambulance, tricycle. This is a candidate for later
evaluation, not a drop-in replacement. It lacks the literal `car` class; sedan,
suv, van and pickup need a documented canonical mapping. Etrike and ambulance
also need explicit handling. Production currently filters the local slot to
three classes, so merely pointing that slot at this checkpoint would discard
other coverage. Running the candidate in both slots would retain duplicate work.

No unified export, training or production replacement was performed. Missing
training provenance, labels and counting ground truth prevent a justified
equivalence claim. `backend/train.py` was not executed because it can copy weights
into a deployed checkpoint path.

## Measurement protocol

The existing matrix tool first reproduces FP32/640 with both models and two
synchronized sessions, 40 measured iterations after five warmup iterations.
Its aggregate throughput must be divided by two for per-session FPS. Later
recording replays use independent sessions and a one-slot bounded mailbox.
Complete-sequence delivery separates model/tracker drift from latest-frame
dropping. Frame age is measured after host decode, not sensor exposure.

Only one native benchmark runs at a time, in fresh bounded subprocesses. Both
models, thresholds, shared/LATENCY scheduling and CPU budgets are fixed. Existing
applications and OS services are not stopped. System/process CPU and RAM are
recorded, and pre-run load is sampled by the new tool. For timing comparisons,
system CPU differences above 10 percentage points or RAM-use differences above
5 percentage points are treated as confounded. These checks qualify exploratory
timings; they do not provide OS-level background-load control or ground truth.

Resolution experiments use isolated copies of the original dynamic exports.
XML/BIN content stays unchanged; only experiment-copy input-size metadata and
its integrity hashes describe the requested inference limit. Original manifests
are retained as provenance. This is inference-size testing, not retraining or a
new precision export. Production validation is not weakened. Requested size and
actual preprocessed BCHW geometry are recorded because dynamic rectangular
letterboxing can produce a non-square tensor.

## FP32 baseline

The unchanged existing matrix tool completed two independent FP32/640 runs:

| Run | FPS per synchronized session | Process CPU, host % | System CPU % |
| --- | ---: | ---: | ---: |
| baseline-01 | 2.86 | 43.0 | 60.3 |
| baseline-02 | 2.53 | 38.5 | 66.3 |

These use 40 measured pairs after five warmup pairs, shared/LATENCY and automatic
thread/stream budgets. They reproduce execution, not a stable controlled-load
performance estimate. The unchanged complete 126-frame translated-bus replay
also completed at 3.04 FPS per session; its accepted sequence is the original-path
reference for verifying the isolated loader at 640.

The original replay CLI defaults to all scheduling candidates when no mode is
specified. Its shared baseline completed, but the unnecessary candidate remainder
was explicitly stopped and its report marked `interrupted_after_baseline`.
Only the completed shared baseline is used. The first isolated experiment failed
before inference because Ultralytics requires an `_openvino_model` directory
suffix. That experiment-loader issue was corrected and covered by a test; the
failed `resolution-matrix-01.json` is retained, not counted as a measurement.

The installed runtime was OpenVINO 2026.4.1, Ultralytics 8.4.126, PyTorch
2.15.0+cpu and OpenCV 5.0.0.93. Every successful resolution case reported CPU,
FP32, LATENCY, two OpenVINO threads and one stream per graph. There was no
precision, scheduler or model-cadence change between sizes.

## Resolution and replay results

The first successful isolated matrix (`resolution-matrix-02.json`) used 40
measured pairs after five warmup pairs. All four dynamic sizes executed with
both models and independent camera trackers. Actual tensors for the portrait
stock image are shown below, with batch and channels omitted.

| Requested size | Actual H x W | FPS/session | Local inference A/B ms | COCO inference A/B ms | Detector wall A/B ms | Process/system CPU % | RSS MiB | System RAM % |
| --- | --- | ---: | --- | --- | --- | --- | ---: | ---: |
| 640 | 640 x 480 | 2.30 | 159.9 / 100.3 | 128.7 / 170.3 | 432.2 / 293.1 | 35.9 / 67.9 | 574.8 | 86.2 |
| 512 | 512 x 384 | 3.21 | 116.3 / 79.3 | 73.8 / 129.2 | 308.5 / 225.4 | 33.2 / 72.3 | 544.3 | 82.6 |
| 416 | 416 x 320 | 2.93 | 144.9 / 64.5 | 92.7 / 141.9 | 338.1 / 229.4 | 26.0 / 83.2 | 527.5 | 84.1 |
| 320 | 320 x 256 | 5.84 | 61.4 / 42.7 | 37.9 / 63.5 | 168.0 / 122.9 | 33.1 / 72.3 | 510.5 | 85.9 |

RSS is the mean process resident set, not a peak or the complete application's
RAM demand. Process CPU is normalized over four logical CPUs. The 416 row fails
the declared system-CPU comparability limit against 640; its lower speed than
512 is not evidence that its model computation inherently costs more. Paired
barriers and per-model locks also make camera wall/inference times asymmetric.
These numbers are synchronized compute replay, not sustained live FPS.

The independent-session complete recording replay (`resolution-replay-01.json`)
processed all 126 source frames per camera, with offline line counting enabled
and guides fixed at 35/55 percent. Both models ran on every accepted frame.
Landscape tensors were 480x640, 384x512, 320x416 and 256x320 respectively.

| Size | Processed FPS A/B | Local inference A/B ms | COCO inference A/B ms | Detector wall A/B ms | Mean host frame age A/B ms | Process/system CPU % | RSS MiB | Stale A/B |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| 640 | 2.00 / 2.00 | 216.4 / 222.2 | 232.4 / 225.6 | 495.1 / 495.8 | 982.3 / 984.3 | 34.3 / 74.7 | 629.6 | 1 / 1 |
| 512 | 3.02 / 3.02 | 141.1 / 137.6 | 147.5 / 150.8 | 327.0 / 327.6 | 647.7 / 649.5 | 35.1 / 75.3 | 579.7 | 0 / 0 |
| 416 | 4.93 / 4.93 | 83.8 / 85.1 | 88.3 / 87.4 | 199.7 / 199.5 | 395.0 / 393.4 | 40.2 / 73.4 | 555.0 | 0 / 0 |
| 320 | 8.52 / 8.52 | 35.0 / 40.4 | 41.3 / 35.8 | 91.3 / 93.6 | 137.8 / 142.6 | 44.6 / 63.8 | 540.1 | 0 / 0 |

One completion per camera at 640 exceeded the 2500 ms offline age budget and was
excluded from current publications; processed FPS above includes those completed
tracker updates. Its current FPS is approximately 1.99 per camera. The baseline
age p95 was 1804/1828 ms, versus 283/283 ms at 320. System RAM means were
approximately 86.7%, 85.5%, 86.1% and 85.6%. Backpressure makes the complete replay
older than latest-frame delivery. The 640/320 system-CPU difference is 10.9
percentage points, exceeding the declared load-comparability limit. The observed
4.25-fold speed ratio is therefore not a controlled causal estimate.

## Repeated latest-frame measurements

`latest-320-repeat.json` interleaves 640 then 320 in three fresh-process pairs.
Each offers the identical local recording, looping to 300 frames per camera at
nominal 10 FPS, with a one-slot overwrite mailbox and 1000 ms offline age budget.
Common measurement windows were approximately 32-35 seconds. FPS below counts
only current publications; stale results are excluded and never repeated as new
frames. Both models remain enabled on every processed frame.

| Pair | Size | Current FPS A/B | Processing A/B ms | Mean host frame age A/B ms | Age p95 A/B ms | Process/system CPU % | RSS MiB | System RAM % | Stale A/B | Final passed A/B |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- |
| 1 | 640 | 2.74 / 2.71 | 358.1 / 361.1 | 416.0 / 415.2 | 721 / 786 | 45.6 / 64.4 | 624.8 | 86.1 | 1 / 1 | 4 / 4 |
| 1 | 320 | 9.43 / 9.43 | 60.3 / 63.2 | 62.4 / 66.1 | 104 / 127 | 45.2 / 52.0 | 544.1 | 82.8 | 0 / 0 | 5 / 5 |
| 2 | 640 | 2.68 / 2.65 | 361.9 / 365.1 | 419.5 / 423.0 | 770 / 707 | 44.0 / 63.7 | 629.8 | 84.1 | 2 / 2 | 4 / 3 |
| 2 | 320 | 4.50 / 4.50 | 212.9 / 212.1 | 268.6 / 272.4 | 627 / 695 | 29.0 / 84.7 | 540.9 | 86.1 | 3 / 4 | 5 / 5 |
| 3 | 640 | 1.67 / 1.64 | 556.8 / 563.4 | 623.7 / 620.7 | 1096 / 1027 | 33.5 / 78.0 | 637.0 | 86.6 | 4 / 4 | 1 / 3 |
| 3 | 320 | 6.55 / 6.52 | 149.0 / 149.5 | 203.9 / 206.1 | 352 / 319 | 38.4 / 76.7 | 541.6 | 85.7 | 0 / 0 | 5 / 5 |

Observed paired mean current-FPS increases were +246%, +69% and +295%.
Pairs 1 and 2 fail the declared system-CPU comparability limit (differences of
12.5 and 21.0 percentage points). Pair 3 passes the coarse CPU/RAM screen
(1.35/0.91 percentage points), but this still does not control background
processes, paging, clock behavior or dataset validity. The evidence supports
reduced computation and consistently lower measured RSS at 320; it does not
establish a controlled effect size or a production-quality improvement.

Accepted A/B frame counts were 91/90, 91/90 and 62/61 for 640, versus 299/299,
161/162 and 216/215 for 320. The mailbox overwrote unprocessed inputs rather
than building an unbounded queue. All three latest comparisons are correctly
`incomparable` for same-sequence agreement because their accepted subsets differ.
Their timestamp/age/publication audits pass. Different final counters cannot be
interpreted as missed/double-counting rates without event ground truth.
Every accepted version remains in the raw JSON; `final-summary.json` contains
aggregate counts and timings. The complete-sequence table above provides the
separate local and COCO latency comparison.

## Detection and tracking validation boundaries

Per-class AP, precision and recall are **not evaluated** for each required class:
car, motorcycle, truck, bicycle, bus, tricycle, jeepney and ebike. There is no
labeled validation split. The diagnostic comparator reports same-class box
agreement and unmatched reference/candidate observations, not false negatives,
false positives or road accuracy. A same-class overlap diagnostic is not proof
of a double-counted physical vehicle.

Original-path versus isolated-copy 640 replay processed the same 126 frames per
camera. The existing strict parity checker found no differences in its semantic
trace (including boxes, confidences, class, canonical tracks, roles, crossings,
passed counters and ledger contents). All behavioral coverage checks were
exercised. However, **global identity equivalence failed**: missing/reassigned
global identities appeared at sequences 40 and 45. The original run completed at
3.04 FPS/session, versus 2.00 in the more loaded copy run. Production identity
assignment uses host monotonic time; different replay wall times can affect its
expiry windows. This is a plausible explanation, not a proven root cause or a
passed identity gate. Evidence is in
`output/phase3-openvino/original-versus-cloned-640-parity.json`.

The experiment does not substitute a synthetic source clock into production
identity logic or suppress these differences. Complete-sequence comparisons
separate input dropping from model output changes, but cannot isolate every
time-dependent registry effect. End-to-end identity/counting accuracy still
requires independently labeled road footage and repeatable timing conditions.

Same-sequence agreement against the isolated 640 reference is recorded in
`resolution-agreement.json`. Its `comparable` status means source, sequence,
precision and fixed settings matched; it does **not** mean accuracy passed.
All timestamp arithmetic, ordering and current/stale status audits passed.

| Size | Same-class matched observations | Unmatched reference/candidate observations | Mean matched IoU | Canonical track splits/merges | Per-camera/frame crossing-flag mismatches | Maximum ledger-point drift A/B | Final passed A/B |
| --- | ---: | --- | ---: | --- | ---: | --- | --- |
| 640 reference | 158 | 0 / 0 | 1.000 | 0 / 0 | 0 | 0 / 0 | 2 / 2 |
| 512 | 146 | 12 / 12 | 0.972 | 0 / 0 | 34 | 6 / 6 | 2 / 2 |
| 416 | 146 | 12 / 12 | 0.968 | 0 / 0 | 34 | 6 / 6 | 2 / 2 |
| 320 | 36 | 122 / 126 | 0.952 | 2 / 0 | 94 | 5 / 5 | 2 / 2 |

Counts above aggregate observations over both sessions, except explicitly A/B
columns. The reference recorded 146 jeepney and 12 bus labels; 512 and 416
recorded 158 jeepney and zero bus labels each; 320 recorded 36 jeepney and 126
bus labels. This label drift on a synthetic stock photograph does not establish
which model configuration is correct on roadwork traffic. Four same-class
overlapping-box pairs at IoU >= 0.8 appeared at 320 (zero in the other runs);
these are duplicate candidates, not confirmed double-counted vehicles.

Although final passed counts and final ledger points reconverged, intermediate
ledger changes and crossing timing differed. The report retains every mismatch,
not just totals. At 320, global-ID correspondence also showed two split and four
merge relationships plus six missing-ID matched observations. These are
reference-agreement failures, not ground-truth identity-error rates. They prevent
promoting 320 on the strength of FPS or identical final counters.

## Promotion decision and hardware limits

| Strategy | Decision | Evidence or blocking condition |
| --- | --- | --- |
| Original dual FP32/640, shared/LATENCY | Retained | Existing production behavior and rollback baseline |
| FP32/512 or 416 | Experiment only; not promoted | Faster replay in some conditions, but class/crossing/ledger drift and no labeled validation |
| FP32/320 | Experiment only; not promoted | Repeated speed/RSS gains, but substantial detection/identity/crossing disagreement and variable sustained rates |
| INT8 local and COCO | Not generated or tested | Representative calibration and labeled validation absent; NNCF absent |
| Unified 13-class checkpoint | Not deployed or benchmarked as an equivalent pipeline | Canonical mappings, training provenance and validated roadside detection/counting results absent |

No model, precision, input size or scheduling optimization passed every promotion
gate. Production stays on its original settings. There is no claimed production
before/after FPS gain. The closest observed latest-frame diagnostic was 9.43 FPS
per session; neither sustained 10 FPS per camera nor real-road reliability was
demonstrated. On this two-physical-core host, FP32 work from two networks and
competing CPU/memory demand remain material limits. Four logical CPUs are not
four independent physical cores. Model reduction can lower compute, but the
observed class/fusion/tracking effects require validation before deployment.

System RAM remained about 83-87% used in the latest trials. Lower detector RSS
does not reserve memory for Flask, decoding, browser sessions or the rest of the
application. Background load could not be held fully constant on the working
host; measured load screens and all repetitions are retained rather than
presenting a single best-case result as a guarantee.

## Changed files, checks and rollback

Only new experiment/report files were added for Phase 3:

- `backend/scripts/benchmark_openvino_models.py`: original-export validation,
  isolated provenance-marked copies, fixed shared/LATENCY dual-model sessions,
  fresh-process watchdogs, size sweeps, actual tensor geometry and fixed-setting
  metadata. Existing Phase 1/2 workers provide stage/resource/age measurements.
- `backend/scripts/compare_openvino_models.py`: strict comparison eligibility,
  same-class box agreement, track/global-ID correspondence, per-frame crossing
  and ledger drift, timestamp/status audit, and input/output collision protection.
- `backend/tests/test_benchmark_openvino_models.py` and
  `backend/tests/test_compare_openvino_models.py`: 14 additional regression tests.
- This report and retained artifacts under `output/phase3-openvino/`, including
  input/export provenance, complete raw traces, failed-attempt evidence, summary
  helper, comparison reports and production file-hash snapshots.

Final backend command: `.venv/Scripts/python.exe -m pytest -q`.
**286 passed in 11.66 seconds.** `git diff --check` and whitespace checks for the
new files passed. The independent native `critical_reviewer` identified reporting
gaps during implementation; per-frame/max drift, per-camera event mismatches,
age arithmetic, fixed-config eligibility, global-ID correspondence and evidence
file protection were corrected and covered by tests. Final review found no
remaining material blocker in the inspected tools/report; it did not claim
hardware validation.

SHA256 snapshots `production-before.json` and `production-after.json` verify all
13 checked files unchanged: both exports' XML/BIN/metadata/manifests and
`config.py`, `detector.py`, `inference_runtime.py`, `camera.py`, and
`openvino_artifacts.py`. Production paths are never overwritten by the tools,
and existing export-validation rules remain intact. No running service or
physical controller was started/reconfigured. Existing unrelated workspace edits
were preserved. Frontend checks were unnecessary because no frontend file changed.

Rollback requires no production restoration: the original models and
shared/LATENCY configuration remain selected. The new scripts and experiment
directories are opt-in and can remain unused. Archive the measurement reports
before removing experimental copies; do not reset the pre-existing workspace
changes to undo this phase.

## Reproduction and outstanding validation

Run from the checkout root; each output must be a new path. The source below is
the explicitly synthetic diagnostic fixture, not roadside calibration data:

```powershell
.\backend\.venv\Scripts\python.exe backend/scripts/benchmark_openvino_models.py --kind matrix --source backend/.venv/Lib/site-packages/ultralytics/assets/bus.jpg --output output/phase3-openvino/recheck-matrix.json --sizes 640 512 416 320 --frames 40 --warmup 5 --timeout-seconds 240
.\backend\.venv\Scripts\python.exe backend/scripts/benchmark_openvino_models.py --kind replay --source output/phase2-openvino/fixtures/translated-bus-episodes.avi --manifest output/phase2-openvino/fixtures/translated-bus-episodes-manifest.json --output output/phase3-openvino/recheck-all.json --sizes 640 512 416 320 --frames 126 --delivery all --line-counting --guide-green 35 --guide-red 55 --timeout-seconds 240
.\backend\.venv\Scripts\python.exe backend/scripts/benchmark_openvino_models.py --kind replay --source output/phase2-openvino/fixtures/translated-bus-episodes.avi --manifest output/phase2-openvino/fixtures/translated-bus-episodes-manifest.json --output output/phase3-openvino/recheck-latest.json --sizes 640 320 --repeats 3 --frames 300 --delivery latest --max-age-ms 1000 --line-counting --guide-green 35 --guide-red 55 --timeout-seconds 240
```

The benchmark adds one 640 baseline per repeat, followed by the requested
non-640 candidates. Confidence remains local 0.20/COCO 0.25 in these measurements;
no thresholds were retuned to improve apparent agreement. Parent/child execution
failures are reported separately from agreement/accuracy gates. The standalone
comparator accepts individual worker result objects or `{ "result": ... }`
wrappers; extract the desired run from a multi-run report first.

Outstanding work is representative calibration for both deployed viewpoints and
all vehicle classes, independently labeled per-class validation, and annotated
vehicle identities/entry/exit/queue crossings/counts. Include varying distance,
occlusion, lighting and empty scenes, with calibration/evaluation split apart.
Then test INT8/size candidates and the separately mapped unified model under
repeatable system load. Live dual-camera frame freshness, road accuracy,
cold-start/reconnect identity stability, driver/RTSP buffering, browser latency
and physical timing behavior remain unvalidated. The known callback-arrival
freshness issue is unchanged; faster offline inference is not a safety fix.
