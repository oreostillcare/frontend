from traffic_transactions import TrafficTransactionManager


def vehicle(gid, track_id, vehicle_class="car", points=4):
    return {
        "gid": gid,
        "trackId": track_id,
        "class": vehicle_class,
        "confidence": 0.9,
        "detectedAt": "2026-09-14T00:00:00Z",
        "points": points,
    }


def detection(gid, track_id, **events):
    item = {
        "vehicleId": gid,
        "trackId": track_id,
        "class": "car",
        "confidence": 0.91,
        "boundingBox": [100, 100, 160, 160],
        "centerPoint": [130, 130],
        "inTrafficZone": True,
        "trafficRole": "INCOMING",
        **events,
    }
    if item["trafficRole"] == "OUTGOING":
        item.setdefault("outgoingRouteComplete", True)
        item.setdefault("outgoingRouteTransition", True)
    return item


def test_a_to_b_deducts_on_red_touch_and_first_unique_outgoing_detection():
    manager = TrafficTransactionManager(outgoing_confirmation_seconds=0)
    transaction = manager.begin("nodeA", [vehicle("GID-1", 11), vehicle("GID-2", 12)], 8)
    manager.activate()

    assert transaction["batchTotal"] == 2
    assert transaction["sourceRemaining"] == 2
    assert transaction["destinationRemaining"] == 2

    manager.observe_detections(1, [detection("GID-1", 11, redTransition=True)])
    manager.observe_detections(1, [detection("GID-1", 11, redTransition=True)])
    assert manager.snapshot_active()["sourceRemaining"] == 1

    manager.observe_detections(1, [detection("GID-2", 12, redTransition=True)])
    assert manager.snapshot_active()["status"] == "source_complete"

    manager.observe_detections(
        2,
        [detection("OTHER-1", 21, inTrafficZone=True, trafficRole="OUTGOING")],
    )
    assert manager.snapshot_active()["destinationRemaining"] == 2
    manager.observe_detections(
        2,
        [detection("OTHER-1", 21, inTrafficZone=True, trafficRole="OUTGOING")],
    )
    manager.observe_detections(
        2,
        [detection("OTHER-1", 21, inTrafficZone=True, trafficRole="OUTGOING")],
    )
    assert manager.snapshot_active()["destinationRemaining"] == 1
    for _ in range(3):
        manager.observe_detections(
            2,
            [
                detection(
                    "OTHER-2",
                    22,
                    inTrafficZone=True,
                    trafficRole="OUTGOING",
                    boundingBox=[220, 100, 280, 160],
                    centerPoint=[250, 130],
                )
            ],
        )
    completed = manager.payload_for_firestore()

    assert completed["status"] == "complete"
    assert completed["sourceNode"] == "node-a"
    assert completed["destinationNode"] == "node-b"
    assert completed["sourceRemaining"] == 0
    assert completed["destinationRemaining"] == 0
    assert [item["gid"] for item in completed["releasedVehicles"]] == ["GID-1", "GID-2"]


def test_new_source_gids_do_not_modify_the_frozen_batch():
    manager = TrafficTransactionManager(outgoing_confirmation_seconds=0)
    manager.begin("nodeB", [vehicle("GID-7", 70)], 4)
    manager.activate()

    manager.observe_detections(2, [detection("GID-NEW", 71, redTransition=True)])
    for _ in range(3):
        manager.observe_detections(
            1,
            [detection("OUTGOING-7", 80, inTrafficZone=True, trafficRole="OUTGOING")],
        )
    assert manager.snapshot_active()["sourceRemaining"] == 1
    assert manager.snapshot_active()["destinationRemaining"] == 1

    manager.observe_detections(2, [detection("GID-7", 70, redTransition=True)])
    manager.observe_detections(
        1,
        [detection("OUTGOING-7", 80, inTrafficZone=True, trafficRole="OUTGOING")],
    )
    transaction = manager.snapshot_active()

    assert transaction["sourceNode"] == "node-b"
    assert transaction["destinationNode"] == "node-a"
    assert transaction["status"] == "persist_pending"


def test_preexisting_outgoing_tid_and_stuttered_replacement_do_not_reduce_expected_count():
    manager = TrafficTransactionManager(outgoing_confirmation_seconds=0)
    old_outgoing = detection("OLD-OUT", 90, trafficRole="OUTGOING")
    manager.observe_detections(2, [old_outgoing])

    manager.begin("nodeA", [vehicle("GID-1", 10)], 4)
    manager.activate()

    for _ in range(4):
        manager.observe_detections(2, [old_outgoing])
    assert manager.snapshot_active()["destinationRemaining"] == 1

    for _ in range(3):
        manager.observe_detections(
            2,
            [detection("OLD-OUT-NEW-TID", 91, trafficRole="OUTGOING")],
        )
    assert manager.snapshot_active()["destinationRemaining"] == 1

    manager.observe_detections(1, [detection("GID-1", 10, redTransition=True)])

    for _ in range(3):
        manager.observe_detections(
            2,
            [
                detection(
                    "ACTUAL-NEW",
                    92,
                    trafficRole="OUTGOING",
                    boundingBox=[300, 100, 360, 160],
                    centerPoint=[330, 130],
                )
            ],
        )
    assert manager.snapshot_active()["destinationRemaining"] == 0


def test_preexisting_incoming_vehicle_cannot_become_a_new_destination_outgoing():
    manager = TrafficTransactionManager(
        outgoing_confirmation_frames=1,
        outgoing_confirmation_seconds=0,
    )
    waiting_vehicle = detection("WAITING-B", 90, trafficRole="INCOMING")
    manager.observe_detections(2, [waiting_vehicle])
    manager.begin("nodeA", [vehicle("GID-1", 10)], 4)
    manager.activate()
    manager.observe_detections(1, [detection("GID-1", 10, redTransition=True)])

    manager.observe_detections(
        2,
        [detection("WAITING-B", 90, trafficRole="OUTGOING")],
    )

    assert manager.snapshot_active()["destinationRemaining"] == 1


def test_new_outgoing_requires_one_second_after_source_release(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("traffic_transactions.time.monotonic", lambda: clock[0])
    manager = TrafficTransactionManager(
        outgoing_confirmation_frames=1,
        outgoing_confirmation_seconds=1.0,
    )
    manager.begin("nodeA", [vehicle("GID-1", 10)], 4)
    manager.activate()
    manager.observe_detections(1, [detection("GID-1", 10, redTransition=True)])

    outgoing = detection("ARRIVING-A", 20, trafficRole="OUTGOING")
    manager.observe_detections(2, [outgoing])
    clock[0] = 100.9
    manager.observe_detections(2, [outgoing])
    assert manager.snapshot_active()["destinationRemaining"] == 1

    clock[0] = 101.0
    manager.observe_detections(2, [outgoing])
    assert manager.snapshot_active()["destinationRemaining"] == 0


def test_outgoing_without_midpoint_confirmation_is_not_accepted():
    manager = TrafficTransactionManager(
        outgoing_confirmation_frames=1,
        outgoing_confirmation_seconds=0,
    )
    manager.begin("nodeA", [vehicle("GID-1", 10)], 4)
    manager.activate()
    manager.observe_detections(1, [detection("GID-1", 10, redTransition=True)])

    for _ in range(5):
        manager.observe_detections(
            2,
            [
                detection(
                    "FIRST-SEEN-OUT",
                    20,
                    trafficRole="OUTGOING",
                    outgoingRouteComplete=False,
                    outgoingRouteTransition=False,
                )
            ],
        )

    assert manager.snapshot_active()["destinationRemaining"] == 1
