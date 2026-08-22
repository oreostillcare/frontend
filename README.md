# Intelligent Roadworks Traffic Management Dashboard

Computer Engineering thesis prototype for monitoring a single-lane roadworks traffic system. The Next.js dashboard is a non-critical monitoring client; camera inference, tracking, counting, and eventual traffic-signal operation remain local.

## Quick setup (Windows PowerShell)

Install Node.js 20.9 or newer and Python 3, then run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

The script uses `npm ci` for the locked frontend dependencies, creates `backend/.venv`, installs `backend/requirements.txt`, creates local environment files from the committed examples without overwriting existing files, and downloads the standard YOLO model. Edit `.env.local` and `backend/.env` after setup.

Datasets, trained weights, videos, logs, environment files, virtual environments, and build output are deliberately excluded from Git. Dataset downloads are optional because they are large and their URLs are private:

```powershell
.\setup.ps1 -DownloadDatasets
```

## Manual frontend setup

```powershell
npm install
npm run dev
```

If PowerShell blocks `npm.ps1`, use `npm.cmd install` and `npm.cmd run dev`. Copy `.env.example` to `.env.local` and configure Firebase plus `NEXT_PUBLIC_BACKEND_URL`. Never commit `.env.local`.

## Manual Flask backend setup

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

If activation is blocked, run `.\.venv\Scripts\python.exe -m pip install -r requirements.txt` followed by `.\.venv\Scripts\python.exe app.py`. Copy `.env.example` to `.env`, then add private RTSP and Roboflow values. The committed example contains placeholders only.

The backend starts detection immediately; opening a browser does not create the camera or inference worker. For an offline, Flask-only view that does not require Next.js, Firebase, or internet access, open:

```text
http://127.0.0.1:5000/local
```

Camera capture continuously drains RTSP into a one-frame overwrite buffer. YOLO always takes the newest available frame, so inference that runs slower than the camera drops stale frames instead of accumulating latency. `frameAgeMs` and `processingMs` are exposed in local telemetry for latency diagnosis.

While `TEST_SINGLE_CAMERA_MODE=true`, the Flask console and Next.js monitoring page render Camera A twice for a two-view load test. Camera B is explicitly labeled `TEST MIRROR`; both MJPEG endpoints share Camera A's single capture, YOLO, ByteTrack, and latest JPEG buffer. This adds only a second viewer/network decode path, not a second inference pipeline. When test mode is disabled, Camera 2 receives its own physical stream and worker.

## Datasets and training

From the repository root:

```powershell
.\backend\scripts\download_datasets.ps1
.\backend\scripts\download_datasets.ps1 -Dataset etrike_ebike
.\backend\scripts\download_datasets.ps1 -Dataset road_vehicles
python .\backend\scripts\inspect_datasets.py
python .\backend\scripts\prepare_combined_dataset.py
python .\backend\train.py
```

Dataset download and training are always manual. Downloads use `curl.exe`, retry transient failures, reject Cloudflare HTML responses, validate the ZIP signature, and never print private dataset URLs. Evaluate the resulting weights before copying a selected `best.pt` to `backend/models/best.pt`.

For LAN development on the configured workstation, open `http://192.168.1.12:3000`. Restart both development servers after changing the workstation IP, allowed origins, or public backend URL.

## Camera architecture

With `TEST_SINGLE_CAMERA_MODE=true`, Flask creates one `CameraWorker`, one `VideoCapture`, one YOLO model/tracking pipeline, and one latest JPEG buffer. Both MJPEG endpoints consume that buffer; Camera B is labeled as a test mirror. When disabled, Camera 2 receives its own worker and independent ByteTrack/counting state.

Configure the counting line with `LINE_X1`, `LINE_Y1`, `LINE_X2`, and `LINE_Y2`. The defaults are placeholders and must be calibrated against the installed camera view.

Line counting is currently disabled with `ENABLE_LINE_COUNTING=false` so testing focuses on detection and tracking. While disabled, the video has no counting line or passed counter and the dashboard reports passed vehicles as unavailable.

The local test configuration uses the camera's lower-bandwidth `stream2` profile at a target of 10 detection FPS. Stock COCO inference is restricted to `car`, `motorcycle`, `truck`, and `bus`; the local confidence threshold is 0.25 to improve recall for smaller motorcycles.

Firebase Authentication can operate without Realtime Database. Until `NEXT_PUBLIC_FIREBASE_DATABASE_URL` is provided, historical analytics and logs intentionally show empty states.
