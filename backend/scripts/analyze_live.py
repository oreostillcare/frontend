"""Read-only correlation of numeric live benchmark reports; no camera or model imports."""

import argparse
import json
from pathlib import Path
import statistics


def mean(values):
    return round(statistics.mean(values), 3) if values else None


def correlate(rows, left, right):
    pairs = [(row[left], row[right]) for row in rows if row.get(left) is not None and row.get(right) is not None]
    if len(pairs) < 3 or len({p[0] for p in pairs}) < 2 or len({p[1] for p in pairs}) < 2:
        return None
    return round(statistics.correlation([p[0] for p in pairs], [p[1] for p in pairs]), 4)


def analyze(path, camera="1"):
    report = json.loads(path.read_text(encoding="utf-8"))
    output = {"file": str(path), "status": report.get("status"), "measurements": []}
    logical = report.get("host", {}).get("logicalCpus") or 1
    for measurement in report.get("measurements", []):
        rows = []
        previous = None
        for sample in measurement["samples"]:
            state = sample["cameras"][camera]
            frames = sample.get("completedFrames", {}).get(camera, [])
            timing = state["lastFrameTimings"]
            row = {"elapsedSeconds": sample["elapsedSeconds"], "timestampUtc": sample.get("timestampUtc"),
                   "systemCpu": sample["systemCpuPercent"],
                   "pythonCpu": sample["pythonCpuPercentOneCore100"] / logical,
                   "rssMiB": sample["pythonRssMb"], "processLoad": sample.get("processLoad")}
            row["otherCpuApprox"] = max(0, row["systemCpu"] - row["pythonCpu"])
            for key in ("localInferenceMs", "cocoInferenceMs", "processingMs", "frameAgeMs"):
                row[key] = mean([frame[key] for frame in frames if key in frame]) if frames else timing.get(key)
            row["fps"] = ((state["completedFrames"] - previous["cameras"][camera]["completedFrames"]) /
                          (sample["elapsedSeconds"] - previous["elapsedSeconds"])) if previous else None
            previous = sample
            rows.append(row)
        groups = {}
        for label, selected in (("systemCpuAtLeast80", [r for r in rows if r["systemCpu"] >= 80]),
                                ("systemCpuBelow80", [r for r in rows if r["systemCpu"] < 80])):
            groups[label] = {"samples": len(selected), **{key: mean([r[key] for r in selected if r.get(key) is not None])
                            for key in ("systemCpu", "pythonCpu", "otherCpuApprox", "processingMs", "frameAgeMs", "fps")}}
        segments = []
        duration = measurement["seconds"]
        for index in range(4):
            selected = [r for r in rows if duration * index / 4 <= r["elapsedSeconds"] < duration * (index + 1) / 4 + .01]
            segments.append({"quarter": index + 1, **{key: mean([r[key] for r in selected if r.get(key) is not None])
                             for key in ("systemCpu", "pythonCpu", "processingMs", "frameAgeMs", "rssMiB", "fps")}})
        output["measurements"].append({
            "scenario": measurement["scenario"], "seconds": duration,
            "timingCorrelationSource": "per-interval mean of all completed frames" if "perFrameTimings" in measurement["cameras"][camera]
                                       else "latest completed frame sampled at 1 Hz; historical alignment is approximate",
            "pearsonVsProcessing": {key: correlate(rows, key, "processingMs") for key in (
                "elapsedSeconds", "systemCpu", "pythonCpu", "otherCpuApprox", "localInferenceMs", "cocoInferenceMs", "frameAgeMs", "fps")},
            "cpuGroups": groups, "quarters": segments,
            "largestProcessingIntervals": sorted(rows, key=lambda row: row.get("processingMs") or 0, reverse=True)[:12],
            "samples": rows,
        })
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    results = [analyze(path) for path in args.inputs]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2), encoding="utf-8")
    for result in results:
        print(result["file"])
        for measurement in result["measurements"]:
            print(json.dumps({key: measurement[key] for key in ("scenario", "seconds", "pearsonVsProcessing", "cpuGroups", "quarters")}))


if __name__ == "__main__":
    main()
