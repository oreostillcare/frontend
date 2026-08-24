from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1] / "datasets"
for name in (
    "etrike_ebike", "road_vehicles", "tricycle", "jeepney",
    "jeepney_lozano", "jeepney_augmented", "tricycle_jeep",
    "dlsud_vehicles", "traffico_ph", "combined",
):
    files = list((ROOT / name).rglob("data.yaml")) if (ROOT / name).exists() else []
    if not files: print(f"{name}: not downloaded"); continue
    path = files[0]; data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}; names = data.get("names", [])
    print(f"\n{name}: {path}"); print(f"classes ({len(names)}): {names}")
    for key in ("train", "val", "test"): print(f"{key}: {data.get(key, '--')}")
