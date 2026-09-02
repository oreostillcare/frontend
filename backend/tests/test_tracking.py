from tracking import TrackState


def detection(track_id, center):
    return {"trackId": track_id, "centerPoint": list(center)}


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

