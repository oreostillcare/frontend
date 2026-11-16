import importlib

import pytest

import config
from config import Settings, env_bool, env_camera_url, env_csv, env_float, env_int, mask_rtsp_url


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_env_bool_accepts_supported_true_values(monkeypatch, value):
    monkeypatch.setenv("TEST_BOOLEAN", value)
    assert env_bool("TEST_BOOLEAN") is True


def test_env_bool_uses_default_and_rejects_other_values(monkeypatch):
    monkeypatch.delenv("TEST_BOOLEAN", raising=False)
    assert env_bool("TEST_BOOLEAN", True) is True

    monkeypatch.setenv("TEST_BOOLEAN", "enabled")
    assert env_bool("TEST_BOOLEAN", True) is False


@pytest.mark.parametrize(
    ("parser", "value", "default", "expected"),
    [
        (env_int, "42", 7, 42),
        (env_int, "invalid", 7, 7),
        (env_float, "2.5", 1.0, 2.5),
        (env_float, "invalid", 1.0, 1.0),
    ],
)
def test_numeric_environment_parsing(monkeypatch, parser, value, default, expected):
    monkeypatch.setenv("TEST_NUMBER", value)
    assert parser("TEST_NUMBER", default) == expected


def test_env_csv_trims_and_discards_empty_values(monkeypatch):
    monkeypatch.setenv("TEST_CSV", "http://one.test, , http://two.test ,")
    assert env_csv("TEST_CSV", "") == ("http://one.test", "http://two.test")


@pytest.mark.parametrize(
    ("url", "quality", "expected"),
    [
        ("rtsp://camera.test/stream1", "stream2", "rtsp://camera.test/stream2"),
        ("rtsp://camera.test/stream2/", "STREAM1", "rtsp://camera.test/stream1"),
        ("rtsp://camera.test/live", "stream2", "rtsp://camera.test/live"),
    ],
)
def test_camera_stream_quality_rewriting(monkeypatch, url, quality, expected):
    monkeypatch.setenv("TEST_CAMERA_URL", url)
    monkeypatch.setenv("CAMERA_STREAM_QUALITY", quality)
    assert env_camera_url("TEST_CAMERA_URL") == expected


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("", "unconfigured camera source"),
        ("camera-device-0", "configured camera source"),
        ("rtsp://admin:secret@192.0.2.1:554/stream1", "rtsp://***:***@192.0.2.1:554/stream1"),
    ],
)
def test_rtsp_url_masking(url, expected):
    assert mask_rtsp_url(url) == expected


def test_openvino_runtime_settings_defaults_and_normalizes_environment(monkeypatch):
    monkeypatch.delenv("OPENVINO_REQUEST_MODE", raising=False)
    monkeypatch.delenv("OPENVINO_PERFORMANCE_HINT", raising=False)
    settings_class = importlib.reload(config).Settings
    assert settings_class().openvino_request_mode == "shared"
    assert settings_class().openvino_performance_hint == "LATENCY"

    monkeypatch.setenv("OPENVINO_REQUEST_MODE", "ASYNC")
    monkeypatch.setenv("OPENVINO_PERFORMANCE_HINT", "throughput")
    settings_class = importlib.reload(config).Settings
    assert settings_class().openvino_request_mode == "async"
    assert settings_class().openvino_performance_hint == "THROUGHPUT"


def test_openvino_request_timeout_defaults_and_rejects_nonpositive_values(monkeypatch):
    monkeypatch.delenv("OPENVINO_REQUEST_TIMEOUT_MS", raising=False)
    settings_class = importlib.reload(config).Settings
    assert settings_class().openvino_request_timeout_ms == 5000

    monkeypatch.setenv("OPENVINO_REQUEST_TIMEOUT_MS", "1250")
    settings_class = importlib.reload(config).Settings
    assert settings_class().openvino_request_timeout_ms == 1250
    with pytest.raises(ValueError, match="OPENVINO_REQUEST_TIMEOUT_MS"):
        settings_class(openvino_request_timeout_ms=0)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("OPENVINO_REQUEST_MODE", "maybe", "OPENVINO_REQUEST_MODE"),
        ("OPENVINO_PERFORMANCE_HINT", "BALANCED", "OPENVINO_PERFORMANCE_HINT"),
    ],
)
def test_openvino_runtime_settings_reject_unsupported_values(monkeypatch, field, value, message):
    monkeypatch.setenv(field, value)
    with pytest.raises(ValueError, match=message):
        importlib.reload(config).Settings()

