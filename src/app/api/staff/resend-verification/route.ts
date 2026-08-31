import type { UserRecord } from "firebase-admin/auth";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminAuth, adminDb } from "@/lib/firebase/admin";
import {
  ApiError,
  createOpaqueToken,
  errorResponse,
  expiresInHours,
  findStaffByEmail,
  getRequestOrigin,
  getStaffInvitationExpirationMillis,
  hashToken,
  normalizeEmail,
  requireAdministrator,
} from "@/lib/firebase/admin-staff";
import { sendFirebaseVerificationEmail } from "@/lib/firebase/firebase-verification-email";
import { deletePendingInvitationAuthUser } from "@/lib/firebase/staff-lifecycle";

const RESEND_COOLDOWN_MS = 180_000;
const resendSchema = z.object({ email: z.email() });

function toMillis(value: unknown) {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function newestFirst(left: FirebaseFirestore.QueryDocumentSnapshot, right: FirebaseFirestore.QueryDocumentSnapshot) {
  const leftData = left.data();
  const rightData = right.data();
  return (
    Math.max(toMillis(rightData.updatedAt), toMillis(rightData.createdAt)) -
    Math.max(toMillis(leftData.updatedAt), toMillis(leftData.createdAt))
  );
}

async function preparePendingAuthUser(
  email: string,
  invitation: FirebaseFirestore.DocumentData,
  temporaryPassword: string,
) {
  const storedUid = typeof invitation.authUid === "string" ? invitation.authUid.trim() : "";
  let authUser: UserRecord | null = null;

  if (storedUid) {
    try {
      authUser = await adminAuth.getUser(storedUid);
    } catch (error) {
      if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    }
  }
  if (!authUser) {
    try {
      authUser = await adminAuth.getUserByEmail(email);
    } catch (error) {
      if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    }
  }
  if (authUser && normalizeEmail(authUser.email || "") !== email) {
    throw new ApiError("The pending Firebase account does not match this invitation.", 409, "auth-user-mismatch");
  }

  if (!authUser) {
    const createdUser = await adminAuth.createUser({
      email,
      password: temporaryPassword,
      displayName: String(invitation.username || ""),
      emailVerified: false,
      disabled: false,
    });
    return { authUser: createdUser, created: true };
  }

  const updatedUser = await adminAuth.updateUser(authUser.uid, {
    password: temporaryPassword,
    displayName: String(invitation.username || ""),
    emailVerified: false,
    disabled: false,
  });
  return { authUser: updatedUser, created: false };
}

export async function POST(request: Request) {
  let rotatedInvitationRef: FirebaseFirestore.DocumentReference | null = null;
  let deliveryAttemptId = "";
  let newlyCreatedUid = "";

  try {
    const administrator = await requireAdministrator(request);
    const input = resendSchema.parse(await request.json());
    const email = normalizeEmail(input.email);

    if (await findStaffByEmail(email)) {
      throw new ApiError("This staff account is already verified.", 409, "staff-already-verified");
    }

    const invitationSnapshot = await adminDb
      .collection("pendingStaffInvitations")
      .where("normalizedEmail", "==", email)
      .get();
    const invitations = invitationSnapshot.docs.sort(newestFirst);
    const activeInvitation = invitations.find((document) => {
      const status = document.data().status;
      return status === "pending" || status === "expired";
    });
    if (!activeInvitation) {
      const archivedInvitation = invitations.some((document) => document.data().status === "archived");
      throw new ApiError(
        archivedInvitation
          ? "Restore this pending account before resending verification."
          : "No pending invitation was found for this email address.",
        archivedInvitation ? 409 : 404,
        archivedInvitation ? "account-archived" : "invitation-not-found",
      );
    }

    const activeData = activeInvitation.data();
    const now = Timestamp.now().toMillis();
    const currentExpiry = getStaffInvitationExpirationMillis(activeData);
    if (activeData.status === "pending" && currentExpiry > now) {
      throw new ApiError(
        "The current verification link is still active. Wait until it expires before resending.",
        409,
        "verification-still-active",
      );
    }
    if (activeData.status === "expired" || currentExpiry <= now) {
      await activeInvitation.ref.update({
        status: "expired",
        expiredAt: activeData.expiredAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await deletePendingInvitationAuthUser(activeData);
    }
    const resendAvailableAt = toMillis(activeData.verificationResendAvailableAt);
    if (resendAvailableAt > now) {
      throw new ApiError(
        "A verification email was requested recently. Wait for the cooldown before trying again.",
        429,
        "verification-resend-cooldown",
      );
    }

    const temporaryPassword = createOpaqueToken();
    const preparedUser = await preparePendingAuthUser(email, activeData, temporaryPassword);
    if (preparedUser.created) newlyCreatedUid = preparedUser.authUser.uid;

    const verificationToken = createOpaqueToken();
    const tokenHash = hashToken(verificationToken);
    const expiresAt = expiresInHours(1);
    const cooldownEndsAt = Timestamp.fromMillis(now + RESEND_COOLDOWN_MS);
    deliveryAttemptId = createOpaqueToken();
    const nextInvitationRef = adminDb.collection("pendingStaffInvitations").doc(tokenHash);

    await adminDb.runTransaction(async (transaction) => {
      const current = await transaction.get(activeInvitation.ref);
      const data = current.data();
      if (!current.exists || !data || (data.status !== "pending" && data.status !== "expired")) {
        throw new ApiError(
          "This pending invitation changed. Refresh the staff list and try again.",
          409,
          "stale-invitation",
        );
      }
      const transactionNow = Timestamp.now().toMillis();
      if (data.status === "pending" && getStaffInvitationExpirationMillis(data) > transactionNow) {
        throw new ApiError(
          "The current verification link is still active. Wait until it expires before resending.",
          409,
          "verification-still-active",
        );
      }
      if (toMillis(data.verificationResendAvailableAt) > transactionNow) {
        throw new ApiError(
          "A verification email was requested recently. Wait for the cooldown before trying again.",
          429,
          "verification-resend-cooldown",
        );
      }

      transaction.set(nextInvitationRef, {
        email,
        normalizedEmail: email,
        username: data.username,
        role: data.role,
        authUid: preparedUser.authUser.uid,
        tokenHash,
        status: "pending",
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
        invitedBy: data.invitedBy,
        verificationDeliveryStatus: "sending",
        verificationDeliveryAttemptId: deliveryAttemptId,
        verificationResendAvailableAt: cooldownEndsAt,
        verificationResendCount: Number(data.verificationResendCount || 0) + 1,
        verificationResendRequestedAt: FieldValue.serverTimestamp(),
        verificationResentBy: administrator.token.uid,
      });
      transaction.update(activeInvitation.ref, {
        status: "superseded",
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    rotatedInvitationRef = nextInvitationRef;

    const invitationUrl = new URL("/complete-invitation", getRequestOrigin(request));
    invitationUrl.searchParams.set("token", verificationToken);
    await sendFirebaseVerificationEmail(email, temporaryPassword, invitationUrl.toString());

    await nextInvitationRef.update({
      verificationDeliveryStatus: "sent",
      verificationDeliveryAttemptId: FieldValue.delete(),
      verificationSentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return Response.json({
      success: true,
      message: `Verification email resent to ${email}.`,
      expiresAt: expiresAt.toDate().toISOString(),
      cooldownEndsAt: cooldownEndsAt.toDate().toISOString(),
    });
  } catch (error) {
    if (rotatedInvitationRef && deliveryAttemptId) {
      await rotatedInvitationRef
        .update({
          status: "expired",
          expiresAt: Timestamp.now(),
          verificationDeliveryStatus: "failed",
          verificationDeliveryAttemptId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        })
        .catch(() => undefined);
    }
    if (newlyCreatedUid) await adminAuth.deleteUser(newlyCreatedUid).catch(() => undefined);
    if (error instanceof z.ZodError) {
      return Response.json(
        { success: false, message: "Enter a valid email address.", error: "Enter a valid email address." },
        { status: 400 },
      );
    }
    if (error instanceof ApiError) {
      return Response.json(
        { success: false, message: error.message, error: error.message, code: error.code },
        { status: error.status },
      );
    }
    const response = errorResponse(error);
    const payload = (await response.json()) as { error?: string; code?: string };
    const message = payload.error ? payload.error : "Unable to resend the verification email.";
    return Response.json({ ...payload, success: false, message }, { status: response.status });
  }
}
