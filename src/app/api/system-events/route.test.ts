import { beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: vi.fn(() => ({ add: firestore.add })) },
}));

import { POST } from "./route";

const event = {
  occurredAt: "2026-11-21T08:00:00Z",
  eventType: "camera_disconnected",
  category: "camera",
  component: "camera-1",
  severity: "warning",
  message: "Camera is disconnected",
  eventStatus: "observed",
  nodeId: "node-a",
  laneId: "lane-a",
};

function request(body: unknown = event, secret = "test-secret") {
  return new Request("http://localhost/api/system-events", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("system event ingestion", () => {
  beforeEach(() => {
    vi.stubEnv("SYSTEM_LOGS_SECRET", "test-secret");
    firestore.add.mockResolvedValue({ id: "event-1" });
  });

  it("persists a sanitized backend event", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(firestore.add).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: event.eventType, source: "backend", occurredAt: expect.any(Date) }),
    );
    expect(await response.json()).toEqual({ success: true, eventId: "event-1" });
  });

  it("rejects unauthorized and invalid events", async () => {
    expect((await POST(request(event, "wrong"))).status).toBe(401);
    expect((await POST(request({ ...event, severity: "fatal" }))).status).toBe(400);
    expect(firestore.add).not.toHaveBeenCalled();
  });
});
