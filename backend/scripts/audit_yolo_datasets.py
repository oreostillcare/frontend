from collections import Counter
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1] / "datasets"
DATASETS = (
    "jeepney_lozano",
    "jeepney_augmented",
    "tricycle_jeep",
    "dlsud_vehicles",
    "traffico_ph",
)


def names_list(raw):
    if isinstance(raw, dict):
        return [str(raw[index]) for index in sorted(raw)]
    return [str(name) for name in (raw or [])]


def resolve_images(base: Path, relative: str) -> Path:
    candidate = (base / relative).resolve()
    if candidate.exists():
        return candidate
    clean = [part for part in Path(relative).parts if part not in (".", "..")]
    return base.joinpath(*clean)


for dataset_name in DATASETS:
    yaml_files = list((ROOT / dataset_name).rglob("data.yaml"))
    if not yaml_files:
        print(f"\n{dataset_name}: missing data.yaml")
        continue
    yaml_path = yaml_files[0]
    data = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
    names = names_list(data.get("names"))
    print(f"\n{dataset_name}: {names}")
    total = Counter()
    for split_key in ("train", "val", "test"):
        relative = data.get(split_key)
        if not relative:
            print(f"  {split_key}: unavailable")
            continue
        image_dir = resolve_images(yaml_path.parent, relative)
        if image_dir.name != "images" and (image_dir / "images").exists():
            image_dir = image_dir / "images"
        label_dir = image_dir.parent / "labels"
        images = sum(
            1 for path in image_dir.glob("*")
            if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp"}
        )
        counts = Counter()
        for label in label_dir.glob("*.txt"):
            for row in label.read_text(encoding="utf-8", errors="ignore").splitlines():
                parts = row.split()
                if not parts:
                    continue
                class_id = int(float(parts[0]))
                name = names[class_id] if 0 <= class_id < len(names) else f"invalid:{class_id}"
                counts[name] += 1
        total.update(counts)
        summary = ", ".join(f"{name}={count}" for name, count in counts.most_common())
        print(f"  {split_key}: images={images}, boxes={sum(counts.values())}; {summary}")
    print("  TOTAL: " + ", ".join(f"{name}={count}" for name, count in total.most_common()))
