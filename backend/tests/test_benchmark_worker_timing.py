import ast
from pathlib import Path

from scripts.benchmark_worker_timing import BoundedMetrics, Trace, high_resolution_wait, timed_predictor


def test_deadline_wait_uses_remaining_time_and_can_stop_within_one_chunk():
    clock = [0.0]
    waits = []

    class Event:
        stopped = False

        def is_set(self):
            return self.stopped

    event = Event()

    def sleep(seconds):
        waits.append(seconds)
        clock[0] += seconds

    assert not high_resolution_wait(event, .035, lambda: clock[0], sleep)
    assert abs(clock[0] - .035) < 1e-9 and max(waits) <= .01
    assert not high_resolution_wait(event, .01, lambda: clock[0], sleep)  # Past deadline: no catch-up wait.
    count = len(waits)

    def interrupted_sleep(seconds):
        sleep(seconds)
        event.stopped = True

    assert high_resolution_wait(event, 1, lambda: clock[0], interrupted_sleep)
    assert len(waits) == count + 1


def test_fixed_histogram_memory_does_not_grow_with_frame_count():
    metrics = BoundedMetrics()
    for _ in range(20000):
        metrics.add("sleepMs", 7.25)
    assert len(metrics.values["sleepMs"][1]) == 10002
    result = metrics.summary()["sleepMs"]
    assert result["count"] == 20000 and result["mean"] == 7.25
    assert result["p99BinUpper"] == 7.3


def test_trace_measures_sleep_overshoot_and_separates_copy_and_wait():
    trace = Trace()
    trace.record({"iterationStartAt": 0., "rawLockRequestedAt": 0., "rawLockAcquiredAt": .001,
        "frameWaitStartedAt": .001, "workerWakeupAt": .003, "frameAcquiredAt": .003,
        "frameCopyDoneAt": .004, "detectorStartedAt": .004, "detectorDoneAt": .034,
        "completedAt": .035, "sleepStartedAt": .035, "sleepDoneAt": .108,
        "sleepRequestedMs": 65, "scheduledDeadlineAt": .100, "actualNextIterationAt": .108})
    result = trace.drain()[0]
    assert abs(result["frameCopyMs"] - 1) < 1e-9
    assert abs(result["frameWaitMs"] - 2) < 1e-9
    assert abs(result["sleepOvershootMs"] - 8) < 1e-9
    assert abs(result["unaccountedWorkMs"]) < 1e-9


def test_predictor_hooks_preserve_outputs_and_callback_order():
    calls = []

    class Base:
        def preprocess(self, value): calls.append("preprocess"); return value
        def inference(self, value): calls.append("inference"); return value
        def postprocess(self, value): calls.append("postprocess"); return value
        def run_callbacks(self, event): calls.append(event)

    trace = Trace()
    model = timed_predictor(Base, trace, "local")()
    value = object()
    assert model.preprocess(value) is value
    assert model.inference(value) is value
    assert model.postprocess(value) is value
    model.run_callbacks("on_predict_postprocess_end")
    assert calls == ["preprocess", "inference", "postprocess", "on_predict_postprocess_end"]
    assert trace.current["localPreprocessDoneAt"] <= trace.current["localInferenceDoneAt"]
    assert trace.current["localPostprocessDoneAt"] <= trace.current["localByteTrackDoneAt"]


def test_production_loops_are_inherited_and_no_control_modules_imported():
    tree = ast.parse((Path(__file__).parents[1] / "scripts/benchmark_worker_timing.py").read_text())
    forbidden = {"app", "flask", "traffic_control", "traffic_transactions", "firebase_admin"}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            assert node.name not in {"_capture_loop", "_processing_loop"}
        elif isinstance(node, ast.ImportFrom):
            assert (node.module or "").split(".")[0] not in forbidden
        elif isinstance(node, ast.Import):
            assert not {alias.name.split(".")[0] for alias in node.names} & forbidden
