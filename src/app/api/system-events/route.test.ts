import { beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({ add: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: vi.fn(() => ({ add: firestore.add, get: firestore.get })) },
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
    vi.clearAllMocks();
    vi.stubEnv("SYSTEM_LOGS_SECRET", "test-secret");
    vi.stubEnv("MAILJET_API_KEY", "");
    vi.stubEnv("MAILJET_API_SECRET", "");
    vi.stubEnv("MAILJET_SENDER_EMAIL", "");
    firestore.add.mockResolvedValue({ id: "event-1", update: firestore.update });
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

  it("emails active staff for warning events and excludes archived staff", async () => {
    vi.stubEnv("MAILJET_API_KEY", "mailjet-key");
    vi.stubEnv("MAILJET_API_SECRET", "mailjet-secret");
    vi.stubEnv("MAILJET_SENDER_EMAIL", "alerts@example.com");
    firestore.get.mockResolvedValue({
      docs: [
        { data: () => ({ email: "operator@example.com", accountStatus: "active" }) },
        { data: () => ({ email: "archived@example.com", accountStatus: "archived" }) },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Messages: [{ Status: "success", To: [{ MessageUUID: "message-1" }] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const response = await POST(request({ ...event, severity: "warning" }));

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.mailjet.com/v3.1/send",
      expect.objectContaining({ method: "POST" }),
    );
    const [, requestInit] = vi.mocked(fetch).mock.calls[0];
    const payload = JSON.parse(String(requestInit?.body)) as { Messages: Array<{ Subject: string; TextPart: string }> };
    expect(payload.Messages[0].Subject).toContain("Camera disconnected");
    expect(payload.Messages[0].TextPart).toContain("affecting Node A on Lane A");
    expect(firestore.update).toHaveBeenCalledWith(
      expect.objectContaining({ notification: expect.objectContaining({ status: "accepted", attempts: 1 }) }),
    );
  });
});
