# E — System Logs

The backend health monitor reports camera, detector, Wi-Fi/ESP32, and traffic-controller
transitions to `POST /api/system-events`. The Next.js route validates the payload and writes
the live event to Firestore `systemEvents`, which the logs screen already subscribes to.

The writer reuses `TRAFFIC_INGEST_SECRET` by default. Set `SYSTEM_LOGS_URL`,
`SYSTEM_LOGS_SECRET`, `SYSTEM_LOGS_INTERVAL_SECONDS`, or `SYSTEM_LOGS_CRITICAL_AFTER`
only when the defaults need changing. Each failure records the initial warning, three
retry events, then one critical event if it persists. GPS, compass, battery, and node-location events
remain disabled until their hardware telemetry exists.
