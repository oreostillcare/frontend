from dataclasses import dataclass, field
from pathlib import Path
import os
import math
from urllib.parse import quote, unquote, urlsplit, urlunsplit
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
# Share the workspace .env with Next.js, falling back to the checkout/backend.
# Never load .env.local. Override stale variables inherited from a terminal.
workspace_env = BASE_DIR.parent.parent / ".env"
project_env = workspace_env if workspace_env.exists() else BASE_DIR.parent / ".env"
backend_env = BASE_DIR / ".env"
load_dotenv(project_env if project_env.exists() else backend_env, override=True)

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
    url = os.getenv(name, "").strip()
    if not url:
        return ""
    prefix = name.removesuffix("_RTSP_URL")
    try:
        # Split userinfo first so reserved characters in a legacy password do
        # not become a path, query or fragment. Separate fields are unambiguous.
        scheme, address = url.split("://", 1)
        userinfo, separator, address_without_auth = address.rpartition("@")
        parts = urlsplit(f"{scheme}://{address_without_auth if separator else address}")
        if parts.scheme != "rtsp" or not parts.hostname or parts.port == 0:
            raise ValueError()
        username = os.getenv(f"{prefix}_USERNAME")
        password = os.getenv(f"{prefix}_PASSWORD")
        if username is not None or password is not None:
            if not username or password is None:
                raise ValueError()
        elif separator:
            username, colon, password = userinfo.partition(":")
            if not colon or not username:
                raise ValueError()
            username, password = unquote(username), unquote(password)
        auth = f"{quote(username, safe='')}:{quote(password, safe='')}@" if username is not None else ""
        quality = os.getenv(f"{prefix}_STREAM_QUALITY", os.getenv("CAMERA_STREAM_QUALITY", "")).strip().lower()
        if quality and quality not in {"stream1", "stream2"}:
            raise ValueError()
        path = parts.path
        if quality and path.rstrip("/").endswith(("/stream1", "/stream2")):
            path = path.rstrip("/")[:-7] + quality
        return urlunsplit((parts.scheme, auth + parts.netloc, path, parts.query, parts.fragment))
    except (ValueError, TypeError):
        raise ValueError(f"Invalid {name} or camera credentials/profile; inspect server-side configuration") from None


def configure_rtsp_capture(config) -> None:
    """Set FFmpeg options once before capture threads; never mutate per worker."""
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = f"rtsp_transport;{getattr(config, 'rtsp_transport', 'tcp')}"
    # Native decoder errors can include authenticated URLs. Application status
    # supplies sanitized faults instead of forwarding native log text.
    os.environ["OPENCV_FFMPEG_LOGLEVEL"] = "-8"
    os.environ["OPENCV_LOG_LEVEL"] = "SILENT"


def camera_input_identity(source):
    if isinstance(source, str) and source.startswith("rtsp://"):
        # Different profiles/accounts on one host still represent one camera.
        return ("rtsp", (urlsplit(source).hostname or "").lower().rstrip("."))
    return source

@dataclass(frozen=True)
class Settings:
    dv20_camera_index: int = env_int("DV20_USB_CAMERA_INDEX", env_int("USB_CAMERA_1_INDEX", 0))
    logi_c270_camera_index: int = env_int("LOGI_C270_CAMERA_INDEX", 2)
    web_camera_index: int = env_int("WEB_CAMERA_INDEX", env_int("USB_CAMERA_2_INDEX", 1))

    # Credentials remain server-side; browsers receive only local stream URLs.
    camera_1_source: str = os.getenv("CAMERA_1_SOURCE", "usb").strip().lower()
    camera_2_source: str = os.getenv("CAMERA_2_SOURCE", "usb").strip().lower()
    node_b_display_mirror: bool = env_bool("ENABLE_NODE_B_DISPLAY_MIRROR", False)
    # Independent of mirror mode. Local prototypes cannot operate roadside lights.
    observation_only: bool = env_bool("SMARTROAD_OBSERVATION_ONLY", True)
    rtsp_timeout_ms: int = env_int("RTSP_TIMEOUT_MS", 5000)
    rtsp_transport: str = os.getenv("RTSP_TRANSPORT", "tcp").strip().lower()
    camera_stale_seconds: float = env_float("CAMERA_STALE_SECONDS", 5.0)
    camera_repeat_seconds: float = env_float("CAMERA_REPEAT_SECONDS", 10.0)
    reconnect_max_seconds: float = env_float("CAMERA_RECONNECT_MAX_SECONDS", 30.0)
    raw_stream_fps: float = env_float("RAW_STREAM_FPS", 10.0)
    camera_1_url: str = field(default=env_camera_url("CAMERA_1_RTSP_URL"), repr=False)
    camera_2_url: str = field(default=env_camera_url("CAMERA_2_RTSP_URL"), repr=False)
    local_yolo_model: Path = BASE_DIR / os.getenv("LOCAL_YOLO_MODEL", "models/trained_local.pt")
    coco_yolo_model: Path = BASE_DIR / os.getenv("COCO_YOLO_MODEL", "models/yolov8n.pt")
    confidence: float = env_float("DETECTION_CONFIDENCE", 0.35)
    image_size: int = env_int("DETECTION_IMAGE_SIZE", 640)
    camera_capture_fps: int = env_int("CAMERA_CAPTURE_FPS", 60)
    detection_fps: float = env_float("DETECTION_FPS", 5.0)
    performance_profiling: bool = env_bool("ENABLE_PERFORMANCE_PROFILING", False)
    viewer_aware_jpeg: bool = env_bool("ENABLE_VIEWER_AWARE_JPEG", True)
    inference_backend: str = os.getenv("INFERENCE_BACKEND", "openvino").strip().lower()
    cpu_inference_threads: int = env_int("CPU_INFERENCE_THREADS", 0)
    local_openvino_model: Path = BASE_DIR / os.getenv(
        "LOCAL_OPENVINO_MODEL", "models/openvino/trained_local_openvino_model"
    )
    coco_openvino_model: Path = BASE_DIR / os.getenv(
        "COCO_OPENVINO_MODEL", "models/openvino/yolov8n_openvino_model"
    )
    openvino_threads: int = env_int("OPENVINO_INFERENCE_THREADS", 0)
    openvino_streams: int = env_int("OPENVINO_NUM_STREAMS", 0)
    openvino_request_mode: str = os.getenv("OPENVINO_REQUEST_MODE", "shared").strip().lower()
    openvino_performance_hint: str = os.getenv("OPENVINO_PERFORMANCE_HINT", "LATENCY").strip().upper()
    openvino_request_timeout_ms: int = int(os.getenv("OPENVINO_REQUEST_TIMEOUT_MS", "5000"))
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
    timer_batching_enabled: bool = env_bool("ENABLE_TIMER_BATCHING", True)
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
    system_logs_enabled: bool = env_bool("ENABLE_SYSTEM_LOGS", True)
    system_logs_url: str = os.getenv("SYSTEM_LOGS_URL", "http://127.0.0.1:3000/api/system-events").strip()
    system_logs_secret: str = (
        os.getenv("SYSTEM_LOGS_SECRET", "")
        or os.getenv("TRAFFIC_INGEST_SECRET", "")
        or os.getenv("CRON_SECRET", "")
    ).strip()
    system_logs_interval_seconds: float = env_float("SYSTEM_LOGS_INTERVAL_SECONDS", 10.0)
    system_logs_critical_after: int = max(5, env_int("SYSTEM_LOGS_CRITICAL_AFTER", 5))
    frontend_origins: tuple[str, ...] = env_csv("FRONTEND_ORIGIN", "http://localhost:3000")
    reconnect_seconds: float = env_float("CAMERA_RECONNECT_SECONDS", 3.0)

    def __post_init__(self):
        if self.rtsp_transport not in {"tcp", "udp"}:
            raise ValueError("RTSP_TRANSPORT must be tcp or udp")
        for name in ("camera_stale_seconds", "camera_repeat_seconds", "reconnect_seconds", "reconnect_max_seconds"):
            if not math.isfinite(getattr(self, name)) or getattr(self, name) <= 0:
                raise ValueError(f"{name} must be finite and positive")
        if self.reconnect_max_seconds < self.reconnect_seconds or self.rtsp_timeout_ms <= 0:
            raise ValueError("Camera reconnect maximum must cover initial delay; RTSP timeout must be positive")
        if self.openvino_request_mode not in {"shared", "fair", "independent", "async"}:
            raise ValueError("OPENVINO_REQUEST_MODE must be shared, fair, independent, or async")
        if self.openvino_performance_hint not in {"LATENCY", "THROUGHPUT"}:
            raise ValueError("OPENVINO_PERFORMANCE_HINT must be LATENCY or THROUGHPUT")
        if self.openvino_request_timeout_ms <= 0:
            raise ValueError("OPENVINO_REQUEST_TIMEOUT_MS must be a positive integer")

settings = Settings()

def mask_rtsp_url(url: str) -> str:
    # Do not echo any URL components: malformed userinfo/query tokens may also
    # contain secrets. Camera/node identity is provided separately by callers.
    return "configured camera source" if url else "unconfigured camera source"
