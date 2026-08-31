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

const RESEND_COOLDOWN_MS = 180_000;
const resendSchema = z.object({ email: z.email() });

function toMillis(value: unknown) {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function newestFirst(
  left: FirebaseFirestore.QueryDocumentSnapshot,
  right: FirebaseFirestore.QueryDocumentSnapshot,
) {
  const leftData = left.data();
  const rightData = right.data();
  return (
    Math.max(toMillis(rightData.updatedAt), toMillis(rightData.createdAt)) -
    Math.max(toMillis(leftData.updatedAt), toMillis(leftData.createdAt))
  );
}

async function getOrRepairPendingAuthUser(email: string, invitation: FirebaseFirestore.DocumentData) {
  const storedUid = typeof invitation.authUid === "string" ? invitation.authUid.trim() : "";
  let authUser: UserRecord | null = null;

  if (storedUid) {
    try {
      authUser = await adminAuth.getUser(storedUid);
    } catch (error) {
      if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    }
    if (authUser && normalizeEmail(authUser.email || "") !== email) {
      throw new ApiError("The pending Firebase account does not match this invitation.", 409, "auth-user-mismatch");
    }
  }

  if (!authUser) {
    try {
      authUser = await adminAuth.getUserByEmail(email);
    } catch (error) {
      if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    }
  }

  if (!authUser) {
    authUser = await adminAuth.createUser({
      uid: createOpaqueToken(),
      email,
      password: createOpaqueToken(),
      displayName: String(invitation.username || ""),
      emailVerified: false,
      disabled: false,
    });
  } else if (authUser.emailVerified || authUser.disabled) {
    authUser = await adminAuth.updateUser(authUser.uid, { emailVerified: false, disabled: false });
  }

  return authUser;
}

export async function POST(request: Request) {
  let rotatedInvitationRef: FirebaseFirestore.DocumentReference | null = null;
  let deliveryAttemptId = "";

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
    const currentExpiry = getStaffInvitationExpirationMillis(activeData);
    if (activeData.status === "pending" && currentExpiry > Date.now()) {
      throw new ApiError(
        "The current verification link is still active. Wait until it expires before resending.",
        409,
        "verification-still-active",
      );
    }
    const resendAvailableAt = toMillis(activeData.verificationResendAvailableAt);
    if (resendAvailableAt > Date.now()) {
      throw new ApiError(
        "A verification email was requested recently. Wait for the cooldown before trying again.",
        429,
        "verification-resend-cooldown",
      );
    }

    const authUser = await getOrRepairPendingAuthUser(email, activeData);
    const verificationToken = createOpaqueToken();
    const expiresAt = expiresInHours(1);
    const cooldownEndsAt = Timestamp.fromMillis(Date.now() + RESEND_COOLDOWN_MS);
    deliveryAttemptId = createOpaqueToken();
    const nextInvitationRef = adminDb.collection("pendingStaffInvitations").doc(hashToken(verificationToken));

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
      const currentExpiresAt = getStaffInvitationExpirationMillis(data);
      if (data.status === "pending" && currentExpiresAt > Date.now()) {
        throw new ApiError(
          "The current verification link is still active. Wait until it expires before resending.",
          409,
          "verification-still-active",
        );
      }
      const currentCooldown = toMillis(data.verificationResendAvailableAt);
      if (currentCooldown > Date.now()) {
        throw new ApiError(
          "A verification email was requested recently. Wait for the cooldown before trying again.",
          429,
          "verification-resend-cooldown",
        );
      }

      transaction.set(nextInvitationRef, {
        ...data,
        status: "pending",
        authUid: authUser.uid,
        expiresAt,
        verificationDeliveryStatus: "sending",
        verificationDeliveryAttemptId: deliveryAttemptId,
        verificationSentAt: Timestamp.now(),
        verificationResendAvailableAt: cooldownEndsAt,
        verificationResendCount: Number(data.verificationResendCount || 0) + 1,
        verificationResendRequestedAt: Timestamp.now(),
        verificationResentBy: administrator.token.uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (nextInvitationRef.id !== activeInvitation.id) transaction.delete(activeInvitation.ref);
    });
    rotatedInvitationRef = nextInvitationRef;

    const continueUrl = new URL("/complete-invitation", getRequestOrigin(request));
    continueUrl.searchParams.set("token", verificationToken);
    await sendFirebaseVerificationEmail(authUser.uid, email, continueUrl.toString());

    await nextInvitationRef
      .update({
        status: "pending",
        verificationDeliveryStatus: "sent",
        verificationDeliveryAttemptId: FieldValue.delete(),
        verificationSentAt: Timestamp.now(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch((error) => console.error("Verification email sent, but delivery metadata was not updated:", error));

    return Response.json({
      success: true,
      message: "Verification email resent successfully.",
      expiresAt: expiresAt.toDate().toISOString(),
      cooldownEndsAt: cooldownEndsAt.toDate().toISOString(),
    });
  } catch (error) {
    if (rotatedInvitationRef && deliveryAttemptId) {
      const retryAt =
        error instanceof ApiError && error.status === 429
          ? Timestamp.fromMillis(Date.now() + RESEND_COOLDOWN_MS)
          : Timestamp.now();
      await adminDb
        .runTransaction(async (transaction) => {
          const current = await transaction.get(rotatedInvitationRef!);
          if (current.data()?.verificationDeliveryAttemptId !== deliveryAttemptId) return;
          transaction.update(rotatedInvitationRef!, {
            status: "expired",
            expiresAt: Timestamp.now(),
            verificationDeliveryStatus: "failed",
            verificationDeliveryAttemptId: FieldValue.delete(),
            verificationResendAvailableAt: retryAt,
            updatedAt: FieldValue.serverTimestamp(),
          });
        })
        .catch(() => undefined);
    }
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
    const message = payload.error || "Unable to resend the verification email.";
    return Response.json({ ...payload, success: false, message }, { status: response.status });
  }
}
