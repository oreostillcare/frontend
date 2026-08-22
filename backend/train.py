from pathlib import Path
import shutil

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "datasets" / "combined" / "data.yaml"
BASE_MODEL = ROOT / "models" / "best.pt"
EXPECTED_CLASSES = [
    "etrike", "ebike", "bicycle", "bus", "jeepney", "motorcycle",
    "van", "pickup", "suv", "sedan", "truck", "ambulance", "tricycle",
]
MIN_TRAIN_IMAGES = 80_000


def validate_dataset() -> None:
    import yaml

    if not DATA.exists():
        raise SystemExit("Missing combined data.yaml. Run scripts/prepare_combined_dataset.py first.")
    config = yaml.safe_load(DATA.read_text(encoding="utf-8")) or {}
    names = config.get("names", [])
    if isinstance(names, dict):
        names = [names[index] for index in sorted(names)]
    if list(names) != EXPECTED_CLASSES:
        raise SystemExit(f"Unexpected classes in data.yaml: {names}")
    train_dir = DATA.parent / config.get("train", "images/train")
    train_images = sum(
        1 for path in train_dir.glob("*")
        if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp"}
    )
    if train_images < MIN_TRAIN_IMAGES:
        raise SystemExit(
            f"Combined dataset looks partial: {train_images} train images; "
            f"expected at least {MIN_TRAIN_IMAGES}."
        )


def main():
    validate_dataset()
    if not BASE_MODEL.exists():
        raise SystemExit(f"Missing fine-tuning checkpoint: {BASE_MODEL}")

    model = YOLO(str(BASE_MODEL))
    model.train(
        data=str(DATA),
        epochs=80,
        imgsz=640,
        batch=8,
        device=0,
        workers=2,
        patience=20,
        cos_lr=True,
        close_mosaic=10,
        amp=True,
        project=str(ROOT / "runs"),
        name="roadworks-full-ph-clean",
    )
    best = Path(model.trainer.best)
    # Evaluate the selected checkpoint on the untouched test split before it
    # can replace the model used by the live application.
    test_model = YOLO(str(best))
    test_metrics = test_model.val(
        data=str(DATA),
        split="test",
        imgsz=640,
        batch=8,
        device=0,
        workers=2,
        project=str(ROOT / "runs"),
        name="roadworks-full-ph-clean-test",
    )
    print(
        f"Independent test: mAP50={test_metrics.box.map50:.4f}, "
        f"mAP50-95={test_metrics.box.map:.4f}"
    )
    destination = ROOT / "models" / "best.pt"
    destination.parent.mkdir(parents=True, exist_ok=True)
    backup = destination.with_name("best-before-full-ph.pt")
    if destination.exists() and not backup.exists():
        shutil.copy2(destination, backup)
    shutil.copy2(best, destination)
    print(f"Best model copied to {destination}")


if __name__ == "__main__":
    main()
