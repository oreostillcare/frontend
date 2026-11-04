from types import SimpleNamespace
from unittest.mock import Mock
import threading
import time

import numpy as np
import pytest

import camera as camera_module
from camera import CameraWorker


class FakeDetector:
    def __init__(self, config, line, use_coco_fallback=True, model_pool=None, vehicle_registry=None):
        self.config = config
        self.line = line
        self.use_coco_fallback = use_coco_fallback
        self.vehicle_registry = vehicle_registry
        self.model = object()
        self.model_online = True
        self.track_state = SimpleNamespace(passed=12)
        self.incoming_ledger = Mock()
        self.incoming_ledger.snapshot.return_value = (
            [{"gid": "VEH-0001", "class": "car", "detectedAt": "2026-09-14T08:00:00Z", "points": 4}],
            4,
        )


class StopAfterRetry:
    stopped = False

    def is_set(self):
        return self.stopped

    def wait(self, _timeout):
        self.stopped = True
        return True


@pytest.fixture
def worker(monkeypatch):
    monkeypatch.setattr(camera_module, "Detector", FakeDetector)
    config = SimpleNamespace(detection_fps=5.0, line_counting=True, reconnect_seconds=0.01)
    return CameraWorker(1, 0, config, (0, 50, 100, 50))


@pytest.mark.parametrize(
    ("previous", "instant", "expected"),
    [
        (0.0, 10.04, 10.0),
        (10.0, 20.0, 12.0),
        (12.5, 12.5, 12.5),
    ],
)
def test_smoothed_fps(previous, instant, expected):
    assert CameraWorker._smoothed_fps(previous, instant) == expected


def test_camera_worker_enables_dual_model_detection(worker):
    assert worker.detector.use_coco_fallback is True


def test_start_rejects_an_unconfigured_camera(monkeypatch):
    monkeypatch.setattr(camera_module, "Detector", FakeDetector)
    config = SimpleNamespace(detection_fps=5.0, line_counting=True, reconnect_seconds=1.0)
    worker = CameraWorker(1, None, config, (0, 0, 10, 0))

    worker.start()

    assert worker.error == "Camera source not configured"
    assert worker._capture_thread is None
    assert worker._processing_thread is None


def test_start_creates_capture_and_processing_threads_once(monkeypatch, worker):
    threads = []

    class FakeThread:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.started = False
            threads.append(self)

        def start(self):
            self.started = True

        def is_alive(self):
            return self.started

    monkeypatch.setattr(camera_module.threading, "Thread", FakeThread)

    worker.start()
    worker.start()

    assert len(threads) == 2
    assert {thread.kwargs["name"] for thread in threads} == {"camera-capture-1", "camera-detection-1"}
    assert all(thread.started for thread in threads)


def test_open_capture_uses_configured_directshow_index(monkeypatch, worker):
    capture = object()
    video_capture = Mock(return_value=capture)
    monkeypatch.setattr(camera_module.cv2, "VideoCapture", video_capture)

    assert worker._open_capture() is capture
    video_capture.assert_called_once_with(0, camera_module.cv2.CAP_DSHOW)


@pytest.mark.parametrize("devices", [[], [{"index": 0, "name": "Other Webcam"}], None])
def test_reconnect_refuses_changed_or_unavailable_usb_mapping(monkeypatch, worker, devices):
    worker.usb_device_name = "Webcam A"
    monkeypatch.setattr(camera_module, "enumerate_usb_devices", lambda: devices)
    capture = Mock()
    monkeypatch.setattr(camera_module.cv2, "VideoCapture", capture)
    with pytest.raises(RuntimeError, match="mapping changed"):
        worker._open_capture()
    capture.assert_not_called()


def test_usb_workers_have_independent_tracking_and_frame_buffers(monkeypatch, worker):
    second = CameraWorker(2, 1, worker.config, worker.detector.line)
    assert worker.detector is not second.detector
    assert worker.detector.track_state is not second.detector.track_state
    assert worker._raw_condition is not second._raw_condition
    worker._raw_frame = np.ones((4, 4, 3), dtype=np.uint8)
    worker._raw_version = 5
    assert second._raw_frame is None and second._raw_version == 0
    worker.detector.track_state.passed = 99
    assert second.detector.track_state.passed == 12


def test_rtsp_uses_ffmpeg_timeouts_and_masks_credentials(monkeypatch, worker):
    worker.source = "rtsp://user:secret@192.168.1.2:554/stream1"
    capture = Mock()
    monkeypatch.setattr(camera_module.cv2, "VideoCapture", capture)
    worker._open_capture()
    capture.assert_called_once_with(worker.source, camera_module.cv2.CAP_FFMPEG, [
        camera_module.cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000,
        camera_module.cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000,
    ])
    assert "secret" not in worker._capture_errors()[0]


def test_raw_viewers_share_one_unannotated_encode_without_detection(monkeypatch, worker):
    worker.online = True
    worker._raw_frame = np.zeros((8, 8, 3), dtype=np.uint8)
    worker._raw_version = 1
    worker.detector.process = Mock(side_effect=AssertionError("Raw view invoked inference"))
    encode = Mock(return_value=(True, np.array([1, 2, 3], dtype=np.uint8)))
    monkeypatch.setattr(camera_module.cv2, "imencode", encode)
    first, second = worker.raw_frames(), worker.raw_frames()
    try:
        assert next(first).endswith(b"\x01\x02\x03\r\n")
        assert next(second).endswith(b"\x01\x02\x03\r\n")
        assert worker._raw_viewers == 2
        encode.assert_called_once()
        np.testing.assert_array_equal(encode.call_args.args[1], worker._raw_frame)
        worker.detector.process.assert_not_called()
        assert worker._capture_thread is None and worker._processing_thread is None
    finally:
        first.close()
        second.close()
        worker.stop()
        worker.wait_until_stopped()
    assert worker._raw_viewers == 0
    assert worker._raw_jpeg_frame is None


def test_capture_loop_marks_unavailable_webcam_offline_without_crashing(monkeypatch, worker):
    capture = Mock()
    capture.isOpened.return_value = False
    monkeypatch.setattr(camera_module.cv2, "VideoCapture", Mock(return_value=capture))
    worker._stop = StopAfterRetry()

    worker._capture_loop()

    assert worker.online is False
    assert worker.error == "USB camera 1 unavailable"
    assert worker._raw_frame is None
    capture.release.assert_called_once()


def test_capture_loop_handles_webcam_driver_error_without_crashing(monkeypatch, worker):
    monkeypatch.setattr(
        camera_module.cv2,
        "VideoCapture",
        Mock(side_effect=camera_module.cv2.error("camera unavailable")),
    )
    worker._stop = StopAfterRetry()

    worker._capture_loop()

    assert worker.online is False
    assert worker.error == "USB camera 1 unavailable"


@pytest.mark.parametrize("read_result", [(False, None), (True, None)])
def test_capture_loop_marks_webcam_read_failure_offline(monkeypatch, worker, read_result):
    capture = Mock()
    capture.isOpened.return_value = True
    capture.read.return_value = read_result
    monkeypatch.setattr(camera_module.cv2, "VideoCapture", Mock(return_value=capture))
    worker._stop = StopAfterRetry()
    worker._raw_frame = object()
    worker._jpeg_frame = b"stale-jpeg"

    worker._capture_loop()

    assert worker.online is False
    assert worker.error == "USB camera 1 interrupted; reconnecting"
    assert worker._raw_frame is None
    assert worker._jpeg_frame is None
    capture.release.assert_called_once()


def test_capture_loop_publishes_webcam_frame_and_marks_camera_online(monkeypatch, worker):
    class StopAfterFrame:
        checks = 0

        def is_set(self):
            self.checks += 1
            return self.checks >= 3

        def wait(self, _timeout):
            return True

    frame = object()
    capture = Mock()
    capture.isOpened.return_value = True
    capture.read.return_value = (True, frame)
    monkeypatch.setattr(camera_module.cv2, "VideoCapture", Mock(return_value=capture))
    worker._stop = StopAfterFrame()

    worker._capture_loop()

    assert worker.online is True
    assert worker.error is None
    assert worker._raw_frame is frame
    assert worker._raw_version == 1
    capture.release.assert_called_once()


def test_offline_telemetry_hides_stale_detection_values(worker):
    worker.online = False
    worker.capture_fps = 15.0
    worker.fps = 5.0
    worker.processing_ms = 30.0
    worker.frame_age_ms = 50.0
    worker.visible = 4
    worker.classes = {"car": 4}

    payload = worker.telemetry()

    assert payload == {
        "id": 1,
        "configured": True,
        "online": False,
        "testMirror": False,
        "captureFps": None,
        "fps": None,
        "processingMs": None,
        "frameAgeMs": None,
        "tracker": "ByteTrack",
        "modelOnline": True,
        "visibleVehicles": None,
        "vehiclesPassed": None,
        "classes": {},
        "incomingVehicles": [],
        "incomingPoints": None,
        "totalVehicles": None,
        "expectedVehicles": None,
        "vehicleCountState": "OFFLINE",
    }


def test_online_telemetry_exposes_current_counts(worker):
    worker.online = True
    worker.capture_fps = 15.0
    worker.fps = 5.0
    worker.processing_ms = 30.0
    worker.frame_age_ms = 50.0
    worker.visible = 3
    worker.classes = {"car": 2, "bus": 1}

    payload = worker.telemetry()

    assert payload["visibleVehicles"] == 3
    assert payload["vehiclesPassed"] == 12
    assert payload["classes"] == {"car": 2, "bus": 1}
    assert payload["incomingVehicles"] == [
        {"gid": "VEH-0001", "class": "car", "detectedAt": "2026-09-14T08:00:00Z", "points": 4}
    ]
    assert payload["incomingPoints"] == 4
    assert payload["totalVehicles"] == 0
    assert payload["expectedVehicles"] == 0
    assert payload["vehicleCountState"] == "CALCULATING"
    assert payload["captureFps"] == 15.0
    assert payload["fps"] == 5.0


def test_line_counting_disabled_hides_passed_total(worker):
    worker.online = True
    worker.config.line_counting = False

    assert worker.telemetry()["vehiclesPassed"] is None


def test_frames_yields_multipart_jpeg_payload(worker):
    worker._viewer_aware_jpeg = False  # Explicit compatibility mode permits a cached first frame.
    worker._jpeg_frame = b"jpeg-data"
    worker._jpeg_version = 1

    stream = worker.frames()

    assert next(stream) == b"--frame\r\nContent-Type: image/jpeg\r\n\r\njpeg-data\r\n"
    stream.close()


def start_viewer(worker, expected=1):
    stream = worker.frames()
    received = []
    thread = threading.Thread(target=lambda: received.append(next(stream, None)))
    thread.start()
    with worker._jpeg_condition:
        assert worker._jpeg_condition.wait_for(lambda: worker._viewer_count == expected, timeout=2)
    return stream, thread, received


def test_first_viewer_waits_for_fresh_shared_encode_and_disconnect_cleans_up(monkeypatch, worker):
    worker._jpeg_frame = b"stale"
    encode = Mock(return_value=(True, np.array([1, 2, 3], dtype=np.uint8)))
    monkeypatch.setattr(camera_module.cv2, "imencode", encode)
    first, first_thread, first_received = start_viewer(worker)
    second, second_thread, second_received = start_viewer(worker, expected=2)
    try:
        assert worker._jpeg_frame is None
        assert worker._encode_frame(object()) is True
        first_thread.join(timeout=2)
        second_thread.join(timeout=2)
        assert not first_thread.is_alive() and not second_thread.is_alive()
        assert first_received == second_received == [b"--frame\r\nContent-Type: image/jpeg\r\n\r\n\x01\x02\x03\r\n"]
        encode.assert_called_once()
    finally:
        worker.stop()
        first_thread.join(timeout=2)
        second_thread.join(timeout=2)
        first.close()
        second.close()
    assert worker._viewer_count == 0
    assert worker._jpeg_frame is None


def test_no_viewers_skip_encoding_but_compatibility_mode_still_encodes(monkeypatch, worker):
    encode = Mock(return_value=(True, np.array([1], dtype=np.uint8)))
    monkeypatch.setattr(camera_module.cv2, "imencode", encode)
    assert worker._encode_frame(object()) is False
    encode.assert_not_called()
    worker._viewer_aware_jpeg = False
    assert worker._encode_frame(object()) is True
    encode.assert_called_once()


def test_stopping_a_waiting_viewer_releases_its_registration(worker):
    stream, thread, received = start_viewer(worker)
    worker.stop()
    thread.join(timeout=2)
    assert not thread.is_alive()
    assert received == [None]
    stream.close()
    assert worker._viewer_count == 0


def test_encode_failure_does_not_publish_a_new_version(monkeypatch, worker):
    worker._viewer_aware_jpeg = False
    monkeypatch.setattr(camera_module.cv2, "imencode", Mock(return_value=(False, None)))
    assert worker._encode_frame(object()) is False
    assert worker._jpeg_version == 0


@pytest.mark.parametrize("viewer_aware", [False, True])
def test_processing_without_viewers_keeps_detection_transactions_and_telemetry(monkeypatch, worker, viewer_aware):
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    detection = {"trackId": 7, "class": "car", "inTrafficZone": True}
    worker.detector.process = Mock(return_value=(frame, [detection]))
    worker.detection_handler = Mock()
    worker.online = True
    worker._viewer_aware_jpeg = viewer_aware
    worker._raw_frame = frame
    worker._raw_captured_at = time.perf_counter()
    worker._raw_version = 1
    worker._stop = StopAfterRetry()
    monkeypatch.setattr(worker, "_wait_for_processing_deadline", worker._stop.wait)
    encode = Mock(return_value=(True, np.array([1], dtype=np.uint8)))
    monkeypatch.setattr(camera_module.cv2, "imencode", encode)
    worker._processing_loop()
    worker.detector.process.assert_called_once()
    worker.detection_handler.assert_called_once_with(1, [detection])
    assert worker.visible == 1
    assert worker.total_vehicles == 1
    assert worker.vehicle_count_state == "CALCULATING"
    assert worker.telemetry()["incomingPoints"] == 4
    assert encode.call_count == (0 if viewer_aware else 1)


def test_inflight_encode_from_previous_viewer_session_is_discarded(monkeypatch, worker):
    first, thread, _ = start_viewer(worker)
    with worker._jpeg_condition:
        worker._jpeg_frame = b"initial"
        worker._jpeg_version += 1
        worker._jpeg_condition.notify_all()
    thread.join(timeout=2)
    next_viewer = []

    def encode(_extension, _frame, _options):
        first.close()
        next_viewer.extend(start_viewer(worker))
        return True, np.array([9], dtype=np.uint8)

    monkeypatch.setattr(camera_module.cv2, "imencode", encode)
    try:
        assert worker._encode_frame(object()) is False
        assert worker._jpeg_frame is None
    finally:
        worker.stop()
        stream, pending_thread, _ = next_viewer
        pending_thread.join(timeout=2)
        stream.close()


def test_optional_profile_exposes_timings_and_resources_only_when_enabled(monkeypatch, worker):
    assert "performance" not in worker.telemetry()
    worker.profiler.enabled = True
    monkeypatch.setattr(camera_module.PROCESS_SAMPLER, "snapshot", lambda: {"processRssMb": 10})
    assert worker.telemetry()["performance"]["processRssMb"] == 10


@pytest.mark.parametrize("case", ["remaining", "expired", "stopped", "stop_during_sleep"])
def test_production_deadline_wait_matches_validated_helper(monkeypatch, worker, case):
    from scripts.benchmark_worker_timing import high_resolution_wait

    def exercise(production):
        clock, sleeps = [0.0], []
        worker._stop = threading.Event()
        if case == "stopped":
            worker._stop.set()

        def sleep(seconds):
            sleeps.append(seconds)
            clock[0] += seconds
            if case == "stop_during_sleep":
                worker._stop.set()

        deadline = -1 if case == "expired" else .035
        monkeypatch.setattr(camera_module.time, "perf_counter", lambda: clock[0])
        monkeypatch.setattr(camera_module.time, "sleep", sleep)
        if production:
            worker._wait_for_processing_deadline(deadline)
        else:
            high_resolution_wait(worker._stop, deadline, lambda: clock[0], sleep)
        return clock[0], sleeps

    observed = exercise(True)
    assert observed == exercise(False)
    assert all(0 < delay <= .01 for delay in observed[1])
    if case == "remaining":
        assert observed[0] == pytest.approx(.035)
    elif case == "stop_during_sleep":
        assert observed[0] <= .01
    else:
        assert observed[1] == []


@pytest.mark.parametrize("work_seconds", [.025, .15])
def test_processing_deadline_budgets_copy_and_reanchors_without_catchup(monkeypatch, worker, work_seconds):
    clock, starts, copied, deadlines = [0.0], [], [], []
    worker.config.detection_fps = 10
    worker._stop = threading.Event()

    class Frame:
        def copy(self):
            copied.append(clock[0])
            clock[0] += .005
            return self

    class Condition:
        def __enter__(self):
            starts.append(clock[0])

        def __exit__(self, *_args):
            pass

        def wait_for(self, predicate, timeout):
            worker._raw_frame = Frame()
            worker._raw_version += 1
            worker._raw_captured_at = clock[0]
            return predicate()

    def detect(frame):
        clock[0] += work_seconds
        return frame, []

    real_wait = worker._wait_for_processing_deadline

    def wait(deadline):
        deadlines.append(deadline)
        real_wait(deadline)
        if len(deadlines) == 3:
            worker._stop.set()

    worker._raw_condition = Condition()
    worker.detector.process = Mock(side_effect=detect)
    monkeypatch.setattr(worker, "_draw_transaction_counts", lambda _frame: None)
    monkeypatch.setattr(worker, "_encode_frame", lambda _frame: False)
    monkeypatch.setattr(worker, "_wait_for_processing_deadline", wait)
    monkeypatch.setattr(camera_module.time, "perf_counter", lambda: clock[0])
    monkeypatch.setattr(camera_module.time, "sleep", lambda delay: clock.__setitem__(0, clock[0] + delay))
    worker._processing_loop()

    period = max(.1, .005 + work_seconds)
    assert starts == pytest.approx([0, period, 2 * period])
    assert deadlines == pytest.approx([start + .1 for start in starts])
    assert copied == starts  # Exactly one copy, after pacing, before detection.
    assert worker.detector.process.call_count == 3


def test_processing_unavailable_delayed_repeated_and_reconnected_frames(monkeypatch, worker):
    clock, versions, copied, waits = [0.0], [], [], []
    worker.config.detection_fps = 10
    events = iter([(None, 0, 1.0), (4, 4, .25), (4, 4, 1.0), (None, 4, 1.0), (7, 7, .25)])

    class Frame:
        def __init__(self, version):
            self.version = version

        def copy(self):
            copied.append(self.version)
            return self

    class Condition:
        def __enter__(self):
            pass

        def __exit__(self, *_args):
            pass

        def wait_for(self, predicate, timeout):
            event = next(events, None)
            if event is None:
                worker._stop.set()
                return predicate()
            frame, version, delay = event
            clock[0] += delay
            worker._raw_frame = Frame(frame) if frame is not None else None
            worker._raw_version = version
            worker._raw_captured_at = clock[0]
            return predicate()

    def detect(frame):
        versions.append(frame.version)
        clock[0] += .02
        return frame, []

    worker._raw_condition = Condition()
    worker.detector.process = Mock(side_effect=detect)
    monkeypatch.setattr(worker, "_draw_transaction_counts", lambda _frame: None)
    monkeypatch.setattr(worker, "_encode_frame", lambda _frame: False)
    monkeypatch.setattr(camera_module.time, "perf_counter", lambda: clock[0])
    monkeypatch.setattr(camera_module.time, "sleep", waits.append)
    worker._processing_loop()
    assert versions == copied == [4, 7]
    assert waits == []  # Source waiting already exhausted each iteration budget.


def test_stopped_processing_worker_never_acquires_or_processes_a_frame(worker):
    worker.stop()
    worker._raw_frame = Mock()
    worker.detector.process = Mock()
    worker._processing_loop()
    worker._raw_frame.copy.assert_not_called()
    worker.detector.process.assert_not_called()

