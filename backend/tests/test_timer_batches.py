"""Clock-driven regressions: no cameras, network, physical signals, or sleeps."""

import pytest

import timer_batches
from timer_batches import TimerBatchManager
from traffic_control import ALL_RED, NODE_A, NODE_B, YELLOW_COMMANDS, Esp32SignalController, PointComparisonController
from tracking import TrackState, TrafficRegion


def queued(gid="waiting", track=1):
    return {"gid": gid, "trackId": track, "class": "car", "points": 4}


def crossing(gid="entered", track=10, outgoing=False):
    return {
        "vehicleId": gid, "trackId": track, "class": "car", "confidence": 0.9,
        "inTrafficZone": True, "trafficRole": "OUTGOING" if outgoing else "INCOMING",
        "redBoundaryTransition": not outgoing,
        "outgoingRouteTransition": outgoing,
        "boundingBox": [track * 100, 100, track * 100 + 50, 160],
        "centerPoint": [track * 100 + 25, 130],
    }


class Signals:
    def __init__(self):
        self.commands = []
        self.fail = None

    def apply(self, command):
        self.commands.append(command)
        if command == self.fail:
            return {"success": False, "commandedState": "FAILED", "nodes": {}, "error": "No acknowledgement"}
        states = {NODE_A: "RED", NODE_B: "RED"}
        if command in states:
            states[command] = "GREEN"
        elif command in YELLOW_COMMANDS.values():
            states[next(node for node, yellow in YELLOW_COMMANDS.items() if yellow == command)] = "YELLOW"
        assert list(states.values()).count("GREEN") <= 1
        return {
            "success": True, "commandedState": command, "error": None,
            "nodes": {node: {"success": True, "state": state} for node, state in states.items()},
        }

    refresh = apply


class Writer:
    enabled = False

    def write(self, payload):
        return {"success": True, "persisted": False}


@pytest.fixture
def clock(monkeypatch):
    value = [0.0]
    monkeypatch.setattr(timer_batches.time, "monotonic", lambda: value[0])
    return value


def setup_controller(manager=None):
    manager = manager or TimerBatchManager(outgoing_confirmation_frames=1, outgoing_confirmation_seconds=0)
    scores = {
        NODE_A: {"ready": True, "points": 4, "vehicles": [queued()], "behindGreenVehicles": 1},
        NODE_B: {"ready": True, "points": 100, "vehicles": [queued("b", 2)], "behindGreenVehicles": 0},
    }
    signals = Signals()
    controller = PointComparisonController(
        lambda: scores, signals, transaction_manager=manager, transaction_writer=Writer(),
    )
    assert controller.evaluate_once()["decision"] == ALL_RED
    return controller, manager, scores, signals


def test_timer_candidate_bypasses_higher_weight_and_does_not_count_waiting_vehicles(clock):
    controller, manager, _, _ = setup_controller()
    result = controller.evaluate_once()
    assert result["decision"] == NODE_A
    assert result["transaction"]["decisionMode"] == "TIMER"
    assert result["transaction"]["timerRemainingSeconds"] == 60
    assert result["transaction"]["enteredCount"] == 0
    manager.observe_detections(1, [{**crossing(), "redBoundaryTransition": False}])
    assert manager.snapshot_active()["enteredCount"] == 0


def test_weighted_selection_and_frozen_totals_remain_when_no_backlog(clock):
    controller, manager, scores, _ = setup_controller()
    scores[NODE_A]["behindGreenVehicles"] = 0
    result = controller.evaluate_once()
    assert result["decision"] == NODE_B
    assert result["transaction"]["decisionMode"] == "WEIGHTED"
    assert result["transaction"]["batchPoints"] == 100
    assert "timerRemainingSeconds" not in manager.snapshot_active()


def test_expiration_yellow_clearance_and_per_batch_counts(clock):
    controller, manager, _, _ = setup_controller()
    controller.evaluate_once()
    for index, moment in enumerate(range(0, 60, 10)):
        clock[0] = moment
        item = crossing(f"entry-{index}", 10 + index)
        manager.observe_detections(1, [item, item])
    assert manager.snapshot_active()["enteredCount"] == 6
    assert manager.snapshot_active()["destinationRemaining"] == 6
    clock[0] = 60
    expired = controller.evaluate_once()
    assert expired["decision"] == YELLOW_COMMANDS[NODE_A]
    assert expired["nodeB"]["signal"] == "RED"
    assert expired["transaction"]["endReason"] == "timer_expired"
    clock[0] = 61.99
    assert controller.evaluate_once()["nodeA"]["signal"] == "YELLOW"
    clock[0] = 62
    waiting = controller.evaluate_once()
    assert waiting["decision"] == ALL_RED
    assert waiting["transaction"]["status"] == "clearance"
    for index in range(6):
        item = crossing(f"exit-{index}", 30 + index, outgoing=True)
        manager.observe_detections(2, [item, item])
    completed = controller.evaluate_once()
    assert completed["transaction"] is None
    assert completed["lastCompletedTransaction"]["enteredCount"] == 6
    assert completed["lastCompletedTransaction"]["exitedCount"] == 6


def test_inactivity_resets_on_entry_and_ends_at_15_seconds(clock):
    controller, manager, _, _ = setup_controller()
    controller.evaluate_once()
    for moment in (10, 20, 25):
        clock[0] = moment
        manager.observe_detections(1, [crossing(f"vehicle-{moment}", moment)])
    clock[0] = 39.99
    assert controller.evaluate_once()["decision"] == NODE_A
    clock[0] = 40
    result = controller.evaluate_once()
    assert result["decision"] == YELLOW_COMMANDS[NODE_A]
    assert result["transaction"]["endReason"] == "incoming_inactivity"
    assert result["transaction"]["unusedGreenSeconds"] == 20
    clock[0] = 42
    assert controller.evaluate_once()["transaction"]["status"] == "clearance"


def test_zero_entries_inactivity_counts_from_green_and_both_eligible_alternate(clock):
    controller, manager, scores, _ = setup_controller()
    scores[NODE_B]["behindGreenVehicles"] = 1
    assert controller.evaluate_once()["decision"] == NODE_A
    clock[0] = 15
    assert controller.evaluate_once()["decision"] == YELLOW_COMMANDS[NODE_A]
    clock[0] = 17
    completed = controller.evaluate_once()
    assert completed["lastCompletedTransaction"]["batchTotal"] == 0
    assert completed["transaction"] is None
    controller.evaluate_once()
    assert controller.evaluate_once()["decision"] == NODE_B


def test_entry_during_yellow_increases_expected_exits(clock):
    controller, manager, _, _ = setup_controller()
    controller.evaluate_once()
    clock[0] = 15
    controller.evaluate_once()
    clock[0] = 16
    manager.observe_detections(1, [crossing()])
    clock[0] = 17
    assert controller.evaluate_once()["transaction"]["destinationRemaining"] == 1
    manager.observe_detections(2, [crossing("exit", 20, outgoing=True)])
    assert controller.evaluate_once()["transaction"] is None


def test_equal_counts_do_not_end_green_early(clock):
    controller, manager, _, _ = setup_controller()
    controller.evaluate_once()
    manager.observe_detections(1, [crossing()])
    manager.observe_detections(2, [crossing("exit", 20, outgoing=True)])
    clock[0] = 10
    assert controller.evaluate_once()["decision"] == NODE_A


def test_camera_failure_latches_batch_even_after_camera_returns(clock):
    controller, manager, scores, _ = setup_controller()
    controller.evaluate_once()
    scores[NODE_B]["ready"] = False
    assert controller.evaluate_once()["decision"] == ALL_RED
    scores[NODE_B]["ready"] = True
    assert controller.evaluate_once()["transaction"]["status"] == "anomaly"
    assert controller.evaluate_once()["decision"] == ALL_RED


def test_yellow_ack_failure_requests_red_and_never_reopens_green(clock):
    controller, manager, _, signals = setup_controller()
    controller.evaluate_once()
    signals.fail = YELLOW_COMMANDS[NODE_A]
    clock[0] = 15
    result = controller.evaluate_once()
    assert result["decision"] == ALL_RED
    assert result["transaction"]["status"] == "anomaly"
    assert signals.commands[-1] == ALL_RED
    signals.fail = None
    assert controller.evaluate_once()["decision"] == ALL_RED


def test_entry_after_red_or_unmatched_exit_latches_anomaly(clock):
    controller, manager, _, _ = setup_controller()
    controller.evaluate_once()
    manager.observe_detections(1, [crossing()])
    clock[0] = 15
    controller.evaluate_once()
    clock[0] = 17
    controller.evaluate_once()
    manager.observe_detections(1, [crossing("late", 11)])
    assert controller.evaluate_once()["transaction"]["status"] == "anomaly"
    assert manager.snapshot_active()["enteredCount"] == 2


def test_unmatched_exit_during_green_cannot_clear_a_batch(clock):
    controller, manager, _, _ = setup_controller()
    controller.evaluate_once()
    manager.observe_detections(2, [crossing("unmatched", 20, outgoing=True)])
    assert controller.evaluate_once()["decision"] == ALL_RED
    assert manager.snapshot_active()["status"] == "anomaly"


def test_multiple_same_frame_exits_are_reconciled_without_losing_crossings(clock):
    controller, manager, _, _ = setup_controller()
    controller.evaluate_once()
    manager.observe_detections(1, [crossing("entry-1", 10), crossing("entry-2", 11)])
    exits = [crossing("exit-1", 20, outgoing=True), crossing("exit-2", 21, outgoing=True)]
    manager.observe_detections(2, exits)
    assert manager.snapshot_active()["exitedCount"] == 2
    manager.observe_detections(2, exits)
    assert manager.snapshot_active()["exitedCount"] == 2
    assert manager.snapshot_active()["status"] == "active"


def test_extra_same_frame_exit_is_an_anomaly_not_clearance(clock):
    controller, manager, _, _ = setup_controller()
    controller.evaluate_once()
    manager.observe_detections(1, [crossing()])
    manager.observe_detections(2, [
        crossing("exit-1", 20, outgoing=True), crossing("exit-2", 21, outgoing=True),
    ])
    assert manager.snapshot_active()["status"] == "anomaly"
    assert controller.evaluate_once()["decision"] == ALL_RED


def test_opposite_red_node_entry_requires_review(clock):
    controller, manager, _, _ = setup_controller()
    controller.evaluate_once()
    manager.observe_detections(2, [crossing("wrong-direction", 20)])
    assert manager.snapshot_active()["status"] == "anomaly"
    assert controller.evaluate_once()["decision"] == ALL_RED
    assert manager.snapshot()["unassignedCrossings"][0]["cameraId"] == 2


def test_restart_starts_with_clean_runtime_without_local_database(clock, tmp_path):
    manager = TimerBatchManager()
    manager.begin_timer(NODE_A, [queued()])
    manager.activate()
    manager.observe_detections(1, [crossing()])
    restarted = TimerBatchManager()
    assert restarted.snapshot_active() is None
    assert restarted.begin_timer(NODE_B, [queued()]) is not None
    assert not list(tmp_path.glob("*.sqlite"))


def test_no_batch_entry_blocks_current_runtime_only(clock):
    manager = TimerBatchManager()
    manager.observe_detections(1, [crossing()])
    assert manager.begin_timer(NODE_A, [queued()]) is None
    restarted = TimerBatchManager()
    assert restarted.snapshot()["blockedReason"] is None
    assert restarted.snapshot()["unassignedCrossings"] == []


def test_queue_freshness_and_behind_green_count(clock):
    manager = TimerBatchManager()
    manager.observe_detections(1, [{"trackId": 1, "behindGreenIncoming": True}])
    assert manager.queue_view(1) == {"fresh": True, "behindGreenVehicles": 1}
    clock[0] = 6
    assert manager.queue_view(1)["fresh"] is False


def test_yellow_wire_protocol_requires_opposite_red_first(monkeypatch):
    signal = Esp32SignalController("a", "b")
    requests = []

    def set_state(node, state):
        requests.append((node, state))
        return {"success": True, "state": state, "error": None}

    monkeypatch.setattr(signal, "_set_node_state", set_state)
    result = signal.apply(YELLOW_COMMANDS[NODE_A])
    assert result["success"]
    assert requests == [(NODE_B, "RED"), (NODE_A, "YELLOW")]


def test_weighted_cycle_keeps_expected_exit_gate_and_adds_yellow(clock):
    controller, manager, scores, _ = setup_controller()
    scores[NODE_A]["behindGreenVehicles"] = 0
    controller.evaluate_once()
    manager.observe_detections(2, [{**crossing("b", 2), "redTransition": True}])
    yellow = controller.evaluate_once()
    assert yellow["decision"] == YELLOW_COMMANDS[NODE_B]
    clock[0] = 2
    assert controller.evaluate_once()["transaction"]["destinationRemaining"] == 1
    manager.observe_detections(1, [crossing("exit-b", 20, outgoing=True)])
    assert controller.evaluate_once()["transaction"] is None


def test_backlog_requires_incoming_motion_and_true_red_boundary_crossing():
    region = TrafficRegion(green_y=100, red_y=200, motion_deadband=2)
    state = TrackState((0, 200, 300, 200), True)
    observations = []
    for y in (50, 60, 150, 190, 205):
        item = {"trackId": 1, "centerPoint": [100, y], "boundingBox": [90, y - 15, 110, y + 15]}
        state.update([item], region)
        observations.append(item)
    assert observations[0]["behindGreenIncoming"] is False
    assert observations[1]["behindGreenIncoming"] is True
    assert observations[1]["trafficRole"] is None
    assert observations[3]["redLineTouched"] is True
    assert observations[3]["redBoundaryTransition"] is False
    assert observations[4]["redBoundaryTransition"] is True


def test_entry_motion_is_verified_even_when_track_first_appears_between_lines():
    region = TrafficRegion(green_y=100, red_y=200, motion_deadband=2)
    state = TrackState((0, 200, 300, 200), True)
    first = {"trackId": 1, "centerPoint": [100, 180]}
    boundary = {"trackId": 1, "centerPoint": [100, 210]}
    state.update([first], region)
    state.update([boundary], region)
    assert boundary["redBoundaryTransition"] is True
