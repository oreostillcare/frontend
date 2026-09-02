import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const firebaseAdmin = vi.hoisted(() => ({
  adminAuth: {
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    getUserByEmail: vi.fn(),
    updateUser: vi.fn(),
  },
  adminDb: {
    batch: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

vi.mock("./admin", () => firebaseAdmin);

import { reconcileEmailChange } from "./email-change-status";

interface HarnessOptions {
  request?: Record<string, unknown>;
  requestExists?: boolean;
  staff?: Record<string, unknown>;
  staffExists?: boolean;
}

function createHarness({ request, requestExists = true, staff, staffExists = true }: HarnessOptions = {}) {
  const requestRef = {
    get: vi.fn(),
    id: "request-id",
    update: vi.fn().mockResolvedValue(undefined),
  };
  const staffRef = {
    get: vi.fn(),
    id: String(request?.staffId ?? "staff-1"),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const requestSnapshot = {
    data: () => request,
    exists: requestExists,
  };
  const staffSnapshot = {
    data: () => staff,
    exists: staffExists,
  };
  requestRef.get.mockResolvedValue(requestSnapshot);
  staffRef.get.mockResolvedValue(staffSnapshot);

  firebaseAdmin.adminDb.collection.mockImplementation((collectionName: string) => ({
    doc: vi.fn(() => (collectionName === "staffEmailChanges" ? requestRef : staffRef)),
  }));

  const transaction = {
    get: vi.fn(async (reference: unknown) => (reference === requestRef ? requestSnapshot : staffSnapshot)),
    update: vi.fn(),
  };
  firebaseAdmin.adminDb.runTransaction.mockImplementation(async (callback: (value: typeof transaction) => unknown) =>
    callback(transaction),
  );

  const batch = {
    commit: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(),
  };
  firebaseAdmin.adminDb.batch.mockReturnValue(batch);

  return { batch, requestRef, requestSnapshot, staffRef, staffSnapshot, transaction };
}

function pendingRequest(overrides: Record<string, unknown> = {}) {
  return {
    expiresAt: Timestamp.fromDate(new Date("2026-09-03T10:00:00.000Z")),
    newEmail: "new@example.com",
    normalizedNewEmail: "new@example.com",
    oldEmail: "old@example.com",
    staffId: "staff-1",
    staffUid: "target-uid",
    status: "pending",
    ...overrides,
  };
}

describe("reconcileEmailChange", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:00:00.000Z"));
    firebaseAdmin.adminAuth.createUser.mockResolvedValue({ uid: "replacement-uid" });
    firebaseAdmin.adminAuth.deleteUser.mockResolvedValue(undefined);
    firebaseAdmin.adminAuth.updateUser.mockResolvedValue({ uid: "target-uid" });
  });

  it("rejects a missing request", async () => {
    createHarness({ requestExists: false });

    await expect(reconcileEmailChange("request-id")).rejects.toMatchObject({
      code: "invalid-email-change",
      status: 404,
    });
  });

  it("rejects a request belonging to a different staff account", async () => {
    createHarness({ request: pendingRequest({ staffId: "staff-2" }) });

    await expect(reconcileEmailChange("request-id", "staff-1")).rejects.toMatchObject({
      code: "request-mismatch",
      status: 409,
    });
  });

  it("returns completed requests without touching Firebase Auth", async () => {
    createHarness({
      request: pendingRequest({
        completedAt: Timestamp.fromDate(new Date("2026-09-02T09:00:00.000Z")),
        status: "completed",
      }),
    });

    await expect(reconcileEmailChange("request-id")).resolves.toEqual({
      completedAt: "2026-09-02T09:00:00.000Z",
      newEmail: "new@example.com",
      status: "completed",
    });
    expect(firebaseAdmin.adminAuth.getUserByEmail).not.toHaveBeenCalled();
  });

  it("returns processing requests as processing", async () => {
    createHarness({ request: pendingRequest({ status: "processing" }) });

    await expect(reconcileEmailChange("request-id")).resolves.toEqual({
      newEmail: "new@example.com",
      status: "processing",
    });
  });

  it("rejects cancelled or replaced requests", async () => {
    createHarness({ request: pendingRequest({ status: "cancelled" }) });

    await expect(reconcileEmailChange("request-id")).rejects.toMatchObject({
      code: "inactive-email-change",
      status: 410,
    });
  });

  it("marks an expired request before rejecting it", async () => {
    const { requestRef } = createHarness({
      request: pendingRequest({ expiresAt: Timestamp.fromDate(new Date("2026-09-02T09:59:59.999Z")) }),
    });

    await expect(reconcileEmailChange("request-id")).rejects.toMatchObject({
      code: "expired-email-change",
      status: 410,
    });
    expect(requestRef.update).toHaveBeenCalledWith(expect.objectContaining({ status: "expired" }));
  });

  it("rejects a request superseded on the staff record", async () => {
    createHarness({ request: pendingRequest(), staff: { emailChangeRequestId: "newer-request" } });

    await expect(reconcileEmailChange("request-id")).rejects.toMatchObject({
      code: "superseded-token",
      status: 410,
    });
  });

  it("stays pending when the verification Firebase user does not exist", async () => {
    createHarness({ request: pendingRequest(), staff: { emailChangeRequestId: "request-id" } });
    firebaseAdmin.adminAuth.getUserByEmail.mockRejectedValue({ code: "auth/user-not-found" });

    await expect(reconcileEmailChange("request-id")).resolves.toEqual({
      newEmail: "new@example.com",
      status: "pending",
    });
  });

  it("stays pending while the verification Firebase user is unverified", async () => {
    createHarness({ request: pendingRequest(), staff: { emailChangeRequestId: "request-id" } });
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValue({ emailVerified: false, uid: "verification-uid" });

    await expect(reconcileEmailChange("request-id")).resolves.toEqual({
      newEmail: "new@example.com",
      status: "pending",
    });
  });

  it("claims and completes a verified email change", async () => {
    const { batch, transaction } = createHarness({
      request: pendingRequest(),
      staff: { emailChangeRequestId: "request-id" },
    });
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValue({ emailVerified: true, uid: "verification-uid" });

    await expect(reconcileEmailChange("request-id")).resolves.toEqual({
      newEmail: "new@example.com",
      status: "completed",
    });

    expect(transaction.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "processing" }),
    );
    expect(firebaseAdmin.adminAuth.deleteUser).toHaveBeenCalledWith("verification-uid");
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalledWith("target-uid", {
      email: "new@example.com",
      emailVerified: true,
    });
    expect(batch.update).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledOnce();
  });

  it("does not delete the verification user when it is already the target user", async () => {
    createHarness({ request: pendingRequest(), staff: { emailChangeRequestId: "request-id" } });
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValue({ emailVerified: true, uid: "target-uid" });

    await reconcileEmailChange("request-id");

    expect(firebaseAdmin.adminAuth.deleteUser).not.toHaveBeenCalled();
  });

  it("attempts compensating Auth and request-state changes when the final batch fails", async () => {
    const { batch, requestRef } = createHarness({
      request: pendingRequest(),
      staff: { emailChangeRequestId: "request-id" },
    });
    firebaseAdmin.adminAuth.getUserByEmail.mockResolvedValue({ emailVerified: true, uid: "verification-uid" });
    batch.commit.mockRejectedValue(new Error("Firestore commit failed"));

    await expect(reconcileEmailChange("request-id")).rejects.toThrow("Firestore commit failed");

    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenNthCalledWith(2, "target-uid", {
      email: "old@example.com",
      emailVerified: true,
    });
    expect(firebaseAdmin.adminAuth.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "new@example.com", emailVerified: true }),
    );
    expect(requestRef.update).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });
});
