import type { UserRecord } from "firebase-admin/auth";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminAuth, adminDb } from "@/lib/firebase/admin";
import {
  ApiError,
  errorResponse,
  getStaffInvitationExpirationMillis,
  hashToken,
  normalizeEmail,
} from "@/lib/firebase/admin-staff";
import { deletePendingInvitationAuthUser } from "@/lib/firebase/staff-lifecycle";

const completionSchema = z.object({
  token: z.string().min(20),
  password: z.string().min(8).max(128),
});

function invitationStatusError(status: unknown): never {
  if (status === "cancelled") throw new ApiError("This invitation was cancelled.", 410, "cancelled-token");
  if (status === "expired" || status === "expiring" || status === "superseded") {
    throw new ApiError("This invitation link has expired.", 410, "expired-token");
  }
  if (status === "completed") {
    throw new ApiError("This invitation link has already been used.", 410, "used-token");
  }
  throw new ApiError("This invitation link is invalid.", 404, "invalid-token");
}

async function deleteExpiredAuthUser(invitation: FirebaseFirestore.DocumentData) {
  await deletePendingInvitationAuthUser(invitation).catch((error) => {
    console.error("Unable to delete the expired pending Firebase user:", error);
  });
}

export async function POST(request: Request) {
  let invitationRef: FirebaseFirestore.DocumentReference | null = null;

  try {
    const input = completionSchema.parse(await request.json());
    const pendingInvitationRef = adminDb.collection("pendingStaffInvitations").doc(hashToken(input.token));
    invitationRef = pendingInvitationRef;

    const claim = await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(pendingInvitationRef);
      const invitation = snapshot.data();
      if (!snapshot.exists || !invitation) {
        throw new ApiError("This invitation link is invalid.", 404, "invalid-token");
      }
      if (invitation.status !== "pending") invitationStatusError(invitation.status);
      if (getStaffInvitationExpirationMillis(invitation) <= Timestamp.now().toMillis()) {
        transaction.update(pendingInvitationRef, {
          status: "expired",
          expiredAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return { invitation, expired: true as const };
      }
      transaction.update(pendingInvitationRef, { status: "processing", updatedAt: FieldValue.serverTimestamp() });
      return { invitation, expired: false as const };
    });

    if (claim.expired) {
      await deleteExpiredAuthUser(claim.invitation);
      throw new ApiError("This invitation link has expired.", 410, "expired-token");
    }

    const invitation = claim.invitation;
    let authUser: UserRecord;
    try {
      const authUid = typeof invitation.authUid === "string" ? invitation.authUid : "";
      authUser = authUid ? await adminAuth.getUser(authUid) : await adminAuth.getUserByEmail(String(invitation.email));
    } catch (error) {
      if ((error as { code?: string }).code === "auth/user-not-found") {
        throw new ApiError("The pending Firebase account was not found.", 409, "missing-auth-user");
      }
      throw error;
    }

    const invitationEmail = normalizeEmail(String(invitation.normalizedEmail || invitation.email));
    if (!authUser.email || normalizeEmail(authUser.email) !== invitationEmail) {
      throw new ApiError("The Firebase account does not match this invitation.", 409, "auth-user-mismatch");
    }
    if (!authUser.emailVerified) {
      throw new ApiError("Verify the Firebase email before creating your password.", 409, "email-unverified");
    }

    await adminAuth.updateUser(authUser.uid, {
      password: input.password,
      displayName: String(invitation.username),
      disabled: false,
    });

    const batch = adminDb.batch();
    batch.create(adminDb.collection("staff").doc(authUser.uid), {
      uid: authUser.uid,
      authUid: authUser.uid,
      role: invitation.role,
      username: invitation.username,
      email: invitationEmail,
      normalizedEmail: invitationEmail,
      emailVerified: true,
      accountStatus: "active",
      emailChangeStatus: "none",
      dateJoined: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      invitedBy: invitation.invitedBy,
    });
    batch.update(invitationRef, {
      status: "completed",
      completedAt: FieldValue.serverTimestamp(),
      completedByUid: authUser.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();

    return Response.json({ message: "Your verified SmartRoad staff account is active." });
  } catch (error) {
    if (invitationRef) {
      const current = await invitationRef.get().catch(() => null);
      const currentData = current?.data();
      if (currentData?.status === "processing") {
        const expired = getStaffInvitationExpirationMillis(currentData) <= Timestamp.now().toMillis();
        await invitationRef
          .update({
            status: expired ? "expired" : "pending",
            ...(expired ? { expiredAt: FieldValue.serverTimestamp() } : {}),
            updatedAt: FieldValue.serverTimestamp(),
          })
          .catch(() => undefined);
        if (expired) await deleteExpiredAuthUser(currentData);
      }
    }
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "Use a password with at least 8 characters.", code: "invalid-input" },
        { status: 400 },
      );
    }
    return errorResponse(error);
  }
}
