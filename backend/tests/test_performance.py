from types import SimpleNamespace
from unittest.mock import Mock
import sys

import performance
from performance import ProcessSampler, StageProfiler


def test_disabled_profiling_does_not_read_a_clock(monkeypatch):
    clock = Mock(side_effect=AssertionError("disabled profiler read clock"))
    monkeypatch.setattr(performance.time, "perf_counter", clock)
    profiler = StageProfiler(False)
    with profiler.measure("unused"):
        pass
    assert profiler.snapshot() == {}


def test_profile_is_bounded_to_the_latest_frame(monkeypatch):
    monkeypatch.setattr(performance.time, "perf_counter", Mock(side_effect=[1.0, 1.025]))
    profiler = StageProfiler(True)
    with profiler.measure("stageMs"):
        pass
    assert profiler.snapshot() == {"stageMs": 25.0}
    profiler.reset()
    assert profiler.snapshot() == {}


def test_resources_are_sampled_once_per_second_and_cpu_is_primed(monkeypatch):
    process = SimpleNamespace(cpu_percent=Mock(return_value=120.0), memory_info=lambda: SimpleNamespace(rss=1048576))
    psutil = SimpleNamespace(
        Process=lambda: process,
        cpu_percent=Mock(return_value=30.0),
        virtual_memory=lambda: SimpleNamespace(percent=40.0),
    )
    monkeypatch.setitem(sys.modules, "psutil", psutil)
    now = [10.0]
    monkeypatch.setattr(performance.time, "monotonic", lambda: now[0])
    sampler = ProcessSampler()
    assert sampler.snapshot()["processCpuPercent"] is None
    assert sampler.snapshot()["processRssMb"] == 1
    assert process.cpu_percent.call_count == 1
    now[0] += 1
    assert sampler.snapshot()["processCpuPercent"] == 120.0


def test_resource_sampling_error_does_not_break_telemetry(monkeypatch):
    monkeypatch.setitem(sys.modules, "psutil", SimpleNamespace(Process=Mock(side_effect=RuntimeError("denied"))))
    assert ProcessSampler().snapshot() == {"resourceSamplingError": "denied"}
