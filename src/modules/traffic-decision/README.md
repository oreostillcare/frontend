# Module K — Traffic Decision

The current weighted decision and signal-controller implementation remains in `backend/scoring.py`, `backend/traffic_control.py`, and `backend/traffic_transactions.py`. The Python service imports these modules from its existing backend root, so this marker avoids a risky import rewrite.
