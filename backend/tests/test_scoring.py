import pytest

from scoring import IncomingVehicleLedger, VEHICLE_CLASS_POINTS


@pytest.mark.parametrize(
    ("vehicle_class", "points"),
    [
        ("truck", 7),
        ("bus", 6),
        ("jeepney", 5),
        ("car", 4),
        ("tricycle", 3),
        ("motorcycle", 2),
        ("ebike", 2),
        ("bicycle", 1),
        ("emergency", 0),
    ],
)
def test_vehicle_class_points(vehicle_class, points):
    assert VEHICLE_CLASS_POINTS[vehicle_class] == points


def detection(gid, vehicle_class="car", role="INCOMING", in_zone=True):
    return {
        "vehicleId": gid,
        "class": vehicle_class,
        "trafficRole": role,
        "inTrafficZone": in_zone,
    }


def test_ledger_lists_unique_active_incoming_vehicles_and_totals_points():
    ledger = IncomingVehicleLedger()

    ledger.update(
        [
            detection("VEH-0001", "car"),
            detection("VEH-0001", "car"),
            detection("VEH-0002", "truck"),
            detection("VEH-0003", "bus", role="OUTGOING"),
            detection("VEH-0004", "bicycle", in_zone=False),
        ],
        detected_at="2026-09-14T08:00:00Z",
    )

    assert ledger.records == [
        {
            "gid": "VEH-0001",
            "class": "car",
            "detectedAt": "2026-09-14T08:00:00Z",
            "points": 4,
        },
        {
            "gid": "VEH-0002",
            "class": "truck",
            "detectedAt": "2026-09-14T08:00:00Z",
            "points": 7,
        },
    ]
    assert ledger.total_points == 11


def test_ledger_preserves_first_detected_time_and_removes_departed_vehicles():
    ledger = IncomingVehicleLedger()
    ledger.update([detection("VEH-0001")], detected_at="2026-09-14T08:00:00Z")
    ledger.update(
        [detection("VEH-0001"), detection("VEH-0002", "emergency")],
        detected_at="2026-09-14T08:00:05Z",
    )

    assert ledger.records[0]["detectedAt"] == "2026-09-14T08:00:00Z"
    assert ledger.total_points == 4

    ledger.update([], detected_at="2026-09-14T08:00:10Z")

    assert ledger.records == []
    assert ledger.total_points == 0

    ledger.update([detection("VEH-0001")], detected_at="2026-09-14T08:00:15Z")

    assert ledger.records[0]["detectedAt"] == "2026-09-14T08:00:00Z"
