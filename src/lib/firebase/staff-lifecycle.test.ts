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

  it("archives a verified staff record only after disabling Firebase Auth", async () => {
    firestore.seed("staff", "staff-1", activeStaff());

    await expect(archiveStaffMember("staff-1", "administrator-uid")).resolves.toEqual({
      message: "Staff account archived. Dashboard access is disabled.",
    });
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenCalledWith("staff-uid", { disabled: true });
    expect(firestore.get("staff", "staff-1")).toMatchObject({
      accountStatus: "archived",
      archivedBy: "administrator-uid",
    });
  });

  it("re-enables Firebase Auth when archiving the Firestore record fails", async () => {
    firestore.seed("staff", "staff-1", activeStaff());
    firestore.ref("staff", "staff-1").update = vi.fn().mockRejectedValueOnce(new Error("Firestore unavailable"));

    await expect(archiveStaffMember("staff-1", "administrator-uid")).rejects.toThrow("Firestore unavailable");
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenNthCalledWith(1, "staff-uid", { disabled: true });
    expect(firebaseAdmin.adminAuth.updateUser).toHaveBeenNthCalledWith(2, "staff-uid", { disabled: false });
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
