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

const verificationEmail = vi.hoisted(() => ({
  sendFirebaseVerificationEmail: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => firebaseAdmin);
vi.mock("@/lib/firebase/firebase-verification-email", () => verificationEmail);

import { POST } from "./route";

function post(body: unknown, authenticated = true) {
  return new Request("https://request.example/api/staff/invitations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Authorization: "Bearer administrator-token" } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("staff invitation creation", () => {
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
    firebaseAdmin.adminAuth.getUserByEmail.mockRejectedValue({ code: "auth/user-not-found" });
    firebaseAdmin.adminAuth.createUser.mockResolvedValue({ uid: "new-auth-uid" });
    firebaseAdmin.adminAuth.deleteUser.mockResolvedValue(undefined);
    verificationEmail.sendFirebaseVerificationEmail.mockResolvedValue(undefined);
  });

  it("requires authentication", async () => {
    const response = await POST(post({ email: "new@example.com", role: "Operator", username: "new.user" }, false));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "unauthenticated" });
    expect(firebaseAdmin.adminAuth.createUser).not.toHaveBeenCalled();
  });

  it("requires the Administrator role", async () => {
    firestore.seed("staff", "administrator-uid", {
      accountStatus: "active",
      email: "operator@example.com",
      role: "Operator",
      uid: "administrator-uid",
    });

    const response = await POST(post({ email: "new@example.com", role: "Operator", username: "new.user" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "administrator-required" });
  });

  it("validates email, username, and role", async () => {
    const response = await POST(post({ email: "invalid", role: "Owner", username: "x" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid-input" });
  });

  it("rejects an email already owned by staff", async () => {
    firestore.seed("staff", "staff-1", {
      accountStatus: "active",
      email: "existing@example.com",
      normalizedEmail: "existing@example.com",
      role: "Operator",
    });

    const response = await POST(post({ email: "EXISTING@example.com", role: "Operator", username: "new.user" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "email-already-in-use" });
  });

  it("rejects an email pending on another staff record", async () => {
    firestore.seed("staff", "staff-1", {
      accountStatus: "active",
      email: "old@example.com",
      pendingEmail: "new@example.com",
      role: "Operator",
    });

    const response = await POST(post({ email: "new@example.com", role: "Operator", username: "new.user" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "email-pending" });
  });

  it.each([
    ["pending", "invitation-pending"],
    ["expired", "invitation-pending"],
    ["archived", "invitation-archived"],
  ])("rejects an existing %s invitation", async (status, expectedCode) => {
    firestore.seed("pendingStaffInvitations", "existing-invitation", {
      email: "new@example.com",
      normalizedEmail: "new@example.com",
      status,
    });

    const response = await POST(post({ email: "new@example.com", role: "Operator", username: "new.user" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: expectedCode });
  });

  it("rejects an orphaned Firebase Auth account", async () => {
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValue({ uid: "orphaned-auth-uid" });

    const response = await POST(post({ email: "new@example.com", role: "Operator", username: "new.user" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "auth-email-already-in-use" });
  });

  it("creates the Auth user and invitation before sending verification", async () => {
    const response = await POST(post({ email: "NEW@EXAMPLE.COM", role: "Operator", username: " New User " }));
    const payload = (await response.json()) as { email: string; expiresAt: string; success: boolean };
    const invitations = firestore.documents("pendingStaffInvitations");

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      email: "new@example.com",
      expiresAt: "2026-09-02T11:00:00.000Z",
      message: "Invitation email sent to new@example.com.",
      success: true,
    });
    expect(firebaseAdmin.adminAuth.createUser).toHaveBeenCalledWith({
      disabled: false,
      displayName: "New User",
      email: "new@example.com",
      emailVerified: false,
      password: expect.any(String),
    });
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.data()).toMatchObject({
      authUid: "new-auth-uid",
      normalizedEmail: "new@example.com",
      role: "Operator",
      status: "pending",
      verificationDeliveryStatus: "sent",
    });
    expect(invitations[0]?.data()?.expiresAt).toBeInstanceOf(Timestamp);
    expect(verificationEmail.sendFirebaseVerificationEmail).toHaveBeenCalledWith(
      "new@example.com",
      expect.any(String),
      expect.stringMatching(/^https:\/\/app\.example\/complete-invitation\?token=/),
    );
  });

  it("removes both records when verification delivery fails", async () => {
    verificationEmail.sendFirebaseVerificationEmail.mockRejectedValueOnce(new Error("Email delivery failed"));

    const response = await POST(post({ email: "new@example.com", role: "Operator", username: "New User" }));

    expect(response.status).toBe(500);
    expect(firestore.documents("pendingStaffInvitations")).toHaveLength(0);
    expect(firebaseAdmin.adminAuth.deleteUser).toHaveBeenCalledWith("new-auth-uid");
  });
});
