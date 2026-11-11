# Timer admission and weighted batches

Implemented on `added-timer-batching-logic-v-2.0.0` as an additional local
controller mode. Weighted class scores, score ties, frozen weighted candidates,
and existing outgoing confirmation/deduplication remain in place.

## Selecting the mode

Before each new batch the controller checks both cameras and fresh detection
observations. A node qualifies for TIMER when it has incoming scoring records
between the red/green lines and incoming tracks behind green. No percentage-full
threshold is assumed. Behind-green tracks must have measured incoming motion;
unknown stationary or outgoing tracks do not qualify. A known incoming track
retains its direction when it stops. Camera guides and framing must leave that
approach area visible.

With one eligible node, serve it without comparing scores. With two, serve the
opposite of the last completed batch's source. With no previous batch, A starts,
matching the existing tie convention. With neither eligible, use the original
weighted decision. The selected mode stays fixed for the batch.

## Admission and clearance

- TIMER starts 60 seconds only after verified GREEN. Entries are actual incoming
  center crossings of the red boundary (`redBoundaryTransition`), not occupancy
  or an early bounding-box touch. Each admitted GID/source track is counted once.
- Every entry adds one expected exit at the opposite node and records class,
  timestamps, source, destination, and transaction ID. TIMER is not a frozen list:
  newly arriving vehicles can join while admission remains open.
- Stop green at 60 seconds, or 15 consecutive seconds without a verified entry.
  The inactivity clock starts at GREEN, including when no vehicle enters.
- Both modes now pass through a two-second prototype YELLOW warning, timed from
  its acknowledgement, with the opposite node RED. Entries during timer yellow
  still belong to that batch. An unplanned entry outside a frozen weighted batch
  is recorded and requires review rather than being silently discarded.
- After YELLOW, require both RED acknowledgements. TIMER clears when entered
  equals exited; WEIGHTED clears when the existing opposite expected count is
  zero (and the frozen source batch has been released). The opposite direction
  cannot be released just because the timer stopped.
- Persist the completed batch before recalculating another cycle, retaining the
  existing Firestore retry behavior. Entry/exit equality during GREEN does not
  end that admission phase early.

## Runtime state and persistence

The active timer and its entry/exit counters live in the backend process memory.
Only completed batches are sent through the existing authenticated Firestore
endpoint and stored in `trafficTransactions` and `trafficEvents`, including
decision mode and timer metadata. The website reads the authoritative live
snapshot from the backend; it does not schedule or persist countdown ticks.

Camera/model loss, stale detection results (over five seconds), failed signal
acknowledgements, unmatched timer exits, and unexpected entries hold both RED
and expose an anomaly/review reason. A backend restart loses unfinished runtime
state, so the operator must verify both RED and road clearance before starting a
new cycle.

## Dashboard and configuration

The existing dashboard Remaining field now receives the prioritized node's
controller countdown, and Mode reports TIMER or WEIGHTED. It polls authoritative
backend state; the website does not schedule lights or need to remain open.
The system API's `trafficControl.transaction` also exposes entered/exited counts,
expected exits, stage, end reason, unused seconds, and anomaly information.

```dotenv
ENABLE_TIMER_BATCHING=true
SMARTROAD_OBSERVATION_ONLY=true
```

`ENABLE_TIMER_BATCHING=false` disables timer selection, keeping weighted scoring
and the new shared yellow/clearance accounting. Observation-only and mirror mode
still prevent all ESP32 I/O, scheduling, and Firestore uploads. They have not been
turned off by this implementation. Clock-driven tests use fake signal adapters;
there is no automatic switch from observation-only to physical operation.

Physical firmware must accept and acknowledge `YELLOW` at `/command` in addition
to RED/GREEN. No ESP32 firmware is included in this repository. Missing YELLOW
support produces a red request and a latched anomaly rather than skipping the
warning. The proposed two-second interval is a prototype value; physical timing
and detector/count reliability need site-specific verification before deployment.

## Regression coverage

`backend/tests/test_timer_batches.py` covers selection, alternation, expiry,
inactivity (including zero entries), live entry/exit accounting, yellow arrivals,
weighted clearance, camera/signal faults, in-memory restart behavior, backlog direction,
and true entry-boundary crossings without cameras or network calls. Frontend
transaction tests cover empty timer batches, reconciled counts, and chunked
storage. Run validation only with explicit authorization, per AGENTS.md.
