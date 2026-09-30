from dataclasses import dataclass
from pathlib import Path
import os
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
# This is a local appliance-style service: the project .env is its source of
# truth. Override stale variables inherited from a long-lived VS Code terminal.
backend_env = BASE_DIR / ".env"
load_dotenv(backend_env if backend_env.exists() else BASE_DIR.parent / ".env", override=True)

def env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}

def env_int(name: str, default: int) -> int:
    try: return int(os.getenv(name, default))
    except (TypeError, ValueError): return default

def env_float(name: str, default: float) -> float:
    try: return float(os.getenv(name, default))
    except (TypeError, ValueError): return default

def env_percentage(name: str, default: float) -> float:
    return min(100.0, max(0.0, env_float(name, default)))

def env_optional_percentage(name: str) -> float | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    try:
        return min(100.0, max(0.0, float(value)))
    except ValueError:
        return None

def env_csv(name: str, default: str) -> tuple[str, ...]:
    return tuple(value.strip() for value in os.getenv(name, default).split(",") if value.strip())

def env_camera_url(name: str) -> str:
    url = os.getenv(name, "")
    quality = os.getenv("CAMERA_STREAM_QUALITY", "").strip().lower()
    if quality in {"stream1", "stream2"} and url.rstrip("/").endswith(("stream1", "stream2")):
        return f"{url.rstrip('/')[:-7]}{quality}"
    return url

@dataclass(frozen=True)
class Settings:
    dv20_camera_index: int = env_int("DV20_USB_CAMERA_INDEX", env_int("USB_CAMERA_1_INDEX", 0))
    logi_c270_camera_index: int = env_int("LOGI_C270_CAMERA_INDEX", 2)
    web_camera_index: int = env_int("WEB_CAMERA_INDEX", env_int("USB_CAMERA_2_INDEX", 1))

    # RTSP - FOR FUTURE USE
    # Keep the authenticated stream URLs loaded so RTSP can be restored without
    # rebuilding the connection configuration.
    camera_1_url: str = env_camera_url("CAMERA_1_RTSP_URL")
    camera_2_url: str = env_camera_url("CAMERA_2_RTSP_URL")
    local_yolo_model: Path = BASE_DIR / os.getenv("LOCAL_YOLO_MODEL", "models/trained_local.pt")
    coco_yolo_model: Path = BASE_DIR / os.getenv("COCO_YOLO_MODEL", "models/yolov8n.pt")
    confidence: float = env_float("DETECTION_CONFIDENCE", 0.35)
    image_size: int = env_int("DETECTION_IMAGE_SIZE", 640)
    camera_capture_fps: int = env_int("CAMERA_CAPTURE_FPS", 60)
    detection_fps: float = env_float("DETECTION_FPS", 5.0)
    line_counting: bool = env_bool("ENABLE_LINE_COUNTING", True)
    line: tuple[int, int, int, int] = (env_int("LINE_X1", 0), env_int("LINE_Y1", 360), env_int("LINE_X2", 1280), env_int("LINE_Y2", 360))
    guide_green_y_percent: float = env_percentage("GUIDE_GREEN_Y_PERCENT", 15.0)
    guide_red_y_percent: float = env_percentage("GUIDE_RED_Y_PERCENT", 80.0)
    camera_1_guide_green_y_percent: float | None = env_optional_percentage(
        "CAMERA_1_GUIDE_GREEN_Y_PERCENT"
    )
    camera_1_guide_red_y_percent: float | None = env_optional_percentage("CAMERA_1_GUIDE_RED_Y_PERCENT")
    camera_2_guide_green_y_percent: float | None = env_optional_percentage(
        "CAMERA_2_GUIDE_GREEN_Y_PERCENT"
    )
    camera_2_guide_red_y_percent: float | None = env_optional_percentage("CAMERA_2_GUIDE_RED_Y_PERCENT")
    direction_motion_deadband_pixels: int = env_int("DIRECTION_MOTION_DEADBAND_PIXELS", 4)
    direction_motion_window_frames: int = env_int("DIRECTION_MOTION_WINDOW_FRAMES", 5)
    direction_reversal_min_distance_pixels: int = env_int(
        "DIRECTION_REVERSAL_MIN_DISTANCE_PIXELS",
        24,
    )
    outgoing_route_completion_percent: float = env_percentage(
        "OUTGOING_ROUTE_COMPLETION_PERCENT",
        50.0,
    )
    global_id_local_grace_seconds: float = env_float("GLOBAL_ID_LOCAL_GRACE_SECONDS", 6.0)
    global_id_cross_camera_seconds: float = env_float("GLOBAL_ID_CROSS_CAMERA_SECONDS", 60.0)
    global_id_match_threshold: float = env_float("GLOBAL_ID_MATCH_THRESHOLD", 0.55)
    global_id_ambiguity_margin: float = env_float("GLOBAL_ID_AMBIGUITY_MARGIN", 0.08)
    global_id_minimum_sample_confidence: float = env_float("GLOBAL_ID_MIN_SAMPLE_CONFIDENCE", 0.45)
    global_id_maximum_samples: int = env_int("GLOBAL_ID_MAX_SAMPLES", 8)
    esp32_control_enabled: bool = env_bool("ENABLE_ESP32_POINT_CONTROL", True)
    esp32_node_a_ip: str = os.getenv("ESP32_NODE_A_IP", "192.168.1.220").strip()
    esp32_node_b_ip: str = os.getenv("ESP32_NODE_B_IP", "192.168.1.221").strip()
    esp32_timeout_seconds: float = env_float("ESP32_TIMEOUT_SECONDS", 1.25)
    esp32_request_attempts: int = env_int("ESP32_REQUEST_ATTEMPTS", 2)
    esp32_heartbeat_enabled: bool = env_bool("ESP32_HEARTBEAT_ENABLED", True)
    esp32_heartbeat_interval_seconds: float = env_float("ESP32_HEARTBEAT_INTERVAL_SECONDS", 2.0)
    esp32_heartbeat_timeout_seconds: float = env_float("ESP32_HEARTBEAT_TIMEOUT_SECONDS", 5.0)
    traffic_comparison_interval_seconds: float = env_float("TRAFFIC_COMPARISON_INTERVAL_SECONDS", 1.0)
    traffic_outgoing_confirmation_frames: int = env_int("TRAFFIC_OUTGOING_CONFIRMATION_FRAMES", 3)
    traffic_outgoing_confirmation_seconds: float = env_float(
        "TRAFFIC_OUTGOING_CONFIRMATION_SECONDS",
        1.0,
    )
    traffic_outgoing_id_switch_grace_seconds: float = env_float(
        "TRAFFIC_OUTGOING_ID_SWITCH_GRACE_SECONDS",
        1.0,
    )
    traffic_firestore_enabled: bool = env_bool("ENABLE_TRAFFIC_FIRESTORE_UPLOAD", False)
    traffic_firestore_url: str = os.getenv(
        "TRAFFIC_FIRESTORE_URL",
        "http://127.0.0.1:3000/api/traffic/transactions",
    ).strip()
    traffic_ingest_secret: str = (
        os.getenv("TRAFFIC_INGEST_SECRET", "") or os.getenv("CRON_SECRET", "")
    ).strip()
    traffic_firestore_timeout_seconds: float = env_float("TRAFFIC_FIRESTORE_TIMEOUT_SECONDS", 5.0)
    frontend_origins: tuple[str, ...] = env_csv("FRONTEND_ORIGIN", "http://localhost:3000")
    reconnect_seconds: float = env_float("CAMERA_RECONNECT_SECONDS", 3.0)

settings = Settings()

def mask_rtsp_url(url: str) -> str:
    if "@" not in url or "://" not in url: return "configured camera source" if url else "unconfigured camera source"
    scheme, remainder = url.split("://", 1)
    return f"{scheme}://***:***@{remainder.split('@', 1)[1]}"
