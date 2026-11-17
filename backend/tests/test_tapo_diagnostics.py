from dataclasses import replace
import json
import hashlib
import re
from unittest.mock import Mock

import pytest

from config import Settings, camera_input_identity
from scripts import check_tapo_cameras as diagnostics


def test_offline_report_has_mapping_and_no_secrets_or_network(monkeypatch):
    monkeypatch.setattr(diagnostics.socket, "getaddrinfo", Mock(side_effect=AssertionError("offline")))
    config = Settings(camera_1_source="rtsp", camera_2_source="rtsp", node_b_display_mirror=False,
                      camera_1_url="rtsp://user:secret@a.test/stream1",
                      camera_2_url="rtsp://other:private@b.test/stream2")
    report = diagnostics.configuration_report(config)
    assert report["dualRtspReady"] and not report["networkTested"]
    assert [c["node"] for c in report["cameras"]] == ["Node A", "Node B"]
    assert [c["profile"] for c in report["cameras"]] == ["stream1", "stream2"]
    assert all(value not in json.dumps(report) for value in ("secret", "private", "a.test", "b.test", "rtsp://"))
    assert not diagnostics.configuration_report(replace(config, camera_2_source="disabled"))["dualRtspReady"]


def test_same_camera_different_profiles_and_credentials_are_one_input():
    assert camera_input_identity("rtsp://a:b@CAMERA.test/stream1") == camera_input_identity("rtsp://c:d@camera.test/stream2")
    assert camera_input_identity(0) != camera_input_identity(1)


@pytest.mark.parametrize("challenge", ['Basic realm="Tapo"', 'Digest realm="Tapo", nonce="123", qop="auth", algorithm=MD5'])
@pytest.mark.parametrize("status,expected", [(200, "accepted"), (401, "rejected"), (403, "rejected")])
def test_authentication_challenge(monkeypatch, challenge, status, expected):
    exchange = Mock(side_effect=[(401, challenge, "rtsp://camera.test:554/stream1"), (status, "", "")])
    monkeypatch.setattr(diagnostics, "describe", exchange)
    assert diagnostics.authentication("rtsp://u:p%40ss@camera.test/stream1", 1) == (expected, status)
    assert exchange.call_args.args[2].startswith(("Basic ", "Digest "))


def test_rtsp_digest_hashes_full_request_target(monkeypatch):
    uri = "rtsp://camera.test:554/stream1"
    exchange = Mock(side_effect=[(401, 'Digest realm="Tapo", nonce="123", algorithm=MD5', uri), (200, "", "")])
    monkeypatch.setattr(diagnostics, "describe", exchange)
    assert diagnostics.authentication("rtsp://u:p%40ss@camera.test/stream1", 1)[0] == "accepted"
    authorization = exchange.call_args.args[2]
    digest = lambda value: hashlib.md5(value.encode()).hexdigest()
    expected = digest(f'{digest("u:Tapo:p@ss")}:123:{digest("DESCRIBE:" + uri)}')
    assert f'uri="{uri}"' in authorization
    assert re.search(r'response="([^"]+)"', authorization).group(1) == expected


def test_network_failure_is_sanitized(monkeypatch):
    config = Settings(camera_1_source="rtsp", camera_1_url="rtsp://u:private@camera.test/stream1")
    monkeypatch.setattr(diagnostics.socket, "getaddrinfo", Mock(side_effect=OSError(config.camera_1_url)))
    report = diagnostics.probe(1, config)
    assert not report["decoded"] and "private" not in json.dumps(report)


def test_child_error_output_is_never_forwarded(monkeypatch):
    monkeypatch.setattr(diagnostics.subprocess, "run", Mock(return_value=Mock(stdout="private URL", returncode=1)))
    assert diagnostics.bounded_probe(1, Settings()) == {
        "camera": 1, "decoded": False, "fault": "Probe failed or exceeded deadline",
    }
