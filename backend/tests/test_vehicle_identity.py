import vehicle_identity as identity_module
from vehicle_identity import GlobalVehicleRegistry


def detection(
    track_id,
    center=(20, 20),
    traffic_role="INCOMING",
    in_traffic_zone=True,
    red_transition=False,
):
    return {
        "trackId": track_id,
        "class": "car",
        "confidence": 0.8,
        "centerPoint": list(center),
        "boundingBox": [10, 10, 30, 30],
        "trafficRole": traffic_role,
        "inTrafficZone": in_traffic_zone,
        "redTransition": red_transition,
    }


def registry(monkeypatch):
    monkeypatch.setattr(identity_module, "appearance_descriptor", lambda frame, _box: frame)
    monkeypatch.setattr(
        identity_module,
        "appearance_similarity",
        lambda first, second: 1.0 if first == second else 0.0,
    )
    return GlobalVehicleRegistry(
        local_grace_seconds=6.0,
        cross_camera_seconds=60.0,
        match_threshold=0.55,
    )


def test_incoming_track_receives_and_keeps_global_id(monkeypatch):
    vehicles = registry(monkeypatch)
    first = detection(1)
    second = detection(1, center=(22, 20))

    vehicles.assign(1, [first], "red-car", now=1.0)
    vehicles.assign(1, [second], "red-car", now=2.0)

    assert first["vehicleId"] == "VEH-0001"
    assert second["vehicleId"] == first["vehicleId"]


def test_short_same_camera_tid_loss_reuses_global_id(monkeypatch):
    vehicles = registry(monkeypatch)
    before_loss = detection(3, center=(20, 20))
    after_loss = detection(9, center=(21, 20))

    vehicles.assign(1, [before_loss], "red-car", now=1.0)
    vehicles.assign(1, [after_loss], "red-car", now=3.0)

    assert after_loss["vehicleId"] == before_loss["vehicleId"]


def test_opposite_camera_outgoing_reuses_confirmed_red_departure_gid(monkeypatch):
    vehicles = registry(monkeypatch)
    node_a = detection(4, red_transition=True)
    node_b = detection(12, traffic_role="OUTGOING")

    vehicles.assign(1, [node_a], "blue-car", now=10.0)
    vehicles.assign(2, [node_b], "blue-car", now=20.0)

    assert node_a["vehicleId"] == "VEH-0001"
    assert node_b["vehicleId"] == node_a["vehicleId"]


def test_single_confirmed_departure_uses_route_when_appearance_is_weak(monkeypatch):
    vehicles = registry(monkeypatch)
    incoming = detection(4, red_transition=True)
    outgoing = detection(12, traffic_role="OUTGOING")

    vehicles.assign(1, [incoming], "dark-camera", now=10.0)
    vehicles.assign(2, [outgoing], "bright-camera", now=20.0)

    assert outgoing["vehicleId"] == incoming["vehicleId"]
    assert outgoing["globalIdMatchMode"] == "ROUTE"


def test_outgoing_without_confirmed_departure_receives_own_gid(monkeypatch):
    vehicles = registry(monkeypatch)
    outgoing = detection(12, traffic_role="OUTGOING")

    vehicles.assign(2, [outgoing], "red-car", now=1.0)

    assert outgoing["vehicleId"] == "VEH-0001"
    assert "globalIdPendingReason" not in outgoing


def test_confirmed_outgoing_gid_remains_stable(monkeypatch):
    vehicles = registry(monkeypatch)
    incoming = detection(4, red_transition=True)
    first_outgoing = detection(12, traffic_role="OUTGOING")
    later_outgoing = detection(12, center=(22, 20), traffic_role="OUTGOING")

    vehicles.assign(1, [incoming], "red-car", now=1.0)
    vehicles.assign(2, [first_outgoing], "red-car", now=2.0)
    vehicles.assign(2, [later_outgoing], "red-car", now=3.0)

    assert first_outgoing["vehicleId"] == incoming["vehicleId"]
    assert later_outgoing["vehicleId"] == incoming["vehicleId"]


def test_simultaneous_incoming_tracks_receive_different_global_ids(monkeypatch):
    vehicles = registry(monkeypatch)
    first = detection(1)
    second = detection(2, center=(25, 20))

    vehicles.assign(1, [first, second], "same-frame", now=1.0)

    assert first["vehicleId"] == "VEH-0001"
    assert second["vehicleId"] == "VEH-0002"
