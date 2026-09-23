"""Start and supervise the local Flask and Next.js development servers on Windows.

Run from the repository root with: backend\.venv\Scripts\python.exe backend\run_local.py
Both services must be stopped before starting this launcher.
"""

import os
import queue
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen


BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BACKEND_DIR.parent
RESET_REQUESTS: queue.Queue[None] = queue.Queue(maxsize=1)
RESET_PENDING = threading.Event()
RESET_LOCK = threading.Lock()


def port_is_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("0.0.0.0", port))
        except OSError:
            return False
    return True


def stop_owned_process(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            timeout=15,
        )
    else:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Owned process {process.pid} did not stop") from None


def main() -> None:
    if os.name != "nt":
        raise SystemExit("This launcher is configured for the Windows local console.")

    npm = shutil.which("npm.cmd")
    if npm is None:
        raise SystemExit("npm.cmd was not found in PATH.")
    for port in (5000, 3000):
        if not port_is_available(port):
            raise SystemExit(f"Port {port} is already in use. Stop the old Flask/Next.js terminal first.")

    reset_token = secrets.token_urlsafe(32)
    reset_pin = secrets.token_hex(6).upper()

    class ResetHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path != "/reset" or not secrets.compare_digest(
                self.headers.get("X-Reset-Token", ""), reset_token
            ):
                self.send_error(403)
                return
            with RESET_LOCK:
                if RESET_PENDING.is_set():
                    self.send_error(409, "A reset is already pending")
                    return
                RESET_PENDING.set()
                RESET_REQUESTS.put_nowait(None)
            self.send_response(202)
            self.end_headers()

        def log_message(self, _format: str, *_args: object) -> None:
            pass

    supervisor = ThreadingHTTPServer(("127.0.0.1", 0), ResetHandler)
    supervisor_thread = threading.Thread(target=supervisor.serve_forever, daemon=True)
    supervisor_thread.start()

    child_env = os.environ.copy()
    child_env.update(
        {
            "LOCAL_SUPERVISOR_URL": f"http://127.0.0.1:{supervisor.server_port}/reset",
            "LOCAL_SUPERVISOR_TOKEN": reset_token,
            "LOCAL_RESET_PIN": reset_pin,
        }
    )
    python = BACKEND_DIR / ".venv" / "Scripts" / "python.exe"
    if not python.is_file():
        python = Path(sys.executable)

    backend: subprocess.Popen | None = None
    frontend: subprocess.Popen | None = None

    def start_services() -> tuple[subprocess.Popen, subprocess.Popen]:
        backend_process = subprocess.Popen(
            [str(python), "app.py"],
            cwd=BACKEND_DIR,
            env=child_env,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        try:
            frontend_process = subprocess.Popen(
                [npm, "run", "dev"],
                cwd=PROJECT_DIR,
                env=os.environ.copy(),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        except Exception:
            stop_owned_process(backend_process)
            raise
        return backend_process, frontend_process

    def prepare_backend_shutdown() -> None:
        if backend is None or backend.poll() is not None:
            return
        try:
            prepare = Request(
                "http://127.0.0.1:5000/api/local/prepare-reset",
                data=b"",
                headers={"X-Reset-Token": reset_token},
                method="POST",
            )
            with urlopen(prepare, timeout=15) as response:
                if response.status != 200:
                    raise RuntimeError(f"Backend shutdown returned HTTP {response.status}")
        except Exception as error:
            print(f"Graceful backend shutdown failed: {error}", flush=True)
            print("Stopping only the two processes owned by this launcher.", flush=True)

    try:
        backend, frontend = start_services()
        print(f"Local reset PIN: {reset_pin}", flush=True)
        print("Open http://127.0.0.1:5000/local (or the laptop's LAN IP).", flush=True)
        while True:
            RESET_REQUESTS.get()
            # Let Flask return 202 to the browser before asking it to shut down.
            time.sleep(0.5)
            prepare_backend_shutdown()
            stop_owned_process(frontend)
            stop_owned_process(backend)
            backend, frontend = start_services()
            RESET_PENDING.clear()
            print("Local backend and dashboard restarted.", flush=True)
    except KeyboardInterrupt:
        print("Stopping local services...", flush=True)
    finally:
        supervisor.shutdown()
        supervisor.server_close()
        prepare_backend_shutdown()
        try:
            stop_owned_process(frontend)
        finally:
            stop_owned_process(backend)


if __name__ == "__main__":
    main()
