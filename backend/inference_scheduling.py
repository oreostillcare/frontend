"""Fair reentrant lock used when cameras share an OpenVINO infer request."""

from collections import deque
import threading
import time


class FairReentrantLock:
    """A FIFO lock with RLock-style ownership and exception-safe context use."""

    def __init__(self):
        self._condition = threading.Condition()
        self._waiters = deque()
        self._owner = None
        self._depth = 0

    def acquire(self, blocking=True, timeout=-1):
        ident = threading.get_ident()
        with self._condition:
            if self._owner == ident:
                self._depth += 1
                return True
            if not blocking and (self._owner is not None or self._waiters):
                return False
            ticket = object()
            self._waiters.append(ticket)
            deadline = None if timeout is None or timeout < 0 else time.monotonic() + timeout
            try:
                while self._owner is not None or self._waiters[0] is not ticket:
                    if not blocking:
                        self._waiters.remove(ticket)
                        self._condition.notify_all()
                        return False
                    remaining = None if deadline is None else deadline - time.monotonic()
                    if remaining is not None and remaining <= 0:
                        self._waiters.remove(ticket)
                        self._condition.notify_all()
                        return False
                    self._condition.wait(remaining)
                self._waiters.popleft()
                self._owner = ident
                self._depth = 1
                return True
            except BaseException:
                if ticket in self._waiters:
                    self._waiters.remove(ticket)
                    self._condition.notify_all()
                raise

    def release(self):
        ident = threading.get_ident()
        with self._condition:
            if self._owner != ident:
                raise RuntimeError("cannot release an un-acquired lock")
            self._depth -= 1
            if self._depth == 0:
                self._owner = None
                self._condition.notify_all()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.release()
        return False
