from tracking import TrackState, TrafficRegion


def detection(track_id, center, bounding_box=None):
    item = {"trackId": track_id, "centerPoint": list(center)}
    if bounding_box is not None:
        item["boundingBox"] = bounding_box
    return item


def test_first_observation_does_not_count_as_crossing():
    state = TrackState((-10, 0, 10, 0), enabled=True)

    state.update([detection(1, (0, -2))])

    assert state.passed == 0
    assert list(state.history[1]) == [(0, -2)]


def test_crossing_counts_each_track_only_once():
    state = TrackState((-10, 0, 10, 0), enabled=True)

    state.update([detection(1, (0, -2))])
    state.update([detection(1, (0, 2))])
    state.update([detection(1, (0, -2))])

    assert state.passed == 1
    assert state.counted_ids == {1}


def test_distinct_tracks_are_counted_independently():
    state = TrackState((-10, 0, 10, 0), enabled=True)

    state.update([detection(1, (-2, -2)), detection(2, (2, 2))])
    state.update([detection(1, (-2, 2)), detection(2, (2, -2))])

    assert state.passed == 2
    assert state.counted_ids == {1, 2}


def test_disabled_line_counting_still_tracks_history():
    state = TrackState((-10, 0, 10, 0), enabled=False)

    state.update([detection(1, (0, -2))])
    state.update([detection(1, (0, 2))])

    assert state.passed == 0
    assert list(state.history[1]) == [(0, -2), (0, 2)]


def test_non_crossing_movement_is_not_counted():
    state = TrackState((-10, 0, 10, 0), enabled=True)

    state.update([detection(1, (0, -3))])
    state.update([detection(1, (4, -1))])

    assert state.passed == 0


def test_history_respects_maximum_length():
    state = TrackState((-10, 0, 10, 0), enabled=False, max_history=3)

    for x in range(5):
        state.update([detection(1, (x, -1))])

    assert list(state.history[1]) == [(2, -1), (3, -1), (4, -1)]


def test_stale_track_history_is_removed_after_150_missed_frames():
    state = TrackState((-10, 0, 10, 0), enabled=True)
    state.update([detection(7, (0, -1))])

    for _ in range(150):
        state.update([])
    assert 7 in state.history

    state.update([])
    assert 7 not in state.history
    assert 7 not in state.last_seen


def test_region_classifies_only_centroids_between_green_and_red():
    state = TrackState((0, 0, 0, 0), enabled=True)
    region = TrafficRegion(green_y=20, red_y=80)
    above = detection(1, (25, 10))
    incoming_start = detection(2, (75, 30))
    outgoing_start = detection(3, (25, 50))
    below = detection(4, (75, 90))
    state.update([above, incoming_start, outgoing_start, below], region)

    incoming = detection(2, (25, 40))
    outgoing = detection(3, (75, 40))
    state.update([incoming, outgoing], region)

    assert above["inTrafficZone"] is False
    assert above["trafficRole"] is None
    assert incoming["trafficRole"] == "INCOMING"
    assert outgoing["trafficRole"] == "OUTGOING"
    assert below["inTrafficZone"] is False
    assert below["trafficRole"] is None


def test_horizontal_position_does_not_change_vertical_motion_role():
    state = TrackState((0, 0, 0, 0), enabled=True)
    region = TrafficRegion(green_y=20, red_y=80)
    state.update([detection(7, (70, 30))], region)
    incoming = detection(7, (70, 40))
    state.update([incoming], region)
    moved_left = detection(7, (30, 40))

    state.update([moved_left], region)

    assert incoming["trafficRole"] == "INCOMING"
    assert moved_left["trafficRole"] == "INCOMING"
    assert moved_left["blueTransition"] is None
    assert list(state.history[7]) == [(70, 30), (70, 40), (30, 40)]


def test_small_vertical_jitter_keeps_the_last_stable_role():
    state = TrackState((0, 0, 0, 0), enabled=True)
    region = TrafficRegion(green_y=20, red_y=80, motion_deadband=4)
    roles = []

    for y in (30, 40, 41, 39, 42, 40):
        item = detection(8, (50, y))
        state.update([item], region)
        roles.append(item["trafficRole"])

    assert roles[1:] == ["INCOMING"] * 5


def test_sustained_reverse_vertical_motion_updates_the_saved_role():
    state = TrackState((0, 0, 0, 0), enabled=True)
    region = TrafficRegion(
        green_y=20,
        red_y=80,
        motion_deadband=4,
        motion_window=3,
        reversal_distance=15,
    )
    state.update([detection(9, (60, 30))], region)
    incoming = detection(9, (60, 45))
    state.update([incoming], region)
    state.update([detection(9, (40, 35))], region)
    outgoing = detection(9, (40, 25))

    state.update([outgoing], region)

    assert incoming["trafficRole"] == "INCOMING"
    assert outgoing["trafficRole"] == "OUTGOING"
    assert outgoing["blueTransition"] is None


def test_green_then_red_crossing_confirms_vehicle_once():
    state = TrackState((0, 0, 0, 0), enabled=True)
    region = TrafficRegion(green_y=20, red_y=80, blue_x=50)
    observations = []

    for center in ((30, 10), (30, 30), (30, 70), (30, 90), (30, 70), (30, 90)):
        item = detection(10, center)
        state.update([item], region)
        observations.append(item)

    assert state.green_crossed_ids == {10}
    assert state.counted_ids == {10}
    assert state.passed == 1
    assert sum(item["redTransition"] for item in observations) == 1


def test_touching_red_with_bounding_box_confirms_crossing_before_centroid_passes():
    state = TrackState((0, 0, 0, 0), enabled=True)
    region = TrafficRegion(green_y=20, red_y=80, blue_x=50)
    above_green = detection(14, (30, 10), [20, 5, 40, 15])
    inside = detection(14, (30, 30), [20, 20, 40, 40])
    touches_red = detection(14, (30, 70), [20, 60, 40, 80])

    state.update([above_green], region)
    state.update([inside], region)
    state.update([touches_red], region)

    assert touches_red["redTransition"] is True
    assert touches_red["redCrossed"] is True
    assert state.passed == 1


def test_region_crossings_still_support_identity_when_passed_counter_is_disabled():
    state = TrackState((0, 0, 0, 0), enabled=False)
    region = TrafficRegion(green_y=20, red_y=80, blue_x=50)
    observations = []

    for center in ((30, 10), (30, 30), (30, 90)):
        item = detection(12, center)
        state.update([item], region)
        observations.append(item)

    assert observations[1]["greenTransition"] is True
    assert observations[2]["redTransition"] is True
    assert state.passed == 0


def test_outgoing_route_completes_at_halfway_without_red_entry():
    state = TrackState((0, 0, 0, 0), enabled=False)
    region = TrafficRegion(green_y=20, red_y=80, blue_x=50)
    observations = []

    for center in ((70, 70), (70, 60), (70, 50)):
        item = detection(13, center)
        state.update([item], region)
        observations.append(item)

    assert observations[1]["trafficRole"] == "OUTGOING"
    assert observations[1]["redEntryTransition"] is False
    assert observations[1]["outgoingRouteStarted"] is True
    assert observations[2]["greenExitTransition"] is False
    assert observations[2]["outgoingConfirmationY"] == 50
    assert observations[2]["outgoingRouteTransition"] is True
    assert observations[2]["outgoingRouteComplete"] is True


def test_outgoing_first_detected_past_halfway_can_still_complete():
    state = TrackState((0, 0, 0, 0), enabled=False)
    region = TrafficRegion(green_y=20, red_y=80)
    first = detection(15, (70, 45))
    moved_toward_green = detection(15, (70, 35))

    state.update([first], region)
    state.update([moved_toward_green], region)

    assert first["redEntryTransition"] is False
    assert moved_toward_green["trafficRole"] == "OUTGOING"
    assert moved_toward_green["outgoingRouteTransition"] is True
    assert moved_toward_green["outgoingRouteComplete"] is True


def test_red_crossing_without_prior_green_crossing_is_not_counted():
    state = TrackState((0, 0, 0, 0), enabled=True)
    region = TrafficRegion(green_y=20, red_y=80, blue_x=50)

    state.update([detection(11, (30, 60))], region)
    state.update([detection(11, (30, 90))], region)

    assert state.passed == 0

