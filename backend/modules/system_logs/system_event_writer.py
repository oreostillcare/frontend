"""Reports backend health transitions to the live Firestore system log."""

import json
import threading
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class SystemEventWriter:
    """Posts sanitized health events to the Next.js Firestore boundary."""

    def __init__(self, endpoint: str, secret: str = "", timeout_seconds: float = 5.0, enabled: bool = True):
        self.endpoint = endpoint
        self.secret = secret
        self.timeout_seconds = max(0.5, timeout_seconds)
        self.enabled = bool(enabled and endpoint and secret)

    def write(self, event: dict) -> dict:
        if not self.enabled:
            return {"success": True, "persisted": False, "error": None}

        payload = {**event, "occurredAt": event.get("occurredAt") or utc_timestamp()}
        headers = {"Accept": "application/json", "Content-Type": "application/json", "Authorization": f"Bearer {self.secret}"}
        request = Request(self.endpoint, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
                persisted = 200 <= response.status < 300 and body.get("success") is True
                return {"success": persisted, "persisted": persisted, "error": body.get("message")}
        except HTTPError as error:
            try:
                body = json.loads(error.read().decode("utf-8"))
                message = body.get("message")
            except (json.JSONDecodeError, UnicodeDecodeError):
                message = None
            return {"success": False, "persisted": False, "error": message or f"HTTP {error.code}"}
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            return {"success": False, "persisted": False, "error": str(error)}


class SystemHealthMonitor:
    """Converts camera and node health transitions into deduplicated events."""

    def __init__(
        self,
        writer: SystemEventWriter,
        camera_provider,
        controller_provider,
        traffic_provider=None,
        interval_seconds: float = 10.0,
        critical_after: int = 5,
    ):
        self.writer = writer
        self.camera_provider = camera_provider
        self.controller_provider = controller_provider
        self.traffic_provider = traffic_provider or (lambda: {})
        self.interval_seconds = max(1.0, interval_seconds)
        self.critical_after = max(5, critical_after)
        self._states: dict[str, int] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="system-health-monitor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=max(2.0, self.interval_seconds + 1.0))

    def _run(self) -> None:
        while not self._stop.is_set():
            self.check_once()
            self._stop.wait(self.interval_seconds)

    def _observe(self, key: str, condition: bool, event: dict) -> None:
        previous_failures = self._states.get(key, 0)
        if not condition:
            if previous_failures:
                self.writer.write({**event, "severity": "info", "eventStatus": "resolved"})
                self._states.pop(key, None)
            return

        failures = previous_failures + 1
        self._states[key] = failures
        if previous_failures == 0:
            self.writer.write({**event, "severity": "warning", "eventStatus": "observed"})
        elif failures < self.critical_after:
            retry_number = failures - 1
            retry_limit = self.critical_after - 2
            self.writer.write(
                {
                    **event,
                    "severity": "warning",
                    "eventStatus": "active",
                    "message": f"Retry {retry_number}/{retry_limit}: {event['message']}",
                }
            )
        elif failures == self.critical_after:
            self.writer.write({**event, "severity": "critical", "eventStatus": "active", "message": f"{event['message']} persists after retries"})

    def check_once(self) -> None:
        for camera_id, camera in self.camera_provider().items():
            node_id = camera.get("nodeId", f"node-{camera_id}")
            lane_id = camera.get("laneId")
            base = {"category": "camera", "component": f"camera-{camera_id}", "nodeId": node_id, "laneId": lane_id}
            keys = (f"camera-{camera_id}-source", f"camera-{camera_id}-connection", f"camera-{camera_id}-processing", f"camera-{camera_id}-stale")
            active_key = None
            active_event = None
            if not camera.get("configured", True):
                active_key = keys[0]
                active_event = {**base, "eventType": "camera_unavailable", "message": "Camera source is not configured"}
            elif not camera.get("online", False):
                active_key = keys[1]
                active_event = {**base, "eventType": "camera_disconnected", "message": camera.get("captureError") or "Camera is disconnected"}
            elif camera.get("processingError") or camera.get("modelOnline") is False:
                active_key = keys[2]
                active_event = {**base, "eventType": "detector_unavailable", "message": camera.get("processingError") or "Vehicle detector is unavailable"}
            elif camera.get("observationFresh") is False:
                active_key = keys[3]
                active_event = {**base, "eventType": "camera_stale", "message": "Camera feed is stale"}

            for key in keys:
                event = active_event if key == active_key else {**base, "eventType": "camera_health", "message": "Camera health restored"}
                self._observe(key, key == active_key, event)

        controller = self.controller_provider() or {}
        for node_key, node in (("nodeA", controller.get("nodeA")), ("nodeB", controller.get("nodeB"))):
            if not isinstance(node, dict):
                continue
            node_id = "node-a" if node_key == "nodeA" else "node-b"
            base = {"category": "node", "component": "esp32", "nodeId": node_id, "laneId": f"lane-{node_id[-1]}"}
            disconnected_key = f"{node_key}-disconnected"
            wifi_key = f"{node_key}-wifi"
            self._observe(disconnected_key, not node.get("online", False), {**base, "eventType": "esp32_disconnected", "message": "ESP32 node is unreachable"})
            self._observe(wifi_key, bool(node.get("online")) and not node.get("wifiConnected", False), {**base, "eventType": "wifi_disconnected", "message": "Node Wi-Fi is disconnected"})

        traffic = self.traffic_provider() or {}
        self._observe(
            "traffic-controller-error",
            bool(traffic.get("lastError")),
            {
                "category": "traffic_control",
                "component": "traffic-controller",
                "eventType": "traffic_controller_error",
                "message": traffic.get("lastError") or "Traffic controller is healthy",
                "nodeId": "system",
            },
        )
