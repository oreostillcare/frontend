import json

from scripts.analyze_live import analyze


def test_correlation_uses_all_frames_in_interval_and_preserves_spike_process_evidence(tmp_path):
    samples = []
    for index, (cpu, tail) in enumerate(((20, 20), (90, 300), (20, 20)), start=1):
        samples.append({
            "elapsedSeconds": index, "systemCpuPercent": cpu, "pythonCpuPercentOneCore100": 100,
            "pythonRssMb": 500, "processLoad": {"topProcesses": [{"name": "background.exe"}]},
            "cameras": {"1": {"completedFrames": index * 10, "lastFrameTimings": {
                "processingMs": 20, "localInferenceMs": 8, "cocoInferenceMs": 8, "frameAgeMs": 25}}},
            "completedFrames": {"1": [{"processingMs": 20, "frameAgeMs": 25},
                                       {"processingMs": tail, "frameAgeMs": tail + 5}]},
        })
    fixture = tmp_path / "report.json"
    fixture.write_text(json.dumps({"host": {"logicalCpus": 4}, "measurements": [{
        "seconds": 3, "scenario": "none", "samples": samples,
        "cameras": {"1": {"perFrameTimings": {}}},
    }]}))
    before = fixture.read_bytes()
    result = analyze(fixture)["measurements"][0]
    assert result["pearsonVsProcessing"]["otherCpuApprox"] == 1
    worst = result["largestProcessingIntervals"][0]
    assert worst["elapsedSeconds"] == 2
    assert worst["processingMs"] == 160  # The latest frame alone would hide this tail.
    assert worst["processLoad"]["topProcesses"][0]["name"] == "background.exe"
    assert fixture.read_bytes() == before
