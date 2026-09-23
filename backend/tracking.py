from collections import defaultdict, deque
from dataclasses import dataclass

from counting import segments_intersect

INCOMING = "INCOMING"
OUTGOING = "OUTGOING"
LEFT_TO_RIGHT = "LEFT_TO_RIGHT"
RIGHT_TO_LEFT = "RIGHT_TO_LEFT"


@dataclass(frozen=True)
class TrafficRegion:
    green_y: int
    red_y: int
    blue_x: int | None = None
    blue_deadband: int = 4
    motion_deadband: int = 4
    motion_window: int = 5
    reversal_distance: int = 24
    outgoing_route_completion_percent: float = 50.0

    def contains(self, center: tuple[int, int]) -> bool:
        return self.green_y <= center[1] <= self.red_y


class TrackState:
    def __init__(self, line: tuple[int, int, int, int], enabled: bool, max_history: int = 30):
        self.line = line
        self.enabled = enabled
        self.max_history = max_history
        self.history: dict[int, deque[tuple[int, int]]] = defaultdict(lambda: deque(maxlen=max_history))
        self.last_seen: dict[int, int] = {}
        self.counted_ids: set[int] = set()
        self.green_crossed_ids: set[int] = set()
        self.outgoing_route_completed_ids: set[int] = set()
        self.stable_roles: dict[int, str] = {}
        self.role_extreme_y: dict[int, int] = {}
        self.passed = 0
        self.frame_index = 0

    def update(self, detections: list[dict], region: TrafficRegion | None = None) -> None:
        self.frame_index += 1
        for detection in detections:
            track_id = detection["trackId"]
            center = tuple(detection["centerPoint"])
            points = self.history[track_id]
            previous = points[-1] if points else None

            if region is None:
                self._update_legacy_crossing(track_id, previous, center)
            else:
                self._update_region(detection, track_id, previous, center, region)

            points.append(center)
            self.last_seen[track_id] = self.frame_index

        stale = [track_id for track_id, seen in self.last_seen.items() if self.frame_index - seen > 150]
        for track_id in stale:
            self._forget(track_id)

    def _update_legacy_crossing(
        self,
        track_id: int,
        previous: tuple[int, int] | None,
        center: tuple[int, int],
    ) -> None:
        if not self.enabled or previous is None or track_id in self.counted_ids:
            return
        start = (self.line[0], self.line[1])
        end = (self.line[2], self.line[3])
        if segments_intersect(previous, center, start, end):
            self.counted_ids.add(track_id)
            self.passed += 1

    def _update_region(
        self,
        detection: dict,
        track_id: int,
        previous: tuple[int, int] | None,
        center: tuple[int, int],
        region: TrafficRegion,
    ) -> None:
        in_region = region.contains(center)
        role = self._update_motion_role(track_id, center, region) if in_region else None
        green_transition = False
        red_transition = False
        red_line_touched = False
        red_entry_transition = False
        green_exit_transition = False
        outgoing_route_transition = False
        outgoing_confirmation_y = round(
            region.red_y
            + (region.green_y - region.red_y)
            * min(100.0, max(0.0, region.outgoing_route_completion_percent))
            / 100.0
        )

        if previous is not None:
            crossed_green = previous[1] < region.green_y <= center[1]
            if crossed_green:
                self.green_crossed_ids.add(track_id)
                green_transition = True

            crossed_red = previous[1] < region.red_y <= center[1]
            bounding_box = detection.get("boundingBox")
            touches_red = (
                bounding_box is not None
                and bounding_box[1] <= region.red_y <= bounding_box[3]
            )
            reached_red = crossed_red or touches_red
            red_line_touched = reached_red
            if reached_red and track_id in self.green_crossed_ids and track_id not in self.counted_ids:
                self.counted_ids.add(track_id)
                red_transition = True
                if self.enabled:
                    self.passed += 1

            red_entry_transition = previous[1] > region.red_y >= center[1]
            green_exit_transition = previous[1] > region.green_y >= center[1]
            stable_role = self.stable_roles.get(track_id)
            if (
                stable_role == OUTGOING
                and center[1] <= outgoing_confirmation_y
                and track_id not in self.outgoing_route_completed_ids
            ):
                self.outgoing_route_completed_ids.add(track_id)
                outgoing_route_transition = True

        if self.stable_roles.get(track_id) == INCOMING:
            self.outgoing_route_completed_ids.discard(track_id)

        detection.update(
            {
                "inTrafficZone": in_region,
                "trafficRole": role,
                "greenCrossed": track_id in self.green_crossed_ids,
                "redCrossed": track_id in self.counted_ids,
                "blueCrossed": False,
                "blueDirection": None,
                "blueTransition": None,
                "greenTransition": green_transition,
                "redTransition": red_transition,
                "redLineTouched": red_line_touched,
                "redEntryTransition": red_entry_transition,
                "greenExitTransition": green_exit_transition,
                "outgoingRouteStarted": self.stable_roles.get(track_id) == OUTGOING,
                "outgoingRouteComplete": track_id in self.outgoing_route_completed_ids,
                "outgoingRouteTransition": outgoing_route_transition,
                "outgoingConfirmationY": outgoing_confirmation_y,
            }
        )

    def _update_motion_role(
        self,
        track_id: int,
        center: tuple[int, int],
        region: TrafficRegion,
    ) -> str | None:
        points = self.history[track_id]
        current_role = self.stable_roles.get(track_id)
        if not points:
            return current_role

        lookback = min(len(points), max(1, region.motion_window))
        reference_y = points[-lookback][1]
        vertical_delta = center[1] - reference_y
        deadband = max(1, region.motion_deadband)
        observed_role = None
        if vertical_delta >= deadband:
            observed_role = INCOMING
        elif vertical_delta <= -deadband:
            observed_role = OUTGOING

        if current_role is None:
            if observed_role is not None:
                self.stable_roles[track_id] = observed_role
                self.role_extreme_y[track_id] = center[1]
            return self.stable_roles.get(track_id)

        extreme_y = self.role_extreme_y.get(track_id, center[1])
        if current_role == INCOMING:
            extreme_y = max(extreme_y, center[1])
            reverse_distance = extreme_y - center[1]
        else:
            extreme_y = min(extreme_y, center[1])
            reverse_distance = center[1] - extreme_y
        self.role_extreme_y[track_id] = extreme_y

        reversal_distance = max(deadband + 1, region.reversal_distance)
        if observed_role is not None and observed_role != current_role and reverse_distance >= reversal_distance:
            self.stable_roles[track_id] = observed_role
            self.role_extreme_y[track_id] = center[1]

        return self.stable_roles.get(track_id)

    def _forget(self, track_id: int) -> None:
        self.history.pop(track_id, None)
        self.last_seen.pop(track_id, None)
        self.counted_ids.discard(track_id)
        self.green_crossed_ids.discard(track_id)
        self.outgoing_route_completed_ids.discard(track_id)
        self.stable_roles.pop(track_id, None)
        self.role_extreme_y.pop(track_id, None)
