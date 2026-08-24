from pathlib import Path
import shutil
import yaml

ROOT = Path(__file__).resolve().parents[1] / "datasets"
FINAL_OUTPUT = ROOT / "combined"
OUTPUT = ROOT / "combined_building"
ALIASES = {
    "bemac-e-trikes": "etrike",
    "star-8-e-trikes": "etrike",
    "roofed-e-bike": "ebike",
    "e-bike": "ebike",
    "e bike": "ebike",
    "electric bike": "ebike",
    "e-trike": "etrike",
    "e trike": "etrike",
    "electric tricycle": "etrike",
    "tricycle": "tricycle",
    "tricycle - v3 2023-07-16 4:07pm": "tricycle",
    "tricycle - v3 2023-07-16 4-07pm": "tricycle",
    "jeep": "jeepney",
    "jeepney": "jeepney",
    "public utility jeepney": "jeepney",
    "electric bike": "ebike",
    "pickup truck": "pickup",
    "sports utility vehicle": "suv",
    "large bus": "bus",
    "small bus": "bus",
    "medium goods vehicle": "truck",
    "light goods vehicle": "van",
    "hatchback": "sedan",
    "car": "sedan",
    # Multicab has only a handful of labels and visually overlaps with kei
    # vans/light vans in CCTV footage. Keep one stable visual class.
    "multicab": "van",
}

def selected_images(image_dir: Path, source_name: str, split: str):
    return [
        image for image in image_dir.glob("*")
        if image.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp"}
    ]

def names_list(raw):
    if isinstance(raw, dict): return [raw[index] for index in sorted(raw)]
    return list(raw or [])

sources = []
for source_name in (
    "etrike_ebike",
    "road_vehicles",
    "tricycle",
    "jeepney",
    "jeepney_lozano",
    "jeepney_augmented",
    "tricycle_jeep",
    "dlsud_vehicles",
    "traffico_ph",
):
    yamls = list((ROOT / source_name).rglob("data.yaml")) if (ROOT / source_name).exists() else []
    if yamls:
        data = yaml.safe_load(yamls[0].read_text(encoding="utf-8")) or {}
        normalized = [ALIASES.get(str(name).strip().lower(), str(name).strip().lower()) for name in names_list(data.get("names"))]
        sources.append((source_name, yamls[0].parent, data, normalized))
if not sources: raise SystemExit("No source data.yaml files found. Download the datasets first.")
classes = []
for _, _, _, names in sources:
    for name in names:
        if name not in classes: classes.append(name)
if OUTPUT.exists(): shutil.rmtree(OUTPUT)
for split in ("train", "val", "test"):
    (OUTPUT / "images" / split).mkdir(parents=True, exist_ok=True); (OUTPUT / "labels" / split).mkdir(parents=True, exist_ok=True)
for source_name, base, data, source_classes in sources:
    remap = {index: classes.index(name) for index, name in enumerate(source_classes)}
    for split in ("train", "val", "test"):
        relative = data.get(split)
        if not relative: continue
        image_dir = (base / relative).resolve()
        if not image_dir.exists():
            clean_parts = [part for part in Path(relative).parts if part not in (".", "..")]
            image_dir = base.joinpath(*clean_parts)
        if image_dir.name != "images" and (image_dir / "images").exists(): image_dir = image_dir / "images"
        label_dir = image_dir.parent / "labels"
        for image in selected_images(image_dir, source_name, split):
            target_stem = f"{source_name}_{image.stem}"; shutil.copy2(image, OUTPUT / "images" / split / f"{target_stem}{image.suffix.lower()}")
            label = label_dir / f"{image.stem}.txt"; target = OUTPUT / "labels" / split / f"{target_stem}.txt"
            lines = []
            if label.exists():
                for row in label.read_text(encoding="utf-8").splitlines():
                    parts = row.split()
                    if parts and int(parts[0]) in remap: lines.append(" ".join([str(remap[int(parts[0])]), *parts[1:]]))
            target.write_text("\n".join(lines), encoding="utf-8")
(OUTPUT / "data.yaml").write_text(yaml.safe_dump({"path": str(FINAL_OUTPUT), "train": "images/train", "val": "images/val", "test": "images/test", "names": classes}, sort_keys=False), encoding="utf-8")
if FINAL_OUTPUT.exists(): shutil.rmtree(FINAL_OUTPUT)
OUTPUT.rename(FINAL_OUTPUT)
print(f"Combined dataset ready: {FINAL_OUTPUT}"); print(f"Classes: {classes}")
