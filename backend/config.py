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
    dv20_camera_index: int = env_int("DV20_USB_CAMERA_INDEX", env_int("USB_CAMERA_1_INDEX", 2))
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
    detection_fps: float = env_float("DETECTION_FPS", 5.0)
    line_counting: bool = env_bool("ENABLE_LINE_COUNTING", True)
    line: tuple[int, int, int, int] = (env_int("LINE_X1", 0), env_int("LINE_Y1", 360), env_int("LINE_X2", 1280), env_int("LINE_Y2", 360))
    frontend_origins: tuple[str, ...] = env_csv("FRONTEND_ORIGIN", "http://localhost:3000")
    reconnect_seconds: float = env_float("CAMERA_RECONNECT_SECONDS", 3.0)

settings = Settings()

def mask_rtsp_url(url: str) -> str:
    if "@" not in url or "://" not in url: return "configured camera source" if url else "unconfigured camera source"
    scheme, remainder = url.split("://", 1)
    return f"{scheme}://***:***@{remainder.split('@', 1)[1]}"
