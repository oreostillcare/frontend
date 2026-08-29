import "server-only";

import type { UserRecord } from "firebase-admin/auth";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { adminAuth, adminDb } from "./admin";
import { ApiError, createOpaqueToken } from "./admin-staff";

export interface EmailChangeResult {
  status: "pending" | "processing" | "completed";
  newEmail: string;
  completedAt?: string;
}

function timestampToIso(value: unknown) {
  return value instanceof Timestamp ? value.toDate().toISOString() : undefined;
}

export async function reconcileEmailChange(requestId: string, expectedStaffId?: string): Promise<EmailChangeResult> {
  const requestRef = adminDb.collection("staffEmailChanges").doc(requestId);
  const requestSnapshot = await requestRef.get();
  const requestData = requestSnapshot.data();

  if (!requestSnapshot.exists || !requestData) {
    throw new ApiError("This email verification request no longer exists.", 404, "invalid-email-change");
  }
  if (expectedStaffId && requestData.staffId !== expectedStaffId) {
    throw new ApiError(
      "This email verification request does not belong to this staff account.",
      409,
      "request-mismatch",
    );
  }
  if (requestData.status === "completed") {
    return {
      status: "completed",
      newEmail: String(requestData.newEmail),
      completedAt: timestampToIso(requestData.completedAt),
    };
  }
  if (requestData.status === "processing") {
    return { status: "processing", newEmail: String(requestData.newEmail) };
  }
  if (requestData.status !== "pending") {
    throw new ApiError("This email verification request was cancelled or replaced.", 410, "inactive-email-change");
  }
  if (!(requestData.expiresAt instanceof Timestamp) || requestData.expiresAt.toMillis() <= Date.now()) {
    await requestRef.update({ status: "expired", updatedAt: FieldValue.serverTimestamp() });
    throw new ApiError("This email verification request has expired.", 410, "expired-email-change");
  }

  const staffId = String(requestData.staffId);
  const staffRef = adminDb.collection("staff").doc(staffId);
  const staffSnapshot = await staffRef.get();
  const staff = staffSnapshot.data();
  if (!staffSnapshot.exists || !staff || staff.emailChangeRequestId !== requestId) {
    throw new ApiError("This email verification request was replaced by a newer request.", 410, "superseded-token");
  }

  const newEmail = String(requestData.newEmail);
  let verificationUser: UserRecord;
  try {
    verificationUser = await adminAuth.getUserByEmail(newEmail);
  } catch (error) {
    if ((error as { code?: string }).code === "auth/user-not-found") {
      return { status: "pending", newEmail };
    }
    throw error;
  }
  if (!verificationUser.emailVerified) return { status: "pending", newEmail };

  const targetUid = String(requestData.staffUid);
  const oldEmail = String(requestData.oldEmail);
  const verificationUid = verificationUser.uid;
  let targetEmailUpdated = false;
  let verificationUserDeleted = false;

  await adminDb.runTransaction(async (transaction) => {
    const currentRequest = await transaction.get(requestRef);
    if (currentRequest.data()?.status !== "pending") {
      throw new ApiError("This email change is already being processed.", 409, "email-change-processing");
    }
    transaction.update(requestRef, {
      status: "processing",
      processingAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  try {
    if (verificationUid !== targetUid) {
      await adminAuth.deleteUser(verificationUid);
      verificationUserDeleted = true;
    }
    await adminAuth.updateUser(targetUid, { email: newEmail, emailVerified: true });
    targetEmailUpdated = true;

    const batch = adminDb.batch();
    batch.update(staffRef, {
      email: newEmail,
      normalizedEmail: String(requestData.normalizedNewEmail || newEmail).toLowerCase(),
      previousEmail: oldEmail,
      pendingEmail: FieldValue.delete(),
      emailChangeStatus: "completed",
      emailChangeRequestId: FieldValue.delete(),
      emailChangeCompletedAt: FieldValue.serverTimestamp(),
      emailVerified: true,
      emailVerifiedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.update(requestRef, {
      status: "completed",
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();

    return { status: "completed", newEmail };
  } catch (error) {
    if (targetEmailUpdated) {
      await adminAuth.updateUser(targetUid, { email: oldEmail, emailVerified: true }).catch(() => undefined);
    }
    if (verificationUserDeleted) {
      await adminAuth
        .createUser({ email: newEmail, emailVerified: true, password: createOpaqueToken(), disabled: false })
        .catch(() => undefined);
    }
    await requestRef
      .update({ status: "pending", processingAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() })
      .catch(() => undefined);
    throw error;
  }
}
