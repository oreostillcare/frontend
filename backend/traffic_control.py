import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


NODE_A = "nodeA"
NODE_B = "nodeB"
ALL_RED = "allRed"
RED = "RED"
GREEN = "GREEN"
UNKNOWN = "UNKNOWN"


def priority_command(node_a_points: int, node_b_points: int, cameras_ready: bool = True) -> str:
    if not cameras_ready:
        return ALL_RED
    return NODE_A if node_a_points >= node_b_points else NODE_B


class Esp32SignalController:
    """Applies the existing Flow 1 both-red-before-green safety sequence."""

    def __init__(
        self,
        node_a_ip: str,
        node_b_ip: str,
        timeout_seconds: float = 1.25,
        request_attempts: int = 2,
        heartbeat_interval_seconds: float = 2.0,
        heartbeat_timeout_seconds: float = 5.0,
    ):
        self.nodes = {
            NODE_A: {"name": "NODE-A", "ip": node_a_ip},
            NODE_B: {"name": "NODE-B", "ip": node_b_ip},
        }
        self.timeout_seconds = max(0.1, timeout_seconds)
        self.request_attempts = max(1, request_attempts)
        self.heartbeat_interval_seconds = max(0.1, heartbeat_interval_seconds)
        self.heartbeat_timeout_seconds = max(0.1, heartbeat_timeout_seconds)
        self._command_lock = threading.Lock()
        self._heartbeat_lock = threading.Lock()
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread: threading.Thread | None = None
        self._heartbeats = {
            node_key: {
                "lastSeenMonotonic": None,
                "lastSeen": None,
                "powerOn": False,
                "wifiConnected": False,
                "ssid": None,
            }
            for node_key in self.nodes
        }

    def _call(self, node_key: str, method: str, path: str, payload: dict | None = None) -> dict:
        node = self.nodes[node_key]
        body = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        last_error = "No response"
        for attempt in range(self.request_attempts):
            request = Request(
                f"http://{node['ip']}{path}",
                data=body,
                headers=headers,
                method=method,
            )
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    data = json.loads(response.read().decode("utf-8"))
                    return {"ok": 200 <= response.status < 300, "data": data}
            except HTTPError as error:
                return {"ok": False, "error": f"HTTP {error.code}"}
            except (URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
                last_error = str(error)
                if attempt + 1 < self.request_attempts:
                    time.sleep(0.1)
        return {"ok": False, "error": last_error}

    def _set_node_state(self, node_key: str, state: str) -> dict:
        result = self._call(node_key, "POST", "/command", {"state": state})
        data = result.get("data", {})
        verified = (
            result["ok"]
            and data.get("success") is True
            and data.get("node") == self.nodes[node_key]["name"]
            and data.get("state") == state
        )
        return {
            "online": result["ok"],
            "success": verified,
            "state": data.get("state") if result["ok"] else UNKNOWN,
            "error": None if verified else result.get("error", "Invalid ESP32 response"),
        }

    @staticmethod
    def _status_bool(value) -> bool | None:
        if isinstance(value, bool):
            return value
        if isinstance(value, int) and value in (0, 1):
            return bool(value)
        if isinstance(value, str):
            normalized = value.strip().upper()
            if normalized in {"ON", "ONLINE", "CONNECTED", "TRUE", "1"}:
                return True
            if normalized in {"OFF", "OFFLINE", "DISCONNECTED", "FALSE", "0"}:
                return False
        return None

    def _record_heartbeat(self, node_key: str, result: dict) -> None:
        if not result.get("ok") or not isinstance(result.get("data"), dict):
            return

        data = result["data"]
        reported_node = data.get("node")
        if reported_node is not None and reported_node != self.nodes[node_key]["name"]:
            return

        wifi = data.get("wifi")
        wifi_data = wifi if isinstance(wifi, dict) else {}
        power_on = self._status_bool(data.get("powerOn", data.get("power")))
        wifi_connected = self._status_bool(
            wifi_data.get(
                "connected",
                data.get("wifiConnected", data.get("wifiStatus", wifi)),
            )
        )
        ssid = wifi_data.get("ssid", data.get("ssid"))
        if not isinstance(ssid, str) or not ssid.strip():
            ssid = None

        with self._heartbeat_lock:
            previous = self._heartbeats[node_key]
            self._heartbeats[node_key] = {
                "lastSeenMonotonic": time.monotonic(),
                "lastSeen": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "powerOn": True if power_on is None else power_on,
                "wifiConnected": True if wifi_connected is None else wifi_connected,
                "ssid": ssid or previous["ssid"],
            }

    def heartbeat_once(self) -> dict:
        """Poll both ESP32 status endpoints and record valid heartbeat responses."""
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {
                node_key: executor.submit(self._call, node_key, "GET", "/status")
                for node_key in self.nodes
            }
            for node_key, future in futures.items():
                self._record_heartbeat(node_key, future.result())
        return self.heartbeat_snapshot()

    def start_heartbeat(self) -> None:
        if self._heartbeat_thread and self._heartbeat_thread.is_alive():
            return
        self._heartbeat_stop.clear()
        self._heartbeat_thread = threading.Thread(
            target=self._run_heartbeat,
            name="esp32-heartbeat",
            daemon=True,
        )
        self._heartbeat_thread.start()

    def stop_heartbeat(self) -> None:
        self._heartbeat_stop.set()
        if self._heartbeat_thread and self._heartbeat_thread.is_alive():
            join_timeout = max(
                2.0,
                self.timeout_seconds * self.request_attempts + 0.5,
            )
            self._heartbeat_thread.join(timeout=join_timeout)

    def heartbeat_snapshot(self) -> dict:
        now = time.monotonic()
        with self._heartbeat_lock:
            nodes = {}
            for node_key, heartbeat in self._heartbeats.items():
                last_seen = heartbeat["lastSeenMonotonic"]
                online = last_seen is not None and now - last_seen <= self.heartbeat_timeout_seconds
                nodes[node_key] = {
                    "online": online,
                    "powerOn": heartbeat["powerOn"] if online else False,
                    "wifiConnected": heartbeat["wifiConnected"] if online else False,
                    "ssid": heartbeat["ssid"],
                    "lastSeen": heartbeat["lastSeen"],
                }
        return {"timeoutSeconds": self.heartbeat_timeout_seconds, **nodes}

    def _run_heartbeat(self) -> None:
        while not self._heartbeat_stop.is_set():
            self.heartbeat_once()
            self._heartbeat_stop.wait(self.heartbeat_interval_seconds)

    def _set_both_red(self) -> dict[str, dict]:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {
                node_key: executor.submit(self._set_node_state, node_key, RED)
                for node_key in self.nodes
            }
            return {node_key: future.result() for node_key, future in futures.items()}

    def apply(self, command: str) -> dict:
        if command not in (NODE_A, NODE_B, ALL_RED):
            return {"success": False, "error": "Invalid traffic command", "nodes": {}}

        with self._command_lock:
            node_results = self._set_both_red()
            both_red = all(result["success"] for result in node_results.values())
            if command == ALL_RED:
                return {
                    "success": both_red,
                    "commandedState": "BOTH RED" if both_red else "RED REQUEST FAILED",
                    "nodes": node_results,
                    "error": None if both_red else "One or both nodes did not confirm RED",
                }

            if not both_red:
                return {
                    "success": False,
                    "commandedState": "BOTH RED NOT VERIFIED",
                    "nodes": node_results,
                    "error": "Both nodes must confirm RED; GREEN was not sent",
                }

            green_result = self._set_node_state(command, GREEN)
            node_results[command] = green_result
            if not green_result["success"]:
                return {
                    "success": False,
                    "commandedState": "GREEN REQUEST FAILED",
                    "nodes": node_results,
                    "error": f"{self.nodes[command]['name']} did not confirm GREEN",
                }

            return {
                "success": True,
                "commandedState": f"{self.nodes[command]['name']} GREEN",
                "nodes": node_results,
                "error": None,
            }

    def refresh(self, command: str) -> dict:
        """Refresh an already verified state without briefly turning the winner red."""
        if command not in (NODE_A, NODE_B, ALL_RED):
            return {"success": False, "error": "Invalid traffic command", "nodes": {}}
        if command == ALL_RED:
            return self.apply(ALL_RED)

        red_node = NODE_B if command == NODE_A else NODE_A
        with self._command_lock:
            red_result = self._set_node_state(red_node, RED)
            node_results = {red_node: red_result}
            if not red_result["success"]:
                return {
                    "success": False,
                    "commandedState": "OPPOSITE RED NOT VERIFIED",
                    "nodes": node_results,
                    "error": f"{self.nodes[red_node]['name']} did not confirm RED",
                }

            green_result = self._set_node_state(command, GREEN)
            node_results[command] = green_result
            if not green_result["success"]:
                return {
                    "success": False,
                    "commandedState": "GREEN REFRESH FAILED",
                    "nodes": node_results,
                    "error": f"{self.nodes[command]['name']} did not confirm GREEN",
                }

            return {
                "success": True,
                "commandedState": f"{self.nodes[command]['name']} GREEN",
                "nodes": node_results,
                "error": None,
            }


class PointComparisonController:
    """Runs weighted priority directly or through a frozen transaction batch."""

    def __init__(
        self,
        read_points,
        signal_controller,
        interval_seconds: float = 1.0,
        enabled: bool = True,
        transaction_manager=None,
        transaction_writer=None,
    ):
        self.read_points = read_points
        self.signal_controller = signal_controller
        self.transaction_manager = transaction_manager
        self.transaction_writer = transaction_writer
        self.interval_seconds = max(0.1, interval_seconds)
        self.enabled = enabled
        self._lock = threading.RLock()
        self._evaluation_lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._applied_command: str | None = None
        self._calculation_ready = False
        initial_mode = "TRANSACTION_BATCH" if transaction_manager is not None else "POINT_PRIORITY"
        self._snapshot = {
            "enabled": enabled,
            "mode": initial_mode if enabled else "DISABLED",
            "decision": ALL_RED if enabled else None,
            "commandedState": "INITIALIZING" if enabled else "DISABLED",
            "reason": "Waiting for camera scoring" if enabled else "Automatic ESP32 control is disabled",
            "nodeA": {"points": 0, "ready": False, "signal": UNKNOWN},
            "nodeB": {"points": 0, "ready": False, "signal": UNKNOWN},
            "transaction": None,
            "lastCompletedTransaction": None,
            "firestoreUploadEnabled": bool(
                transaction_writer is not None and getattr(transaction_writer, "enabled", True)
            ),
            "lastError": None,
        }
        if self.transaction_manager is not None:
            self.transaction_manager.set_wake_controller(self.wake)

    def start(self) -> None:
        if not self.enabled or (self._thread and self._thread.is_alive()):
            return
        self._thread = threading.Thread(target=self._run, name="point-priority-controller", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=max(2.0, self.interval_seconds * 2))
        if self.enabled and self._applied_command != ALL_RED:
            self.signal_controller.apply(ALL_RED)

    def wake(self) -> None:
        self._wake.set()

    def evaluate_once(self) -> dict:
        with self._evaluation_lock:
            return self._evaluate_once()

    def _evaluate_once(self) -> dict:
        scores = self.read_points()
        node_a = scores[NODE_A]
        node_b = scores[NODE_B]
        cameras_ready = bool(node_a["ready"] and node_b["ready"])
        command, reason = self._choose_command(scores, cameras_ready)

        if command != self._applied_command:
            result = self.signal_controller.apply(command)
        else:
            result = self.signal_controller.refresh(command)
        self._applied_command = command if result["success"] else None

        persistence_error = None
        if result["success"] and self.transaction_manager is not None:
            transaction = self.transaction_manager.snapshot_active()
            if transaction and transaction["status"] == "pending_green" and command == transaction["sourceKey"]:
                self.transaction_manager.activate()
                transaction = self.transaction_manager.snapshot_active()
            if transaction and transaction["status"] == "persist_pending" and command == ALL_RED:
                payload = self.transaction_manager.payload_for_firestore()
                if self.transaction_writer is None:
                    persistence_error = "Firestore transaction writer is not configured"
                elif payload is not None:
                    write_result = self.transaction_writer.write(payload)
                    if write_result["success"]:
                        persisted = write_result.get("persisted", True)
                        completed = self.transaction_manager.mark_completed(persisted=persisted)
                        action = "saved" if persisted else "completed locally (Firestore upload disabled)"
                        reason = f"Transaction {completed['transactionId']} {action}; recalculating next cycle"
                    else:
                        persistence_error = write_result.get("error") or "Firestore write failed"
                        reason = "Transaction complete; keeping both nodes RED while Firestore retry is pending"

        with self._lock:
            previous = self._snapshot
            node_results = result.get("nodes", {})
            commanded_state = result["commandedState"]
            last_error = persistence_error or result.get("error")
            signals = {
                NODE_A: self._signal_from_result(NODE_A, node_results, previous, result["success"]),
                NODE_B: self._signal_from_result(NODE_B, node_results, previous, result["success"]),
            }
            self._snapshot = {
                "enabled": self.enabled,
                "mode": "TRANSACTION_BATCH" if self.transaction_manager is not None else "POINT_PRIORITY",
                "decision": command,
                "commandedState": commanded_state,
                "reason": reason,
                "nodeA": {**self._score_view(node_a), "signal": signals[NODE_A]},
                "nodeB": {**self._score_view(node_b), "signal": signals[NODE_B]},
                "transaction": (
                    self.transaction_manager.snapshot_active() if self.transaction_manager is not None else None
                ),
                "lastCompletedTransaction": (
                    self.transaction_manager.snapshot()["lastCompleted"]
                    if self.transaction_manager is not None
                    else None
                ),
                "firestoreUploadEnabled": bool(
                    self.transaction_writer is not None
                    and getattr(self.transaction_writer, "enabled", True)
                ),
                "lastError": last_error,
            }
            return self.snapshot()

    def reset_for_testing(self, reset_state) -> dict:
        """Hold evaluation, verify both signals RED, then clear runtime state."""
        with self._evaluation_lock:
            result = self.signal_controller.apply(ALL_RED)
            red_verified = result["success"]
            reset_error = None
            if red_verified:
                try:
                    reset_state()
                except Exception as error:
                    reset_error = f"Detection reset failed: {error}"

            with self._lock:
                previous = self._snapshot
                node_results = result.get("nodes", {})
                self._applied_command = ALL_RED if red_verified else None
                self._calculation_ready = False
                self._snapshot = {
                    **previous,
                    "decision": ALL_RED,
                    "commandedState": result["commandedState"],
                    "reason": (
                        "Test state reset; waiting for fresh vehicle movement"
                        if red_verified and reset_error is None
                        else (
                            "Both signals are RED, but detection state did not fully reset"
                            if red_verified
                            else "Test reset blocked because both RED signals were not verified"
                        )
                    ),
                    "nodeA": {
                        "points": 0,
                        "ready": False,
                        "signal": self._signal_from_result(
                            NODE_A,
                            node_results,
                            previous,
                            red_verified,
                        ),
                    },
                    "nodeB": {
                        "points": 0,
                        "ready": False,
                        "signal": self._signal_from_result(
                            NODE_B,
                            node_results,
                            previous,
                            red_verified,
                        ),
                    },
                    "transaction": (
                        None
                        if red_verified and reset_error is None
                        else previous.get("transaction")
                    ),
                    "lastCompletedTransaction": (
                        None
                        if red_verified and reset_error is None
                        else previous.get("lastCompletedTransaction")
                    ),
                    "lastError": reset_error or result.get("error"),
                }
                return self.snapshot()

    def _choose_command(self, scores: dict, cameras_ready: bool) -> tuple[str, str]:
        if not cameras_ready:
            self._calculation_ready = False
            return ALL_RED, "Both cameras and detection models must be online"

        if self.transaction_manager is None:
            command = priority_command(scores[NODE_A]["points"], scores[NODE_B]["points"], True)
            if scores[NODE_A]["points"] == scores[NODE_B]["points"]:
                return command, "Point totals are tied; Node A has priority"
            winner = "Node A" if command == NODE_A else "Node B"
            return command, f"{winner} has more incoming points"

        transaction = self.transaction_manager.snapshot_active()
        if transaction is not None:
            if transaction["status"] in {"pending_green", "active"} and transaction["sourceRemaining"] > 0:
                return transaction["sourceKey"], (
                    f"Frozen {transaction['sourceNode']} batch: "
                    f"{transaction['sourceRemaining']} source vehicles remaining"
                )
            if transaction["status"] == "persist_pending":
                return ALL_RED, "Transaction complete; keeping both nodes RED until Firestore confirms the write"
            return ALL_RED, (
                f"Source batch released; waiting for {transaction['destinationRemaining']} "
                f"vehicles at {transaction['destinationNode']}"
            )

        if not self._calculation_ready:
            self._calculation_ready = True
            return ALL_RED, "Both nodes RED; calculating vehicle totals and weighted points"

        command = priority_command(scores[NODE_A]["points"], scores[NODE_B]["points"], True)
        vehicles = scores[command].get("vehicles", [])
        if not vehicles:
            return ALL_RED, "No incoming vehicles are available for a new batch"

        transaction = self.transaction_manager.begin(command, vehicles, scores[command]["points"])
        if transaction is None:
            return ALL_RED, "Unable to freeze an incoming vehicle batch"
        self._calculation_ready = False
        tie_note = " (tie; Node A priority)" if scores[NODE_A]["points"] == scores[NODE_B]["points"] else ""
        return command, (
            f"Frozen {transaction['batchTotal']} vehicles from {transaction['sourceNode']}"
            f"{tie_note}"
        )

    @staticmethod
    def _score_view(score: dict) -> dict:
        return {"points": score["points"], "ready": score["ready"]}

    @staticmethod
    def _signal_from_result(
        node_key: str,
        node_results: dict,
        previous: dict,
        preserve_missing: bool = True,
    ) -> str:
        result = node_results.get(node_key)
        if result and result.get("success") and result.get("state") in (RED, GREEN):
            return result["state"]
        if result:
            return UNKNOWN
        return previous[node_key]["signal"] if preserve_missing else UNKNOWN

    def snapshot(self) -> dict:
        with self._lock:
            return {
                **self._snapshot,
                "nodeA": dict(self._snapshot["nodeA"]),
                "nodeB": dict(self._snapshot["nodeB"]),
            }

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.evaluate_once()
            except Exception as error:
                try:
                    safety_result = self.signal_controller.apply(ALL_RED)
                except Exception as safety_error:
                    safety_result = {
                        "success": False,
                        "commandedState": "RED REQUEST FAILED",
                        "nodes": {},
                        "error": str(safety_error),
                    }
                last_error = str(error)
                if safety_result.get("error"):
                    last_error += f"; safety command: {safety_result['error']}"
                with self._lock:
                    previous = self._snapshot
                    node_results = safety_result.get("nodes", {})
                    self._snapshot = {
                        **previous,
                        "decision": ALL_RED,
                        "commandedState": safety_result["commandedState"],
                        "reason": "Controller error; requested both red",
                        "nodeA": {
                            **previous[NODE_A],
                            "signal": self._signal_from_result(
                                NODE_A,
                                node_results,
                                previous,
                                safety_result["success"],
                            ),
                        },
                        "nodeB": {
                            **previous[NODE_B],
                            "signal": self._signal_from_result(
                                NODE_B,
                                node_results,
                                previous,
                                safety_result["success"],
                            ),
                        },
                        "lastError": last_error,
                    }
                self._applied_command = ALL_RED if safety_result["success"] else None
            self._wake.wait(self.interval_seconds)
            self._wake.clear()
