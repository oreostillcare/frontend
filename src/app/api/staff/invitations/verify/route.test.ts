import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAdminFirestore } from "@/test/firebase-admin-firestore";

const firebaseAdmin = vi.hoisted(() => ({
  adminAuth: {},
  adminDb: {
    batch: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

const lifecycle = vi.hoisted(() => ({
  deletePendingInvitationAuthUser: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => firebaseAdmin);
vi.mock("@/lib/firebase/staff-lifecycle", () => lifecycle);

import { hashToken } from "@/lib/firebase/admin-staff";

import { GET } from "./route";

const TOKEN = "phase2-invitation-verification-token";

function get(token?: string) {
  const url = new URL("https://app.example/api/staff/invitations/verify");
  if (token !== undefined) url.searchParams.set("token", token);
  return new Request(url);
}

describe("invitation verification", () => {
  let firestore: ReturnType<typeof createFakeAdminFirestore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:00:00.000Z"));
    firestore = createFakeAdminFirestore();
    Object.assign(firebaseAdmin.adminDb, firestore.api);
    lifecycle.deletePendingInvitationAuthUser.mockResolvedValue(true);
  });

  it("requires a token", async () => {
    const response = await GET(get());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "missing-token" });
  });

  it("rejects an unknown token", async () => {
    const response = await GET(get(TOKEN));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid-token" });
  });

  it.each([
    ["cancelled", "cancelled-token"],
    ["expired", "expired-token"],
    ["expiring", "expired-token"],
    ["superseded", "expired-token"],
    ["completed", "used-token"],
    ["processing", "invalid-token"],
  ])("maps invitation status %s to %s", async (status, code) => {
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), {
      email: "invitee@example.com",
      expiresAt: Timestamp.fromDate(new Date("2026-09-02T11:00:00.000Z")),
      status,
    });

    const response = await GET(get(TOKEN));

    expect(response.status).toBe(status === "processing" ? 404 : 410);
    await expect(response.json()).resolves.toMatchObject({ code });
  });

  it("expires a pending invitation at the exact expiration boundary", async () => {
    const invitation = {
      authUid: "invitee-uid",
      createdAt: Timestamp.fromDate(new Date("2026-09-02T09:00:00.000Z")),
      email: "invitee@example.com",
      expiresAt: Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z")),
      status: "pending",
    };
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), invitation);

    const response = await GET(get(TOKEN));

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ code: "expired-token" });
    expect(firestore.get("pendingStaffInvitations", hashToken(TOKEN))).toMatchObject({ status: "expired" });
    expect(lifecycle.deletePendingInvitationAuthUser).toHaveBeenCalledWith(invitation);
  });

  it("still returns the expiration error when Auth-user cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), {
      email: "invitee@example.com",
      expiresAt: Timestamp.fromDate(new Date("2026-09-02T09:59:59.999Z")),
      status: "pending",
    });
    lifecycle.deletePendingInvitationAuthUser.mockRejectedValueOnce(new Error("Auth unavailable"));

    const response = await GET(get(TOKEN));

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ code: "expired-token" });
  });

  it("returns the current invitation details while the link is active", async () => {
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), {
      email: "invitee@example.com",
      expiresAt: Timestamp.fromDate(new Date("2026-09-02T10:00:00.001Z")),
      role: "Operator",
      status: "pending",
      username: "Invitee",
      verificationSentAt: Timestamp.fromDate(new Date("2026-09-02T09:30:00.000Z")),
    });

    const response = await GET(get(TOKEN));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      email: "invitee@example.com",
      role: "Operator",
      username: "Invitee",
    });
    expect(lifecycle.deletePendingInvitationAuthUser).not.toHaveBeenCalled();
  });
});
