import type { User } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordStaffActivityEvent } from "./staff-activity-client";

describe("staff activity client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bounds an unresponsive activity fetch and aborts it", async () => {
    const fetchActivity = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchActivity);
    const user = { getIdToken: vi.fn().mockResolvedValue("test-token") } as unknown as User;
    const event = recordStaffActivityEvent(user, "logout");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(event).resolves.toBeUndefined();
    expect(fetchActivity).toHaveBeenCalledWith("/api/staff/activity", expect.objectContaining({ keepalive: true }));
    const signal = fetchActivity.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds token acquisition and does not start a late request after timeout", async () => {
    let resolveToken: (value: string) => void = () => undefined;
    const getIdToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );
    const fetchActivity = vi.fn();
    vi.stubGlobal("fetch", fetchActivity);
    const event = recordStaffActivityEvent({ getIdToken } as unknown as User, "login");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(event).resolves.toBeUndefined();
    resolveToken("late-token");
    await Promise.resolve();
    expect(fetchActivity).not.toHaveBeenCalled();
  });

  it("records successful events and clears its timer", async () => {
    const fetchActivity = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchActivity);
    await recordStaffActivityEvent({ getIdToken: vi.fn().mockResolvedValue("test-token") } as unknown as User, "login");
    expect(fetchActivity).toHaveBeenCalledWith(
      "/api/staff/activity",
      expect.objectContaining({
        body: JSON.stringify({ event: "login" }),
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tolerates missing users and logging failures", async () => {
    const fetchActivity = vi.fn();
    vi.stubGlobal("fetch", fetchActivity);
    await recordStaffActivityEvent(null, "logout");
    await recordStaffActivityEvent(
      { getIdToken: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as User,
      "logout",
    );
    expect(fetchActivity).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
