import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAdminFirestore } from "@/test/firebase-admin-firestore";

const firebaseAdmin = vi.hoisted(() => ({
  adminAuth: {
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    getUser: vi.fn(),
    getUserByEmail: vi.fn(),
    updateUser: vi.fn(),
    verifyIdToken: vi.fn(),
  },
  adminDb: {
    batch: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

const verificationEmail = vi.hoisted(() => ({ sendFirebaseVerificationEmail: vi.fn() }));
const lifecycle = vi.hoisted(() => ({ deletePendingInvitationAuthUser: vi.fn() }));

vi.mock("@/lib/firebase/admin", () => firebaseAdmin);
vi.mock("@/lib/firebase/firebase-verification-email", () => verificationEmail);
vi.mock("@/lib/firebase/staff-lifecycle", () => lifecycle);

import { POST } from "./route";

function post(email = "invitee@example.com", authenticated = true) {
  return new Request("https://app.example/api/staff/resend-verification", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Authorization: "Bearer administrator-token" } : {}),
    },
    body: JSON.stringify({ email }),
  });
}

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    authUid: "invitee-uid",
    createdAt: Timestamp.fromDate(new Date("2026-09-02T08:00:00.000Z")),
    email: "invitee@example.com",
    expiresAt: Timestamp.fromDate(new Date("2026-09-02T09:00:00.000Z")),
    invitedBy: "administrator-uid",
    normalizedEmail: "invitee@example.com",
    role: "Operator",
    status: "expired",
    username: "Invitee",
    verificationResendCount: 1,
    ...overrides,
  };
}

describe("resend verification", () => {
  let firestore: ReturnType<typeof createFakeAdminFirestore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:00:00.000Z"));
    vi.stubEnv("APP_BASE_URL", "https://app.example");
    firestore = createFakeAdminFirestore();
    Object.assign(firebaseAdmin.adminDb, firestore.api);
    firestore.seed("staff", "administrator-uid", {
      accountStatus: "active",
      email: "admin@example.com",
      normalizedEmail: "admin@example.com",
      role: "Administrator",
      uid: "administrator-uid",
    });
    firebaseAdmin.adminAuth.verifyIdToken.mockResolvedValue({
      email: "admin@example.com",
      uid: "administrator-uid",
    });
    firebaseAdmin.adminAuth.getUser.mockResolvedValue({ email: "invitee@example.com", uid: "invitee-uid" });
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValue({ email: "invitee@example.com", uid: "invitee-uid" });
    firebaseAdmin.adminAuth.updateUser.mockResolvedValue({ email: "invitee@example.com", uid: "invitee-uid" });
    firebaseAdmin.adminAuth.createUser.mockResolvedValue({ email: "invitee@example.com", uid: "new-invitee-uid" });
    firebaseAdmin.adminAuth.deleteUser.mockResolvedValue(undefined);
    verificationEmail.sendFirebaseVerificationEmail.mockResolvedValue(undefined);
    lifecycle.deletePendingInvitationAuthUser.mockResolvedValue(true);
  });

  it("requires authentication and Administrator access", async () => {
    const unauthenticated = await POST(post("invitee@example.com", false));
    expect(unauthenticated.status).toBe(401);

    firestore.seed("staff", "administrator-uid", {
      accountStatus: "active",
      email: "operator@example.com",
      role: "Operator",
      uid: "administrator-uid",
    });
    const forbidden = await POST(post());
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ code: "administrator-required" });
  });

  it("validates the email address", async () => {
    const response = await POST(post("invalid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });

  it("rejects an email that already belongs to verified staff", async () => {
    firestore.seed("staff", "staff-1", {
      accountStatus: "active",
      email: "invitee@example.com",
      normalizedEmail: "invitee@example.com",
      role: "Operator",
    });

    const response = await POST(post());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "staff-already-verified" });
  });

  it("distinguishes missing and archived invitations", async () => {
    const missing = await POST(post());
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: "invitation-not-found" });

    firestore.seed("pendingStaffInvitations", "archived", invitation({ status: "archived" }));
    const archived = await POST(post());
    expect(archived.status).toBe(409);
    await expect(archived.json()).resolves.toMatchObject({ code: "account-archived" });
  });

  it("does not resend while the current verification link remains active", async () => {
    firestore.seed(
      "pendingStaffInvitations",
      "active",
      invitation({
        expiresAt: Timestamp.fromDate(new Date("2026-09-02T10:00:00.001Z")),
        status: "pending",
        verificationSentAt: Timestamp.fromDate(new Date("2026-09-02T09:30:00.000Z")),
      }),
    );

    const response = await POST(post());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "verification-still-active" });
    expect(verificationEmail.sendFirebaseVerificationEmail).not.toHaveBeenCalled();
  });

  it("enforces the resend cooldown for an expired invitation", async () => {
    const expired = invitation({
      verificationResendAvailableAt: Timestamp.fromDate(new Date("2026-09-02T10:00:00.001Z")),
    });
    firestore.seed("pendingStaffInvitations", "expired", expired);

    const response = await POST(post());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "verification-resend-cooldown" });
    expect(lifecycle.deletePendingInvitationAuthUser).toHaveBeenCalledWith(expired);
    expect(firebaseAdmin.adminAuth.createUser).not.toHaveBeenCalled();
  });

  it("rejects a stored Auth user whose email does not match", async () => {
    firestore.seed("pendingStaffInvitations", "expired", invitation());
    firebaseAdmin.adminAuth.getUser.mockResolvedValueOnce({ email: "other@example.com", uid: "invitee-uid" });

    const response = await POST(post());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "auth-user-mismatch" });
    expect(verificationEmail.sendFirebaseVerificationEmail).not.toHaveBeenCalled();
  });

  it("rotates the expired invitation, updates Auth, and sends a new one-hour link", async () => {
    firestore.seed("pendingStaffInvitations", "expired", invitation());

    const response = await POST(post("INVITEE@EXAMPLE.COM"));
    const payload = await response.json();
    const invitations = firestore.documents("pendingStaffInvitations");
    const previous = invitations.find((document) => document.id === "expired");
    const rotated = invitations.find((document) => document.id !== "expired");

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      cooldownEndsAt: "2026-09-02T10:03:00.000Z",
      expiresAt: "2026-09-02T11:00:00.000Z",
      success: true,
    });
    expect(previous?.data()).toMatchObject({ status: "superseded" });
    expect(rotated?.data()).toMatchObject({
      authUid: "invitee-uid",
      status: "pending",
      verificationDeliveryStatus: "sent",
      verificationResendCount: 2,
    });
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalledWith(
      "invitee-uid",
      expect.objectContaining({ disabled: false, emailVerified: false }),
    );
    expect(verificationEmail.sendFirebaseVerificationEmail).toHaveBeenCalledWith(
      "invitee@example.com",
      expect.any(String),
      expect.stringMatching(/^https:\/\/app\.example\/complete-invitation\?token=/),
    );
  });

  it("marks the rotated invitation failed and removes a newly created Auth user when delivery fails", async () => {
    firestore.seed("pendingStaffInvitations", "expired", invitation({ authUid: undefined }));
    firebaseAdmin.adminAuth.getUserByEmail.mockRejectedValueOnce({ code: "auth/user-not-found" });
    verificationEmail.sendFirebaseVerificationEmail.mockRejectedValueOnce(new Error("Delivery unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(post());
    const rotated = firestore.documents("pendingStaffInvitations").find((document) => document.id !== "expired");

    expect(response.status).toBe(500);
    expect(rotated?.data()).toMatchObject({ status: "expired", verificationDeliveryStatus: "failed" });
    expect(firebaseAdmin.adminAuth.deleteUser).toHaveBeenCalledWith("new-invitee-uid");
  });
});
