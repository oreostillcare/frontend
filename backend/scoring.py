import threading
from datetime import datetime, timezone


VEHICLE_CLASS_POINTS = {
    "truck": 7,
    "bus": 6,
    "jeep": 5,
    "jeepney": 5,
    "car": 4,
    "tricycle": 3,
    "motor": 2,
    "motorcycle": 2,
    "ebike": 2,
    "e-bike": 2,
    "bicycle": 1,
    "emergency": 0,
}


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class IncomingVehicleLedger:
    """Keeps one live scoring record per incoming global vehicle ID."""

    def __init__(self):
        self._lock = threading.RLock()
        self._records: dict[str, dict] = {}
        self._first_detected_at: dict[str, str] = {}

    def update(self, detections: list[dict], detected_at: str | None = None) -> None:
        timestamp = detected_at or utc_timestamp()
        active_records: dict[str, dict] = {}

        with self._lock:
            for detection in detections:
                if not detection.get("inTrafficZone") or detection.get("trafficRole") != "INCOMING":
                    continue

                vehicle_id = detection.get("vehicleId")
                if not vehicle_id or vehicle_id in active_records:
                    continue

                vehicle_class = str(detection.get("class", "unknown")).lower()
                first_detected_at = self._first_detected_at.setdefault(vehicle_id, timestamp)
                active_records[vehicle_id] = {
                    "gid": vehicle_id,
                    "trackId": detection.get("trackId"),
                    "class": vehicle_class,
                    "confidence": detection.get("confidence"),
                    "detectedAt": first_detected_at,
                    "points": VEHICLE_CLASS_POINTS.get(vehicle_class, 0),
                }

            self._records = active_records

    @property
    def records(self) -> list[dict]:
        records, _ = self.snapshot()
        return [
            {key: record[key] for key in ("gid", "class", "detectedAt", "points")}
            for record in records
        ]

    @property
    def total_points(self) -> int:
        _, total_points = self.snapshot()
        return total_points

    def snapshot(self) -> tuple[list[dict], int]:
        with self._lock:
            records = [dict(self._records[vehicle_id]) for vehicle_id in sorted(self._records)]
            total_points = sum(record["points"] for record in self._records.values())
            return records, total_points
