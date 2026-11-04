"""List DirectShow source indices without opening devices or starting the app."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from usb_devices import enumerate_usb_devices


if __name__ == "__main__":
    devices = enumerate_usb_devices()
    print(json.dumps({"discoveryAvailable": devices is not None, "devices": devices}, indent=2))
    if devices is None:
        print("Install backend requirements on Windows for DirectShow discovery.")
        raise SystemExit(2)
