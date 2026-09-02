import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAdminFirestore } from "@/test/firebase-admin-firestore";

const firebaseAdmin = vi.hoisted(() => ({
  adminAuth: {
    getUser: vi.fn(),
    getUserByEmail: vi.fn(),
    updateUser: vi.fn(),
  },
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

import { POST } from "./route";

const TOKEN = "phase2-complete-invitation-token";

function post(body: unknown) {
  return new Request("https://app.example/api/staff/invitations/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    authUid: "invitee-uid",
    email: "invitee@example.com",
    expiresAt: Timestamp.fromDate(new Date("2026-09-02T11:00:00.000Z")),
    invitedBy: "administrator-uid",
    normalizedEmail: "invitee@example.com",
    role: "Operator",
    status: "pending",
    username: "Invitee",
    verificationSentAt: Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z")),
    ...overrides,
  };
}

describe("invitation completion", () => {
  let firestore: ReturnType<typeof createFakeAdminFirestore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:30:00.000Z"));
    firestore = createFakeAdminFirestore();
    Object.assign(firebaseAdmin.adminDb, firestore.api);
    firebaseAdmin.adminAuth.getUser.mockResolvedValue({
      email: "invitee@example.com",
      emailVerified: true,
      uid: "invitee-uid",
    });
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValue({
      email: "invitee@example.com",
      emailVerified: true,
      uid: "invitee-uid",
    });
    firebaseAdmin.adminAuth.updateUser.mockResolvedValue({ uid: "invitee-uid" });
    lifecycle.deletePendingInvitationAuthUser.mockResolvedValue(true);
  });

  it("requires a sufficiently long token and password", async () => {
    const response = await POST(post({ password: "short", token: "bad" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid-input" });
    expect(firebaseAdmin.adminAuth.getUser).not.toHaveBeenCalled();
  });

  it("rejects an unknown invitation", async () => {
    const response = await POST(post({ password: "strong-password", token: TOKEN }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid-token" });
  });

  it.each([
    ["cancelled", "cancelled-token"],
    ["expired", "expired-token"],
    ["superseded", "expired-token"],
    ["completed", "used-token"],
    ["processing", "invalid-token"],
  ])("rejects invitation status %s as %s", async (status, code) => {
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), invitation({ status }));

    const response = await POST(post({ password: "strong-password", token: TOKEN }));

    expect(response.status).toBe(status === "processing" ? 404 : 410);
    await expect(response.json()).resolves.toMatchObject({ code });
  });

  it("expires and cleans up an invitation at the exact boundary", async () => {
    const expiredInvitation = invitation({
      expiresAt: Timestamp.fromDate(new Date("2026-09-02T10:30:00.000Z")),
      verificationSentAt: Timestamp.fromDate(new Date("2026-09-02T09:30:00.000Z")),
    });
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), expiredInvitation);

    const response = await POST(post({ password: "strong-password", token: TOKEN }));

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ code: "expired-token" });
    expect(firestore.get("pendingStaffInvitations", hashToken(TOKEN))).toMatchObject({ status: "expired" });
    expect(lifecycle.deletePendingInvitationAuthUser).toHaveBeenCalledWith(expiredInvitation);
  });

  it("restores pending state when the Firebase Auth user is missing", async () => {
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), invitation());
    firebaseAdmin.adminAuth.getUser.mockRejectedValueOnce({ code: "auth/user-not-found" });

    const response = await POST(post({ password: "strong-password", token: TOKEN }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "missing-auth-user" });
    expect(firestore.get("pendingStaffInvitations", hashToken(TOKEN))).toMatchObject({ status: "pending" });
  });

  it("rejects an Auth user whose email does not match the invitation", async () => {
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), invitation());
    firebaseAdmin.adminAuth.getUser.mockResolvedValueOnce({
      email: "other@example.com",
      emailVerified: true,
      uid: "invitee-uid",
    });

    const response = await POST(post({ password: "strong-password", token: TOKEN }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "auth-user-mismatch" });
    expect(firestore.get("pendingStaffInvitations", hashToken(TOKEN))).toMatchObject({ status: "pending" });
  });

  it("requires Firebase email verification before accepting a password", async () => {
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), invitation());
    firebaseAdmin.adminAuth.getUser.mockResolvedValueOnce({
      email: "invitee@example.com",
      emailVerified: false,
      uid: "invitee-uid",
    });

    const response = await POST(post({ password: "strong-password", token: TOKEN }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "email-unverified" });
    expect(firebaseAdmin.adminAuth.updateUser).not.toHaveBeenCalled();
    expect(firestore.get("pendingStaffInvitations", hashToken(TOKEN))).toMatchObject({ status: "pending" });
  });

  it("sets the password, creates staff, and marks the invitation completed", async () => {
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), invitation());

    const response = await POST(post({ password: "strong-password", token: TOKEN }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: "Your verified SmartRoad staff account is active." });
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalledWith("invitee-uid", {
      disabled: false,
      displayName: "Invitee",
      password: "strong-password",
    });
    expect(firestore.get("staff", "invitee-uid")).toMatchObject({
      accountStatus: "active",
      email: "invitee@example.com",
      emailVerified: true,
      role: "Operator",
      uid: "invitee-uid",
    });
    expect(firestore.get("pendingStaffInvitations", hashToken(TOKEN))).toMatchObject({ status: "completed" });
  });

  it("returns the invitation to pending when the final batch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    firestore.seed("pendingStaffInvitations", hashToken(TOKEN), invitation());
    firebaseAdmin.adminDb.batch = vi.fn(() => ({
      commit: vi.fn().mockRejectedValue(new Error("Batch unavailable")),
      create: vi.fn(),
      update: vi.fn(),
    }));

    const response = await POST(post({ password: "strong-password", token: TOKEN }));

    expect(response.status).toBe(500);
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalled();
    expect(firestore.get("staff", "invitee-uid")).toBeUndefined();
    expect(firestore.get("pendingStaffInvitations", hashToken(TOKEN))).toMatchObject({ status: "pending" });
  });
});
