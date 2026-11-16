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
  },
  adminDb: {
    batch: vi.fn(),
    collection: vi.fn(),
    runTransaction: vi.fn(),
  },
}));

vi.mock("./admin", () => firebaseAdmin);

import {
  archiveStaffMember,
  cancelPendingInvitation,
  cleanupArchivedUnverifiedAccounts,
  cleanupExpiredPendingInvitations,
  deletePendingInvitationAuthUser,
  restoreStaffMember,
  updateStaffProfile,
} from "./staff-lifecycle";

const INVITATION_HASH = "a".repeat(64);
const INVITATION_ID = `invitation:${INVITATION_HASH}`;

function activeStaff(overrides: Record<string, unknown> = {}) {
  return {
    accountStatus: "active",
    email: "staff@example.com",
    emailVerified: true,
    normalizedEmail: "staff@example.com",
    role: "Operator",
    uid: "staff-uid",
    ...overrides,
  };
}

function pendingInvitation(overrides: Record<string, unknown> = {}) {
  return {
    authUid: "invited-uid",
    email: "invitee@example.com",
    expiresAt: Timestamp.fromDate(new Date("2026-09-02T11:00:00.000Z")),
    normalizedEmail: "invitee@example.com",
    status: "pending",
    ...overrides,
  };
}

describe("staff lifecycle", () => {
  let firestore: ReturnType<typeof createFakeAdminFirestore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:00:00.000Z"));
    firestore = createFakeAdminFirestore();
    Object.assign(firebaseAdmin.adminDb, firestore.api);
    firebaseAdmin.adminAuth.getUser.mockImplementation(async (uid: string) => ({
      email: uid === "invited-uid" ? "invitee@example.com" : "staff@example.com",
      uid,
    }));
    firebaseAdmin.adminAuth.getUserByEmail.mockImplementation(async (email: string) => ({
      email,
      uid: email === "invitee@example.com" ? "invited-uid" : "staff-uid",
    }));
    firebaseAdmin.adminAuth.updateUser.mockResolvedValue({ uid: "updated" });
    firebaseAdmin.adminAuth.deleteUser.mockResolvedValue(undefined);
    firebaseAdmin.adminAuth.createUser.mockResolvedValue({ uid: "created" });
  });

  it("rejects malformed invitation identifiers", async () => {
    await expect(archiveStaffMember("invitation:not-a-token-hash", "administrator-uid")).rejects.toMatchObject({
      code: "invitation-not-found",
      status: 404,
    });
  });

  it("archives a pending invitation and disables its Firebase user", async () => {
    firestore.seed("pendingStaffInvitations", INVITATION_HASH, pendingInvitation());

    await expect(archiveStaffMember(INVITATION_ID, "administrator-uid")).resolves.toEqual({
      message: "Pending invitation archived. It will be deleted after 6 days unless restored.",
    });

    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalledWith("invited-uid", { disabled: true });
    expect(firestore.get("pendingStaffInvitations", INVITATION_HASH)).toMatchObject({
      accountStatus: "archived",
      archivedBy: "administrator-uid",
      status: "archived",
    });
  });

  it("rolls an invitation back to pending when disabling Auth fails", async () => {
    firestore.seed("pendingStaffInvitations", INVITATION_HASH, pendingInvitation());
    firebaseAdmin.adminAuth.updateUser.mockRejectedValueOnce(new Error("Auth unavailable"));

    await expect(archiveStaffMember(INVITATION_ID, "administrator-uid")).rejects.toThrow("Auth unavailable");
    expect(firestore.get("pendingStaffInvitations", INVITATION_HASH)).toMatchObject({ status: "pending" });
  });

  it("restores an archived invitation and re-enables its Firebase user", async () => {
    firestore.seed(
      "pendingStaffInvitations",
      INVITATION_HASH,
      pendingInvitation({ accountStatus: "archived", archivedBy: "administrator-uid", status: "archived" }),
    );

    await expect(restoreStaffMember(INVITATION_ID)).resolves.toEqual({
      message: "Pending invitation restored. Resend verification if its previous link has expired.",
    });
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalledWith("invited-uid", { disabled: false });
    expect(firestore.get("pendingStaffInvitations", INVITATION_HASH)).toMatchObject({ status: "pending" });
    expect(firestore.get("pendingStaffInvitations", INVITATION_HASH)).not.toHaveProperty("archivedBy");
  });

  it("prevents an administrator from archiving their own verified account", async () => {
    firestore.seed("staff", "staff-1", activeStaff({ uid: "administrator-uid" }));

    await expect(archiveStaffMember("staff-1", "administrator-uid")).rejects.toMatchObject({
      code: "cannot-archive-self",
      status: 409,
    });
    expect(firebaseAdmin.adminAuth.updateUser).not.toHaveBeenCalled();
  });

  it("reserves a verified staff archive before disabling Firebase Auth", async () => {
    firestore.seed("staff", "staff-1", activeStaff());
    firebaseAdmin.adminAuth.updateUser.mockImplementationOnce(async () => {
      expect(firestore.get("staff", "staff-1")).toMatchObject({ accountStatus: "archived" });
      expect(firestore.get("staff", "staff-1")?.lifecycleOperationId).toBeTruthy();
      return { uid: "staff-uid" };
    });

    await expect(archiveStaffMember("staff-1", "administrator-uid")).resolves.toEqual({
      message: "Staff account archived. Dashboard access is disabled.",
    });
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalledWith("staff-uid", { disabled: true });
    expect(firestore.get("staff", "staff-1")).toMatchObject({
      accountStatus: "archived",
      archivedBy: "administrator-uid",
    });
    expect(firestore.get("staff", "staff-1")).not.toHaveProperty("lifecycleOperationId");
  });

  it("prevents archiving the last active administrator", async () => {
    firestore.seed("staff", "staff-1", activeStaff({ role: "Administrator", uid: "other-admin-uid" }));

    await expect(archiveStaffMember("staff-1", "administrator-uid")).rejects.toMatchObject({
      code: "last-administrator",
      status: 409,
    });
    expect(firebaseAdmin.adminAuth.updateUser).not.toHaveBeenCalled();
  });

  it("re-enables Firebase Auth when archiving the Firestore record fails", async () => {
    firestore.seed("staff", "staff-1", activeStaff());
    firestore.ref("staff", "staff-1").update = vi.fn().mockRejectedValueOnce(new Error("Firestore unavailable"));

    await expect(archiveStaffMember("staff-1", "administrator-uid")).rejects.toThrow("Firestore unavailable");
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenNthCalledWith(1, "staff-uid", { disabled: true });
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenNthCalledWith(2, "staff-uid", { disabled: false });
    expect(firestore.get("staff", "staff-1")).toMatchObject({ accountStatus: "active" });
    expect(firestore.get("staff", "staff-1")).not.toHaveProperty("lifecycleOperationId");
  });

  it("rejects one of two concurrent administrator demotions", async () => {
    firestore.seed("staff", "admin-a", activeStaff({ role: "Administrator", uid: "admin-a" }));
    firestore.seed("staff", "admin-b", activeStaff({ role: "Administrator", uid: "admin-b" }));

    const results = await Promise.allSettled([
      updateStaffProfile("admin-a", { role: "Operator" }),
      updateStaffProfile("admin-b", { role: "Operator" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "last-administrator", status: 409 },
    });
    expect(firestore.documents("staff").filter((document) => document.data()?.role === "Administrator")).toHaveLength(
      1,
    );
  });

  it("protects the remaining administrator during a concurrent archive and demotion", async () => {
    firestore.seed("staff", "admin-a", activeStaff({ role: "Administrator", uid: "admin-a" }));
    firestore.seed("staff", "admin-b", activeStaff({ role: "Administrator", uid: "admin-b" }));

    const results = await Promise.allSettled([
      archiveStaffMember("admin-a", "acting-admin"),
      updateStaffProfile("admin-b", { role: "Operator" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "last-administrator" },
    });
    const remaining = firestore.documents("staff").filter((document) => {
      const data = document.data();
      return data?.role === "Administrator" && data.accountStatus !== "archived";
    });
    expect(remaining).toHaveLength(1);
  });

  it("rejects one of two concurrent administrator archives before a second Auth disable", async () => {
    firestore.seed("staff", "admin-a", activeStaff({ role: "Administrator", uid: "admin-a" }));
    firestore.seed("staff", "admin-b", activeStaff({ role: "Administrator", uid: "admin-b" }));

    const results = await Promise.allSettled([
      archiveStaffMember("admin-a", "acting-admin"),
      archiveStaffMember("admin-b", "acting-admin"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "last-administrator" },
    });
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalledTimes(1);
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalledWith(expect.any(String), { disabled: true });
  });

  it("keeps failed Auth recovery reserved and excludes it from the administrator count", async () => {
    firestore.seed("staff", "admin-a", activeStaff({ role: "Administrator", uid: "admin-a" }));
    firestore.seed("staff", "admin-b", activeStaff({ role: "Administrator", uid: "admin-b" }));
    firebaseAdmin.adminAuth.updateUser.mockRejectedValueOnce(new Error("disable failed"));
    firebaseAdmin.adminAuth.updateUser.mockRejectedValueOnce(new Error("recovery failed"));

    await expect(archiveStaffMember("admin-a", "acting-admin")).rejects.toThrow("disable failed");
    expect(firestore.get("staff", "admin-a")).toMatchObject({ accountStatus: "archived" });
    await expect(updateStaffProfile("admin-b", { role: "Operator" })).rejects.toMatchObject({
      code: "last-administrator",
    });
    await expect(updateStaffProfile("admin-a", { role: "Operator" })).rejects.toMatchObject({
      code: "staff-operation-in-progress",
    });
    await expect(restoreStaffMember("admin-a")).rejects.toMatchObject({ code: "staff-operation-in-progress" });
  });

  it("restores the prior profile status when Auth disabling fails and recovery succeeds", async () => {
    firestore.seed("staff", "staff-1", activeStaff());
    firebaseAdmin.adminAuth.updateUser.mockRejectedValueOnce(new Error("Auth unavailable"));

    await expect(archiveStaffMember("staff-1", "administrator-uid")).rejects.toThrow("Auth unavailable");
    expect(firestore.get("staff", "staff-1")).toMatchObject({ accountStatus: "active" });
    expect(firestore.get("staff", "staff-1")).not.toHaveProperty("archivedBy");
    expect(firestore.get("staff", "staff-1")).not.toHaveProperty("lifecycleOperationId");
  });

  it("restores an archived verified staff record", async () => {
    firestore.seed("staff", "staff-1", activeStaff({ accountStatus: "archived", archivedBy: "administrator-uid" }));

    await expect(restoreStaffMember("staff-1")).resolves.toEqual({
      message: "Staff account restored. Dashboard access is enabled.",
    });
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalledWith("staff-uid", { disabled: false });
    expect(firestore.get("staff", "staff-1")).toMatchObject({ accountStatus: "active" });
    expect(firestore.get("staff", "staff-1")).not.toHaveProperty("archivedBy");
  });

  it("keeps a restoring administrator unavailable until Auth is enabled and blocks stale lifecycle writes", async () => {
    firestore.seed(
      "staff",
      "admin-a",
      activeStaff({ role: "Administrator", uid: "admin-a", accountStatus: "archived" }),
    );
    firestore.seed("staff", "admin-b", activeStaff({ role: "Administrator", uid: "admin-b" }));
    let resolveEnable: (value: { uid: string }) => void = () => undefined;
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    firebaseAdmin.adminAuth.updateUser.mockImplementationOnce(() => {
      signalStarted();
      return new Promise<{ uid: string }>((resolve) => {
        resolveEnable = resolve;
      });
    });

    const restoration = restoreStaffMember("admin-a");
    await started;
    expect(firestore.get("staff", "admin-a")?.accountStatus).toBe("archived");
    await expect(restoreStaffMember("admin-a")).rejects.toMatchObject({ code: "staff-operation-in-progress" });
    await expect(updateStaffProfile("admin-a", { role: "Operator" })).rejects.toMatchObject({
      code: "staff-operation-in-progress",
    });
    await expect(updateStaffProfile("admin-b", { role: "Operator" })).rejects.toMatchObject({
      code: "last-administrator",
    });
    resolveEnable({ uid: "admin-a" });
    await restoration;
    expect(firestore.get("staff", "admin-a")?.accountStatus).toBe("active");
    expect(firestore.get("staff", "admin-a")).not.toHaveProperty("lifecycleOperationId");
  });

  it("leaves a failed restore archived and releases its reservation after Auth rollback", async () => {
    firestore.seed("staff", "staff-1", activeStaff({ accountStatus: "archived" }));
    firebaseAdmin.adminAuth.updateUser.mockRejectedValueOnce(new Error("Auth unavailable"));
    await expect(restoreStaffMember("staff-1")).rejects.toThrow("Auth unavailable");
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenLastCalledWith("staff-uid", { disabled: true });
    expect(firestore.get("staff", "staff-1")?.accountStatus).toBe("archived");
    expect(firestore.get("staff", "staff-1")).not.toHaveProperty("lifecycleOperationId");
  });

  it("does not delete an old unverified account while its Auth restoration is pending", async () => {
    firestore.seed(
      "staff",
      "staff-1",
      activeStaff({
        accountStatus: "archived",
        archivedAt: Timestamp.fromDate(new Date("2026-08-20T10:00:00.000Z")),
        emailVerified: false,
      }),
    );
    let resolveEnable: (value: { uid: string }) => void = () => undefined;
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    firebaseAdmin.adminAuth.updateUser.mockImplementationOnce(() => {
      signalStarted();
      return new Promise<{ uid: string }>((resolve) => {
        resolveEnable = resolve;
      });
    });

    const restoration = restoreStaffMember("staff-1");
    await started;
    await expect(cleanupArchivedUnverifiedAccounts()).resolves.toEqual({ deleted: 0, failed: [] });
    expect(firebaseAdmin.adminAuth.deleteUser).not.toHaveBeenCalled();
    expect(firestore.ref("staff", "staff-1").delete).not.toHaveBeenCalled();
    expect(firestore.get("staff", "staff-1")?.accountStatus).toBe("archived");

    resolveEnable({ uid: "staff-uid" });
    await expect(restoration).resolves.toEqual({ message: "Staff account restored. Dashboard access is enabled." });
    expect(firestore.get("staff", "staff-1")?.accountStatus).toBe("active");
    expect(firestore.get("staff", "staff-1")).not.toHaveProperty("lifecycleOperationId");
  });

  it("does not delete an invitation Auth user once a staff record owns the email", async () => {
    firestore.seed(
      "staff",
      "staff-1",
      activeStaff({ email: "invitee@example.com", normalizedEmail: "invitee@example.com" }),
    );

    await expect(deletePendingInvitationAuthUser(pendingInvitation())).rejects.toMatchObject({
      code: "invitation-already-completed",
      status: 409,
    });
    expect(firebaseAdmin.adminAuth.deleteUser).not.toHaveBeenCalled();
  });

  it("cancels an active invitation and deletes its pending Auth user", async () => {
    firestore.seed("pendingStaffInvitations", INVITATION_HASH, pendingInvitation());

    await expect(cancelPendingInvitation(INVITATION_ID)).resolves.toEqual({
      message: "Pending invitation cancelled.",
    });
    expect(firebaseAdmin.adminAuth.deleteUser).toHaveBeenCalledWith("invited-uid");
    expect(firestore.get("pendingStaffInvitations", INVITATION_HASH)).toMatchObject({ status: "cancelled" });
  });

  it("returns a stable result when cancelling a missing invitation", async () => {
    await expect(cancelPendingInvitation(INVITATION_ID)).resolves.toEqual({
      message: "Pending invitation is already cancelled.",
    });
  });

  it("restores pending state when deleting an invitation Auth user fails", async () => {
    firestore.seed("pendingStaffInvitations", INVITATION_HASH, pendingInvitation());
    firebaseAdmin.adminAuth.deleteUser.mockRejectedValueOnce(new Error("Auth unavailable"));

    await expect(cancelPendingInvitation(INVITATION_ID)).rejects.toThrow("Auth unavailable");
    expect(firestore.get("pendingStaffInvitations", INVITATION_HASH)).toMatchObject({ status: "pending" });
  });

  it("expires elapsed invitations and deletes their Auth users", async () => {
    firestore.seed(
      "pendingStaffInvitations",
      INVITATION_HASH,
      pendingInvitation({ expiresAt: Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z")) }),
    );

    await expect(cleanupExpiredPendingInvitations()).resolves.toEqual({ deletedAuthUsers: 1, failed: [] });
    expect(firebaseAdmin.adminAuth.deleteUser).toHaveBeenCalledWith("invited-uid");
    expect(firestore.get("pendingStaffInvitations", INVITATION_HASH)).toMatchObject({ status: "expired" });
  });

  it("reports expired invitation cleanup failures and releases the claim", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    firestore.seed(
      "pendingStaffInvitations",
      INVITATION_HASH,
      pendingInvitation({ expiresAt: Timestamp.fromDate(new Date("2026-09-02T09:59:00.000Z")) }),
    );
    firebaseAdmin.adminAuth.deleteUser.mockRejectedValueOnce(new Error("Auth unavailable"));

    await expect(cleanupExpiredPendingInvitations()).resolves.toEqual({
      deletedAuthUsers: 0,
      failed: [INVITATION_HASH],
    });
    expect(firestore.get("pendingStaffInvitations", INVITATION_HASH)).toMatchObject({ status: "expired" });
    expect(firestore.get("pendingStaffInvitations", INVITATION_HASH)).not.toHaveProperty("cleanupOperationId");
  });

  it("permanently deletes archived unverified accounts after six days", async () => {
    const archivedAt = Timestamp.fromDate(new Date("2026-08-27T09:59:59.000Z"));
    firestore.seed("pendingStaffInvitations", INVITATION_HASH, pendingInvitation({ archivedAt, status: "archived" }));
    firestore.seed(
      "staff",
      "unverified-staff",
      activeStaff({ accountStatus: "archived", archivedAt, emailVerified: false, uid: "unverified-uid" }),
    );

    await expect(cleanupArchivedUnverifiedAccounts()).resolves.toEqual({ deleted: 2, failed: [] });
    expect(firestore.get("pendingStaffInvitations", INVITATION_HASH)).toBeUndefined();
    expect(firestore.get("staff", "unverified-staff")).toBeUndefined();
    expect(firebaseAdmin.adminAuth.deleteUser).toHaveBeenCalledWith("invited-uid");
    expect(firebaseAdmin.adminAuth.deleteUser).toHaveBeenCalledWith("unverified-uid");
  });

  it("keeps archived verified staff and records still inside retention", async () => {
    firestore.seed(
      "staff",
      "verified-staff",
      activeStaff({
        accountStatus: "archived",
        archivedAt: Timestamp.fromDate(new Date("2026-08-20T10:00:00.000Z")),
        emailVerified: true,
      }),
    );
    firestore.seed(
      "pendingStaffInvitations",
      INVITATION_HASH,
      pendingInvitation({
        archivedAt: Timestamp.fromDate(new Date("2026-08-27T10:00:00.001Z")),
        status: "archived",
      }),
    );

    await expect(cleanupArchivedUnverifiedAccounts()).resolves.toEqual({ deleted: 0, failed: [] });
    expect(firebaseAdmin.adminAuth.deleteUser).not.toHaveBeenCalled();
  });
});
