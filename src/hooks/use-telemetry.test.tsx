// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSystemStatus } from "@/lib/api/system";
import type { SystemStatus } from "@/lib/api/types";

import { useTelemetry } from "./use-telemetry";

vi.mock("@/lib/api/system", () => ({ getSystemStatus: vi.fn() }));
vi.mock("@/lib/api/cameras", () => ({
  getCameras: vi.fn(() => {
    throw new Error("Duplicate camera request");
  }),
}));

afterEach(cleanup);

describe("useTelemetry", () => {
  it("uses cameras from the system snapshot and retains them on a failed refresh", async () => {
    const snapshot: SystemStatus = {
      status: "online",
      cameras: [{ id: 1, configured: true, online: true }],
    };
    vi.mocked(getSystemStatus).mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("Unavailable"));
    const { result } = renderHook(() => useTelemetry());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cameras).toEqual(snapshot.cameras);
    await act(() => result.current.refresh());
    expect(result.current.error).toBe("Unavailable");
    expect(result.current.cameras).toEqual(snapshot.cameras);
  });

  it("coalesces timer and manual refreshes while a request is pending", async () => {
    vi.useFakeTimers();
    let resolve!: (value: SystemStatus) => void;
    vi.mocked(getSystemStatus).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result, unmount } = renderHook(() => useTelemetry(2000));
    await act(async () => {
      void result.current.refresh();
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getSystemStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ status: "online", cameras: [] });
    });
    vi.mocked(getSystemStatus).mockResolvedValue({ status: "offline", cameras: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getSystemStatus).toHaveBeenCalledTimes(2);
    expect(result.current.system?.status).toBe("offline");
    unmount();
    await vi.advanceTimersByTimeAsync(4000);
    expect(getSystemStatus).toHaveBeenCalledTimes(2);
  });

  it("can recover from errors and accepts a snapshot without cameras", async () => {
    vi.mocked(getSystemStatus).mockRejectedValueOnce("network").mockResolvedValueOnce({ status: "online" });
    const { result } = renderHook(() => useTelemetry());
    await waitFor(() => expect(result.current.error).toBe("Telemetry unavailable"));
    await act(() => result.current.refresh());
    expect(result.current.error).toBeNull();
    expect(result.current.cameras).toEqual([]);
  });
});
