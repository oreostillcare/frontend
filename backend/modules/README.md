# Backend modules

These folders mirror the A–P flowchart modules. Python implementation files live in the module that owns them; modules that are currently frontend/API-only contain a short scope note instead of fabricated backend logic.

| Module | Folder | Current backend responsibility |
| --- | --- | --- |
| A | `authentication_session` | Frontend Firebase authentication; no Python implementation yet |
| B | `dashboard` | Flask entrypoint remains `backend/app.py` to preserve `python app.py` |
| C | `live_monitoring` | Camera capture, detection, tracking, counting, model/runtime, USB, and performance |
| D | `traffic_analytics` | Frontend/Firestore read presentation; no separate Python service |
| E | `system_logs` | Frontend/Firestore log presentation; no separate Python service |
| F | `staff_management` | Firebase staff operations are handled by the Next.js app |
| G | `account` | Firebase account operations are handled by the Next.js app |
| H | `firebase_data_error` | Shared error handling is handled at the API/UI boundary |
| I | `offline_connectivity` | Connectivity state is handled by the existing API/UI layers |
| J | `logout_route_protection` | Frontend route protection |
| K | `traffic_decision` | Weighted scoring and signal-control decisions |
| L | `timer_batching` | Timer batch manager |
| M | `live_maps` | Map and node-state UI/API are currently Next.js-owned |
| N | `node_session_logs` | Session-log UI/API are currently Next.js-owned |
| O | `firebase_persistence` | Traffic transaction persistence |
| P | `notifications` | Website alarm UI exists; email integration is deferred |

`backend/config.py` remains a shared backend configuration dependency, and `backend/run_local.py` remains a launcher. They are not duplicated into feature folders.
