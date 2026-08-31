import "server-only";

import type { UserRecord } from "firebase-admin/auth";
import { type DocumentData, FieldValue, type QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";

import { adminAuth, adminDb } from "./admin";
import {
  ApiError,
  createOpaqueToken,
  findStaffByEmail,
  findStaffDocument,
  getStaffAuthUid,
  normalizeEmail,
} from "./admin-staff";

const INVITATION_ID_PREFIX = "invitation:";
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const ARCHIVED_UNVERIFIED_RETENTION_MS = 6 * 24 * 60 * 60 * 1000;
const CLEANUP_LEASE_MS = 10 * 60 * 1000;

function invitationDocumentId(staffId: string) {
  if (!staffId.startsWith(INVITATION_ID_PREFIX)) return null;
  const documentId = staffId.slice(INVITATION_ID_PREFIX.length);
  if (!TOKEN_HASH_PATTERN.test(documentId)) {
    throw new ApiError("Pending invitation not found.", 404, "invitation-not-found");
  }
  return documentId;
}

function isUserNotFound(error: unknown) {
  return (error as { code?: string }).code === "auth/user-not-found";
}

async function getAuthUserByUid(uid: string) {
  try {
    return await adminAuth.getUser(uid);
  } catch (error) {
    if (isUserNotFound(error)) return null;
    throw error;
  }
}

async function getAuthUserByEmail(email: string) {
  try {
    return await adminAuth.getUserByEmail(email);
  } catch (error) {
    if (isUserNotFound(error)) return null;
    throw error;
  }
}

async function getInvitationAuthUser(data: DocumentData) {
  const email = normalizeEmail(String(data.email || ""));
  if (!email) return null;

  const staff = await findStaffByEmail(email);
  if (staff) {
    throw new ApiError("This invitation is already connected to a staff account.", 409, "invitation-already-completed");
  }

  const storedUid = typeof data.authUid === "string" ? data.authUid.trim() : "";
  const storedUser = storedUid ? await getAuthUserByUid(storedUid) : null;
  if (storedUser) {
    if (normalizeEmail(storedUser.email || "") !== email) {
      throw new ApiError("The pending Firebase account does not match this invitation.", 409, "auth-user-mismatch");
    }
    return storedUser;
  }

  return getAuthUserByEmail(email);
}

export async function deletePendingInvitationAuthUser(data: DocumentData) {
  const authUser = await getInvitationAuthUser(data);
  if (!authUser) return false;
  await adminAuth.deleteUser(authUser.uid);
  return true;
}

async function archiveInvitation(documentId: string, administratorUid: string) {
  const invitationRef = adminDb.collection("pendingStaffInvitations").doc(documentId);
  const operationId = createOpaqueToken();
  const invitation = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(invitationRef);
    const data = snapshot.data();
    if (!snapshot.exists || !data) {
      throw new ApiError("Pending invitation not found.", 404, "invitation-not-found");
    }
    if (data.status === "archived") return { data, alreadyArchived: true };
    if (data.status !== "pending" && data.status !== "expired") {
      throw new ApiError("Only a pending invitation can be archived.", 409, "invitation-not-pending");
    }

    transaction.update(invitationRef, {
      status: "archived",
      accountStatus: "archived",
      archivedAt: Timestamp.now(),
      archivedBy: administratorUid,
      lifecycleOperationId: operationId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { data, alreadyArchived: false };
  });

  if (invitation.alreadyArchived) return "Pending invitation is already archived.";

  try {
    const authUser = await getInvitationAuthUser(invitation.data);
    if (authUser) await adminAuth.updateUser(authUser.uid, { disabled: true });
    await invitationRef.update({
      ...(authUser ? { authUid: authUser.uid } : {}),
      lifecycleOperationId: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await adminDb
      .runTransaction(async (transaction) => {
        const current = await transaction.get(invitationRef);
        if (current.data()?.lifecycleOperationId !== operationId) return;
        transaction.update(invitationRef, {
          status: "pending",
          accountStatus: FieldValue.delete(),
          archivedAt: FieldValue.delete(),
          archivedBy: FieldValue.delete(),
          lifecycleOperationId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      })
      .catch(() => undefined);
    throw error;
  }

  return "Pending invitation archived. It will be deleted after 6 days unless restored.";
}

async function restoreInvitation(documentId: string) {
  const invitationRef = adminDb.collection("pendingStaffInvitations").doc(documentId);
  const operationId = createOpaqueToken();
  const invitation = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(invitationRef);
    const data = snapshot.data();
    if (!snapshot.exists || !data) {
      throw new ApiError("Archived invitation not found.", 404, "invitation-not-found");
    }
    if (data.cleanupOperationId) {
      throw new ApiError("This invitation is being permanently deleted.", 409, "cleanup-in-progress");
    }
    if (data.status === "pending") return { data, alreadyActive: true };
    if (data.status !== "archived") {
      throw new ApiError("Only an archived invitation can be restored.", 409, "invitation-not-archived");
    }

    transaction.update(invitationRef, {
      status: "pending",
      accountStatus: FieldValue.delete(),
      archivedAt: FieldValue.delete(),
      archivedBy: FieldValue.delete(),
      restoredAt: FieldValue.serverTimestamp(),
      lifecycleOperationId: operationId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { data, alreadyActive: false };
  });

  if (invitation.alreadyActive) return "Pending invitation is already active.";

  try {
    const authUser = await getInvitationAuthUser(invitation.data);
    if (authUser) await adminAuth.updateUser(authUser.uid, { disabled: false });
    await invitationRef.update({
      ...(authUser ? { authUid: authUser.uid } : {}),
      lifecycleOperationId: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await adminDb
      .runTransaction(async (transaction) => {
        const current = await transaction.get(invitationRef);
        if (current.data()?.lifecycleOperationId !== operationId) return;
        transaction.update(invitationRef, {
          status: "archived",
          accountStatus: "archived",
          archivedAt: invitation.data.archivedAt || Timestamp.now(),
          archivedBy: invitation.data.archivedBy || FieldValue.delete(),
          lifecycleOperationId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      })
      .catch(() => undefined);
    throw error;
  }

  return "Pending invitation restored. Resend verification if its previous link has expired.";
}

async function archiveVerifiedStaff(staffId: string, administratorUid: string) {
  const staffDocument = await findStaffDocument(staffId);
  if (!staffDocument?.exists) throw new ApiError("Staff record not found.", 404, "staff-not-found");
  const staff = staffDocument.data();
  if (staff?.accountStatus === "archived" || staff?.status === "archived") {
    return "Staff account is already archived.";
  }

  const targetUid = await getStaffAuthUid(staffDocument);
  if (targetUid === administratorUid) {
    throw new ApiError("You cannot archive your own administrator account.", 409, "cannot-archive-self");
  }

  await adminAuth.updateUser(targetUid, { disabled: true });
  try {
    await staffDocument.ref.update({
      uid: targetUid,
      authUid: targetUid,
      accountStatus: "archived",
      archivedAt: Timestamp.now(),
      archivedBy: administratorUid,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await adminAuth.updateUser(targetUid, { disabled: false }).catch(() => undefined);
    throw error;
  }

  return "Staff account archived. Dashboard access is disabled.";
}

async function restoreVerifiedStaff(staffId: string) {
  const staffDocument = await findStaffDocument(staffId);
  if (!staffDocument?.exists) throw new ApiError("Staff record not found.", 404, "staff-not-found");
  const staff = staffDocument.data();
  if (staff?.cleanupOperationId) {
    throw new ApiError("This staff account is being permanently deleted.", 409, "cleanup-in-progress");
  }
  if (staff?.accountStatus !== "archived" && staff?.status !== "archived") {
    return "Staff account is already active.";
  }

  const targetUid = await getStaffAuthUid(staffDocument);
  await adminAuth.updateUser(targetUid, { disabled: false });
  try {
    await staffDocument.ref.update({
      uid: targetUid,
      authUid: targetUid,
      accountStatus: "active",
      archivedAt: FieldValue.delete(),
      archivedBy: FieldValue.delete(),
      reactivatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await adminAuth.updateUser(targetUid, { disabled: true }).catch(() => undefined);
    throw error;
  }

  return "Staff account restored. Dashboard access is enabled.";
}

export async function archiveStaffMember(staffId: string, administratorUid: string) {
  const documentId = invitationDocumentId(staffId);
  const message = documentId
    ? await archiveInvitation(documentId, administratorUid)
    : await archiveVerifiedStaff(staffId, administratorUid);
  return { message };
}

export async function restoreStaffMember(staffId: string) {
  const documentId = invitationDocumentId(staffId);
  const message = documentId ? await restoreInvitation(documentId) : await restoreVerifiedStaff(staffId);
  return { message };
}

export async function cancelPendingInvitation(staffId: string) {
  const documentId = invitationDocumentId(staffId);
  if (!documentId) throw new ApiError("Pending invitation not found.", 404, "invitation-not-found");

  const invitationRef = adminDb.collection("pendingStaffInvitations").doc(documentId);
  const operationId = createOpaqueToken();
  const invitation = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(invitationRef);
    const data = snapshot.data();
    if (!snapshot.exists || !data) return null;
    if (data.status !== "pending") {
      throw new ApiError("Only an active pending invitation can be cancelled.", 409, "invitation-not-pending");
    }
    transaction.update(invitationRef, {
      status: "cancelling",
      lifecycleOperationId: operationId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return data;
  });

  if (!invitation) return { message: "Pending invitation is already cancelled." };

  try {
    await deletePendingInvitationAuthUser(invitation);
    await invitationRef.update({
      status: "cancelled",
      cancelledAt: FieldValue.serverTimestamp(),
      lifecycleOperationId: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await adminDb
      .runTransaction(async (transaction) => {
        const current = await transaction.get(invitationRef);
        if (current.data()?.lifecycleOperationId !== operationId) return;
        transaction.update(invitationRef, {
          status: "pending",
          lifecycleOperationId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      })
      .catch(() => undefined);
    throw error;
  }

  return { message: "Pending invitation cancelled." };
}

async function deleteAuthUserForCleanup(data: DocumentData, isInvitation: boolean) {
  const email = normalizeEmail(String(data.email || ""));
  if (isInvitation && email && (await findStaffByEmail(email))) return;

  const uid = typeof data.uid === "string" && data.uid ? data.uid : String(data.authUid || "");
  let authUser: UserRecord | null = null;
  if (uid) {
    authUser = await getAuthUserByUid(uid);
  } else if (email) {
    authUser = await getAuthUserByEmail(email);
  }
  if (!authUser) return;
  if (email && normalizeEmail(authUser.email || "") !== email) {
    throw new Error("Archived record and Firebase Authentication user do not match.");
  }
  await adminAuth.deleteUser(authUser.uid);
}

function isExpiredArchivedInvitation(document: QueryDocumentSnapshot) {
  const status = document.data().status;
  return status === "archived" || status === "deleting";
}

function isExpiredArchivedStaff(document: QueryDocumentSnapshot) {
  const data = document.data();
  return (
    (data.accountStatus === "archived" || data.status === "archived" || data.cleanupStatus === "deleting") &&
    data.emailVerified === false
  );
}

export interface ArchivedCleanupResult {
  deleted: number;
  failed: string[];
}

export interface ExpiredInvitationCleanupResult {
  deletedAuthUsers: number;
  failed: string[];
}

export async function cleanupExpiredPendingInvitations(): Promise<ExpiredInvitationCleanupResult> {
  const now = Timestamp.now();
  const invitationSnapshot = await adminDb
    .collection("pendingStaffInvitations")
    .where("expiresAt", "<=", now)
    .limit(200)
    .get();
  const candidates = invitationSnapshot.docs.filter((document) => {
    const status = document.data().status;
    return status === "pending" || status === "expired";
  });

  let deletedAuthUsers = 0;
  const failed: string[] = [];
  for (const candidate of candidates) {
    const operationId = createOpaqueToken();
    try {
      const invitation = await adminDb.runTransaction(async (transaction) => {
        const current = await transaction.get(candidate.ref);
        const data = current.data();
        if (!current.exists || !data || (data.status !== "pending" && data.status !== "expired")) return null;
        if (!(data.expiresAt instanceof Timestamp) || data.expiresAt.toMillis() > Timestamp.now().toMillis()) {
          return null;
        }
        transaction.update(candidate.ref, {
          status: "expiring",
          cleanupOperationId: operationId,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return data;
      });
      if (!invitation) continue;

      const deletedAuthUser = await deletePendingInvitationAuthUser(invitation);
      await candidate.ref.update({
        status: "expired",
        expiredAt: invitation.expiredAt || FieldValue.serverTimestamp(),
        authDeletedAt: FieldValue.serverTimestamp(),
        cleanupOperationId: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (deletedAuthUser) deletedAuthUsers += 1;
    } catch (error) {
      await candidate.ref
        .update({
          status: "expired",
          cleanupOperationId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        })
        .catch(() => undefined);
      failed.push(candidate.id);
      console.error("Unable to clean up expired pending invitation:", candidate.id, error);
    }
  }

  return { deletedAuthUsers, failed };
}

async function claimCleanupCandidate(
  document: QueryDocumentSnapshot,
  isInvitation: boolean,
  cutoff: Timestamp,
  operationId: string,
) {
  return adminDb.runTransaction(async (transaction) => {
    const current = await transaction.get(document.ref);
    const data = current.data();
    if (
      !current.exists ||
      !data ||
      !(data.archivedAt instanceof Timestamp) ||
      data.archivedAt.toMillis() > cutoff.toMillis()
    ) {
      return null;
    }

    const cleanupStartedAt = data.cleanupStartedAt instanceof Timestamp ? data.cleanupStartedAt.toMillis() : 0;
    if (data.cleanupOperationId && cleanupStartedAt > Date.now() - CLEANUP_LEASE_MS) return null;
    if (isInvitation) {
      if (data.status !== "archived" && data.status !== "deleting") return null;
      transaction.update(document.ref, {
        status: "deleting",
        cleanupOperationId: operationId,
        cleanupStartedAt: Timestamp.now(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      const isArchived = data.accountStatus === "archived" || data.status === "archived";
      if (!isArchived || data.emailVerified !== false) return null;
      transaction.update(document.ref, {
        cleanupStatus: "deleting",
        cleanupOperationId: operationId,
        cleanupStartedAt: Timestamp.now(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return data;
  });
}

async function releaseCleanupCandidate(document: QueryDocumentSnapshot, isInvitation: boolean, operationId: string) {
  await adminDb.runTransaction(async (transaction) => {
    const current = await transaction.get(document.ref);
    if (current.data()?.cleanupOperationId !== operationId) return;
    transaction.update(document.ref, {
      ...(isInvitation ? { status: "archived" } : { cleanupStatus: FieldValue.delete() }),
      cleanupOperationId: FieldValue.delete(),
      cleanupStartedAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export async function cleanupArchivedUnverifiedAccounts(): Promise<ArchivedCleanupResult> {
  const cutoff = Timestamp.fromMillis(Date.now() - ARCHIVED_UNVERIFIED_RETENTION_MS);
  const [invitationSnapshot, staffSnapshot] = await Promise.all([
    adminDb.collection("pendingStaffInvitations").where("archivedAt", "<=", cutoff).limit(200).get(),
    adminDb.collection("staff").where("archivedAt", "<=", cutoff).limit(200).get(),
  ]);
  const candidates = [
    ...invitationSnapshot.docs
      .filter(isExpiredArchivedInvitation)
      .map((document) => ({ document, isInvitation: true })),
    ...staffSnapshot.docs.filter(isExpiredArchivedStaff).map((document) => ({ document, isInvitation: false })),
  ];

  let deleted = 0;
  const failed: string[] = [];
  for (const candidate of candidates) {
    const operationId = createOpaqueToken();
    try {
      const data = await claimCleanupCandidate(candidate.document, candidate.isInvitation, cutoff, operationId);
      if (!data) continue;
      await deleteAuthUserForCleanup(data, candidate.isInvitation);
      await candidate.document.ref.delete();
      deleted += 1;
    } catch (error) {
      await releaseCleanupCandidate(candidate.document, candidate.isInvitation, operationId).catch(() => undefined);
      failed.push(candidate.document.id);
      console.error("Unable to clean up archived unverified staff record:", candidate.document.id, error);
    }
  }

  return { deleted, failed };
}
