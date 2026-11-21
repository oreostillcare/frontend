# SmartRoad C# backend migration

This is an additive migration shell. The Python backend remains the active runtime while each contract is mirrored and tested one at a time.

## Current boundary

- `SmartRoad.Api` mirrors `GET /api/health` and returns `{ "status": "ok" }`.
- No frontend route, Firebase write, camera pipeline, traffic decision, or node behavior is changed.

## Next boundaries

Migrate read-only contracts first, then shared domain models, then write paths. Keep camera/YOLO/OpenVINO integration in Python until an explicit interop boundary is tested.
