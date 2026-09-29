# Intelligent Roadworks Traffic Management Dashboard

Computer Engineering thesis prototype for monitoring a single-lane roadworks traffic system. The Next.js dashboard is a non-critical monitoring client; camera inference, tracking, counting, and eventual traffic-signal operation remain local.

## Quick setup (Windows PowerShell)

Install Python 3, then run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

If Node.js is missing, the script automatically installs the current Node.js LTS release through Windows Package Manager (`winget`). Windows may request administrator approval. It then uses `npm ci` for the locked frontend dependencies, creates `backend/.venv`, installs `backend/requirements.txt`, creates local environment files from the committed examples without overwriting existing files, and verifies the bundled custom model. Edit `.env.local` and `backend/.env` after setup.

If `winget` is unavailable, install Node.js LTS manually from [nodejs.org](https://nodejs.org/) and rerun the script.

The selected custom runtime weights are included at `backend/models/best.pt`; the live application uses only this checkpoint and does not load a COCO fallback. If the custom checkpoint is unavailable, the model reports offline instead of downloading another model. The training datasets are not needed to run detection. Other training outputs, videos, logs, environment files, virtual environments, and build output are deliberately excluded from Git. Dataset downloads are optional because they are large and their URLs are private:

```powershell
.\setup.ps1 -DownloadDatasets
```

## Manual frontend setup

```powershell
npm ci
npm run dev
```

If PowerShell blocks `npm.ps1`, use `npm.cmd ci` and `npm.cmd run dev`. Copy `.env.example` to `.env.local` and configure Firebase plus `NEXT_PUBLIC_BACKEND_URL`. Never commit `.env.local`.

## Firebase emulator integration tests

The regular Playwright suite uses mocked Firebase responses so it stays fast and deterministic. Run the separate
emulator suite to verify Firebase Authentication, Firestore reads, Admin SDK token verification, staff profile loading,
and `firestore.rules` without touching a hosted Firebase project:

```powershell
npm.cmd run test:firebase
```

Run every frontend unit test, backend test, production build, regular browser test, Firestore rules test, and Firebase
emulator browser test with:

```powershell
npm.cmd run test:all
```

This command starts isolated Auth and Firestore emulators under the `demo-smartroad` project, validates the security
rules, seeds an administrator account, and runs real browser flows for login, password-reset links, reset cooldowns and
expiry, invitation verification and resend, email-change verification, cancellation, and expiry. The command stops the
emulators afterward. Java 17 is supported by the project-pinned Firebase CLI. Keep `firebase-tools` on the v14 line
unless the development machines are upgraded to Java 21, which is required by Firebase CLI v15.

Regular and Firebase browser reports are kept separately so the second suite does not overwrite the first:

```powershell
npm.cmd run report:e2e
npm.cmd run report:e2e:firebase
```

For manual inspection, keep the emulators running with:

```powershell
npm.cmd run firebase:emulators
```

The Emulator Suite UI is available at `http://127.0.0.1:4000` while this manual command is running.

For staff verification emails, set `APP_BASE_URL` to the exact SmartRoad origin and add that hostname to Firebase
Authentication > Settings > Authorized domains. Production deployments also need a random `CRON_SECRET` (at least
16 characters) so Vercel can securely run the daily archived-invitation cleanup.

## Manual Flask backend setup

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

If activation is blocked, run `.\.venv\Scripts\python.exe -m pip install -r requirements.txt` followed by `.\.venv\Scripts\python.exe app.py`. Copy `.env.example` to `.env`, then set `LAPTOP_CAMERA_INDEX` if the webcam is not device `0`. The retained RTSP and Roboflow fields are placeholders for future/private values.

The backend starts detection immediately; opening a browser does not create the camera or inference worker. For an offline, Flask-only view that does not require Next.js, Firebase, or internet access, open:

```text
http://127.0.0.1:5000/local
```

For the **Reset system** button on `/local`, stop any separately running Flask and Next.js terminals, then start both services through the Windows launcher from the repository root:

```powershell
.\backend\.venv\Scripts\python.exe .\backend\run_local.py
```

The launcher runs `app.py` and `npm.cmd run dev`, prints a reset PIN in its terminal, and restarts only the processes it started when the PIN is entered on `/local`. Restarting clears in-memory detection, tracking, counting, and traffic-control state. The backend requests both ESP32 signals RED before the restart; each ESP32's own watchdog remains the hardware-side fallback. If the two services were started separately, the button is disabled because their processes cannot be safely identified and restarted by the page.

The `/local` console also provides **Both RED + clear test** for repeated toy-vehicle trials. It works without the launcher: both ESP32 nodes must confirm RED before the backend recreates both detector/tracker workers and clears live counts, temporary track IDs, global vehicle IDs, transaction batches, and controller totals. It does not erase historical records already saved to Firestore. Remove the toy vehicles from both traffic zones before resetting, then place and move them for the next test; any vehicle still visible to YOLO can be detected again immediately after the reset.

Camera capture continuously drains the laptop webcam into a one-frame overwrite buffer. YOLO always takes the newest available frame, so inference that runs slower than the camera drops stale frames instead of accumulating latency. `frameAgeMs` and `processingMs` are exposed in local telemetry for latency diagnosis. The RTSP URL, authentication, FFmpeg connection, reconnection, and masked-error path remain in the backend under `RTSP - FOR FUTURE USE`.

While the laptop webcam is active, the Flask console and Next.js monitoring page render Camera A twice. Camera B is explicitly labeled `TEST MIRROR`; both MJPEG endpoints share Camera A's single capture, YOLO, ByteTrack, and latest JPEG buffer. This avoids opening the laptop webcam twice. `TEST_SINGLE_CAMERA_MODE` and the second physical worker remain available for the future RTSP mode.

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

Dataset download and training are always manual. Downloads use `curl.exe`, retry transient failures, reject Cloudflare HTML responses, validate the ZIP signature, and never print private dataset URLs. A fresh clone can run inference with the bundled `backend/models/best.pt` without downloading the datasets. Evaluate newly trained weights before replacing that selected runtime model.

For LAN development on the configured workstation, open `http://192.168.1.12:3000`. Restart both development servers after changing the workstation IP, allowed origins, or public backend URL.

## Camera architecture

In laptop-webcam mode, Flask creates one `CameraWorker`, one `VideoCapture`, one YOLO model/tracking pipeline, and one latest JPEG buffer. Both MJPEG endpoints consume that buffer, and Camera B is labeled as a test mirror. The retained RTSP mode can restore `TEST_SINGLE_CAMERA_MODE`; when disabled there, Camera 2 receives its own worker and independent ByteTrack/counting state.

Configure the counting line with `LINE_X1`, `LINE_Y1`, `LINE_X2`, and `LINE_Y2`. The defaults are placeholders and must be calibrated against the installed camera view.

Line counting is currently disabled with `ENABLE_LINE_COUNTING=false` so testing focuses on detection and tracking. While disabled, the video has no counting line or passed counter and the dashboard reports passed vehicles as unavailable.

The local test configuration uses laptop webcam device `0` by default at a target of 10 detection FPS. All supported vehicle classes are inferred by the custom `best.pt` checkpoint at the configured confidence threshold. The retained RTSP configuration can still select the lower-bandwidth `stream2` profile when that source is restored.

Firebase Authentication can operate without Realtime Database. Until `NEXT_PUBLIC_FIREBASE_DATABASE_URL` is provided, historical analytics and logs intentionally show empty states.
