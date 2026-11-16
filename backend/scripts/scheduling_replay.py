"""Small bounded latest-frame mailbox for offline scheduling experiments."""

from dataclasses import dataclass
import math
import threading
import time


@dataclass(frozen=True)
class FrameEnvelope:
    camera_id: int
    generation: int
    version: int
    sequence: int
    captured_at: float
    frame: object


class LatestFrameMailbox:
    """One-slot overwrite mailbox; rejects duplicate/out-of-order versions."""

    def __init__(self, camera_id: int, clock=time.monotonic):
        self.camera_id = camera_id
        self._clock = clock
        self._condition = threading.Condition()
        self._generation = -1
        self._version = -1
        self._slot = None
        self._closed = False
        self._error = None
        self.published = 0
        self.replaced = 0
        self.expired = 0

    def publish(self, envelope: FrameEnvelope) -> bool:
        with self._condition:
            if self._closed or envelope.camera_id != self.camera_id:
                return False
            if (not math.isfinite(envelope.captured_at)
                    or envelope.captured_at > self._clock()):
                return False
            if envelope.generation < self._generation:
                return False
            if envelope.generation > self._generation:
                self._generation, self._version = envelope.generation, -1
            if envelope.version <= self._version:
                return False
            self._version = envelope.version
            if self._slot is not None:
                self.replaced += 1
            self._slot = envelope
            self.published += 1
            self._condition.notify()
            return True

    def take(self, max_age_seconds: float, timeout: float | None = None):
        if not math.isfinite(max_age_seconds) or max_age_seconds <= 0:
            raise ValueError("max_age_seconds must be positive")
        deadline = None if timeout is None else self._clock() + timeout
        with self._condition:
            while self._slot is None and not self._closed:
                remaining = None if deadline is None else deadline - self._clock()
                if remaining is not None and remaining <= 0:
                    return None
                self._condition.wait(remaining)
            if self._error is not None:
                raise RuntimeError("frame producer failed") from self._error
            envelope, self._slot = self._slot, None
            self._condition.notify_all()
            if envelope is None:
                return None
            if self._clock() - envelope.captured_at > max_age_seconds:
                self.expired += 1
                return None
            return envelope

    def completion_status(self, envelope, max_age_seconds, *, stopped=False):
        """Classify publication only; this cannot undo an already tracked frame."""
        with self._condition:
            if stopped or self._error is not None:
                return "stopped"
            if envelope.camera_id != self.camera_id or envelope.generation != self._generation:
                return "superseded_generation"
            age = self._clock() - envelope.captured_at
            if not math.isfinite(age) or age < 0 or age > max_age_seconds:
                return "stale"
            # EOF closes the producer while its last selected frame finishes.
            return "current"

    def wait_for_capacity(self, timeout: float | None = None) -> bool:
        """Wait until the single slot is empty; false means closed or timed out."""
        deadline = None if timeout is None else self._clock() + timeout
        with self._condition:
            while self._slot is not None and not self._closed:
                remaining = None if deadline is None else deadline - self._clock()
                if remaining is not None and remaining <= 0:
                    return False
                self._condition.wait(remaining)
            return not self._closed

    def close(self):
        with self._condition:
            self._closed = True
            self._condition.notify_all()

    def fail(self, error: BaseException):
        with self._condition:
            self._error = error
            self._closed = True
            self._slot = None
            self._condition.notify_all()

    @property
    def closed(self):
        with self._condition:
            return self._closed

