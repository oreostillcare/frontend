import threading
import time

import pytest

from inference_scheduling import FairReentrantLock


def test_fair_lock_is_fifo_and_allows_owner_reentry():
    lock = FairReentrantLock()
    order = []
    ready = [threading.Event() for _ in range(3)]
    release_workers = threading.Event()

    threads = []
    try:
        with lock:
            with lock:
                assert lock.acquire(blocking=False)
                lock.release()
            for index in range(3):
                def worker(worker_index=index):
                    ready[worker_index].set()
                    with lock:
                        order.append(worker_index)
                        release_workers.wait(timeout=2)

                thread = threading.Thread(target=worker)
                threads.append(thread)
                thread.start()
                assert ready[index].wait(timeout=2)
                deadline = time.monotonic() + 2
                while len(lock._waiters) < index + 1 and time.monotonic() < deadline:
                    threading.Event().wait(0.001)
                assert len(lock._waiters) == index + 1, "worker did not enter the FIFO queue"
    finally:
        release_workers.set()
        for thread in threads:
            thread.join(timeout=2)
    assert not any(thread.is_alive() for thread in threads)
    assert order == [0, 1, 2]


def test_fair_lock_releases_after_exception_and_rejects_foreign_release():
    lock = FairReentrantLock()
    with pytest.raises(ValueError):
        with lock:
            raise ValueError("failed work")

    with lock:
        pass
    with pytest.raises(RuntimeError, match="un-acquired"):
        lock.release()


def test_fair_lock_removes_timed_out_waiter_without_blocking_next_waiter():
    lock = FairReentrantLock()
    with lock:
        acquired = []

        def timeout_worker():
            acquired.append(lock.acquire(timeout=0.02))

        thread = threading.Thread(target=timeout_worker)
        thread.start()
        thread.join(timeout=1)
        assert acquired == [False]
        assert len(lock._waiters) == 0

    assert lock.acquire(timeout=0.1)
    lock.release()
