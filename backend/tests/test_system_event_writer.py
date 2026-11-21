from modules.system_logs.system_event_writer import SystemHealthMonitor


class FakeWriter:
    def __init__(self):
        self.events = []

    def write(self, event):
        self.events.append(event)
        return {"success": True, "persisted": True}


def camera(online=False):
    return {
        1: {
            "configured": True,
            "online": online,
            "observationFresh": online,
            "processingError": None,
            "modelOnline": True,
            "nodeId": "node-a",
            "laneId": "lane-a",
        }
    }


def controller(online=False):
    return {"nodeA": {"online": online, "wifiConnected": online}, "nodeB": {"online": online, "wifiConnected": online}}


def test_health_transitions_are_deduplicated_and_resolved():
    writer = FakeWriter()
    monitor = SystemHealthMonitor(writer, lambda: camera(False), lambda: controller(True), critical_after=5)

    monitor.check_once()
    monitor.check_once()
    monitor.check_once()
    monitor.check_once()
    monitor.check_once()
    assert [event["severity"] for event in writer.events] == ["warning", "warning", "warning", "warning", "critical"]
    assert writer.events[0]["eventType"] == "camera_disconnected"
    assert [event["message"] for event in writer.events[1:4]] == [
        "Retry 1/3: Camera is disconnected",
        "Retry 2/3: Camera is disconnected",
        "Retry 3/3: Camera is disconnected",
    ]

    monitor.camera_provider = lambda: camera(True)
    monitor.check_once()
    assert writer.events[-1]["severity"] == "info"
    assert writer.events[-1]["eventStatus"] == "resolved"


def test_health_monitor_reports_unreachable_nodes_without_gps_or_compass_events():
    writer = FakeWriter()
    monitor = SystemHealthMonitor(writer, lambda: {}, lambda: controller(False))
    monitor.check_once()

    assert {event["eventType"] for event in writer.events} == {"esp32_disconnected"}
    assert all("gps" not in event["eventType"] and "compass" not in event["eventType"] for event in writer.events)


def test_health_monitor_reports_controller_errors():
    writer = FakeWriter()
    monitor = SystemHealthMonitor(writer, lambda: {}, lambda: controller(True), lambda: {"lastError": "signal failed"})
    monitor.check_once()
    assert writer.events[-1]["eventType"] == "traffic_controller_error"
    assert writer.events[-1]["nodeId"] == "system"
