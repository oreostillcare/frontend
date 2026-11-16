"""Offline agreement analysis for two benchmark_openvino_scheduling JSON reports.

This is a diagnostic comparator, not an accuracy evaluator: the reports contain
no ground-truth labels, and its output must never promote a model automatically.
"""

import argparse
import json
import math
from pathlib import Path


TRANSITION_FIELDS = (
    "greenCrossed", "redCrossed", "redLineTouched", "greenTransition",
    "redTransition", "redEntryTransition", "greenExitTransition",
    "outgoingRouteStarted", "outgoingRouteComplete", "outgoingRouteTransition",
)
SIZE_SETTING_KEYS = {"imgsz", "imagesize", "image_size", "requestedimagesize"}
REQUIRED_COMPARISON_SETTINGS = ("sourceFps", "guideGreenPercent", "guideRedPercent", "lineCountingEnabled")


def _unwrap(value):
    while isinstance(value, dict) and "result" in value and "frames" not in value:
        value = value["result"]
    if not isinstance(value, dict) or not isinstance(value.get("frames"), dict):
        raise ValueError("Expected a scheduling report with a frames object")
    return value


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _iou(left, right):
    try:
        ax1, ay1, ax2, ay2 = left["boundingBox"]
        bx1, by1, bx2, by2 = right["boundingBox"]
        values = (ax1, ay1, ax2, ay2, bx1, by1, bx2, by2)
        if not all(_number(value) for value in values):
            return 0.0
        intersection = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
        area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
        area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
        union = area_a + area_b - intersection
        return intersection / union if union > 0 else 0.0
    except (KeyError, TypeError, ValueError):
        return 0.0


def _rows(report):
    rows = []
    for camera in ("camera1", "camera2"):
        for row in report["frames"].get(camera, []):
            rows.append((camera, row))
    return rows


def _sequence_audit(report):
    keys, duplicates, ordered = [], [], True
    by_camera = {}
    for camera in ("camera1", "camera2"):
        camera_rows = report["frames"].get(camera, [])
        camera_keys = []
        for row in camera_rows:
            key = (camera, row.get("generation", 1), row.get("sequence"))
            if key in keys:
                duplicates.append(key)
            keys.append(key)
            camera_keys.append(key)
        ordered &= camera_keys == sorted(camera_keys, key=lambda key: (key[1], key[2]))
        by_camera[camera] = camera_keys
    expected = report.get("source", {}).get("framesRequestedPerCamera")
    complete = isinstance(expected, int) and expected > 0
    if complete:
        for camera, camera_keys in by_camera.items():
            complete &= [(key[1], key[2]) for key in camera_keys] == [(1, seq) for seq in range(expected)]
    return keys, {"duplicateKeys": duplicates, "ordered": ordered, "complete": bool(complete)}


def _timestamp_audit(report):
    cameras = {}
    for camera in ("camera1", "camera2"):
        rows = report["frames"].get(camera, [])
        errors, previous_capture, previous_completion = [], None, None
        fps = report.get("settings", {}).get("sourceFps")
        max_age = report.get("settings", {}).get("maxAgeMs")
        for index, row in enumerate(rows):
            capture, completion = row.get("captureTimeMonotonic"), row.get("completionTimeMonotonic")
            if not _number(capture) or not _number(completion):
                errors.append({"index": index, "reason": "non_finite_or_missing_timestamp"})
                continue
            if completion < capture:
                errors.append({"index": index, "reason": "completion_before_capture"})
            if previous_capture is not None and capture < previous_capture:
                errors.append({"index": index, "reason": "capture_not_monotonic"})
            for name in ("captureAgeAtStartMs", "captureAgeAtCompletionMs"):
                if not _number(row.get(name)) or row[name] < 0:
                    errors.append({"index": index, "reason": f"invalid_{name}"})
            reported_age = row.get("captureAgeAtCompletionMs")
            if _number(reported_age) and not math.isclose(
                reported_age, (completion - capture) * 1000, rel_tol=1e-7, abs_tol=0.01
            ):
                errors.append({"index": index, "reason": "completion_age_inconsistent"})
            if previous_completion is not None and completion < previous_completion:
                errors.append({"index": index, "reason": "completion_not_monotonic"})
            previous_capture, previous_completion = capture, completion
            sequence, source_time = row.get("sequence"), row.get("sourceTimestampSeconds")
            if _number(fps) and fps > 0 and _number(sequence):
                if not _number(source_time) or not math.isclose(source_time, sequence / fps, rel_tol=1e-7, abs_tol=1e-7):
                    errors.append({"index": index, "reason": "source_timestamp_mismatch"})
            else:
                errors.append({"index": index, "reason": "source_timestamp_unverifiable"})
            status, published = row.get("status"), row.get("publishedCurrent")
            if status not in {"current", "stale", "superseded_generation", "stopped"}:
                errors.append({"index": index, "reason": "invalid_completion_status"})
            if not isinstance(published, bool) or published != (status == "current"):
                errors.append({"index": index, "reason": "published_current_status_mismatch"})
            if _number(max_age) and max_age > 0 and _number(reported_age):
                if status == "current" and reported_age > max_age:
                    errors.append({"index": index, "reason": "current_publication_exceeds_max_age"})
                if status == "stale" and reported_age <= max_age:
                    errors.append({"index": index, "reason": "stale_status_within_max_age"})
        statuses = [row.get("status") for row in rows]
        cameras[camera] = {"valid": not errors, "errors": errors,
                           "currentCount": sum(status == "current" for status in statuses),
                           "staleCount": sum(status == "stale" for status in statuses),
                           "supersededCount": sum(status == "superseded_generation" for status in statuses)}
    return cameras


def _frame_map(report):
    return {(camera, row.get("generation", 1), row.get("sequence")): row for camera, row in _rows(report)}


def _comparison_settings(report):
    settings = report.get("settings", {})
    return {key: value for key, value in settings.items() if key.lower() not in SIZE_SETTING_KEYS}


def _without_size_settings(value):
    if isinstance(value, dict):
        return {key: _without_size_settings(item) for key, item in value.items()
                if key.lower() not in SIZE_SETTING_KEYS}
    if isinstance(value, list):
        return [_without_size_settings(item) for item in value]
    return value


def _has_fixed_detection_settings(value):
    return (isinstance(value, dict) and isinstance(value.get("confidence"), dict)
            and _number(value["confidence"].get("local"))
            and _number(value["confidence"].get("coco"))
            and _number(value.get("detectionFps")))


def _precision_settings(report):
    properties = report.get("openvinoCompiledProperties", {})
    return {model: values.get("INFERENCE_PRECISION_HINT")
            for model, values in properties.items() if isinstance(values, dict)}


def _numeric_drift(candidate_value, baseline_value):
    if _number(candidate_value) and _number(baseline_value):
        return candidate_value - baseline_value
    return None


def _event_count(row, field):
    return sum(bool(item.get(field)) for item in row.get("detections", []))


def _match_frame(reference, candidate):
    pairs = []
    for ri, ref in enumerate(reference.get("detections", [])):
        for ci, cand in enumerate(candidate.get("detections", [])):
            if ref.get("class") == cand.get("class"):
                score = _iou(ref, cand)
                if score >= 0.5:
                    pairs.append((score, ri, ci))
    pairs.sort(key=lambda item: (-item[0], item[1], item[2]))
    used_ref, used_cand, matches = set(), set(), []
    for score, ri, ci in pairs:
        if ri not in used_ref and ci not in used_cand:
            used_ref.add(ri)
            used_cand.add(ci)
            matches.append((reference["detections"][ri], candidate["detections"][ci], score))
    return matches, len(reference.get("detections", [])) - len(used_ref), len(candidate.get("detections", [])) - len(used_cand)


def _duplicate_candidates(report):
    count = 0
    for _, row in _rows(report):
        detections = row.get("detections", [])
        for index, left in enumerate(detections):
            for right in detections[index + 1:]:
                if left.get("class") == right.get("class") and _iou(left, right) >= 0.8:
                    count += 1
    return count


def analyze(baseline, candidate):
    baseline, candidate = _unwrap(baseline), _unwrap(candidate)
    ref_keys, ref_sequence = _sequence_audit(baseline)
    cand_keys, cand_sequence = _sequence_audit(candidate)
    same_source = (baseline.get("source", {}).get("rawFileSha256") is not None
                   and baseline.get("source", {}).get("rawFileSha256")
                   == candidate.get("source", {}).get("rawFileSha256"))
    same_sequence = ref_keys == cand_keys and ref_sequence["ordered"] and cand_sequence["ordered"]
    complete = ref_sequence["complete"] and cand_sequence["complete"]
    baseline_settings, candidate_settings = _comparison_settings(baseline), _comparison_settings(candidate)
    missing_settings = [name for name in REQUIRED_COMPARISON_SETTINGS
                        if name not in baseline_settings or name not in candidate_settings]
    same_settings = not missing_settings and baseline_settings == candidate_settings
    baseline_fixed = baseline.get("experimentFixedSettings")
    candidate_fixed = candidate.get("experimentFixedSettings")
    has_fixed = _has_fixed_detection_settings(baseline_fixed) and _has_fixed_detection_settings(candidate_fixed)
    same_fixed_settings = (has_fixed and _without_size_settings(baseline_fixed)
                           == _without_size_settings(candidate_fixed))
    baseline_precision, candidate_precision = _precision_settings(baseline), _precision_settings(candidate)
    same_precision = (all(baseline_precision.get(name) is not None for name in ("local", "coco"))
                      and baseline_precision == candidate_precision)
    comparable = bool(same_source and same_sequence and complete and same_settings
                      and same_fixed_settings and same_precision
                      and not ref_sequence["duplicateKeys"] and not cand_sequence["duplicateKeys"])

    class_counts, ref_unmatched, cand_unmatched = {}, 0, 0
    ious, confidence_shifts, ref_to_candidate, candidate_to_ref = [], [], {}, {}
    ref_gid_to_candidate, candidate_gid_to_ref = {}, {}
    missing_vehicle_ids = []
    transition_counts = {field: {"baseline": 0, "candidate": 0} for field in TRANSITION_FIELDS}
    transition_mismatches, count_drift_rows = [], {camera: [] for camera in ("camera1", "camera2")}
    ref_map, cand_map = _frame_map(baseline), _frame_map(candidate)
    for key in ref_keys:
        left, right = ref_map.get(key), cand_map.get(key)
        if left is None or right is None:
            continue
        matches, left_missing, right_extra = _match_frame(left, right)
        ref_unmatched += left_missing
        cand_unmatched += right_extra
        for item in left.get("detections", []):
            label = str(item.get("class"))
            class_counts.setdefault(label, {"baseline": 0, "candidate": 0, "matched": 0})["baseline"] += 1
        for item in right.get("detections", []):
            label = str(item.get("class"))
            class_counts.setdefault(label, {"baseline": 0, "candidate": 0, "matched": 0})["candidate"] += 1
        for ref, cand, score in matches:
            label = str(ref.get("class"))
            class_counts[label]["matched"] += 1
            ious.append(score)
            if _number(ref.get("confidence")) and _number(cand.get("confidence")):
                confidence_shifts.append(cand["confidence"] - ref["confidence"])
            rt, ct = ref.get("canonicalTrackId"), cand.get("canonicalTrackId")
            if rt is not None and ct is not None:
                ref_to_candidate.setdefault((key[0], rt), set()).add(ct)
                candidate_to_ref.setdefault((key[0], ct), set()).add(rt)
            ref_gid, candidate_gid = ref.get("vehicleId"), cand.get("vehicleId")
            if ref_gid is not None and candidate_gid is not None:
                ref_gid_to_candidate.setdefault(ref_gid, set()).add(candidate_gid)
                candidate_gid_to_ref.setdefault(candidate_gid, set()).add(ref_gid)
            elif ref_gid is not None or candidate_gid is not None:
                missing_vehicle_ids.append({"camera": key[0], "generation": key[1], "sequence": key[2],
                                            "baselineVehicleId": ref_gid, "candidateVehicleId": candidate_gid})
        for field in TRANSITION_FIELDS:
            baseline_events = _event_count(left, field)
            candidate_events = _event_count(right, field)
            transition_counts[field]["baseline"] += baseline_events
            transition_counts[field]["candidate"] += candidate_events
            if baseline_events != candidate_events:
                transition_mismatches.append({"camera": key[0], "generation": key[1], "sequence": key[2],
                                              "field": field, "baselineCount": baseline_events,
                                              "candidateCount": candidate_events})
        count_drift_rows[key[0]].append({
            "generation": key[1], "sequence": key[2],
            "passed": _numeric_drift(right.get("passed"), left.get("passed")),
            "ledgerPoints": _numeric_drift(right.get("ledgerPoints"), left.get("ledgerPoints")),
        })

    splits = [{"camera": camera, "baselineTrackId": track, "candidateTrackIds": sorted(map(str, targets))}
              for (camera, track), targets in ref_to_candidate.items() if len(targets) > 1]
    merges = [{"camera": camera, "candidateTrackId": track, "baselineTrackIds": sorted(map(str, sources))}
              for (camera, track), sources in candidate_to_ref.items() if len(sources) > 1]
    vehicle_splits = [{"baselineVehicleId": identity, "candidateVehicleIds": sorted(map(str, targets))}
                      for identity, targets in ref_gid_to_candidate.items() if len(targets) > 1]
    vehicle_merges = [{"candidateVehicleId": identity, "baselineVehicleIds": sorted(map(str, sources))}
                      for identity, sources in candidate_gid_to_ref.items() if len(sources) > 1]
    count_drift = {}
    for camera, records in count_drift_rows.items():
        metrics = {}
        for field in ("passed", "ledgerPoints"):
            values = [row[field] for row in records if row[field] is not None]
            metrics[field] = {"final": values[-1] if values else None,
                              "maximumAbsolute": max((abs(value) for value in values), default=None),
                              "perFrame": [{"generation": row["generation"], "sequence": row["sequence"], field: row[field]}
                                           for row in records]}
        count_drift[camera] = metrics
    timestamp = {"baseline": _timestamp_audit(baseline), "candidate": _timestamp_audit(candidate)}
    coverage = {}
    for label, report in (("baseline", baseline), ("candidate", candidate)):
        coverage[label] = {camera: {
            "frames": len(report["frames"].get(camera, [])),
            "detections": sum(len(row.get("detections", [])) for row in report["frames"].get(camera, [])),
            "detectionsWithCanonicalTrackId": sum(item.get("canonicalTrackId") is not None
                for row in report["frames"].get(camera, []) for item in row.get("detections", [])),
        } for camera in ("camera1", "camera2")}
    return {
        "status": "comparable" if comparable else "incomparable",
        "comparisonEligibility": {"sameRawSourceSHA256": bool(same_source), "sameOrderedSequence": bool(same_sequence),
                                  "completeSequence": bool(complete), "baselineSequenceAudit": ref_sequence,
                                  "candidateSequenceAudit": cand_sequence,
                                  "sameNonSizeSettings": bool(same_settings),
                                  "missingNonSizeSettings": missing_settings,
                                  "sameExperimentFixedSettings": bool(same_fixed_settings),
                                  "sameCompiledPrecision": bool(same_precision),
                                  "missingFixedSettings": not has_fixed,
                                  "baselineExperimentFixedSettings": baseline_fixed,
                                  "candidateExperimentFixedSettings": candidate_fixed},
        "accuracyEvaluation": "not_evaluated: reports contain no ground-truth labels",
        "automaticPromotion": False,
        "detectionAgreement": {"classCounts": class_counts, "unmatchedReferenceDetections": ref_unmatched,
            "unmatchedCandidateDetections": cand_unmatched,
            "matchedMeanIoU": sum(ious) / len(ious) if ious else None,
            "matchedMeanConfidenceShiftCandidateMinusBaseline":
                sum(confidence_shifts) / len(confidence_shifts) if confidence_shifts else None},
        "trackingCorrespondence": {"splits": splits, "merges": merges,
                                    "globalVehicleIdentity": {"splits": vehicle_splits, "merges": vehicle_merges,
                                                               "missingIdMatches": missing_vehicle_ids},
                                    "coverage": coverage},
        "duplicateCandidatesDiagnostic": {"thresholdIoU": 0.8,
            "baselineSameClassOverlappingPairs": _duplicate_candidates(baseline),
            "candidateSameClassOverlappingPairs": _duplicate_candidates(candidate),
            "groundTruthInterpretation": "none; overlapping detections are only a duplicate-candidate diagnostic"},
        "crossingTransitionCounts": transition_counts, "crossingTransitionMismatches": transition_mismatches,
        "passedAndLedgerPointDrift": count_drift,
        "timestampAudit": timestamp,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        baseline_path = args.baseline.expanduser().resolve()
        candidate_path = args.candidate.expanduser().resolve()
        output_path = args.output.expanduser().resolve()
        aliases_input = output_path in {baseline_path, candidate_path}
        if output_path.exists():
            aliases_input |= any(input_path.exists() and output_path.samefile(input_path)
                                 for input_path in (baseline_path, candidate_path))
        if aliases_input:
            parser.error("--output must not alias --baseline or --candidate")
        result = analyze(json.loads(args.baseline.read_text(encoding="utf-8")),
                         json.loads(args.candidate.read_text(encoding="utf-8")))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
