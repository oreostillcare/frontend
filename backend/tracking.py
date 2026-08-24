from collections import defaultdict, deque
from counting import segments_intersect

class TrackState:
    def __init__(self, line: tuple[int, int, int, int], enabled: bool, max_history: int = 30):
        self.line = line; self.enabled = enabled; self.max_history = max_history
        self.history: dict[int, deque[tuple[int, int]]] = defaultdict(lambda: deque(maxlen=max_history))
        self.last_seen: dict[int, int] = {}; self.counted_ids: set[int] = set(); self.passed = 0; self.frame_index = 0

    def update(self, detections: list[dict]) -> None:
        self.frame_index += 1; a = (self.line[0], self.line[1]); b = (self.line[2], self.line[3])
        for detection in detections:
            track_id = detection["trackId"]; center = tuple(detection["centerPoint"]); points = self.history[track_id]
            if self.enabled and points and track_id not in self.counted_ids and segments_intersect(points[-1], center, a, b):
                self.counted_ids.add(track_id); self.passed += 1
            points.append(center); self.last_seen[track_id] = self.frame_index
        stale = [track_id for track_id, seen in self.last_seen.items() if self.frame_index - seen > 150]
        for track_id in stale: self.history.pop(track_id, None); self.last_seen.pop(track_id, None)
