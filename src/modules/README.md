# SmartRoad modules

Each folder is a named module from the SmartRoad flowchart. Next.js route files remain under `src/app` because the framework requires those locations; they are thin adapters into these modules.

| Module | Folder | Responsibility |
| --- | --- | --- |
| A | `authentication-session` | Login, registration, Google sign-in, validation, and lockout logic |
| B | `dashboard` | Dashboard overview and telemetry summary |
| C | `live-monitoring` | Camera cards, raw/annotated feeds, and monitoring composition |
| D | `traffic-analytics` | Analytics filters, charts, traffic data, and history tables |
| E | `system-logs` | System-log filters and event presentation |
| F | `staff-management` | Administrator staff table and dialogs |
| G | `account` | Account profile and preferences |
| H | `firebase-data-error` | Shared Firebase/API error boundary notes; shared primitives remain in `src/lib/firebase` |
| I | `offline-connectivity` | Detection API client, telemetry polling, offline/error state, and API types |
| J | `logout-route-protection` | Protected dashboard session guard and logout hook |
| K | `traffic-decision` | Backend weighted traffic decision/controller implementation |
| L | `timer-batching` | Deferred timer-batching boundary; existing backend implementation remains unchanged |
| M | `live-maps` | Map UI, node state, coordinates, and node-state service |
| N | `node-session-logs` | Session-log UI, types, Firebase mapping, and read service |
| O | `firebase-persistence` | Completed traffic transaction validation and Firestore writes |
| P | `notifications` | Current website node-alarm provider; email delivery remains deferred |

