"""Credential-safe configuration check; --live explicitly probes both selected cameras.

Never imports app.py, models, ESP32 control, or Firebase clients.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.parse import unquote, urlsplit, urlunsplit
from urllib.request import AbstractDigestAuthHandler, HTTPPasswordMgr, Request, parse_http_list, parse_keqv_list

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import camera_input_identity, configure_rtsp_capture, settings


def configuration_report(config):
    cameras = []
    for camera_id in (1, 2):
        mode = getattr(config, f"camera_{camera_id}_source")
        url = getattr(config, f"camera_{camera_id}_url")
        parts = urlsplit(url)
        cameras.append({
            "camera": camera_id, "node": "Node A" if camera_id == 1 else "Node B",
            "source": mode, "endpointConfigured": bool(url),
            "profile": parts.path.rsplit("/", 1)[-1] if parts.path in {"/stream1", "/stream2"} else "custom",
            "credentialsConfigured": parts.username is not None and parts.password is not None,
        })
    urls = [getattr(config, f"camera_{i}_url") for i in (1, 2)]
    independent = bool(all(urls) and camera_input_identity(urls[0]) != camera_input_identity(urls[1]))
    return {
        "mode": "configuration-only", "networkTested": False, "cameras": cameras,
        "dualRtspReady": all(c["source"] == "rtsp" and c["endpointConfigured"] for c in cameras)
        and independent and not config.node_b_display_mirror,
        "independentHosts": independent, "displayMirror": config.node_b_display_mirror,
        "observationOnly": config.observation_only, "transport": config.rtsp_transport,
        "timeoutMs": config.rtsp_timeout_ms,
    }


def describe(url, timeout, authorization=None):
    """One bounded RTSP exchange; never returns server text or the private URI."""
    parts = urlsplit(url)
    host = parts.hostname
    authority = f"[{host}]" if ":" in host else host
    uri = urlunsplit(("rtsp", f"{authority}:{parts.port or 554}", parts.path, parts.query, ""))
    headers = [f"DESCRIBE {uri} RTSP/1.0", "CSeq: 1", "Accept: application/sdp"]
    if authorization:
        headers.append("Authorization: " + authorization)
    with socket.create_connection((host, parts.port or 554), timeout=timeout) as connection:
        connection.settimeout(timeout)
        connection.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("utf-8"))
        data = b""
        deadline = time.monotonic() + timeout
        while b"\r\n\r\n" not in data:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or len(data) >= 16384:
                raise TimeoutError()
            connection.settimeout(remaining)
            block = connection.recv(min(4096, 16384 - len(data)))
            if not block:
                raise OSError()
            data += block
    lines = data.decode("latin1").split("\r\n")
    status = int(lines[0].split()[1])
    challenge = next((line.split(":", 1)[1].strip() for line in lines if line.lower().startswith("www-authenticate:")), "")
    return status, challenge, uri


def authentication(url, timeout):
    status, challenge, uri = describe(url, timeout)
    if status == 401:
        parts = urlsplit(url)
        if parts.username is None or parts.password is None:
            return "credentials_missing", status
        username, password = unquote(parts.username), unquote(parts.password)
        if challenge.lower().startswith("basic "):
            authorization = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
        elif challenge.lower().startswith("digest "):
            values = parse_keqv_list(parse_http_list(challenge[7:]))
            manager = HTTPPasswordMgr()
            manager.add_password(values.get("realm"), uri, username, password)
            handler = AbstractDigestAuthHandler(manager)
            try:
                request = Request(uri, method="DESCRIBE")
                # RTSP uses an absolute request target; urllib defaults to an
                # HTTP path selector, which would produce the wrong digest.
                request.selector = uri
                value = handler.get_authorization(request, values)
            except (ValueError, KeyError):
                value = None
            if not value:
                return "unsupported_challenge", status
            authorization = "Digest " + value
        else:
            return "unsupported_challenge", status
        status, _, _ = describe(url, timeout, authorization)
        return ("accepted" if status == 200 else "rejected" if status in {401, 403} else "stream_error"), status
    return ("not_required" if status == 200 else "rejected" if status == 403 else "stream_error"), status


def probe(camera_id, config):
    url = getattr(config, f"camera_{camera_id}_url")
    result = {"camera": camera_id, "hostnameResolved": False, "portOpen": False, "decoded": False}
    if not url or getattr(config, f"camera_{camera_id}_source") != "rtsp":
        return {**result, "fault": "RTSP source not selected/configured"}
    parts = urlsplit(url)
    timeout = config.rtsp_timeout_ms / 1000
    try:
        socket.getaddrinfo(parts.hostname, parts.port or 554, type=socket.SOCK_STREAM)
        result["hostnameResolved"] = True
        with socket.create_connection((parts.hostname, parts.port or 554), timeout=timeout):
            result["portOpen"] = True
        result["authentication"], result["rtspStatus"] = authentication(url, timeout)
        if result["authentication"] not in {"accepted", "not_required"}:
            return result
        configure_rtsp_capture(config)
        import cv2
        cv2.setLogLevel(0)
        capture = cv2.VideoCapture(url, cv2.CAP_FFMPEG, [
            cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, config.rtsp_timeout_ms,
            cv2.CAP_PROP_READ_TIMEOUT_MSEC, config.rtsp_timeout_ms,
        ])
        try:
            result["streamInitialized"] = capture.isOpened()
            started = time.perf_counter()
            ok, frame = capture.read() if capture.isOpened() else (False, None)
            result["decoded"] = bool(ok and frame is not None)
            if result["decoded"]:
                result["resolution"] = list(frame.shape[1::-1])
                result["firstReadMs"] = round((time.perf_counter() - started) * 1000, 1)
        finally:
            capture.release()
    except socket.gaierror:
        result["fault"] = "Hostname resolution failed"
    except (TimeoutError, OSError):
        result["fault"] = "Network connection failed or timed out"
    except Exception:
        result["fault"] = "RTSP initialization/decoding failed"
    return result


def bounded_probe(camera_id, config):
    # DNS and native decoder shutdown also need a hard process deadline.
    try:
        child = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--probe-camera", str(camera_id)],
            capture_output=True, text=True, timeout=10 + config.rtsp_timeout_ms / 1000 * 6,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        result = json.loads(child.stdout)
        if child.returncode != 0 or not isinstance(result, dict):
            raise ValueError()
        return result
    except (subprocess.TimeoutExpired, ValueError, OSError):
        # Never forward child output: decoder/library errors may contain URLs.
        return {"camera": camera_id, "decoded": False, "fault": "Probe failed or exceeded deadline"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Open both selected RTSP cameras concurrently")
    parser.add_argument("--probe-camera", type=int, choices=(1, 2), help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.probe_camera:
        print(json.dumps(probe(args.probe_camera, settings)))
        return
    report = configuration_report(settings)
    if args.live:
        with ThreadPoolExecutor(max_workers=2) as pool:
            report.update(mode="live-connectivity", networkTested=True,
                          probes=list(pool.map(lambda i: bounded_probe(i, settings), (1, 2))))
    print(json.dumps(report, indent=2))
    if args.live and not all(p.get("decoded") for p in report["probes"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
