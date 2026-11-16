# OpenVINO Phase 1: profiling and safe camera diagnostics

## Scope

This investigation uses the native `fast_explorer`, `deep_thinker`,
`critical_reviewer`, and `code_worker` agents. It preserves both production models,
per-camera ByteTrack state, counting, transaction callbacks, and physical signal
behavior. Single-model benchmark scenarios are diagnostic only.

The available host is an Intel Core i5-7200U, with two physical cores and four
logical CPUs, OpenVINO 2026.4.1, and Ultralytics 8.4.126. Both FP32 OpenVINO exports
are present. The backend virtual environment is `backend/.venv`; its existing
pytest development dependency was installed to run the regression suite.

## Why the target is 10 FPS

`backend/config.py` loads `thesis/.env` when present, otherwise the checkout's
`.env`, otherwise `backend/.env`. `load_dotenv(..., override=True)` makes that
selected file override inherited terminal values. The selected workspace file
currently contains `DETECTION_FPS=10`; the dataclass fallback is 5. Neither value
measures attainable inference speed. No target or deployment environment setting
was increased during this investigation.

The Flask `/local` monitor renders the configured target. The Next.js monitoring
grid's FPS value is measured completed-frame FPS. Current deployment settings
select RTSP for Camera A and disable Camera B; the offline dual-camera scenario
creates two independent detector sessions without altering those settings.

## Baseline and hypotheses

The user's live observation was approximately 1.9 FPS, 1,386 ms processing,
1,457 ms frame age, 75% CPU, and 84% RAM. These values are reported observations,
not measurements collected by this change.

An initial local, warmed, stock-image run with both models and one detector
measured 6.58 FPS and 151.98 ms processing, including about 67.77 ms local-model
inference and 69.94 ms COCO inference. It used three warmup frames and ten measured
samples, OpenVINO default threads/streams, and no capture, pacing, JPEG, or physical
control. Process RSS was 518.5 MiB; process CPU was 186% with one logical CPU
defined as 100% (46.5% normalized across this four-logical-CPU host); system memory
usage at completion was 90.9%. See
`output/phase1-openvino/baseline-dual-single.json`.

Both models run serially within each detector. Cameras share a lock per model;
different models can overlap across cameras. Locks must remain because the
installed OpenVINO `CompiledModel.__call__` reuses a cached inference request.
Removing those locks requires a separate design with independent infer requests.
OpenVINO thread budgets apply to each compiled model, so an unrestricted graph
budget can compete with the other graph, decoder, preprocessing, and OS.

The capture thread already maintains one overwrite slot rather than an unbounded
frame queue. Processing selects the latest version after pacing. Increasing the
FPS target cannot remove inference latency. Duplicate preprocessing exists in the
two independent Ultralytics predictors; sharing it would require proving matching
input geometry and preserving each model's original-frame postprocessing and
tracker callbacks, so it is not changed speculatively.

## Measurement boundaries

The matrix tool uses real exported models and the production `track(persist=True)`
path. It separates local-only, COCO-only, dual-model single-camera, and dual-model
two-concurrent-camera sessions. Each configuration runs in a fresh subprocess.
Warmup is excluded, and per-model locks and independent predictors are retained.

A stock still image is available from the installed Ultralytics package. Replaying
it measures compute and lock contention; it does not measure moving-vehicle
accuracy, real camera buffering, frame freshness, line-crossing accuracy, browser
transport, or sustained roadside performance. Repeated benchmark inputs do not
change the live scheduler or publish repeated results as camera FPS.

`frameAgeMs` retains its legacy meaning: elapsed host time from completion of
`capture.read()` to completion of processing. It is not sensor exposure age.
Additional capture/result ages identify software stalls. The capture backend may
reject or ignore `CAP_PROP_BUFFERSIZE=1`; an accepted setter is not proof of bounded
sensor/network buffering.

## Safety boundary

No freshness thresholds, observation acceptance rules, signal interlocks, clearance
logic, traffic transaction implementation, Firebase ingestion, or model cadence
are changed. The known downstream freshness issue remains: transactions timestamp
callback arrival rather than capture. Correcting that can affect readiness and
physical control, and requires dedicated simulation and acceptance criteria.

Inference failure is surfaced separately from capture health; partially mutated
tracker state is not automatically restarted. JPEG errors are presentation
failures and should not interrupt inference or publish a new JPEG version.

## Validation and measurements

Initial backend suite: 214 passed, one failed. The failure predates Phase 1:
`test_phase1_replay` uses a model-pool double without the current `runtime_path()`
interface. The fixture is updated without changing production traffic rules.

Final regression results, matrix results, selected changes, and remaining
live-validation work follow below.

### Completed default and OpenVINO-only measurements

Each row below is a separate fresh process, with three warmup iterations and
15 measured iterations per detector. The image is the installed Ultralytics
`assets/bus.jpg`, with configured image size 640 and confidence 0.20. For two
cameras, both receive independent copies of the same input and synchronize before
each iteration. Both must complete before the next pair starts. Thus paired FPS
is synchronized replay throughput, not independent production capture FPS.

| Scenario | OV threads/streams requested | FPS per session | Mean detector wall ms | Mean local/COCO inference ms | Process CPU / system CPU % | Mean process RSS MiB |
| --- | --- | ---: | ---: | --- | --- | ---: |
| Local only | 0 / 0 | 5.94 | 168.5 | 157.8 / n/a | 32.9 / 87.2 | 450.7 |
| COCO only | 0 / 0 | 4.47 | 223.7 | n/a / 209.7 | 27.1 / 93.0 | 460.5 |
| Both models, one session | 0 / 0 | 2.65 | 377.4 | 151.0 / 204.5 | 29.0 / 89.5 | 517.1 |
| Both models, two sessions | 0 / 0 | 1.16 | 738.5 | 276.2 / 282.6 | 26.8 / 97.1 | 581.0 |
| Both models, two sessions | 1 / 1 | 1.28 | 641.0 | 233.7 / 253.6 | 25.0 / 86.0 | 579.8 |
| Both models, two sessions | 1 / 2 | 1.44 | 579.9 | 215.2 / 229.2 | 26.5 / 80.4 | 578.9 |
| Both models, two sessions | 2 / 1 | 1.68 | 496.6 | 186.5 / 201.9 | 35.4 / 87.5 | 575.1 |
| Both models, two sessions | 2 / 2 | 1.57 | 531.0 | 188.3 / 212.6 | 29.0 / 76.2 | 631.9 |

CPU in this table is normalized to the four-logical-CPU host. For two-session
rows, wall/stage/resource means average the two sessions; FPS uses the common
paired interval. The JSON reports preserve separate per-session distributions.
Default zero resolved to two OpenVINO threads and one stream per graph. Requested
one thread/two streams resolved to one thread/one stream. All graphs reported CPU
execution and FP32 precision. Two streams with two threads consumed more RSS and
did not improve throughput in this run.

The apparent gain from default to explicit 2/1 is **not a demonstrated tuning
gain**: both resolved to exactly the same compiled settings. System CPU varied
from 76% to 97%, and the initial 6.58 FPS dual-model single-session run was much
faster than the subsequent 2.65 FPS run without a model/pacing change. A separate
short process sample showed significant background-service CPU consumption. No
background service was stopped or reconfigured. These results do not justify a
production thread/stream setting change or a sustained before/after FPS claim.

Under default paired replay, Camera 1 averaged 305.0 ms of model-lock wait while
Camera 2 averaged near zero; the synchronized benchmark's ordering is relevant
to that asymmetry. Both sessions also had substantially larger inference times
than the initial one-session sample. Contention, CPU availability, and memory
pressure require separation under a controlled live or recorded-road workload.

Raw reports: `output/phase1-openvino/default-matrix.json` and
`output/phase1-openvino/thread-stream-matrix.json`. Every camera report includes
sample counts, mean/p50/p95 stage times, lock wait, process RSS, and system RAM.

### Native failure during additional CPU-budget experiments

The existing nonzero `CPU_INFERENCE_THREADS` path crashed a benchmark subprocess
with Windows status `3221225477` (`0xC0000005`) for both one- and two-session
dual-model runs with budget 1. A faulthandler reproduction located the native
failure in `core.compile_model()` called by `inference_runtime.py` after lazy
backend setup. Reports retain the failure rather than inventing performance data.

That path previously changed `intel:cpu` to `cpu`, causing Ultralytics to change
PyTorch threads, then changes the thread budget again after backend construction.
Installed PyTorch documentation requires setting its thread budget before eager
execution. This is an initialization-order hypothesis, not proof of the native
crash's root cause; a one-session reproduction rules out cross-camera contention
as a necessary cause.

An isolated early-bootstrap budget-2 experiment completed successfully, followed
by a narrow production fix: OpenVINO applies an explicit PyTorch thread budget
in `ModelPool` construction before Ultralytics import/model loading, keeps the
`intel:cpu` device path, and skips the late setter in predictor setup. The PyTorch
backend retains its existing behavior. This follows the ordering guidance in
[PyTorch's thread-budget documentation](https://docs.pytorch.org/docs/2.15/generated/torch.set_num_threads.html).
The process-global budget must be initialized before camera workers; constructing
another pool with a different budget after inference starts is not a supported
hot-retuning mechanism. Default budget zero is unchanged.

Fresh-process reproductions after this fix completed all four combinations:
single- and paired-camera dual-model replay, each with explicit PyTorch budgets
1 and 2, 15 samples and three warmup iterations. No native crash occurred. Budget
1 measured 7.87 FPS for one session and 3.30 FPS per paired session; budget 2
measured 5.07 and 1.66 respectively. These observations establish that the tested
initialization path now runs; they do not prove the exact native-library root
cause or a live FPS improvement. See `fixed-cpu-thread-matrix.json`.

### Final control comparison and tuning decision

The final comparison held OpenVINO at two threads and one stream, used 40 measured
iterations after five warmup iterations, and recorded the actual PyTorch budget
inside each inference thread. Both the unchanged default and explicit budget 1
resolved to one PyTorch intra-op thread in each worker. System CPU was about 51%
in both runs, much lower than during the earlier loaded-system matrix.

| PyTorch budget requested | Paired FPS per session | Camera A/B detector wall ms | Camera A/B local inference ms | Camera A/B COCO inference ms | Process CPU host % | Mean RSS MiB | System RAM % |
| --- | ---: | --- | --- | --- | ---: | ---: | ---: |
| 0 (unchanged default) | 3.49 | 284.4 / 208.7 | 122.6 / 63.0 | 69.5 / 128.9 | 47.8 | 581.2 | 87.7 |
| 1 (explicit) | 3.35 | 296.4 / 217.9 | 125.8 / 66.1 | 72.1 / 134.7 | 47.5 | 575.8 | 86.3 |

Camera A/B mean lock waits were 76.2 / 0.003 ms for the default and
82.0 / 0.003 ms for explicit budget 1. Pair-latency p95 was 309.4 / 308.3 ms.
The asymmetry comes from synchronized paired replay and shared locks; it is not
evidence that one physical camera is inherently slower. See
`output/phase1-openvino/post-fix-control-matrix.json` for all distributions.

**No production FPS, OpenVINO thread/stream, or PyTorch budget change was
promoted.** Explicit budget 1 did not beat the default in the control comparison.
The earlier 1.16-to-3.49 FPS difference is consistent with background-load variation;
these measurements do not isolate every cause or demonstrate a code optimization.
The validated changes are initialization safety,
per-stage observability, bounded-buffer diagnostics, and resilient presentation
encoding. Ten FPS per camera remains unproven and was not attained in this replay.

## Final changed files and checks

- `backend/camera.py`: capture/processing timing and health diagnostics; independent
  raw/annotated JPEG failure recovery; reconnect FPS baseline correction.
- `backend/detector.py`: per-model preprocessing/inference/postprocessing timing;
  early OpenVINO-specific PyTorch budget initialization and device preservation.
- `backend/inference_runtime.py`: avoid late OpenVINO thread-budget mutation.
- `backend/scripts/benchmark_openvino_matrix.py`: file-only isolated matrix,
  per-camera worker-thread budgets, resources, compiled properties, and failures.
- `backend/tests/test_camera.py`, `test_detector.py`, `test_inference_runtime.py`,
  `test_phase1_replay.py`, and `test_benchmark_openvino_matrix.py`: regression
  coverage and the pre-existing replay fixture repair.
- This report and JSON artifacts under `output/phase1-openvino/`.

Final command from `backend/`: `.venv/Scripts/python.exe -m pytest -q`.
**231 passed.** `git diff --check` passed. The independent native
`critical_reviewer` verified the encoder-error fix and initialization-order fix
with no remaining blocking findings. The previously existing application changes
outside the files listed above were preserved.

No physical controller was started by a benchmark. Existing replay tests use fake
signals and validate IDs, annotations, counts, and a completed simulated control
cycle. Model weights, precision, detection arguments/cadence, predictor isolation,
counting rules, and transaction callback order remain intact. No frontend or
Firebase contract was changed; frontend checks were not needed for these backend
changes. This is not hardware or traffic-accuracy validation.

## Reproduce and collect the missing live evidence

From the checkout root, run the installed Python interpreter against an existing
local video file, or the stock image for compute-only diagnostics:

```powershell
.\backend\.venv\Scripts\python.exe backend/scripts/benchmark_openvino_matrix.py --source backend/.venv/Lib/site-packages/ultralytics/assets/bus.jpg --threads 0,1,2 --streams 0,1,2 --cpu-threads 0 --frames 40 --warmup 5 --output output/phase1-openvino/recheck.json
```

That command does not start Flask, camera capture, signal controllers, or uploads.
Use `--mode dual-camera` to select only paired replay. Single-model modes never
change production configuration. Reports include failures and return nonzero on
an unsuccessful configuration. Inspect compiled properties rather than assuming
that a requested stream count was honored; see
[OpenVINO's thread/stream guidance](https://docs.openvino.ai/2025/openvino-workflow/running-inference/inference-devices-and-modes/cpu-device/performance-hint-and-thread-scheduling.html).

For a controlled live observation run, enable `ENABLE_PERFORMANCE_PROFILING=true`
in the selected environment file and restart the backend through the normal
deployment procedure. This task did not change that flag or restart the service.
The camera telemetry's `performance` object then includes model stages, lock wait,
buffer/copy/capture costs, presentation costs, and process/system resources.
Top-level `processingHealth`, `processingThreadAlive`, `processingError`,
`displayError`, `captureAgeMs`, and `resultAgeMs` expose processing stalls and
presentation failures without changing readiness semantics.

Remaining work: test two actual cameras (Camera B is currently disabled in the
deployment environment), collect sustained performance with representative moving
traffic and ground truth, separate driver/RTSP buffering from post-decode age, and
validate tracker continuity across reconnects. Address callback-arrival freshness
in a dedicated simulated control change. Any future independent-infer-request or
quantization work needs memory, accuracy, and counting validation before adopting
it. Real before/after camera FPS, frame age, and end-to-end browser latency remain
pending; the user's original live numbers must not be compared directly with the
stock replay as a claimed improvement.
