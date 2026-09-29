import math
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

import cv2

LOCAL_MATCH_THRESHOLD = 0.55


@dataclass
class LocalBinding:
    vehicle_id: str
    last_seen_at: float


@dataclass
class VehicleObservation:
    track_id: int
    vehicle_class: str
    traffic_role: str | None
    center: tuple[int, int]
    descriptors: deque[Any]
    aspect_ratios: deque[float]
    confidences: deque[float]
    frame_diagonal: float
    seen_at: float


@dataclass
class DepartureCandidate:
    vehicle_id: str
    origin_camera_id: int
    traffic_role: str | None
    descriptors: tuple[Any, ...]
    aspect_ratios: tuple[float, ...]
    confidences: tuple[float, ...]
    departed_at: float


def appearance_descriptor(frame, bounding_box: list[int]) -> Any | None:
    """Build a compact color descriptor without introducing another model."""
    if not hasattr(frame, "shape") or len(frame.shape) < 2:
        return None
    height, width = frame.shape[:2]
    x1, y1, x2, y2 = bounding_box
    horizontal_inset = round((x2 - x1) * 0.12)
    vertical_inset = round((y2 - y1) * 0.12)
    x1 += horizontal_inset
    x2 -= horizontal_inset
    y1 += vertical_inset
    y2 -= vertical_inset
    x1 = min(width, max(0, x1))
    x2 = min(width, max(0, x2))
    y1 = min(height, max(0, y1))
    y2 = min(height, max(0, y2))
    if x2 <= x1 or y2 <= y1:
        return None

    crop = frame[y1:y2, x1:x2]
    if crop.size == 0:
        return None
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv], [0, 1], None, [18, 16], [0, 180, 0, 256])
    cv2.normalize(histogram, histogram)
    return histogram


def appearance_similarity(first: Any | None, second: Any | None) -> float | None:
    if first is None or second is None:
        return None
    correlation = float(cv2.compareHist(first, second, cv2.HISTCMP_CORREL))
    return min(1.0, max(0.0, correlation))


def multi_sample_similarity(descriptor: Any | None, samples: tuple[Any, ...] | deque[Any]) -> float | None:
    similarities = [
        similarity
        for sample in samples
        if (similarity := appearance_similarity(descriptor, sample)) is not None
    ]
    if not similarities:
        return None
    strongest = sorted(similarities, reverse=True)[:3]
    return sum(strongest) / len(strongest)


def bounding_box_aspect_ratio(bounding_box: list[int]) -> float:
    x1, y1, x2, y2 = bounding_box
    return max(1, x2 - x1) / max(1, y2 - y1)


def shape_similarity(aspect_ratio: float, samples: tuple[float, ...] | deque[float]) -> float:
    if not samples:
        return 0.0
    differences = [abs(math.log(max(aspect_ratio, 0.01) / max(sample, 0.01))) for sample in samples]
    return max(0.0, 1.0 - (min(differences) / math.log(3)))


class GlobalVehicleRegistry:
    """Associates camera-local ByteTrack IDs with session-wide vehicle IDs."""

    def __init__(
        self,
        local_grace_seconds: float = 6.0,
        cross_camera_seconds: float = 60.0,
        match_threshold: float = 0.55,
        ambiguity_margin: float = 0.08,
        minimum_sample_confidence: float = 0.45,
        maximum_samples: int = 8,
    ):
        self.local_grace_seconds = max(0.1, local_grace_seconds)
        self.cross_camera_seconds = max(self.local_grace_seconds, cross_camera_seconds)
        self.match_threshold = min(1.0, max(0.0, match_threshold))
        self.ambiguity_margin = min(1.0, max(0.0, ambiguity_margin))
        self.minimum_sample_confidence = min(1.0, max(0.0, minimum_sample_confidence))
        self.maximum_samples = max(1, maximum_samples)
        self._lock = threading.RLock()
        self._next_vehicle_number = 1
        self._bindings: dict[tuple[int, int], LocalBinding] = {}
        self._observations: dict[tuple[str, int], VehicleObservation] = {}
        self._departures: dict[str, DepartureCandidate] = {}
        self._confirmed_handoffs: set[tuple[str, int]] = set()

    def reset(self) -> None:
        """Clear all session identities so the next vehicle starts a fresh test."""
        with self._lock:
            self._next_vehicle_number = 1
            self._bindings.clear()
            self._observations.clear()
            self._departures.clear()
            self._confirmed_handoffs.clear()

    def assign(self, camera_id: int, detections: list[dict], frame, now: float | None = None) -> None:
        observed_at = time.monotonic() if now is None else now
        frame_diagonal = self._frame_diagonal(frame)
        prepared = [
            (
                detection,
                appearance_descriptor(frame, detection["boundingBox"]),
            )
            for detection in detections
        ]

        with self._lock:
            self._prune(observed_at)
            active_keys = {(camera_id, detection["trackId"]) for detection in detections}
            assigned_vehicle_ids = {
                binding.vehicle_id
                for local_key, binding in self._bindings.items()
                if local_key in active_keys and observed_at - binding.last_seen_at <= self.local_grace_seconds
            }

            for detection, descriptor in prepared:
                track_id = detection["trackId"]
                local_key = (camera_id, track_id)
                vehicle_id = self._bound_vehicle(local_key, observed_at)
                in_traffic_zone = detection.get("inTrafficZone", True)
                traffic_role = self._restore_last_traffic_role(
                    camera_id,
                    vehicle_id,
                    detection,
                )

                # ByteTrack can issue a replacement temporary ID after a short
                # detection gap. Recover the same-camera GID and its saved role
                # so a stationary waiting vehicle remains eligible next cycle.
                if vehicle_id is None and in_traffic_zone and traffic_role is None:
                    candidate_id = self._same_camera_match(
                        camera_id,
                        detection,
                        descriptor,
                        frame_diagonal,
                        observed_at,
                        active_keys,
                        assigned_vehicle_ids,
                    )
                    candidate_role = self._saved_traffic_role(camera_id, candidate_id)
                    if candidate_role is not None:
                        vehicle_id = candidate_id
                        detection["trafficRole"] = candidate_role
                        traffic_role = candidate_role

                is_outgoing = in_traffic_zone and traffic_role == "OUTGOING"
                identity_eligible = in_traffic_zone and traffic_role in (
                    "INCOMING",
                    "OUTGOING",
                )
                if vehicle_id is None and not identity_eligible and not detection.get("redTransition"):
                    detection["vehicleId"] = None
                    continue

                if is_outgoing and (vehicle_id, camera_id) not in self._confirmed_handoffs:
                    previous_vehicle_id = vehicle_id
                    handoff_vehicle_id = self._same_camera_match(
                        camera_id,
                        detection,
                        descriptor,
                        frame_diagonal,
                        observed_at,
                        active_keys,
                        assigned_vehicle_ids,
                        confirmed_handoffs_only=True,
                    )
                    if handoff_vehicle_id is None:
                        handoff_vehicle_id = self._cross_camera_match(
                            camera_id,
                            detection,
                            descriptor,
                            observed_at,
                            assigned_vehicle_ids,
                        )
                    if handoff_vehicle_id is None:
                        detection.pop("globalIdPendingReason", None)
                    else:
                        vehicle_id = handoff_vehicle_id
                        self._confirmed_handoffs.add((vehicle_id, camera_id))
                        if previous_vehicle_id is not None and previous_vehicle_id != vehicle_id:
                            self._observations.pop((previous_vehicle_id, camera_id), None)
                            assigned_vehicle_ids.discard(previous_vehicle_id)

                if vehicle_id is None:
                    vehicle_id = self._same_camera_match(
                        camera_id,
                        detection,
                        descriptor,
                        frame_diagonal,
                        observed_at,
                        active_keys,
                        assigned_vehicle_ids,
                    )
                if vehicle_id is None:
                    vehicle_id = self._new_vehicle_id()

                self._bindings[local_key] = LocalBinding(vehicle_id, observed_at)
                observation_key = (vehicle_id, camera_id)
                if identity_eligible or observation_key not in self._observations:
                    self._update_observation(
                        observation_key,
                        detection,
                        descriptor,
                        frame_diagonal,
                        observed_at,
                    )
                detection["vehicleId"] = vehicle_id
                assigned_vehicle_ids.add(vehicle_id)

                if detection.get("redTransition"):
                    observation = self._observations[observation_key]
                    self._departures[vehicle_id] = DepartureCandidate(
                        vehicle_id=vehicle_id,
                        origin_camera_id=camera_id,
                        traffic_role=observation.traffic_role,
                        descriptors=tuple(observation.descriptors),
                        aspect_ratios=tuple(observation.aspect_ratios),
                        confidences=tuple(observation.confidences),
                        departed_at=observed_at,
                    )

    def _update_observation(
        self,
        observation_key: tuple[str, int],
        detection: dict,
        descriptor: Any | None,
        frame_diagonal: float,
        observed_at: float,
    ) -> None:
        observation = self._observations.get(observation_key)
        if observation is None:
            observation = VehicleObservation(
                track_id=detection["trackId"],
                vehicle_class=detection["class"],
                traffic_role=detection.get("trafficRole"),
                center=tuple(detection["centerPoint"]),
                descriptors=deque(maxlen=self.maximum_samples),
                aspect_ratios=deque(maxlen=self.maximum_samples),
                confidences=deque(maxlen=self.maximum_samples),
                frame_diagonal=frame_diagonal,
                seen_at=observed_at,
            )
            self._observations[observation_key] = observation

        confidence = float(detection.get("confidence", 0.5))
        if descriptor is not None and (confidence >= self.minimum_sample_confidence or not observation.descriptors):
            observation.descriptors.append(descriptor)
            observation.aspect_ratios.append(bounding_box_aspect_ratio(detection["boundingBox"]))
            observation.confidences.append(confidence)
        observation.track_id = detection["trackId"]
        observation.vehicle_class = detection["class"]
        traffic_role = detection.get("trafficRole")
        if traffic_role in ("INCOMING", "OUTGOING"):
            observation.traffic_role = traffic_role
        observation.center = tuple(detection["centerPoint"])
        observation.frame_diagonal = frame_diagonal
        observation.seen_at = observed_at

    def _restore_last_traffic_role(
        self,
        camera_id: int,
        vehicle_id: str | None,
        detection: dict,
    ) -> str | None:
        traffic_role = detection.get("trafficRole")
        if traffic_role in ("INCOMING", "OUTGOING"):
            return traffic_role
        if not detection.get("inTrafficZone", True):
            return None

        saved_role = self._saved_traffic_role(camera_id, vehicle_id)
        if saved_role is not None:
            detection["trafficRole"] = saved_role
        return saved_role

    def _saved_traffic_role(self, camera_id: int, vehicle_id: str | None) -> str | None:
        if vehicle_id is None:
            return None
        observation = self._observations.get((vehicle_id, camera_id))
        if observation is None or observation.traffic_role not in ("INCOMING", "OUTGOING"):
            return None
        return observation.traffic_role

    def _bound_vehicle(self, local_key: tuple[int, int], observed_at: float) -> str | None:
        binding = self._bindings.get(local_key)
        if binding is None:
            return None
        if observed_at - binding.last_seen_at <= self.local_grace_seconds:
            return binding.vehicle_id
        self._bindings.pop(local_key, None)
        return None

    def _same_camera_match(
        self,
        camera_id: int,
        detection: dict,
        descriptor: Any | None,
        frame_diagonal: float,
        observed_at: float,
        active_keys: set[tuple[int, int]],
        assigned_vehicle_ids: set[str],
        confirmed_handoffs_only: bool = False,
    ) -> str | None:
        matches: list[tuple[float, str]] = []
        center = tuple(detection["centerPoint"])

        for (vehicle_id, observation_camera_id), observation in self._observations.items():
            if observation_camera_id != camera_id or vehicle_id in assigned_vehicle_ids:
                continue
            if confirmed_handoffs_only and (vehicle_id, camera_id) not in self._confirmed_handoffs:
                continue
            if (camera_id, observation.track_id) in active_keys:
                continue
            age = observed_at - observation.seen_at
            if age < 0 or age > self.local_grace_seconds:
                continue
            if observation.vehicle_class != detection["class"] and not confirmed_handoffs_only:
                continue

            similarity = multi_sample_similarity(descriptor, observation.descriptors)
            if similarity is None:
                continue
            if frame_diagonal > 1.0 and observation.frame_diagonal > 1.0:
                diagonal = max(frame_diagonal, observation.frame_diagonal)
                distance = math.dist(center, observation.center) / diagonal
                if distance > 0.3:
                    continue
                position_score = 1.0 - (distance / 0.3)
            else:
                # Synthetic frames used by offline callers may not expose image
                # dimensions, so appearance and class carry the match instead.
                position_score = 0.5
            shape_score = shape_similarity(
                bounding_box_aspect_ratio(detection["boundingBox"]),
                observation.aspect_ratios,
            )
            confidence_score = min(
                float(detection.get("confidence", 0.5)),
                sum(observation.confidences) / len(observation.confidences) if observation.confidences else 0.5,
            )
            score = (
                (similarity * 0.6)
                + (position_score * 0.2)
                + (shape_score * 0.12)
                + (confidence_score * 0.08)
            )
            if score < LOCAL_MATCH_THRESHOLD:
                continue
            matches.append((score, vehicle_id))

        return self._choose_unambiguous(matches)

    def _cross_camera_match(
        self,
        camera_id: int,
        detection: dict,
        descriptor: Any | None,
        observed_at: float,
        assigned_vehicle_ids: set[str],
    ) -> str | None:
        if detection.get("trafficRole") != "OUTGOING":
            return None
        return self._confirmed_departure_match(
            camera_id,
            detection,
            descriptor,
            observed_at,
            assigned_vehicle_ids,
        )

    def _confirmed_departure_match(
        self,
        camera_id: int,
        detection: dict,
        descriptor: Any | None,
        observed_at: float,
        assigned_vehicle_ids: set[str],
    ) -> str | None:
        candidates: list[tuple[float | None, str]] = []

        for vehicle_id, departure in self._departures.items():
            if departure.origin_camera_id == camera_id or vehicle_id in assigned_vehicle_ids:
                continue
            age = observed_at - departure.departed_at
            if age < 0 or age > self.cross_camera_seconds:
                continue
            if departure.traffic_role != "INCOMING":
                continue

            score = self._cross_candidate_score(
                detection,
                descriptor,
                departure.descriptors,
                departure.aspect_ratios,
                departure.confidences,
                age,
            )
            candidates.append((score, vehicle_id))

        if not candidates:
            detection["globalIdPendingReason"] = "NO_CONFIRMED_DEPARTURE"
            return None

        if len(candidates) == 1:
            score, vehicle_id = candidates[0]
            detection["globalIdMatchMode"] = (
                "APPEARANCE" if score is not None and score >= self.match_threshold else "ROUTE"
            )
        else:
            matches = [
                (float(score), candidate_id)
                for score, candidate_id in candidates
                if score is not None and score >= self.match_threshold
            ]
            vehicle_id = self._choose_unambiguous(matches)
            if vehicle_id is None:
                detection["globalIdPendingReason"] = "AMBIGUOUS_OR_LOW_MATCH"
                return None
            score = next(match_score for match_score, candidate_id in matches if candidate_id == vehicle_id)
            detection["globalIdMatchMode"] = "APPEARANCE"

        detection["globalIdMatchConfidence"] = round(score, 3) if score is not None else None
        self._departures.pop(vehicle_id, None)
        return vehicle_id

    def _cross_candidate_score(
        self,
        detection: dict,
        descriptor: Any | None,
        descriptors: tuple[Any, ...],
        aspect_ratios: tuple[float, ...],
        confidences: tuple[float, ...],
        age: float,
    ) -> float | None:
        similarity = multi_sample_similarity(descriptor, descriptors)
        if similarity is None:
            return None
        shape_score = shape_similarity(
            bounding_box_aspect_ratio(detection["boundingBox"]),
            aspect_ratios,
        )
        confidence_score = min(
            float(detection.get("confidence", 0.5)),
            sum(confidences) / len(confidences) if confidences else 0.5,
        )
        timing_score = max(0.0, 1.0 - (age / self.cross_camera_seconds))
        score = (
            (similarity * 0.7)
            + (shape_score * 0.12)
            + (confidence_score * 0.08)
            + (timing_score * 0.1)
            + 0.05
        )
        return min(1.0, score)

    def _choose_unambiguous(self, matches: list[tuple[float, str]]) -> str | None:
        if not matches:
            return None
        ranked = sorted(matches, reverse=True)
        if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < self.ambiguity_margin:
            return None
        return ranked[0][1]

    def _new_vehicle_id(self) -> str:
        vehicle_id = f"VEH-{self._next_vehicle_number:04d}"
        self._next_vehicle_number += 1
        return vehicle_id

    def _prune(self, observed_at: float) -> None:
        stale_bindings = [
            local_key
            for local_key, binding in self._bindings.items()
            if observed_at - binding.last_seen_at > self.local_grace_seconds
        ]
        for local_key in stale_bindings:
            self._bindings.pop(local_key, None)

        stale_observations = [
            key
            for key, observation in self._observations.items()
            if observed_at - observation.seen_at > self.cross_camera_seconds
        ]
        for key in stale_observations:
            self._observations.pop(key, None)

        stale_departures = [
            vehicle_id
            for vehicle_id, departure in self._departures.items()
            if observed_at - departure.departed_at > self.cross_camera_seconds
        ]
        for vehicle_id in stale_departures:
            self._departures.pop(vehicle_id, None)

    @staticmethod
    def _frame_diagonal(frame) -> float:
        if not hasattr(frame, "shape") or len(frame.shape) < 2:
            return 1.0
        height, width = frame.shape[:2]
        return math.hypot(width, height)
