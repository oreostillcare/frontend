from collections import Counter, defaultdict, deque
from pathlib import Path
import cv2
from config import Settings
from tracking import TrackState

COCO_VEHICLES = {"bicycle", "car", "motorcycle", "truck", "bus"}
CUSTOM_VEHICLES = {
    "ambulance", "bicycle", "bus", "ebike", "etrike", "firetruck", "jeepney",
    "motorcycle", "multicab", "pickup", "police", "sedan", "suv", "tricycle", "truck", "van",
}
CUSTOM_ONLY_VEHICLES = CUSTOM_VEHICLES - COCO_VEHICLES
COCO_TRACK_ID_OFFSET = 1_000_000
CLASS_LOCK_OBSERVATIONS = 5
CLASS_LOCK_MIN_VOTES = 3


def box_iou(first: list[int], second: list[int]) -> float:
    left = max(first[0], second[0]); top = max(first[1], second[1])
    right = min(first[2], second[2]); bottom = min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    first_area = max(0, first[2] - first[0]) * max(0, first[3] - first[1])
    second_area = max(0, second[2] - second[0]) * max(0, second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / union if union else 0.0

class Detector:
    def __init__(
        self,
        config: Settings,
        line: tuple[int, int, int, int],
        use_coco_fallback: bool = True,
        use_custom_model: bool = True,
    ):
        self.config = config; self.track_state = TrackState(line, config.line_counting); self.model = None
        self.use_coco_fallback = use_coco_fallback
        self.use_custom_model = use_custom_model
        self.coco_model = None; self.model_type = "unavailable"; self.weights = None; self.load_error = None
        self.allowed_class_ids = []; self.coco_class_ids = []
        self.class_history: dict[int, deque[str]] = defaultdict(
            lambda: deque(maxlen=CLASS_LOCK_OBSERVATIONS)
        )
        self.locked_classes: dict[int, str] = {}
        self.class_last_seen: dict[int, int] = {}
        self.frame_index = 0
        try:
            from ultralytics import YOLO
            custom = config.custom_yolo_model
            use_custom = self.use_custom_model and custom.exists()
            candidate = str(custom) if use_custom else config.yolo_model
            self.model = YOLO(candidate); self.model_type = "custom" if use_custom else "coco"; self.weights = Path(candidate).name
            allowed = (
                CUSTOM_ONLY_VEHICLES
                if self.model_type == "custom" and self.use_coco_fallback
                else CUSTOM_VEHICLES
                if self.model_type == "custom"
                else COCO_VEHICLES
            )
            self.allowed_class_ids = [int(class_id) for class_id, name in self.model.names.items() if str(name).lower() in allowed]
            if self.model_type == "custom" and self.use_coco_fallback:
                self.coco_model = YOLO(config.yolo_model)
                self.coco_class_ids = [int(class_id) for class_id, name in self.coco_model.names.items() if str(name).lower() in COCO_VEHICLES]
        except Exception as exc: self.load_error = str(exc)

    def tracked_detections(self, model, frame, class_ids: list[int], allowed: set[str], track_offset: int = 0, confidence: float | None = None):
        results = model.track(
            frame,
            persist=True,
            tracker="bytetrack.yaml",
            classes=class_ids,
            conf=self.config.confidence if confidence is None else confidence,
            imgsz=self.config.image_size,
            verbose=False,
        )
        detections = []
        for result in results:
            boxes = result.boxes
            if boxes is None or boxes.id is None: continue
            for xyxy, track_id, cls_id, confidence in zip(boxes.xyxy.cpu().tolist(), boxes.id.int().cpu().tolist(), boxes.cls.int().cpu().tolist(), boxes.conf.cpu().tolist()):
                name = str(model.names[cls_id]).lower()
                if name not in allowed: continue
                x1, y1, x2, y2 = map(int, xyxy); center = ((x1 + x2) // 2, (y1 + y2) // 2)
                detections.append({"trackId": track_id + track_offset, "class": name, "confidence": round(float(confidence), 3), "boundingBox": [x1, y1, x2, y2], "centerPoint": list(center)})
        return detections

    def stabilize_classes(self, detections: list[dict]) -> None:
        """Vote briefly, then keep one class for the lifetime of each ByteTrack ID."""
        for item in detections:
            track_id = item["trackId"]
            self.class_last_seen[track_id] = self.frame_index
            if track_id in self.locked_classes:
                item["class"] = self.locked_classes[track_id]
                continue

            history = self.class_history[track_id]
            history.append(item["class"])
            winner, votes = Counter(history).most_common(1)[0]
            # Show the running majority immediately, but only make it permanent
            # after several observations so one bad first frame cannot lock it.
            item["class"] = winner
            if len(history) >= CLASS_LOCK_OBSERVATIONS and votes >= CLASS_LOCK_MIN_VOTES:
                self.locked_classes[track_id] = winner

        stale = [
            track_id for track_id, seen in self.class_last_seen.items()
            if self.frame_index - seen > 150
        ]
        for track_id in stale:
            self.class_history.pop(track_id, None)
            self.locked_classes.pop(track_id, None)
            self.class_last_seen.pop(track_id, None)

    def process(self, frame):
        if self.model is None: return frame, []
        self.frame_index += 1
        allowed = (
            CUSTOM_ONLY_VEHICLES
            if self.model_type == "custom" and self.use_coco_fallback
            else CUSTOM_VEHICLES
            if self.model_type == "custom"
            else COCO_VEHICLES
        )
        custom_confidence = (
            min(self.config.confidence, 0.12)
            if self.model_type == "custom" and self.use_coco_fallback
            else self.config.confidence
        )
        detections = self.tracked_detections(
            self.model, frame, self.allowed_class_ids, allowed, confidence=custom_confidence
        )
        if self.coco_model is not None:
            coco_confidence = max(self.config.confidence, 0.25)
            coco = self.tracked_detections(
                self.coco_model, frame, self.coco_class_ids, COCO_VEHICLES,
                COCO_TRACK_ID_OFFSET, coco_confidence,
            )
            detections.extend(
                item for item in coco
                if not any(box_iou(item["boundingBox"], custom["boundingBox"]) >= 0.35 for custom in detections)
            )
        self.stabilize_classes(detections)
        for item in detections:
            x1, y1, x2, y2 = item["boundingBox"]; name = item["class"]; track_id = item["trackId"]; confidence = item["confidence"]
            color = (255, 120, 40) if track_id < COCO_TRACK_ID_OFFSET else (70, 180, 90)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, f"{name} #{track_id % COCO_TRACK_ID_OFFSET} {confidence:.2f}", (x1, max(18, y1 - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (255, 255, 255), 1, cv2.LINE_AA)
        self.track_state.update(detections); x1, y1, x2, y2 = self.track_state.line
        if self.config.line_counting:
            cv2.line(frame, (x1, y1), (x2, y2), (0, 190, 255), 2)
        overlay = f"VISIBLE: {len({item['trackId'] for item in detections})}"
        if self.config.line_counting:
            overlay += f"  PASSED: {self.track_state.passed}"
        cv2.putText(frame, overlay, (12, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255, 255, 255), 2, cv2.LINE_AA)
        return frame, detections
