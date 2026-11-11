"""Additional admission mode; weighted scoring and exit confirmation stay intact."""

import math
import time

from scoring import VEHICLE_CLASS_POINTS
from traffic_transactions import CAMERA_NODES, TrafficTransactionManager, utc_timestamp


class TimerBatchManager(TrafficTransactionManager):
    """Own the in-memory timer, yellow confirmation, and batch lifecycle.

    Completed batches are persisted by the existing Firestore transaction writer.
    """

    def __init__(self, *args, timer_enabled=True, **kwargs):
        super().__init__(*args, **kwargs)
        self.timer_enabled = timer_enabled
        self._queue_views = {}
        self._blocked_reason = None
        self._unassigned_crossings = []

    def queue_view(self, camera_id):
        with self._lock:
            view = self._queue_views.get(camera_id)
            if not view or time.monotonic() - view["observedAt"] > 5:
                return {"fresh": False, "behindGreenVehicles": 0}
            return {"fresh": True, "behindGreenVehicles": view["behindGreenVehicles"]}

    def begin(self, source_node, vehicles, batch_points):
        with self._lock:
            if self._blocked_reason:
                return None
            result = super().begin(source_node, vehicles, batch_points)
            if result:
                self._active.setdefault("decisionMode", "WEIGHTED")
                self._active.setdefault("yellowSeconds", 2)
                return self.snapshot_active()
            return None

    def begin_timer(self, source_node, vehicles):
        with self._lock:
            if self._active or self._blocked_reason or not self.timer_enabled:
                return None
            if not self.begin(source_node, vehicles, 0):
                return None
            self._active.update(
                decisionMode="TIMER", batchTotal=0, batchPoints=0,
                sourceRemaining=0, destinationRemaining=0, vehicles={},
                timerDurationSeconds=60, inactivitySeconds=15,
            )
            return self.snapshot_active()

    def activate(self):
        with self._lock:
            if not self._active or self._active["status"] != "pending_green":
                return
            super().activate()
            now = time.monotonic()
            self._active["_greenStartedMonotonic"] = now
            self._active["_lastEntryMonotonic"] = now

    def _end_green(self, reason):
        transaction = self._active
        transaction["status"] = "yellow_pending"
        transaction["endReason"] = reason
        transaction["greenEndedAt"] = utc_timestamp()
        transaction["sourceCompletedAt"] = transaction["greenEndedAt"]
        transaction["completedAt"] = None
        if transaction["decisionMode"] == "TIMER":
            transaction["unusedGreenSeconds"] = self._remaining(transaction)

    def yellow_confirmed(self):
        with self._lock:
            if self._active and self._active["status"] == "yellow_pending":
                self._active["status"] = "yellow"
                self._active["_yellowStartedMonotonic"] = time.monotonic()

    def fault(self, reason):
        with self._lock:
            if self._active:
                self._active["status"] = "anomaly"
                self._active["anomaly"] = reason

    def advance(self):
        with self._lock:
            transaction = self._active
            if not transaction:
                return
            previous = transaction["status"]
            now = time.monotonic()
            if previous == "active" and transaction["decisionMode"] == "TIMER":
                if now - transaction["_greenStartedMonotonic"] >= transaction["timerDurationSeconds"]:
                    self._end_green("timer_expired")
                elif now - transaction["_lastEntryMonotonic"] >= transaction["inactivitySeconds"]:
                    self._end_green("incoming_inactivity")
            elif previous == "yellow":
                if now - transaction["_yellowStartedMonotonic"] >= transaction["yellowSeconds"]:
                    transaction["status"] = "clearance"
            # Completion is authorized only after an actual both-red acknowledgement.

    def red_confirmed(self):
        with self._lock:
            transaction = self._active
            if transaction and transaction["status"] == "clearance":
                if transaction["sourceRemaining"] == 0 and transaction["destinationRemaining"] == 0:
                    transaction["status"] = "persist_pending"
                    transaction["completedAt"] = utc_timestamp()

    def observe_detections(self, camera_id, detections):
        with self._lock:
            self._queue_views[camera_id] = {
                "observedAt": time.monotonic(),
                "behindGreenVehicles": len({
                    item["trackId"] for item in detections
                    if item.get("behindGreenIncoming") and isinstance(item.get("trackId"), int)
                }),
            }
            transaction = self._active
            if transaction is None:
                for detection in detections:
                    if detection.get("redBoundaryTransition"):
                        self._blocked_reason = "Entry observed without an active admission batch; verify road clearance and reset"
                        self._unassigned_crossings.append({
                            "cameraId": camera_id, "detectedAt": utc_timestamp(), "detection": detection,
                        })
            if not transaction or transaction.get("decisionMode") != "TIMER":
                previous = transaction["status"] if transaction else None
                super().observe_detections(camera_id, detections)
                if transaction:
                    if previous in {"yellow_pending", "yellow", "clearance", "anomaly", "persist_pending"}:
                        transaction["status"] = previous
                    elif transaction["status"] in {"source_complete", "persist_pending"}:
                        self._end_green("weighted_batch_released")
                    for detection in detections:
                        if (
                            detection.get("redBoundaryTransition")
                            and CAMERA_NODES.get(camera_id) != transaction["sourceKey"]
                        ):
                            self._unassigned_crossings.append({
                                "cameraId": camera_id, "detectedAt": utc_timestamp(), "detection": detection,
                            })
                            self.fault("Entry from the opposite RED node; verify road clearance")
                        if (
                            CAMERA_NODES.get(camera_id) == transaction["sourceKey"]
                            and detection.get("redBoundaryTransition")
                            and str(detection.get("vehicleId") or "").strip() not in transaction["vehicles"]
                        ):
                            self._record_entry(detection, time.monotonic())
                            self.fault("Unexpected vehicle entered outside the frozen weighted batch")
                return

            observed_at = time.monotonic()
            previous_counts = (transaction["batchTotal"], transaction["destinationRemaining"], transaction["status"])
            self._update_visible_track_memory(camera_id, detections, observed_at)
            self._update_outgoing_track_memory(camera_id, detections, observed_at)
            node = CAMERA_NODES.get(camera_id)
            if node is None:
                return
            for detection in detections:
                if node == transaction["sourceKey"] and detection.get("redBoundaryTransition"):
                    self._record_entry(detection, observed_at)
                elif detection.get("redBoundaryTransition"):
                    self._unassigned_crossings.append({
                        "cameraId": camera_id, "detectedAt": utc_timestamp(), "detection": detection,
                    })
                    self.fault("Entry from the opposite RED node; verify road clearance")
                elif node == transaction["destinationKey"] and detection.get("outgoingRouteTransition"):
                    track_id = detection.get("trackId")
                    gid = str(detection.get("vehicleId") or "").strip()
                    known = (
                        track_id in transaction["_destinationBaselineTrackIds"]
                        or track_id in self._consumed_outgoing_track_ids[camera_id]
                        or gid in transaction["_destinationBaselineGids"]
                        or gid in self._consumed_outgoing_gids[camera_id]
                    )
                    if not known and transaction["destinationRemaining"] == 0:
                        self.fault("Exit crossing has no matching admitted vehicle; reconcile batch counts")
                    self._queue_completed_outgoing_route(transaction, detection, observed_at)
            if node == transaction["destinationKey"]:
                self._process_completed_outgoing_routes(camera_id, transaction, observed_at)
            self._assign_destination_observations(transaction)
            changed = previous_counts != (
                transaction["batchTotal"], transaction["destinationRemaining"], transaction["status"]
            )
        if changed and self._wake_controller:
            self._wake_controller()

    def _record_entry(self, detection, observed_at):
        transaction = self._active
        gid = str(detection.get("vehicleId") or "").strip()
        track_id = detection.get("trackId")
        if not gid or not isinstance(track_id, int):
            self._unassigned_crossings.append({
                "node": transaction["sourceKey"], "detectedAt": utc_timestamp(), "detection": detection,
            })
            self.fault("Entry crossing has no reliable vehicle identity")
            return
        if gid in transaction["vehicles"] or track_id in transaction.setdefault("_sourceEntryTracks", set()):
            return
        timestamp = utc_timestamp()
        vehicle_class = str(detection.get("class") or "unknown").lower()
        transaction["vehicles"][gid] = {
            "gid": gid, "class": vehicle_class,
            "points": VEHICLE_CLASS_POINTS.get(vehicle_class, 0),
            "sourceTrackId": track_id, "sourceConfidence": detection.get("confidence"),
            "sourceDetectedAt": timestamp, "redTouchedAt": timestamp,
            "sourceReleasedAt": timestamp, "destinationTrackId": None,
            "destinationConfidence": None, "destinationConfirmedAt": None,
        }
        transaction["_sourceEntryTracks"].add(track_id)
        transaction["releasedVehicles"].append(gid)
        transaction["_releasedAtMonotonic"].append(observed_at)
        transaction["batchTotal"] += 1
        transaction["batchPoints"] += VEHICLE_CLASS_POINTS.get(vehicle_class, 0)
        transaction["destinationRemaining"] += 1
        transaction["_lastEntryMonotonic"] = observed_at
        if transaction["status"] not in {"active", "yellow_pending", "yellow"}:
            self.fault("Unexpected entry outside the admission phase; verify clearance")

    def _queue_completed_outgoing_route(self, transaction, detection, observed_at):
        if transaction.get("decisionMode") != "TIMER":
            return TrafficTransactionManager._queue_completed_outgoing_route(transaction, detection, observed_at)
        track_id = detection.get("trackId")
        if isinstance(track_id, int):
            transaction["_destinationPendingRoutes"].setdefault(track_id, {
                "detection": dict(detection), "completedAtMonotonic": observed_at,
            })

    def _process_completed_outgoing_routes(self, camera_id, transaction, observed_at):
        if transaction.get("decisionMode") != "TIMER":
            return super()._process_completed_outgoing_routes(camera_id, transaction, observed_at)
        changed = False
        pending_routes = transaction["_destinationPendingRoutes"]
        for track_id, pending in list(pending_routes.items()):
            detection = pending["detection"]
            gid = str(detection.get("vehicleId") or "").strip()
            known = (
                track_id in transaction["_destinationBaselineTrackIds"]
                or track_id in self._consumed_outgoing_track_ids[camera_id]
                or (gid and gid in transaction["_destinationBaselineGids"])
                or (gid and gid in self._consumed_outgoing_gids[camera_id])
            )
            if known:
                pending_routes.pop(track_id)
                continue
            if transaction["destinationRemaining"] == 0:
                self.fault("Exit crossing exceeds confirmed entries; reconcile batch counts")
                pending_routes.pop(track_id)
                continue
            if observed_at - pending["completedAtMonotonic"] > max(10, self.outgoing_confirmation_seconds + 5):
                self.fault("Exit crossing could not be confirmed before tracking expired")
                pending_routes.pop(track_id)
                continue
            # Assign release positions when consumed, rather than freezing all
            # same-frame exits to the same position. Keep existing confirmation
            # frames, time, baseline, GID, and replacement-track checks.
            detection["_releaseIndex"] = transaction["batchTotal"] - transaction["destinationRemaining"]
            if not self._accept_new_outgoing(camera_id, detection, transaction, observed_at):
                continue
            transaction["_destinationObservations"].append({
                "gid": gid or None, "trackId": track_id, "class": detection.get("class"),
                "confidence": detection.get("confidence"), "detectedAt": utc_timestamp(), "assigned": False,
            })
            transaction["destinationRemaining"] -= 1
            pending_routes.pop(track_id)
            changed = True
        return changed

    def mark_completed(self, persisted):
        with self._lock:
            return super().mark_completed(persisted)

    def reset(self):
        with self._lock:
            super().reset()
            self._blocked_reason = None
            self._unassigned_crossings = []
            self._queue_views = {}

    def snapshot_active(self):
        with self._lock:
            return super().snapshot_active()

    def snapshot(self):
        with self._lock:
            result = super().snapshot()
            result["blockedReason"] = self._blocked_reason
            result["unassignedCrossings"] = list(self._unassigned_crossings)
            return result

    @staticmethod
    def _remaining(transaction):
        if transaction["status"] == "pending_green":
            return transaction["timerDurationSeconds"]
        started = transaction.get("_greenStartedMonotonic")
        return (
            max(0, math.ceil(transaction["timerDurationSeconds"] - (time.monotonic() - started)))
            if started is not None else 0
        )

    @staticmethod
    def _public_snapshot(transaction):
        result = TrafficTransactionManager._public_snapshot(transaction)
        entered = len(transaction["releasedVehicles"])
        result.update(enteredCount=entered, exitedCount=transaction["batchTotal"] - transaction["destinationRemaining"])
        if transaction.get("decisionMode") == "TIMER":
            result["timerRemainingSeconds"] = (
                TimerBatchManager._remaining(transaction) if transaction["status"] in {"pending_green", "active"} else 0
            )
        return result
