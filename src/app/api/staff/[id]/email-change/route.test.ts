import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAdminFirestore } from "@/test/firebase-admin-firestore";

const firebaseAdmin = vi.hoisted(() => ({
  adminAuth: {
    deleteUser: vi.fn(),
    getUserByEmail: vi.fn(),
    verifyIdToken: vi.fn(),
  },
  adminDb: {
    batch: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

const emailChangeStatus = vi.hoisted(() => ({ reconcileEmailChange: vi.fn() }));

vi.mock("@/lib/firebase/admin", () => firebaseAdmin);
vi.mock("@/lib/firebase/email-change-status", () => emailChangeStatus);

import { DELETE, GET, POST } from "./route";

const context = { params: Promise.resolve({ id: "staff-1" }) };

function request(method: string, body?: unknown, authenticated = true) {
  return new Request("https://app.example/api/staff/staff-1/email-change", {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(authenticated ? { Authorization: "Bearer administrator-token" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function targetStaff(overrides: Record<string, unknown> = {}) {
  return {
    accountStatus: "active",
    email: "old@example.com",
    emailChangeStatus: "none",
    normalizedEmail: "old@example.com",
    role: "Operator",
    uid: "target-uid",
    ...overrides,
  };
}

describe("staff email change route", () => {
  let firestore: ReturnType<typeof createFakeAdminFirestore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:00:00.000Z"));
    firestore = createFakeAdminFirestore();
    Object.assign(firebaseAdmin.adminDb, firestore.api);
    firestore.seed("staff", "administrator-uid", {
      accountStatus: "active",
      email: "admin@example.com",
      normalizedEmail: "admin@example.com",
      role: "Administrator",
      uid: "administrator-uid",
    });
    firestore.seed("staff", "staff-1", targetStaff());
    firebaseAdmin.adminAuth.verifyIdToken.mockResolvedValue({
      email: "admin@example.com",
      uid: "administrator-uid",
    });
    firebaseAdmin.adminAuth.getUserByEmail.mockRejectedValue({ code: "auth/user-not-found" });
    firebaseAdmin.adminAuth.deleteUser.mockResolvedValue(undefined);
    emailChangeStatus.reconcileEmailChange.mockResolvedValue({
      newEmail: "new@example.com",
      status: "pending",
    });
  });

  it("requires authentication and Administrator access", async () => {
    const unauthenticated = await POST(request("POST", { email: "new@example.com" }, false), context);
    expect(unauthenticated.status).toBe(401);

    firestore.seed("staff", "administrator-uid", {
      accountStatus: "active",
      email: "operator@example.com",
      role: "Operator",
      uid: "administrator-uid",
    });
    const forbidden = await POST(request("POST", { email: "new@example.com" }), context);
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ code: "administrator-required" });
  });

  it("validates the replacement email", async () => {
    const response = await POST(request("POST", { email: "invalid" }), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid-email" });
  });

  it("requires the new address to differ from the current address", async () => {
    const response = await POST(request("POST", { email: "OLD@EXAMPLE.COM" }), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "email-unchanged" });
  });

  it("rejects changes for archived staff", async () => {
    firestore.seed("staff", "staff-1", targetStaff({ accountStatus: "archived" }));

    const response = await POST(request("POST", { email: "new@example.com" }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "account-archived" });
  });

  it("rejects an address owned by another staff record", async () => {
    firestore.seed("staff", "staff-2", {
      accountStatus: "active",
      email: "new@example.com",
      normalizedEmail: "new@example.com",
      role: "Operator",
    });

    const response = await POST(request("POST", { email: "new@example.com" }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "email-already-in-use" });
  });

  it("rejects an address pending on another staff record", async () => {
    firestore.seed("staff", "staff-2", {
      accountStatus: "active",
      email: "other@example.com",
      pendingEmail: "new@example.com",
      role: "Operator",
    });

    const response = await POST(request("POST", { email: "new@example.com" }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "email-pending" });
  });

  it("rejects an address owned by a different Firebase Auth user", async () => {
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValueOnce({ uid: "other-uid" });

    const response = await POST(request("POST", { email: "new@example.com" }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "auth-email-in-use" });
  });

  it("creates a 24-hour request and supersedes the previous request", async () => {
    firestore.seed(
      "staff",
      "staff-1",
      targetStaff({ emailChangeRequestId: "previous-request", emailChangeStatus: "pending" }),
    );
    firestore.seed("staffEmailChanges", "previous-request", { status: "pending" });

    const response = await POST(request("POST", { email: "NEW@EXAMPLE.COM" }), context);
    const payload = (await response.json()) as {
      email: string;
      expiresAt: string;
      temporaryPassword: string;
      verificationToken: string;
    };
    const requests = firestore.documents("staffEmailChanges");
    const current = requests.find((document) => document.id !== "previous-request");

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ email: "new@example.com", expiresAt: "2026-09-03T10:00:00.000Z" });
    expect(payload.verificationToken.length).toBeGreaterThanOrEqual(20);
    expect(payload.temporaryPassword.length).toBeGreaterThanOrEqual(20);
    expect(firestore.get("staffEmailChanges", "previous-request")).toMatchObject({ status: "superseded" });
    expect(current?.data()).toMatchObject({
      newEmail: "new@example.com",
      oldEmail: "old@example.com",
      staffId: "staff-1",
      staffUid: "target-uid",
      status: "pending",
    });
    expect(firestore.get("staff", "staff-1")).toMatchObject({
      emailChangeStatus: "pending",
      pendingEmail: "new@example.com",
    });
  });

  it("GET reports completed and idle records without reconciliation", async () => {
    firestore.seed(
      "staff",
      "staff-1",
      targetStaff({
        email: "new@example.com",
        emailChangeCompletedAt: Timestamp.fromDate(new Date("2026-09-02T09:00:00.000Z")),
        emailChangeStatus: "completed",
      }),
    );
    const completed = await GET(request("GET"), context);
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({
      completedAt: "2026-09-02T09:00:00.000Z",
      email: "new@example.com",
      status: "completed",
    });

    firestore.seed("staff", "staff-1", targetStaff());
    const idle = await GET(request("GET"), context);
    await expect(idle.json()).resolves.toEqual({ email: "old@example.com", status: "idle" });
    expect(emailChangeStatus.reconcileEmailChange).not.toHaveBeenCalled();
  });

  it("GET delegates pending requests to reconciliation with the expected staff ID", async () => {
    firestore.seed(
      "staff",
      "staff-1",
      targetStaff({ emailChangeRequestId: "request-1", emailChangeStatus: "pending", pendingEmail: "new@example.com" }),
    );

    const response = await GET(request("GET"), context);

    expect(response.status).toBe(200);
    expect(emailChangeStatus.reconcileEmailChange).toHaveBeenCalledWith("request-1", "staff-1");
    await expect(response.json()).resolves.toMatchObject({ email: "new@example.com", status: "pending" });
  });

  it("DELETE is idempotent for idle and completed records", async () => {
    const idle = await DELETE(request("DELETE"), context);
    await expect(idle.json()).resolves.toMatchObject({ status: "idle" });

    firestore.seed("staff", "staff-1", targetStaff({ emailChangeStatus: "completed" }));
    const completed = await DELETE(request("DELETE"), context);
    await expect(completed.json()).resolves.toMatchObject({ status: "completed" });
  });

  it("cancels a pending change and deletes the separate verification Auth user", async () => {
    firestore.seed(
      "staff",
      "staff-1",
      targetStaff({ emailChangeRequestId: "request-1", emailChangeStatus: "pending", pendingEmail: "new@example.com" }),
    );
    firestore.seed("staffEmailChanges", "request-1", { status: "pending" });
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValueOnce({ uid: "verification-uid" });

    const response = await DELETE(request("DELETE"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "cancelled" });
    expect(firebaseAdmin.adminAuth.deleteUser).toHaveBeenCalledWith("verification-uid");
    expect(firestore.get("staffEmailChanges", "request-1")).toMatchObject({ status: "cancelled" });
    expect(firestore.get("staff", "staff-1")).toMatchObject({ emailChangeStatus: "none" });
    expect(firestore.get("staff", "staff-1")).not.toHaveProperty("pendingEmail");
  });

  it("rolls the cancellation claim back when Auth deletion fails", async () => {
    firestore.seed(
      "staff",
      "staff-1",
      targetStaff({ emailChangeRequestId: "request-1", emailChangeStatus: "pending", pendingEmail: "new@example.com" }),
    );
    firestore.seed("staffEmailChanges", "request-1", { status: "pending" });
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValueOnce({ uid: "verification-uid" });
    firebaseAdmin.adminAuth.deleteUser.mockRejectedValueOnce(new Error("Auth unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await DELETE(request("DELETE"), context);

    expect(response.status).toBe(500);
    expect(firestore.get("staffEmailChanges", "request-1")).toMatchObject({ status: "pending" });
    expect(firestore.get("staff", "staff-1")).toMatchObject({
      emailChangeRequestId: "request-1",
      emailChangeStatus: "pending",
      pendingEmail: "new@example.com",
    });
  });
});
