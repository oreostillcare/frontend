from traffic_control import ALL_RED, NODE_A, NODE_B, PointComparisonController, priority_command
from traffic_transactions import TrafficTransactionManager


class FakeSignalController:
    def __init__(self):
        self.commands = []
        self.refreshes = []

    def apply(self, command):
        self.commands.append(command)
        signals = {
            NODE_A: "GREEN" if command == NODE_A else "RED",
            NODE_B: "GREEN" if command == NODE_B else "RED",
        }
        return {
            "success": True,
            "commandedState": "BOTH RED" if command == ALL_RED else f"{command} GREEN",
            "nodes": {
                node: {"success": True, "state": signal}
                for node, signal in signals.items()
            },
            "error": None,
        }

    def refresh(self, command):
        self.refreshes.append(command)
        return self.apply(command)


class FailedRefreshSignalController(FakeSignalController):
    def refresh(self, command):
        self.refreshes.append(command)
        return {
            "success": False,
            "commandedState": "OPPOSITE RED NOT VERIFIED",
            "nodes": {},
            "error": "ESP32 unavailable",
        }


class FakeTransactionWriter:
    def __init__(self):
        self.payloads = []

    def write(self, payload):
        self.payloads.append(payload)
        return {"success": True, "error": None}


def test_higher_points_select_the_corresponding_node_and_ties_prioritize_node_a():
    assert priority_command(12, 8) == NODE_A
    assert priority_command(8, 12) == NODE_B
    assert priority_command(8, 8) == NODE_A
    assert priority_command(12, 8, cameras_ready=False) == ALL_RED


def test_comparison_controller_changes_signals_when_the_winner_changes():
    scores = {
        NODE_A: {"points": 12, "ready": True},
        NODE_B: {"points": 8, "ready": True},
    }
    signals = FakeSignalController()
    controller = PointComparisonController(lambda: scores, signals)

    first = controller.evaluate_once()
    scores[NODE_A]["points"] = 4
    scores[NODE_B]["points"] = 14
    second = controller.evaluate_once()

    assert signals.commands == [NODE_A, NODE_B]
    assert first[NODE_A]["signal"] == "GREEN"
    assert first[NODE_B]["signal"] == "RED"
    assert second[NODE_A]["signal"] == "RED"
    assert second[NODE_B]["signal"] == "GREEN"


def test_comparison_controller_refreshes_an_unchanged_decision():
    scores = {
        NODE_A: {"points": 7, "ready": True},
        NODE_B: {"points": 4, "ready": True},
    }
    signals = FakeSignalController()
    controller = PointComparisonController(lambda: scores, signals)

    controller.evaluate_once()
    controller.evaluate_once()

    assert signals.commands == [NODE_A, NODE_A]
    assert signals.refreshes == [NODE_A]


def test_failed_refresh_does_not_keep_reporting_stale_green_state():
    scores = {
        NODE_A: {"points": 7, "ready": True},
        NODE_B: {"points": 4, "ready": True},
    }
    signals = FailedRefreshSignalController()
    controller = PointComparisonController(lambda: scores, signals)

    controller.evaluate_once()
    failed = controller.evaluate_once()

    assert failed[NODE_A]["signal"] == "UNKNOWN"
    assert failed[NODE_B]["signal"] == "UNKNOWN"
    assert failed["lastError"] == "ESP32 unavailable"


def test_transaction_batch_stays_frozen_then_locks_both_red_until_destination_completes():
    scores = {
        NODE_A: {
            "points": 4,
            "ready": True,
            "vehicles": [
                {
                    "gid": "GID-1",
                    "trackId": 10,
                    "class": "car",
                    "confidence": 0.9,
                    "detectedAt": "2026-09-14T00:00:00Z",
                    "points": 4,
                }
            ],
        },
        NODE_B: {"points": 2, "ready": True, "vehicles": []},
    }
    signals = FakeSignalController()
    transactions = TrafficTransactionManager(outgoing_confirmation_seconds=0)
    writer = FakeTransactionWriter()
    controller = PointComparisonController(
        lambda: scores,
        signals,
        transaction_manager=transactions,
        transaction_writer=writer,
    )

    calculating = controller.evaluate_once()
    started = controller.evaluate_once()
    scores[NODE_B]["points"] = 20
    source_still_green = controller.evaluate_once()
    transactions.observe_detections(
        1,
        [
            {
                "vehicleId": "GID-1",
                "trackId": 10,
                "confidence": 0.9,
                "trafficRole": "INCOMING",
                "redTransition": True,
            }
        ],
    )
    waiting = controller.evaluate_once()
    for _ in range(3):
        transactions.observe_detections(
            2,
            [
                {
                    "vehicleId": "OTHER-1",
                    "trackId": 20,
                    "class": "car",
                    "confidence": 0.88,
                    "boundingBox": [100, 100, 160, 160],
                    "centerPoint": [130, 130],
                    "inTrafficZone": True,
                    "trafficRole": "OUTGOING",
                    "outgoingRouteComplete": True,
                    "outgoingRouteTransition": True,
                }
            ],
        )
    completed = controller.evaluate_once()

    assert calculating["decision"] == ALL_RED
    assert started["decision"] == NODE_A
    assert started["transaction"]["batchTotal"] == 1
    assert source_still_green["decision"] == NODE_A
    assert waiting["decision"] == ALL_RED
    assert waiting["transaction"]["sourceRemaining"] == 0
    assert len(writer.payloads) == 1
    assert completed["transaction"] is None
    assert completed["lastCompletedTransaction"]["status"] == "complete"
