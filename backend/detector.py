import copy
import threading
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from typing import Any

import cv2

from config import Settings
from tracking import TrackState

LOCAL_VEHICLES = {"tricycle", "jeepney", "ebike"}
COCO_VEHICLES = {"car", "motorcycle", "truck", "bicycle", "bus"}
VEHICLE_CLASSES = LOCAL_VEHICLES | COCO_VEHICLES
COCO_TRACK_ID_OFFSET = 1_000_000
CLASS_LOCK_OBSERVATIONS = 5
CLASS_LOCK_MIN_VOTES = 3


@dataclass(frozen=True)
class ModelSession:
    model: Any
    inference_lock: Any
    class_ids: list[int]


class ModelPool:
    """Loads each checkpoint once and creates tracker-isolated model sessions."""

    def __init__(self, config: Settings, load_local: bool = True, load_coco: bool = True):
        self.paths = {
            "local": config.local_yolo_model,
            "coco": config.coco_yolo_model,
        }
        self.allowed = {
            "local": LOCAL_VEHICLES,
            "coco": COCO_VEHICLES,
        }
        self.models: dict[str, Any | None] = {"local": None, "coco": None}
        self.class_ids: dict[str, list[int]] = {"local": [], "coco": []}
        self.errors: dict[str, str] = {}
        self.locks = {"local": threading.RLock(), "coco": threading.RLock()}

        requested = {"local": load_local, "coco": load_coco}
        try:
            from ultralytics import YOLO
        except Exception as exc:
            for name, enabled in requested.items():
                if enabled:
                    self.errors[name] = str(exc)
            return

        for name, enabled in requested.items():
            if enabled:
                self._load_checkpoint(YOLO, name)

    def _load_checkpoint(self, yolo_class, name: str) -> None:
        path = self.paths[name]
        try:
            if not path.is_file():
                raise FileNotFoundError(f"Required YOLO model not found: {path}")
            model = yolo_class(str(path))
            names = {int(class_id): str(class_name).lower() for class_id, class_name in model.names.items()}
            missing = self.allowed[name] - set(names.values())
            if missing:
                raise ValueError(f"{path.name} is missing required classes: {sorted(missing)}")
            self.models[name] = model
            self.class_ids[name] = [class_id for class_id, class_name in names.items() if class_name in self.allowed[name]]
        except Exception as exc:
            self.models[name] = None
            self.class_ids[name] = []
            self.errors[name] = str(exc)

    @staticmethod
    def _tracker_session(template):
        # Each wrapper receives its own predictor and ByteTrack callbacks while
        # retaining the template's shared torch model/weights.
        session = copy.copy(template)
        session.predictor = None
        session.callbacks = {event: list(callbacks) for event, callbacks in template.callbacks.items()}
        session.overrides = dict(template.overrides)
        return session

    def create_session(self, name: str) -> ModelSession | None:
        template = self.models[name]
        if template is None:
            return None
        return ModelSession(
            model=self._tracker_session(template),
            inference_lock=self.locks[name],
            class_ids=list(self.class_ids[name]),
        )

    @property
    def online(self) -> bool:
        return all(self.models[name] is not None for name in ("local", "coco"))

    def status(self) -> dict:
        return {
            name: {
                "weights": self.paths[name].name,
                "online": self.models[name] is not None,
                "error": self.errors.get(name),
            }
            for name in ("local", "coco")
        }


def box_iou(first: list[int], second: list[int]) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
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
        model_pool: ModelPool | None = None,
    ):
        self.config = config
        self.track_state = TrackState(line, config.line_counting)
        self.use_coco_fallback = use_coco_fallback
        self.use_custom_model = use_custom_model
        self.class_history: dict[int, deque[str]] = defaultdict(lambda: deque(maxlen=CLASS_LOCK_OBSERVATIONS))
        self.locked_classes: dict[int, str] = {}
        self.class_last_seen: dict[int, int] = {}
        self.frame_index = 0

        load_coco = use_coco_fallback or not use_custom_model
        self.model_pool = model_pool or ModelPool(config, load_local=use_custom_model, load_coco=load_coco)
        self.local_session = self.model_pool.create_session("local") if use_custom_model else None
        self.coco_session = self.model_pool.create_session("coco") if load_coco else None

        # Keep the legacy attributes available to status and offline-processing callers.
        self.model = self.local_session.model if self.local_session else None
        self.coco_model = self.coco_session.model if self.coco_session else None
        self.allowed_class_ids = self.local_session.class_ids if self.local_session else []
        self.coco_class_ids = self.coco_session.class_ids if self.coco_session else []
        self.model_type = "dual" if self.model is not None and self.coco_model is not None else "partial"
        if self.model is None and self.coco_model is None:
            self.model_type = "unavailable"
        active_weights = []
        if use_custom_model:
            active_weights.append(self.model_pool.paths["local"].name)
        if load_coco:
            active_weights.append(self.model_pool.paths["coco"].name)
        self.weights = " + ".join(active_weights) if active_weights else None
        self.load_error = "; ".join(self.model_pool.errors.values()) or None

    @property
    def model_online(self) -> bool:
        required = []
        if self.use_custom_model:
            required.append(self.local_session is not None)
        if self.use_coco_fallback or not self.use_custom_model:
            required.append(self.coco_session is not None)
        return bool(required) and all(required)

    def tracked_detections(
        self,
        session: ModelSession,
        frame,
        allowed: set[str],
        track_offset: int = 0,
        confidence: float | None = None,
    ) -> list[dict]:
        with session.inference_lock:
            results = session.model.track(
                frame,
                persist=True,
                tracker="bytetrack.yaml",
                classes=session.class_ids,
                conf=self.config.confidence if confidence is None else confidence,
                imgsz=self.config.image_size,
                verbose=False,
            )
        detections = []
        for result in results:
            boxes = result.boxes
            if boxes is None or boxes.id is None:
                continue
            values = zip(
                boxes.xyxy.cpu().tolist(),
                boxes.id.int().cpu().tolist(),
                boxes.cls.int().cpu().tolist(),
                boxes.conf.cpu().tolist(),
            )
            for xyxy, track_id, cls_id, detection_confidence in values:
                name = str(session.model.names[cls_id]).lower()
                if name not in allowed:
                    continue
                x1, y1, x2, y2 = map(int, xyxy)
                center = ((x1 + x2) // 2, (y1 + y2) // 2)
                detections.append(
                    {
                        "trackId": track_id + track_offset,
                        "class": name,
                        "confidence": round(float(detection_confidence), 3),
                        "boundingBox": [x1, y1, x2, y2],
                        "centerPoint": list(center),
                    }
                )
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
            item["class"] = winner
            if len(history) >= CLASS_LOCK_OBSERVATIONS and votes >= CLASS_LOCK_MIN_VOTES:
                self.locked_classes[track_id] = winner

        stale = [
            track_id
            for track_id, seen in self.class_last_seen.items()
            if self.frame_index - seen > 150
        ]
        for track_id in stale:
            self.class_history.pop(track_id, None)
            self.locked_classes.pop(track_id, None)
            self.class_last_seen.pop(track_id, None)

    def process(self, frame):
        if self.local_session is None and self.coco_session is None:
            return frame, []
        self.frame_index += 1

        local_detections = (
            self.tracked_detections(self.local_session, frame, LOCAL_VEHICLES)
            if self.local_session is not None
            else []
        )
        detections = list(local_detections)
        if self.coco_session is not None:
            coco_detections = self.tracked_detections(
                self.coco_session,
                frame,
                COCO_VEHICLES,
                COCO_TRACK_ID_OFFSET,
                max(self.config.confidence, 0.25),
            )
            detections.extend(
                item
                for item in coco_detections
                if not any(
                    box_iou(item["boundingBox"], local["boundingBox"]) >= 0.35
                    for local in local_detections
                )
            )

        self.stabilize_classes(detections)
        for item in detections:
            x1, y1, x2, y2 = item["boundingBox"]
            name = item["class"]
            track_id = item["trackId"]
            confidence = item["confidence"]
            color = (255, 120, 40) if track_id < COCO_TRACK_ID_OFFSET else (70, 180, 90)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(
                frame,
                f"{name} #{track_id % COCO_TRACK_ID_OFFSET} {confidence:.2f}",
                (x1, max(18, y1 - 5)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.48,
                (255, 255, 255),
                1,
                cv2.LINE_AA,
            )

        self.track_state.update(detections)
        x1, y1, x2, y2 = self.track_state.line
        if self.config.line_counting:
            cv2.line(frame, (x1, y1), (x2, y2), (0, 190, 255), 2)
        overlay = f"VISIBLE: {len({item['trackId'] for item in detections})}"
        if self.config.line_counting:
            overlay += f"  PASSED: {self.track_state.passed}"
        cv2.putText(frame, overlay, (12, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255, 255, 255), 2, cv2.LINE_AA)
        return frame, detections
