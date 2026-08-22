from hashlib import sha1
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1] / "datasets" / "tricycle"
TRAIN_IMAGES = ROOT / "train" / "images"
TRAIN_LABELS = ROOT / "train" / "labels"


def source_group(path: Path) -> str:
    return path.stem.split(".rf.", 1)[0]


def assigned_split(path: Path) -> str:
    bucket = int(sha1(source_group(path).encode()).hexdigest()[:8], 16) % 100
    if bucket < 80:
        return "train"
    if bucket < 90:
        return "valid"
    return "test"


def main():
    if not TRAIN_IMAGES.exists():
        raise SystemExit(f"Missing tricycle training images: {TRAIN_IMAGES}")

    for split in ("valid", "test"):
        (ROOT / split / "images").mkdir(parents=True, exist_ok=True)
        (ROOT / split / "labels").mkdir(parents=True, exist_ok=True)

    moved = {"valid": 0, "test": 0}
    for image in list(TRAIN_IMAGES.iterdir()):
        if not image.is_file():
            continue
        split = assigned_split(image)
        if split == "train":
            continue
        label = TRAIN_LABELS / f"{image.stem}.txt"
        shutil.move(str(image), ROOT / split / "images" / image.name)
        if label.exists():
            shutil.move(str(label), ROOT / split / "labels" / label.name)
        moved[split] += 1

    print(f"Tricycle grouped split ready: moved {moved['valid']} valid and {moved['test']} test images")


if __name__ == "__main__":
    main()
