"""Optional, bounded diagnostics. Never participates in detection/control decisions."""

import threading
import time
from contextlib import contextmanager, nullcontext


class StageProfiler:
    def __init__(self, enabled: bool = False):
        self.enabled = enabled
        self.values: dict[str, float] = {}

    def reset(self) -> None:
        if self.enabled:
            self.values = {}

    def measure(self, name: str):
        return self._measure(name) if self.enabled else nullcontext()

    @contextmanager
    def _measure(self, name: str):
        started = time.perf_counter()
        try:
            yield
        finally:
            self.values[name] = (time.perf_counter() - started) * 1000

    def snapshot(self) -> dict[str, float]:
        return {name: round(value, 3) for name, value in self.values.items()}


DISABLED_PROFILER = StageProfiler()


class ProcessSampler:
    """One process-wide sample per second, shared by both cameras.

    psutil is supplied by the installed Ultralytics dependency tree. If absent,
    diagnostics remain available with an explicit resource-sampling error.
    Process CPU follows psutil's convention: 100% means one logical CPU busy.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._process = None
        self._sampled_at = 0.0
        self._value: dict = {}

    def snapshot(self) -> dict:
        with self._lock:
            now = time.monotonic()
            if now - self._sampled_at < 1 and self._value:
                return dict(self._value)
            try:
                import psutil

                if self._process is None:
                    self._process = psutil.Process()
                    self._process.cpu_percent()
                    psutil.cpu_percent()
                    self._value = {"processCpuPercent": None, "systemCpuPercent": None}
                else:
                    self._value = {
                        "processCpuPercent": self._process.cpu_percent(),
                        "systemCpuPercent": psutil.cpu_percent(),
                    }
                self._value.update({
                    "processRssMb": round(self._process.memory_info().rss / (1024 * 1024), 2),
                    "systemMemoryPercent": psutil.virtual_memory().percent,
                })
            except Exception as error:
                # Optional diagnostics must not make camera telemetry unavailable.
                self._value = {"resourceSamplingError": str(error)}
            self._sampled_at = now
            return dict(self._value)


PROCESS_SAMPLER = ProcessSampler()
