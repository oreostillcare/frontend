from copy import deepcopy
import json
from pathlib import Path

import pytest

from scripts.compare_openvino_models import analyze, main


def detection(track, box=(0, 0, 10, 10), cls="car", confidence=0.8, **extra):
    return {"canonicalTrackId": track, "class": cls, "confidence": confidence,
            "boundingBox": list(box), **extra}


def report(rows_by_camera=None, *, sha="same", frames=2):
    rows_by_camera = rows_by_camera or {"camera1": [], "camera2": []}
    frame_map = {}
    for camera in ("camera1", "camera2"):
        frame_map[camera] = []
        camera_detections = rows_by_camera.get(camera, [[] for _ in range(frames)])
        for sequence, detections in enumerate(camera_detections):
            frame_map[camera].append({
                "generation": 1, "sequence": sequence, "sourceTimestampSeconds": sequence / 10,
                "captureTimeMonotonic": float(sequence), "completionTimeMonotonic": float(sequence) + 0.1,
                "captureAgeAtStartMs": 1.0, "captureAgeAtCompletionMs": 100.0,
                "status": "current", "publishedCurrent": True,
                "detections": detections, "passed": sequence + 1,
                "ledgerPoints": sequence * 6,
            })
    return {"source": {"rawFileSha256": sha, "framesRequestedPerCamera": frames},
            "settings": {"sourceFps": 10, "guideGreenPercent": 15, "guideRedPercent": 80,
                         "lineCountingEnabled": True, "maxAgeMs": 2500, "imageSize": 640},
            "experimentFixedSettings": {"imageSize": 640,
                                         "confidence": {"local": 0.35, "coco": 0.25},
                                         "detectionFps": 10, "openvino": {"threads": 4}},
            "openvinoCompiledProperties": {"local": {"INFERENCE_PRECISION_HINT": "f32"},
                                           "coco": {"INFERENCE_PRECISION_HINT": "f32"}},
            "frames": frame_map}


def test_reports_track_splits_merges_and_unmatched_detection_count_drift():
    baseline = report({"camera1": [
        [detection("r1"), detection("r2", box=(20, 0, 30, 10))],
        [detection("r1"), detection("r2", box=(20, 0, 30, 10))],
    ]})
    candidate = report({"camera1": [
        [detection("c1"), detection("c2", box=(20, 0, 30, 10)), detection("extra", box=(40, 0, 50, 10))],
        [detection("c1"), detection("c1", box=(20, 0, 30, 10))],
    ]})
    candidate["frames"]["camera1"][1]["passed"] += 1
    candidate["frames"]["camera1"][1]["ledgerPoints"] += 6
    result = analyze(baseline, candidate)
    assert result["status"] == "comparable"
    assert result["automaticPromotion"] is False
    assert result["accuracyEvaluation"].startswith("not_evaluated")
    assert result["detectionAgreement"]["unmatchedReferenceDetections"] == 0
    assert result["detectionAgreement"]["unmatchedCandidateDetections"] == 1
    assert result["trackingCorrespondence"]["splits"]
    assert result["trackingCorrespondence"]["merges"]
    assert result["passedAndLedgerPointDrift"]["camera1"]["passed"]["final"] == 1
    assert result["passedAndLedgerPointDrift"]["camera1"]["passed"]["maximumAbsolute"] == 1
    assert result["passedAndLedgerPointDrift"]["camera1"]["passed"]["perFrame"][0]["passed"] == 0


def test_reports_incomparable_source_or_ordered_sequence_mismatch():
    baseline = report({"camera1": [[detection("a")], [detection("a")]]})
    different_source = report({"camera1": [[detection("a")], [detection("a")]]}, sha="other")
    assert analyze(baseline, different_source)["status"] == "incomparable"
    reordered = deepcopy(baseline)
    reordered["frames"]["camera1"].reverse()
    result = analyze(baseline, reordered)
    assert result["status"] == "incomparable"
    assert result["comparisonEligibility"]["sameOrderedSequence"] is False


def test_duplicate_candidates_are_diagnostic_and_do_not_supply_ground_truth():
    baseline = report({"camera1": [[detection("a")], [detection("a")]]})
    candidate = report({"camera1": [[detection("a"), detection("b")], [detection("a")]]})
    result = analyze(baseline, candidate)
    assert result["duplicateCandidatesDiagnostic"]["candidateSameClassOverlappingPairs"] == 1
    assert "no ground-truth" in result["accuracyEvaluation"]
    assert result["automaticPromotion"] is False


def test_settings_or_missing_fixed_metadata_make_reports_incomparable():
    baseline = report({"camera1": [[detection("a")], [detection("a")]]})
    size_only = deepcopy(baseline)
    size_only["settings"]["imageSize"] = 320
    size_only["experimentFixedSettings"]["imageSize"] = 320
    assert analyze(baseline, size_only)["status"] == "comparable"
    changed = deepcopy(baseline)
    changed["settings"]["guideGreenPercent"] = 16
    result = analyze(baseline, changed)
    assert result["status"] == "incomparable"
    assert not result["comparisonEligibility"]["sameNonSizeSettings"]
    del changed["settings"]["guideGreenPercent"]
    result = analyze(baseline, changed)
    assert "guideGreenPercent" in result["comparisonEligibility"]["missingNonSizeSettings"]
    del changed["experimentFixedSettings"]
    result = analyze(baseline, changed)
    assert not result["comparisonEligibility"]["sameExperimentFixedSettings"]
    assert result["comparisonEligibility"]["missingFixedSettings"]


def test_transition_shift_reports_per_camera_sequence_mismatch():
    baseline = report({"camera1": [[detection("a", greenCrossed=True)], [detection("a")]]})
    candidate = report({"camera1": [[detection("a")], [detection("a", greenCrossed=True)]]})
    result = analyze(baseline, candidate)
    mismatches = result["crossingTransitionMismatches"]
    assert [(item["camera"], item["sequence"], item["field"]) for item in mismatches] == [
        ("camera1", 0, "greenCrossed"), ("camera1", 1, "greenCrossed")]


def test_global_vehicle_id_split_and_merge_across_cameras():
    baseline = report({
        "camera1": [[detection("a", vehicleId="vehicle-a")], [detection("a", vehicleId="vehicle-a")]],
        "camera2": [[detection("b", vehicleId="vehicle-a"),
                     detection("c", box=(20, 0, 30, 10), vehicleId="vehicle-b")]] * 2,
    })
    candidate = report({
        "camera1": [[detection("x", vehicleId="vehicle-x")], [detection("x", vehicleId="vehicle-x")]],
        "camera2": [[detection("y", vehicleId="vehicle-y"),
                     detection("x", box=(20, 0, 30, 10), vehicleId="vehicle-x")]] * 2,
    })
    identities = analyze(baseline, candidate)["trackingCorrespondence"]["globalVehicleIdentity"]
    assert identities["splits"] == [{"baselineVehicleId": "vehicle-a",
                                     "candidateVehicleIds": ["vehicle-x", "vehicle-y"]}]
    assert identities["merges"] == [{"candidateVehicleId": "vehicle-x",
                                     "baselineVehicleIds": ["vehicle-a", "vehicle-b"]}]
    candidate["frames"]["camera1"][0]["detections"][0].pop("vehicleId")
    missing = analyze(baseline, candidate)["trackingCorrespondence"]["globalVehicleIdentity"]["missingIdMatches"]
    assert missing == [{"camera": "camera1", "generation": 1, "sequence": 0,
                        "baselineVehicleId": "vehicle-a", "candidateVehicleId": None}]


def test_timestamp_audit_flags_nonmonotonic_and_incorrect_source_timestamp():
    value = report({"camera1": [[detection("a")], [detection("a")]]})
    value["frames"]["camera1"][0]["captureTimeMonotonic"] = 1.0
    value["frames"]["camera1"][0]["completionTimeMonotonic"] = 1.1
    value["frames"]["camera1"][1]["captureTimeMonotonic"] = 0.5
    value["frames"]["camera1"][1]["completionTimeMonotonic"] = 0.4
    value["frames"]["camera1"][1]["captureAgeAtCompletionMs"] = -1
    value["frames"]["camera1"][0]["sourceTimestampSeconds"] = 123
    result = analyze(value, value)
    errors = result["timestampAudit"]["baseline"]["camera1"]["errors"]
    reasons = {error["reason"] for error in errors}
    assert {"capture_not_monotonic", "completion_before_capture", "invalid_captureAgeAtCompletionMs",
            "source_timestamp_mismatch"} <= reasons


def test_timestamp_audit_flags_age_and_publication_status_inconsistency():
    value = report({"camera1": [[detection("a")], [detection("a")]]})
    first, second = value["frames"]["camera1"]
    first["captureAgeAtCompletionMs"] = 500
    second["status"] = "current"
    second["publishedCurrent"] = False
    second["captureAgeAtCompletionMs"] = 3000
    result = analyze(value, value)
    reasons = {item["reason"] for item in result["timestampAudit"]["baseline"]["camera1"]["errors"]}
    assert {"completion_age_inconsistent", "published_current_status_mismatch",
            "current_publication_exceeds_max_age"} <= reasons


def test_cli_refuses_to_overwrite_either_input(tmp_path):
    source = tmp_path / "report.json"
    content = json.dumps(report())
    source.write_text(content, encoding="utf-8")
    with pytest.raises(SystemExit):
        main(["--baseline", str(source), "--candidate", str(source), "--output", str(source)])
    assert source.read_text(encoding="utf-8") == content
