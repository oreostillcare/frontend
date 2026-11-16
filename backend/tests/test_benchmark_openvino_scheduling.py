import ast
import json
from pathlib import Path
import subprocess
import threading

import pytest

from scripts.benchmark_openvino_scheduling import parity
from scripts.scheduling_replay import FrameEnvelope, LatestFrameMailbox


def envelope(camera=1, generation=1, version=1, sequence=0, captured=0.0):
    return FrameEnvelope(camera, generation, version, sequence, captured, object())


def test_mailbox_rejects_duplicate_versions_old_generations_and_mixed_camera_frames():
    mailbox = LatestFrameMailbox(1, clock=lambda: 1.0)
    assert mailbox.publish(envelope(version=2, sequence=1))
    assert not mailbox.publish(envelope(version=2, sequence=2))
    assert not mailbox.publish(envelope(camera=2, version=3))
    assert mailbox.publish(envelope(generation=2, version=1, sequence=4))
    assert not mailbox.publish(envelope(generation=1, version=99))
    accepted = mailbox.take(5)
    assert (accepted.camera_id, accepted.generation, accepted.version, accepted.sequence) == (1, 2, 1, 4)


def test_mailbox_overwrites_one_slot_and_expires_by_monotonic_age():
    now = [3.0]
    mailbox = LatestFrameMailbox(1, clock=lambda: now[0])
    assert mailbox.publish(envelope(version=1, sequence=0, captured=2.0))
    assert mailbox.publish(envelope(version=2, sequence=1, captured=2.0))
    assert mailbox.replaced == 1
    assert mailbox.take(0.5) is None
    assert mailbox.expired == 1


def test_mailbox_propagates_producer_exception_and_shutdown_unblocks_waiter():
    mailbox = LatestFrameMailbox(1)
    mailbox.fail(ValueError("decode failed"))
    with pytest.raises(RuntimeError, match="producer failed") as raised:
        mailbox.take(1)
    assert isinstance(raised.value.__cause__, ValueError)

    waiting = LatestFrameMailbox(2)
    result = []
    thread = threading.Thread(target=lambda: result.append(waiting.take(1, timeout=2)))
    thread.start()
    waiting.close()
    thread.join(1)
    assert not thread.is_alive()
    assert result == [None]


def test_parity_requires_identical_accepted_sequences_and_checks_semantics():
    row = {"sequence": 3, "detections": [{"canonicalTrackId": 1, "class": "bus", "confidence": 0.9,
            "vehicleId": "vehicle-a",
            "boundingBox": [1, 2, 3, 4], "trafficRole": "INCOMING", "inTrafficZone": True,
            "greenCrossed": True, "redCrossed": False, "redLineTouched": False}],
           "passed": 0, "ledgerPoints": 6, "ledger": [{"class": "bus", "points": 6,
                                                       "canonicalTrackId": 1, "gid": "vehicle-a"}]}
    report = {"frames": {"camera1": [row], "camera2": [row]}}
    assert parity(report, report)["status"] == "passed"
    untested_camera = {"frames": {"camera1": [row], "camera2": []}}
    assert parity(untested_camera, untested_camera)["status"] == "not_passed"
    changed = {"frames": {"camera1": [{**row, "sequence": 4}], "camera2": [row]}}
    compared = parity(report, changed)
    assert compared["status"] == "not_passed"
    assert compared["identicalAcceptedFrameSequences"] is False

    empty = {"frames": {"camera1": [{"sequence": 3, "detections": [], "passed": 0,
                                      "ledgerPoints": 0, "ledger": []}], "camera2": []}}
    assert parity(empty, empty)["status"] == "not_passed"


def test_scheduling_tool_has_no_live_application_or_network_imports():
    path = Path(__import__("scripts.benchmark_openvino_scheduling", fromlist=["__file"]).__file__)
    tree = ast.parse(path.read_text(encoding="utf-8"))
    forbidden = {"app", "camera", "traffic_control", "traffic_transactions", "flask", "socket", "urllib", "requests"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert not {alias.name.split(".")[0] for alias in node.names} & forbidden
        if isinstance(node, ast.ImportFrom):
            assert (node.module or "").split(".")[0] not in forbidden


@pytest.mark.parametrize("captured", [float("nan"), float("inf"), -float("inf"), 2.0])
def test_mailbox_rejects_nonfinite_or_future_capture_time(captured):
    mailbox = LatestFrameMailbox(1, clock=lambda: 1.0)
    assert not mailbox.publish(envelope(captured=captured))
    assert mailbox.published == 0


def test_inflight_publication_rejects_new_generation_expiry_and_shutdown():
    now = [1.0]
    mailbox = LatestFrameMailbox(1, clock=lambda: now[0])
    assert mailbox.publish(envelope(captured=1.0))
    selected = mailbox.take(1)
    assert mailbox.completion_status(selected, 1) == "current"
    assert mailbox.publish(envelope(generation=2, version=1, captured=1.0))
    assert mailbox.completion_status(selected, 1) == "superseded_generation"
    newer = mailbox.take(1)
    now[0] = 3.0
    assert mailbox.completion_status(newer, 1) == "stale"
    assert mailbox.completion_status(newer, 5, stopped=True) == "stopped"


def test_backpressure_waits_for_capacity_and_shutdown_unblocks_producer():
    mailbox = LatestFrameMailbox(1, clock=lambda: 1.0)
    assert mailbox.publish(envelope())
    waiting = threading.Event()
    result = []

    def producer():
        waiting.set()
        result.append(mailbox.wait_for_capacity(timeout=1))

    thread = threading.Thread(target=producer)
    thread.start()
    assert waiting.wait(1)
    assert mailbox.take(5) is not None
    thread.join(1)
    assert result == [True] and not thread.is_alive()
    assert mailbox.replaced == 0
    assert mailbox.publish(envelope(version=2))
    mailbox.close()
    assert mailbox.wait_for_capacity(timeout=0.01) is False


def test_scheduling_records_watchdog_timeout(monkeypatch, tmp_path):
    from scripts import benchmark_openvino_scheduling as benchmark

    source = tmp_path / "still.jpg"
    source.write_bytes(b"image")
    output = tmp_path / "timeout.json"
    monkeypatch.setattr(benchmark, "run_bounded", lambda *a, **k: (_ for _ in ()).throw(
        subprocess.TimeoutExpired(["child"], 0.1)))
    assert benchmark.main(["--source", str(source), "--request-mode", "shared",
                           "--timeout-seconds", "0.1", "--output", str(output)]) == 1
    report = json.loads(output.read_text())
    assert report["status"] == "failed" and report["runs"] == []
    assert "TimeoutExpired" in report["failures"][0]["error"]


def identity_report(camera1_gids, camera2_gids):
    frames = {}
    for camera, gids in (("camera1", camera1_gids), ("camera2", camera2_gids)):
        frames[camera] = [{
            "sequence": index, "detections": [{"canonicalTrackId": 1, "vehicleId": gid,
                "class": "bus", "confidence": 0.9, "boundingBox": [1, 2, 3, 4],
                "trafficRole": "INCOMING", "greenCrossed": True}],
            "passed": 1, "ledgerPoints": 6,
            "ledger": [{"canonicalTrackId": 1, "gid": gid, "class": "bus", "points": 6}],
        } for index, gid in enumerate(gids)]
    return {"frames": frames}


@pytest.mark.parametrize("baseline,candidate", [
    (identity_report(["a", "a"], ["b", "b"]), identity_report(["x", "y"], ["z", "z"])),
    (identity_report(["a", "b"], ["c", "c"]), identity_report(["x", "x"], ["z", "z"])),
    (identity_report(["a"], ["a"]), identity_report(["x"], ["y"])),
])
def test_parity_rejects_global_identity_split_merge_and_lost_handoff(baseline, candidate):
    result = parity(baseline, candidate)
    assert result["status"] == "not_passed"
    assert result["globalIdentityEquivalence"]["differences"]


def test_parity_allows_only_bijective_global_identity_renumbering():
    baseline = identity_report(["a", "a"], ["a", "b"])
    candidate = identity_report(["x", "x"], ["x", "y"])
    result = parity(baseline, candidate)
    assert result["status"] == "passed"
    assert result["globalIdentityEquivalence"]["bijectiveRenaming"] == {"a": "x", "b": "y"}


def test_parity_rejects_reordered_accepted_frames():
    baseline = identity_report(["a", "a"], ["b", "b"])
    candidate = identity_report(["a", "a"], ["b", "b"])
    candidate["frames"]["camera1"].reverse()
    assert parity(baseline, candidate)["status"] == "not_passed"
