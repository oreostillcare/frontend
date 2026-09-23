import json
import math
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


NODE_A = "nodeA"
NODE_B = "nodeB"
NODE_IDS = {NODE_A: "node-a", NODE_B: "node-b"}
CAMERA_NODES = {1: NODE_A, 2: NODE_B}
NODE_CAMERAS = {node_key: camera_id for camera_id, node_key in CAMERA_NODES.items()}


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class TrafficTransactionManager:
    """Owns one frozen, direction-specific vehicle batch at a time."""

    def __init__(
        self,
        wake_controller=None,
        outgoing_confirmation_frames: int = 3,
        outgoing_confirmation_seconds: float = 1.0,
        outgoing_id_switch_grace_seconds: float = 1.0,
    ):
        self._lock = threading.RLock()
        self._active: dict | None = None
        self._last_completed: dict | None = None
        self._wake_controller = wake_controller
        self.outgoing_confirmation_frames = max(1, outgoing_confirmation_frames)
        self.outgoing_confirmation_seconds = max(0.0, outgoing_confirmation_seconds)
        self.outgoing_id_switch_grace_seconds = max(0.1, outgoing_id_switch_grace_seconds)
        self._visible_track_memory: dict[int, dict[int, dict]] = {1: {}, 2: {}}
        self._outgoing_track_memory: dict[int, dict[int, dict]] = {1: {}, 2: {}}
        self._visible_outgoing_track_ids: dict[int, set[int]] = {1: set(), 2: set()}
        self._consumed_outgoing_track_ids: dict[int, set[int]] = {1: set(), 2: set()}
        self._consumed_outgoing_gids: dict[int, set[str]] = {1: set(), 2: set()}
        self._completed_source_gids_still_visible: dict[str, set[str]] = {
            NODE_A: set(),
            NODE_B: set(),
        }

    def set_wake_controller(self, callback) -> None:
        self._wake_controller = callback

    def reset(self) -> None:
        """Clear active/completed batches and all outgoing-vehicle memory."""
        with self._lock:
            self._active = None
            self._last_completed = None
            self._visible_track_memory = {1: {}, 2: {}}
            self._outgoing_track_memory = {1: {}, 2: {}}
            self._visible_outgoing_track_ids = {1: set(), 2: set()}
            self._consumed_outgoing_track_ids = {1: set(), 2: set()}
            self._consumed_outgoing_gids = {1: set(), 2: set()}
            self._completed_source_gids_still_visible = {
                NODE_A: set(),
                NODE_B: set(),
            }

    def begin(self, source_node: str, vehicles: list[dict], batch_points: int) -> dict | None:
        if source_node not in NODE_IDS:
            raise ValueError("Invalid source node")

        unique_vehicles: dict[str, dict] = {}
        for vehicle in vehicles:
            gid = str(vehicle.get("gid") or "").strip()
            if not gid or gid in unique_vehicles:
                continue
            unique_vehicles[gid] = {
                "gid": gid,
                "class": str(vehicle.get("class") or "unknown").lower(),
                "points": int(vehicle.get("points") or 0),
                "sourceTrackId": vehicle.get("trackId"),
                "sourceConfidence": vehicle.get("confidence"),
                "sourceDetectedAt": vehicle.get("detectedAt"),
                "redTouchedAt": None,
                "sourceReleasedAt": None,
                "destinationTrackId": None,
                "destinationConfidence": None,
                "destinationConfirmedAt": None,
            }

        if not unique_vehicles:
            return None

        destination_node = NODE_B if source_node == NODE_A else NODE_A
        destination_camera_id = NODE_CAMERAS[destination_node]
        created_at = utc_timestamp()
        transaction_id = f"traffic-{created_at.replace(':', '').replace('.', '-')}-{uuid.uuid4().hex[:8]}"
        with self._lock:
            if self._active is not None:
                return self.snapshot_active()
            baseline_at = time.monotonic()
            baseline_memory = {
                track_id: state
                for track_id, state in self._visible_track_memory[destination_camera_id].items()
                if baseline_at - state["lastSeenAt"] <= self._visible_memory_seconds()
            }
            self._active = {
                "transactionId": transaction_id,
                "sourceKey": source_node,
                "destinationKey": destination_node,
                "sourceNode": NODE_IDS[source_node],
                "destinationNode": NODE_IDS[destination_node],
                "batchTotal": len(unique_vehicles),
                "batchPoints": int(batch_points),
                "sourceRemaining": len(unique_vehicles),
                "destinationRemaining": len(unique_vehicles),
                "releasedVehicles": [],
                "_releasedAtMonotonic": [],
                "status": "pending_green",
                "createdAt": created_at,
                "greenStartedAt": None,
                "sourceCompletedAt": None,
                "completedAt": None,
                "vehicles": unique_vehicles,
                "_destinationBaselineTrackIds": set(baseline_memory),
                "_destinationBaselineGids": {
                    state["gid"]
                    for state in baseline_memory.values()
                    if state.get("gid")
                },
                "_destinationSeenTrackIds": set(),
                "_destinationSeenGids": set(),
                "_destinationObservations": [],
                "_destinationPendingRoutes": {},
            }
            return self.snapshot_active()

    def activate(self) -> None:
        with self._lock:
            if self._active is None or self._active["status"] != "pending_green":
                return
            self._active["status"] = "active"
            self._active["greenStartedAt"] = utc_timestamp()

    def observe_detections(self, camera_id: int, detections: list[dict]) -> None:
        node_key = CAMERA_NODES.get(camera_id)
        if node_key is None:
            return

        changed = False
        with self._lock:
            observed_at = time.monotonic()
            self._update_visible_track_memory(camera_id, detections, observed_at)
            self._update_outgoing_track_memory(camera_id, detections, observed_at)
            transaction = self._active
            if transaction is None or transaction["status"] == "pending_green":
                return

            for detection in detections:
                gid = str(detection.get("vehicleId") or "").strip()
                vehicle = transaction["vehicles"].get(gid)

                if (
                    node_key == transaction["sourceKey"]
                    and vehicle is not None
                    and (detection.get("redTransition") or detection.get("redLineTouched"))
                    and vehicle["sourceReleasedAt"] is None
                ):
                    vehicle["redTouchedAt"] = utc_timestamp()
                    vehicle["sourceReleasedAt"] = vehicle["redTouchedAt"]
                    vehicle["sourceTrackId"] = detection.get("trackId", vehicle["sourceTrackId"])
                    vehicle["sourceConfidence"] = detection.get("confidence", vehicle["sourceConfidence"])
                    transaction["releasedVehicles"].append(gid)
                    transaction["_releasedAtMonotonic"].append(observed_at)
                    transaction["sourceRemaining"] = max(0, transaction["sourceRemaining"] - 1)
                    changed = True

                if node_key == transaction["destinationKey"] and detection.get(
                    "outgoingRouteTransition"
                ):
                    self._queue_completed_outgoing_route(transaction, detection, observed_at)

            if node_key == transaction["destinationKey"]:
                changed = (
                    self._process_completed_outgoing_routes(
                        camera_id,
                        transaction,
                        observed_at,
                    )
                    or changed
                )

            self._assign_destination_observations(transaction)

            if transaction["sourceRemaining"] == 0 and transaction["sourceCompletedAt"] is None:
                transaction["sourceCompletedAt"] = utc_timestamp()
                transaction["status"] = "source_complete"
                changed = True

            if transaction["sourceRemaining"] == 0 and transaction["destinationRemaining"] == 0:
                transaction["status"] = "persist_pending"
                transaction["completedAt"] = transaction["completedAt"] or utc_timestamp()
                changed = True

        if changed and self._wake_controller is not None:
            self._wake_controller()

    @staticmethod
    def _queue_completed_outgoing_route(
        transaction: dict,
        detection: dict,
        observed_at: float,
    ) -> None:
        track_id = detection.get("trackId")
        if not isinstance(track_id, int):
            return
        accepted_count = transaction["batchTotal"] - transaction["destinationRemaining"]
        if accepted_count >= len(transaction["releasedVehicles"]):
            return
        candidate = deepcopy(detection)
        candidate["_releaseIndex"] = accepted_count
        transaction["_destinationPendingRoutes"][track_id] = {
            "detection": candidate,
            "completedAtMonotonic": observed_at,
        }

    def _process_completed_outgoing_routes(
        self,
        camera_id: int,
        transaction: dict,
        observed_at: float,
    ) -> bool:
        changed = False
        pending_routes = transaction["_destinationPendingRoutes"]
        retention_seconds = max(10.0, self.outgoing_confirmation_seconds + 5.0)

        for track_id, pending in list(pending_routes.items()):
            accepted_count = transaction["batchTotal"] - transaction["destinationRemaining"]
            release_index = pending["detection"].get("_releaseIndex")
            if (
                release_index < accepted_count
                or observed_at - pending["completedAtMonotonic"] > retention_seconds
            ):
                pending_routes.pop(track_id, None)
                continue
            if release_index != accepted_count or transaction["destinationRemaining"] <= 0:
                continue

            detection = pending["detection"]
            if not self._accept_new_outgoing(camera_id, detection, transaction, observed_at):
                if track_id in self._consumed_outgoing_track_ids[camera_id]:
                    pending_routes.pop(track_id, None)
                continue

            gid = str(detection.get("vehicleId") or "").strip()
            transaction["_destinationObservations"].append(
                {
                    "gid": gid or None,
                    "trackId": track_id,
                    "class": detection.get("class"),
                    "confidence": detection.get("confidence"),
                    "detectedAt": utc_timestamp(),
                    "assigned": False,
                }
            )
            transaction["destinationRemaining"] = max(
                0,
                transaction["destinationRemaining"] - 1,
            )
            pending_routes.pop(track_id, None)
            changed = True

        return changed

    def _visible_memory_seconds(self) -> float:
        return max(
            2.0,
            self.outgoing_confirmation_seconds,
            self.outgoing_id_switch_grace_seconds,
        )

    def _update_visible_track_memory(
        self,
        camera_id: int,
        detections: list[dict],
        observed_at: float,
    ) -> None:
        memory = self._visible_track_memory[camera_id]
        for detection in detections:
            if not detection.get("inTrafficZone"):
                continue
            track_id = detection.get("trackId")
            if not isinstance(track_id, int):
                continue
            memory[track_id] = {
                "gid": str(detection.get("vehicleId") or "").strip() or None,
                "class": detection.get("class"),
                "boundingBox": detection.get("boundingBox"),
                "centerPoint": detection.get("centerPoint"),
                "lastSeenAt": observed_at,
            }

        retention_seconds = self._visible_memory_seconds()
        stale_track_ids = [
            track_id
            for track_id, state in memory.items()
            if observed_at - state["lastSeenAt"] > retention_seconds
        ]
        for track_id in stale_track_ids:
            memory.pop(track_id, None)

    def _update_outgoing_track_memory(
        self,
        camera_id: int,
        detections: list[dict],
        observed_at: float,
    ) -> None:
        previous_visible = self._visible_outgoing_track_ids[camera_id]
        current_visible: set[int] = set()
        memory = self._outgoing_track_memory[camera_id]

        for detection in detections:
            if not detection.get("inTrafficZone") or detection.get("trafficRole") != "OUTGOING":
                continue
            track_id = detection.get("trackId")
            if not isinstance(track_id, int):
                continue

            current_visible.add(track_id)
            state = memory.get(track_id)
            continuous = state is not None and track_id in previous_visible
            consecutive_frames = state["consecutiveFrames"] + 1 if continuous else 1
            memory[track_id] = {
                "gid": str(detection.get("vehicleId") or "").strip() or None,
                "class": detection.get("class"),
                "boundingBox": detection.get("boundingBox"),
                "centerPoint": detection.get("centerPoint"),
                "firstSeenAt": state["firstSeenAt"] if continuous else observed_at,
                "lastSeenAt": observed_at,
                "consecutiveFrames": consecutive_frames,
            }

        self._visible_outgoing_track_ids[camera_id] = current_visible

    def _accept_new_outgoing(
        self,
        camera_id: int,
        detection: dict,
        transaction: dict,
        observed_at: float,
    ) -> bool:
        track_id = detection.get("trackId")
        if not isinstance(track_id, int):
            return False
        gid = str(detection.get("vehicleId") or "").strip()

        if (
            track_id in transaction["_destinationBaselineTrackIds"]
            or track_id in transaction["_destinationSeenTrackIds"]
            or track_id in self._consumed_outgoing_track_ids[camera_id]
            or (gid and gid in transaction["_destinationBaselineGids"])
            or (gid and gid in transaction["_destinationSeenGids"])
            or (gid and gid in self._consumed_outgoing_gids[camera_id])
        ):
            return False

        state = self._outgoing_track_memory[camera_id].get(track_id)
        if state is None or state["consecutiveFrames"] < self.outgoing_confirmation_frames:
            return False
        if track_id not in self._visible_outgoing_track_ids[camera_id]:
            return False

        if self._looks_like_recent_old_track(camera_id, track_id, state, transaction, observed_at):
            self._consumed_outgoing_track_ids[camera_id].add(track_id)
            if gid:
                self._consumed_outgoing_gids[camera_id].add(gid)
            return False

        accepted_count = transaction["batchTotal"] - transaction["destinationRemaining"]
        release_index = detection.get("_releaseIndex", accepted_count)
        if release_index != accepted_count:
            return False
        if accepted_count >= len(transaction["releasedVehicles"]):
            return False
        release_observed_at = transaction["_releasedAtMonotonic"][accepted_count]
        confirmation_started_at = max(state["firstSeenAt"], release_observed_at)
        if observed_at - confirmation_started_at < self.outgoing_confirmation_seconds:
            return False

        transaction["_destinationSeenTrackIds"].add(track_id)
        self._consumed_outgoing_track_ids[camera_id].add(track_id)
        if gid:
            transaction["_destinationSeenGids"].add(gid)
            self._consumed_outgoing_gids[camera_id].add(gid)
        return True

    def _looks_like_recent_old_track(
        self,
        camera_id: int,
        track_id: int,
        state: dict,
        transaction: dict,
        observed_at: float,
    ) -> bool:
        for old_track_id, old_state in self._visible_track_memory[camera_id].items():
            if old_track_id == track_id:
                continue
            is_old = (
                old_track_id in transaction["_destinationBaselineTrackIds"]
                or old_track_id in transaction["_destinationSeenTrackIds"]
                or old_track_id in self._consumed_outgoing_track_ids[camera_id]
            )
            if not is_old or observed_at - old_state["lastSeenAt"] > self.outgoing_id_switch_grace_seconds:
                continue
            if state.get("gid") and state["gid"] == old_state.get("gid"):
                return True
            if state.get("class") != old_state.get("class"):
                continue
            if self._boxes_represent_same_vehicle(state.get("boundingBox"), old_state.get("boundingBox")):
                return True
        return False

    @staticmethod
    def _boxes_represent_same_vehicle(current_box, previous_box) -> bool:
        if not current_box or not previous_box or len(current_box) != 4 or len(previous_box) != 4:
            return False
        cx1, cy1, cx2, cy2 = map(float, current_box)
        px1, py1, px2, py2 = map(float, previous_box)
        intersection_width = max(0.0, min(cx2, px2) - max(cx1, px1))
        intersection_height = max(0.0, min(cy2, py2) - max(cy1, py1))
        intersection = intersection_width * intersection_height
        current_area = max(0.0, cx2 - cx1) * max(0.0, cy2 - cy1)
        previous_area = max(0.0, px2 - px1) * max(0.0, py2 - py1)
        union = current_area + previous_area - intersection
        if union > 0 and intersection / union >= 0.25:
            return True

        current_center = ((cx1 + cx2) / 2, (cy1 + cy2) / 2)
        previous_center = ((px1 + px2) / 2, (py1 + py2) / 2)
        center_distance = math.dist(current_center, previous_center)
        largest_dimension = max(cx2 - cx1, cy2 - cy1, px2 - px1, py2 - py1, 1.0)
        return center_distance <= largest_dimension * 0.35

    @staticmethod
    def _assign_destination_observations(transaction: dict) -> None:
        released = [
            transaction["vehicles"][gid]
            for gid in transaction["releasedVehicles"]
            if transaction["vehicles"][gid]["destinationConfirmedAt"] is None
        ]
        observations = [
            observation
            for observation in transaction["_destinationObservations"]
            if not observation["assigned"]
        ]

        for vehicle in list(released):
            matching = next(
                (observation for observation in observations if observation["gid"] == vehicle["gid"]),
                None,
            )
            if matching is None:
                continue
            TrafficTransactionManager._apply_destination_observation(vehicle, matching)
            released.remove(vehicle)
            observations.remove(matching)

        for vehicle, observation in zip(released, observations):
            TrafficTransactionManager._apply_destination_observation(vehicle, observation)

    @staticmethod
    def _apply_destination_observation(vehicle: dict, observation: dict) -> None:
        vehicle["destinationConfirmedAt"] = observation["detectedAt"]
        vehicle["destinationTrackId"] = observation["trackId"]
        vehicle["destinationConfidence"] = observation["confidence"]
        observation["assigned"] = True

    def payload_for_firestore(self) -> dict | None:
        with self._lock:
            if self._active is None or self._active["status"] != "persist_pending":
                return None
            payload = self._public_snapshot(self._active)
            payload["status"] = "complete"
            return payload

    def mark_completed(self, persisted: bool) -> dict | None:
        with self._lock:
            if self._active is None or self._active["status"] != "persist_pending":
                return None
            source_key = self._active["sourceKey"]
            self._completed_source_gids_still_visible[source_key].update(
                self._active["releasedVehicles"]
            )
            completed = self._public_snapshot(self._active)
            completed["status"] = "complete"
            completed["persistedAt"] = utc_timestamp() if persisted else None
            completed["firestoreUploaded"] = persisted
            self._last_completed = completed
            self._active = None
            return deepcopy(completed)

    def next_batch_candidates(self, node_key: str, vehicles: list[dict]) -> list[dict]:
        """Return the fresh visible queue without recounting a just-released vehicle."""
        if node_key not in NODE_IDS:
            raise ValueError("Invalid node")

        with self._lock:
            candidates = deepcopy(vehicles)
            if self._active is not None:
                return candidates

            visible_gids = {
                str(vehicle.get("gid") or "").strip()
                for vehicle in candidates
                if vehicle.get("gid")
            }
            excluded_gids = self._completed_source_gids_still_visible[node_key]

            # Once a completed vehicle leaves the incoming view, its GID may be
            # considered again if it genuinely returns in a later cycle.
            excluded_gids.intersection_update(visible_gids)
            return [
                vehicle
                for vehicle in candidates
                if str(vehicle.get("gid") or "").strip() not in excluded_gids
            ]

    def mark_persisted(self) -> dict | None:
        return self.mark_completed(persisted=True)

    def snapshot_active(self) -> dict | None:
        with self._lock:
            return self._public_snapshot(self._active) if self._active else None

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "active": self._public_snapshot(self._active) if self._active else None,
                "lastCompleted": deepcopy(self._last_completed),
                "nextBatchExcludedGids": {
                    node_key: sorted(gids)
                    for node_key, gids in self._completed_source_gids_still_visible.items()
                },
            }

    @staticmethod
    def _public_snapshot(transaction: dict) -> dict:
        vehicles = []
        for gid in transaction["releasedVehicles"]:
            vehicle = transaction["vehicles"][gid]
            vehicles.append(
                {
                    **{
                        key: deepcopy(value)
                        for key, value in vehicle.items()
                        if not key.startswith("_")
                    },
                    "source": transaction["sourceNode"],
                    "destination": transaction["destinationNode"],
                    "transactionId": transaction["transactionId"],
                }
            )
        return {
            key: deepcopy(value)
            for key, value in transaction.items()
            if key != "vehicles"
            and not key.startswith("_")
            and key not in {"sourceKey", "destinationKey"}
        } | {
            "sourceKey": transaction["sourceKey"],
            "destinationKey": transaction["destinationKey"],
            "releasedVehicles": vehicles,
        }


class FirestoreTransactionWriter:
    """Sends completed transactions to the Next.js Firebase Admin endpoint."""

    def __init__(
        self,
        endpoint: str,
        secret: str = "",
        timeout_seconds: float = 5.0,
        enabled: bool = True,
    ):
        self.endpoint = endpoint
        self.secret = secret
        self.timeout_seconds = max(0.5, timeout_seconds)
        self.enabled = enabled

    def write(self, payload: dict) -> dict:
        if not self.enabled:
            return {"success": True, "persisted": False, "error": None}

        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.secret:
            headers["Authorization"] = f"Bearer {self.secret}"
        request = Request(
            self.endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
                return {
                    "success": 200 <= response.status < 300 and body.get("success") is True,
                    "persisted": 200 <= response.status < 300 and body.get("success") is True,
                    "error": body.get("message"),
                }
        except HTTPError as error:
            try:
                body = json.loads(error.read().decode("utf-8"))
                message = body.get("message")
            except (json.JSONDecodeError, UnicodeDecodeError):
                message = None
            return {"success": False, "error": message or f"HTTP {error.code}"}
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            return {"success": False, "error": str(error)}
