# OpenVINO Phase 2: inference scheduling experiments

## Scope and rollback boundary

This work uses the native `fast_explorer`, `deep_thinker`, `critical_reviewer`,
and `code_worker` roles. Independent investigations ran in parallel, runtime and
benchmark work used separate file ownership, and implementation reviews were
read-only. The main agent completed the benchmark verification fixes and ran
the real-model measurements.

The host is the Intel Core i5-7200U: two physical cores, four logical CPUs,
OpenVINO 2026.4.1, Ultralytics 8.4.126, CPU FP32 inference. Both exported models
remain active. Image size, confidence thresholds, model weights, local-to-COCO
execution order, Ultralytics preprocessing/NMS, and per-camera ByteTrack state
are retained. No traffic-control, Firebase, frontend, or physical-actuation code
is changed. The benchmarks never import the application/controller entry points.

The production defaults remain `shared` requests and `LATENCY`. The selected
workspace environment still requests 10 detection FPS, disables Camera B, and
disables the legacy line-counting telemetry counter. No environment settings or
running services were changed. Tests exercise both camera sessions regardless
of deployment camera settings, and explicitly enable line counting only in
offline cloned settings when testing that branch.

An exact pre-Phase-2 source snapshot and SHA256 manifest are preserved under
`output/phase2-openvino/baseline-source/`. This retains the existing uncommitted
Phase 1 work; do not use a blanket Git reset to roll it back. Setting
`OPENVINO_REQUEST_MODE=shared` and `OPENVINO_PERFORMANCE_HINT=LATENCY`, followed
by the normal backend restart, selects the original execution path. That is
already the current default. For source-level rollback, stop the backend and
restore the corresponding files from the snapshot to their original paths.
New experiment-only modules can remain unused. Snapshot files are reference
copies, not a separate runnable checkout with models or environment files.

## Reproduced Phase 1 baseline

Before modifying scheduling, the existing matrix tool ran with its original
settings: stock `bus.jpg`, both models, two synchronized sessions, 40 measured
iterations after five warmup iterations, automatic OpenVINO threads/streams and
unchanged PyTorch budget zero. It measured **3.17 FPS per session** (6.34 FPS
aggregate). See `output/phase2-openvino/baseline-01.json`.

This is compute replay, not live camera FPS. Phase 1's final comparable paired
replay was 3.49 FPS per session. The difference is not evidence of a regression:
background CPU and memory pressure remain uncontrolled and are recorded for each
run. No claimed improvement is based solely on comparing separate loaded-system
samples or on moving waiting time between measurement fields.

## Implemented scheduling alternatives

| Mode | Request ownership and locking | Ordering |
| --- | --- | --- |
| `shared` | Original shared compiled-model request, shared per-model RLock | Original local then COCO per camera |
| `fair` | Same request and lock boundary, FIFO reentrant admission | Waiting cameras acquire in ticket order |
| `independent` | One synchronous InferRequest per session, per-session lock | One frame in flight per camera |
| `async` | One InferRequest per session, start_async followed by bounded wait_for | No callback-driven or out-of-order tracker updates |

Both `LATENCY` and `THROUGHPUT` compilation hints are supported independently of
the request mode. The installed Ultralytics backend's dispatch selector remains
`LATENCY` so it invokes the owned request adapter rather than creating a new
AsyncInferQueue per call. The actual OpenVINO compilation hint, thread count,
stream count, execution device, and FP32 precision are recorded in reports.

Independent modes replace shared model locks only for OpenVINO. PyTorch retains
its original shared locks. Each request serializes direct calls, owns input
storage through an explicit `ov.Tensor(..., shared_memory=False)`, and returns
copied arrays in compiled-output order through the mapping
interface expected by Ultralytics. Output storage cannot be overwritten by the
next request. See [OpenVINO's request-memory guidance](https://docs.openvino.ai/2026/openvino-workflow/running-inference/inference-request/python-api-advanced-inference.html).

`OPENVINO_REQUEST_TIMEOUT_MS` defaults to 5000 for the experimental async adapter.
After timeout or submission/wait failure, it cancels and attempts one bounded
drain. A request that cannot be drained is poisoned and retains its input;
there is no retry through another mode after tracker mutation. This deadline
does not bound native model compilation or redefine camera/traffic freshness.
Benchmark subprocesses therefore have a separate wall-clock watchdog (180 s
by default), including cleanup of Windows venv-launcher descendants.

## Benchmark and correctness methods

Three distinct workloads must not be conflated:

1. The existing matrix uses a barrier for every paired iteration. It measures
   paired compute throughput, model stages, and shared-lock waiting.
2. The new scheduling tool starts two producer/consumer pairs once and lets them
   run independently. Each camera has one pending frame and one in-flight frame.
   `latest` delivery overwrites pending frames; `all` delivery backpressures the
   producer without overwriting so baseline/candidate inputs can be identical.
3. The moving-fixture parity run processes the same complete sequence through
   both real models, Ultralytics NMS, ByteTrack, direction/crossing state, global
   identity, and incoming ledger. This checks implementation equivalence, not
   real-world detection accuracy.

The fixture is `fixtures/translated-bus-episodes.avi` under the output directory:
126 MJPEG frames, 960x720, nominal 10 FPS. It translates the entire installed
stock photograph, with incoming motion, five occluded frames, reversal,
36 empty frames, and a second entry. The manifest records source hashes and
episode metadata. Guides at 35%/55% and enabled line counting are offline-only
overrides; actual detections, crossings, births, and counts are measured rather
than inferred from the episode names. There is no recorded road footage or
labeled traffic-event ground truth in this checkout.

All four tracker sessions are initialized serially on blank frames before new
track births. This avoids conflating benchmark initialization with the installed
ByteTrack global ID counter's reset behavior. Cold-start/reconnect behavior with
real traffic remains a separate validation requirement.

Parity requires identical ordered camera/generation/frame sequences, actual
detection/identity/crossing coverage for each camera, and matching per-frame
classes, confidences, boxes, persistent canonical track associations, roles,
crossing flags, passed counts and ledger membership/points. Global IDs may be
renumbered only through a complete bijection; splits, merges and lost handoffs
fail the comparison. Raw-ID differences and the renaming map remain visible.

The offline mailbox rejects duplicate/old-generation/nonfinite/future-timestamp
inputs. It expires old pending frames before inference and marks aged,
superseded-generation or stopped completions as non-current. A newer pending
frame alone does not invalidate an ordered in-flight result. Post-inference
publication rejection cannot undo an already executed tracker update. Therefore
this experimental mailbox policy is not connected to production traffic readiness
or callbacks. The production single-overwrite capture buffer is unchanged.

Capture ages are host software timestamps after decode, not sensor/RTSP exposure
age. Completion latency excludes Flask/browser transport, JPEG streaming and
physical control. Reports distinguish processed throughput from current-result
throughput, common-window rates from per-session active rates, and one-core CPU
percent from four-logical-CPU host-normalized CPU percent.

## Observed failures and verification fixes

- A coordinator session ended before its initial eight-case matrix completed.
  Completed rows remain in `candidate-matrix-01.json` with status `interrupted`;
  remaining configurations were rerun in separate reports.
- An async 1-thread/1-stream experiment stalled beyond 200 seconds. Only its
  verified native benchmark child was terminated; its coordinator recorded exit
  15. A short fresh-process probe subsequently passed in 13.09 seconds. This does
  not establish a root cause or universal configuration incompatibility. Evidence
  is retained in `one-thread-candidates-01.json`, `experiment-notes.json`, and
  `async-one-thread-diagnostic.json`. Bounded native waits and subprocess watchdogs
  were added rather than silently dropping that experiment.
- The first moving-replay attempt revealed relative-manifest resolution and
  legacy basename-prefixed digest issues. Preflight validation now resolves the
  manifest before child launch and checks a separately streamed raw-file hash.
  The failed reports remain; correctness conclusions use subsequent valid runs.
- Review caught an adapter list/mapping mismatch, OpenVINO-only lock scoping,
  global-identity parity omissions, and aggregated-camera coverage. These were
  corrected and covered by regression tests before conclusions were drawn.
- A real raw-output/reuse check exposed caller input mutation when NumPy dispatch
  encountered a previously borrowed input binding. Explicit owned Tensor binding
  fixed it. The final real-model check records zero output differences, unchanged
  caller/reference storage, and unchanged retained outputs after reuse. Earlier
  diagnostic reports remain separate from the final passing artifact.
- After bounded waits were added, the previously stalled async 1/1 configuration
  completed 40-frame LATENCY and THROUGHPUT retries. This establishes successful
  retries, not an explanation of the earlier native stall.

## Results and promotion decision

### Exploratory paired matrix

All rows use both models and both sessions, 40 samples after five warmup
iterations. FPS is per synchronized session, so these numbers must not be mixed
with independent live-camera rates. These exploratory runs preceded the final
owned-Tensor binding change; the final-code comparisons follow separately.

| Request mode | Compile hint | Requested threads/streams | Observed FPS/session | Mean process RSS MiB |
| --- | --- | --- | ---: | ---: |
| shared | LATENCY | auto/auto | 2.31 | 580.5 |
| shared | THROUGHPUT | auto/auto | 2.01 | 742.6 |
| fair | LATENCY | auto/auto | 1.68 | 573.7 |
| fair | THROUGHPUT | auto/auto | 2.09 | 745.2 |
| independent | LATENCY | auto/auto | 2.48 | 564.2 |
| independent | THROUGHPUT | auto/auto | 2.98 | 756.1 |
| async | LATENCY | auto/auto | 3.21 | 567.0 |
| async | THROUGHPUT | auto/auto | 2.93 | 754.5 |
| independent | LATENCY | 1/1 | 1.70 | 571.3 |
| independent | THROUGHPUT | 1/1 | 2.20 | 567.8 |
| independent | THROUGHPUT | 2/2 | 3.39 | 633.1 |
| async | THROUGHPUT | 2/2 | 2.87 | 633.4 |

Automatic LATENCY resolved to 2 threads/1 stream per graph; automatic THROUGHPUT
resolved to 4/4. Thus switching hints changed resource allocation as well as
scheduling. THROUGHPUT's larger RSS did not produce a consistent speed win.
Background system CPU across these rows varied from about 45% to 82%; row ranking
is not proof of a repeatable optimization. The bounded async 1/1 retries measured
2.56 FPS (LATENCY) and 2.46 FPS (THROUGHPUT). No failed/stalled configuration is
counted as successful. Original JSON files preserve the per-camera stages, CPU,
memory and actual compiled properties.

### Final-code counted replay

`final-counting-parity.json` uses the owned-Tensor implementation, identical
126-frame sequences per camera, both models, LATENCY, automatic threads/streams,
backpressured one-slot delivery and offline line counting enabled.

| Mode | FPS/session | Detector wall A/B ms | Local inference A/B ms | COCO inference A/B ms | Python lock wait A/B ms | Passed A/B |
| --- | ---: | --- | --- | --- | --- | --- |
| shared baseline | 2.70 | 368.0 / 367.4 | 162.0 / 159.4 | 168.2 / 173.4 | 13.32 / 10.21 | 2 / 2 |
| independent | 3.37 | 292.8 / 293.4 | 127.8 / 127.5 | 140.6 / 139.7 | 0.004 / 0.004 | 2 / 2 |
| async | 3.37 | 293.6 / 293.0 | 127.8 / 126.5 | 138.4 / 140.2 | 0.004 / 0.004 | 2 / 2 |

The apparent 25% improvement is not attributed solely to scheduling: system CPU
was 67.3% for the baseline and about 56% for the candidates. Host-normalized
process CPU was 43.8%, 51.1%, and 52.1% respectively. Mean RSS was approximately
638, 591, and 589 MiB. Backpressure adds waiting age: mean host capture-to-result
age was about 729 ms baseline versus 579 ms independent/async. There were no
stale completions in this final counted replay (2500 ms experiment budget).

Both candidates passed exact accepted-sequence and semantic parity, including
global-ID equivalence. Each camera processed all 126 frames; each per-model stage
contains 126 measurements. The earlier `moving-parity-03.json` also exercised FIFO
and both independent modes with the deployment's disabled counter, observing
incoming/outgoing roles, green/red crossings, exit/route transitions and new track
births after the empty interval. It passed per-frame parity for all three modes.

The final native raw check, `raw-output-parity.json`, passed local and COCO models
in both independent and async modes. All four comparisons were **numerically
identical** (maximum absolute difference 0; declared tolerance rtol 1e-5, atol
1e-6). Input, reference and returned-output lifetime checks passed after request
reuse. This verifies implementation behavior, not labeled detection accuracy.

### Repeated latest-frame comparisons on the final implementation

`final-latest-repeat.json` interleaves shared baseline and independent/LATENCY
three times in fresh processes. Each run offers 300 source frames per camera at
nominal 10 FPS with a one-slot overwrite mailbox. Actual windows were 32-40 s,
including decode/pacing and draining. The offline current-result budget is
1000 ms; it does not change production freshness thresholds. All rows below use
the final owned-Tensor code. CPU is normalized to the four-logical-CPU host.

| Pair | Mode | Current FPS A/B | Processing A/B ms | Capture-to-result mean A/B ms | Age p95 A/B ms | Process/system CPU % | Mean RSS MiB | System RAM % | Stale A/B |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 1 | shared | 3.28 / 3.28 | 302.5 / 301.7 | 359.8 / 356.8 | 410 / 410 | 50.3 / 55.4 | 634.5 | 80.3 | 0 / 0 |
| 1 | independent | 1.33 / 1.30 | 600.4 / 615.3 | 684.7 / 666.9 | 1556 / 1530 | 32.6 / 83.5 | 584.7 | 91.2 | 13 / 12 |
| 2 | shared | 3.06 / 3.06 | 322.5 / 323.4 | 372.5 / 379.0 | 485 / 519 | 49.5 / 59.3 | 631.5 | 92.4 | 0 / 0 |
| 2 | independent | 2.65 / 2.68 | 369.0 / 366.1 | 429.6 / 422.4 | 722 / 717 | 46.0 / 67.6 | 590.2 | 91.2 | 1 / 1 |
| 3 | shared | 3.09 / 3.09 | 320.3 / 321.1 | 376.8 / 372.2 | 481 / 459 | 48.5 / 59.1 | 635.0 | 91.1 | 0 / 0 |
| 3 | independent | 3.14 / 3.11 | 315.2 / 317.2 | 372.1 / 378.3 | 471 / 485 | 51.3 / 59.8 | 589.0 | 90.3 | 0 / 0 |

Paired mean current-FPS changes were approximately **-59.9%, -13.1%, +1.3%**.
These are observed differences, not causal effect estimates: background load and
memory pressure changed sharply, particularly in pair 1. The approximately
equal-load final pair showed only a 1.3% gain. An earlier exploratory repetition
also produced mixed changes (-2.9%, +35.9%, +15.7%) under changing background load.
Neither series demonstrates a robust repeatable gain.

Removing Python model-lock waits does not remove inference scheduling delay:
request/stream contention can move inside the timed native inference call. In
final baseline latest-frame runs, average Python lock waiting was only about
7-11 ms against 302-323 ms detector wall time; the two network passes dominate.
Initial paired barriers exaggerated lock asymmetry relative to free-running
sessions.

The final latest-frame runs processed different subsets (99-106 frames per camera
for shared baseline windows and 64-105 for candidate windows).
The final JSON gives the exact accepted versions and overwritten counts; no
overwritten frame was submitted twice. Non-current completions are excluded from
current FPS rather than repeated as new results. Under latest delivery, counters
varied: final baseline A/B counts were 4/5, 5/5, 6/4; candidate counts were 2/3,
4/3, 4/4. Different accepted subsets cannot pass the same-sequence parity gate,
and these varying counts cannot be called accurate without event ground truth.
Frame dropping and processed-frame-based tracker history remain material risks.

**Promotion decision: no scheduler or performance hint is promoted to the
production default.** The independently owned request paths, FIFO option, bounded
async handling and experiment tooling are implemented and tested as opt-in
capabilities. Shared/LATENCY remains selected. Ten FPS per camera was not attained,
and no sustained live FPS improvement is claimed.

## Tests and changed files

Final backend command: `.venv/Scripts/python.exe -m pytest -q` from `backend/`.
**272 passed.** `git diff --check` passed. Regression coverage includes FIFO order,
reentry, exception release and bounded waiter tests; OpenVINO-only lock changes;
input/output ownership, installed backend mapping contract, bounded async failure
handling; watchdog child-tree cleanup; mailbox overwrite/expiry/duplicate/generation
and shutdown checks; ordered parity, global-ID split/merge/handoff rejection and
per-camera coverage. The native Tensor-specific unit check skips appropriately
on a PyTorch-only development environment. Independent review found no remaining
production blocker after the identified issues were fixed.

Phase-2 source changes:

- `backend/config.py`: validated opt-in request mode, compile hint, async timeout.
- `backend/detector.py`: shared/FIFO/per-session OpenVINO lock selection.
- `backend/inference_runtime.py`: owned requests/Tensors/output copies and bounded
  async handling; original shared path and PyTorch behavior retained.
- `backend/inference_scheduling.py`: FIFO reentrant lock.
- `backend/scripts/benchmark_openvino_matrix.py`: request/hint axes, actual
  properties, and bounded process-tree watchdog.
- `backend/scripts/benchmark_openvino_scheduling.py` and `scheduling_replay.py`:
  independent producer/consumer experiments, timestamped one-slot delivery,
  per-camera resource/latency traces, and strict parity gates.
- Matching config, detector, runtime, lock and benchmark regression tests.
- This document; reports, fixtures, raw verification helper and rollback snapshot
  in `output/phase2-openvino/`.

`backend/camera.py` is byte-identical to its Phase-1 snapshot. Existing unrelated
workspace edits were preserved. No model export, traffic-control policy, signal
transition, transaction/Firebase implementation or Next.js application file was
changed by Phase 2.

## Reproduction

Run from the checkout root, with the installed backend virtual environment:

```powershell
.\backend\.venv\Scripts\python.exe backend/scripts/benchmark_openvino_matrix.py --source backend/.venv/Lib/site-packages/ultralytics/assets/bus.jpg --mode dual-camera --threads 0 --streams 0 --request-mode shared --request-mode independent --request-mode async --performance-hint LATENCY --performance-hint THROUGHPUT --frames 40 --warmup 5 --timeout-seconds 180 --output output/phase2-openvino/recheck-matrix.json
.\backend\.venv\Scripts\python.exe backend/scripts/benchmark_openvino_scheduling.py --source output/phase2-openvino/fixtures/translated-bus-episodes.avi --manifest output/phase2-openvino/fixtures/translated-bus-episodes-manifest.json --delivery all --line-counting --frames 126 --guide-green 35 --guide-red 55 --request-mode independent --request-mode async --output output/phase2-openvino/recheck-parity.json
.\backend\.venv\Scripts\python.exe backend/scripts/benchmark_openvino_scheduling.py --source output/phase2-openvino/fixtures/translated-bus-episodes.avi --delivery latest --line-counting --frames 300 --max-age-ms 1000 --guide-green 35 --guide-red 55 --request-mode independent --repeats 3 --output output/phase2-openvino/recheck-latest.json
.\backend\.venv\Scripts\python.exe output/phase2-openvino/verify_request_outputs.py
```

The scheduling tool returns nonzero for execution failures; completed measurements
can still contain `not_passed` parity comparisons. Inspect those gates and the
recorded coverage rather than interpreting successful process completion as a
promotion recommendation. No winner is automatically enabled.

## Remaining bottlenecks and hardware limits

Both networks still execute for every selected frame. FP32 network work and CPU
availability dominate; a two-physical-core CPU does not have four independent
physical execution cores simply because four logical CPUs are reported.
THROUGHPUT can allocate more streams and memory without helping this workload.
System RAM reached roughly 90-92% in the final repetition, leaving limited room
for the rest of the application and introducing another source of variance.

The current data does not support a reliable 10 FPS per camera commitment at this
model/precision/input-size configuration. Material compute reductions, any
calibrated quantization or input-size change, or different hardware require their
own labeled detection/counting validation; none was silently applied here.

Live two-camera performance, sensor/network buffering, browser end-to-end latency,
counting accuracy on labeled traffic, and cold-start/reconnect identity behavior
remain pending. The known production callback-arrival freshness issue is unchanged:
the experiment's post-inference publication gate is not a substitute for a
capture-timestamp-aware safety design before tracker/controller commits. Physical
signal behavior was neither exercised nor validated.
