import type { UserRecord } from "firebase-admin/auth";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { ApiError, errorResponse, hashToken } from "@/lib/firebase/admin-staff";

const completionSchema = z.object({
  token: z.string().min(20),
  password: z.string().min(8).max(128),
});

export async function POST(request: Request) {
  let invitationRef: FirebaseFirestore.DocumentReference | null = null;

  try {
    const input = completionSchema.parse(await request.json());
    const invitationDocumentRef = adminDb.collection("pendingStaffInvitations").doc(hashToken(input.token));
    invitationRef = invitationDocumentRef;

    const invitation = await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(invitationDocumentRef);
      const data = snapshot.data();
      if (!snapshot.exists || !data) throw new ApiError("This invitation link is invalid.", 404, "invalid-token");
      if (data.status !== "pending")
        throw new ApiError("This invitation link has already been used.", 410, "used-token");
      if (!(data.expiresAt instanceof Timestamp) || data.expiresAt.toMillis() <= Date.now()) {
        transaction.update(invitationDocumentRef, { status: "expired", updatedAt: FieldValue.serverTimestamp() });
        throw new ApiError("This invitation link has expired.", 410, "expired-token");
      }
      transaction.update(invitationDocumentRef, { status: "processing", updatedAt: FieldValue.serverTimestamp() });
      return data;
    });

    let authUser: UserRecord;
    try {
      authUser = await adminAuth.getUserByEmail(String(invitation.email));
    } catch (error) {
      if ((error as { code?: string }).code === "auth/user-not-found") {
        throw new ApiError(
          "Open the Firebase verification email before creating your password.",
          409,
          "email-unverified",
        );
      }
      throw error;
    }
    if (!authUser.emailVerified) {
      throw new ApiError(
        "Open the Firebase verification email before creating your password.",
        409,
        "email-unverified",
      );
    }

    await adminAuth.updateUser(authUser.uid, {
      password: input.password,
      displayName: String(invitation.username),
      disabled: false,
    });

    const batch = adminDb.batch();
    batch.set(adminDb.collection("staff").doc(authUser.uid), {
      uid: authUser.uid,
      authUid: authUser.uid,
      role: invitation.role,
      username: invitation.username,
      email: invitation.email,
      normalizedEmail: invitation.normalizedEmail,
      emailVerified: true,
      accountStatus: "active",
      emailChangeStatus: "none",
      dateJoined: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      invitedBy: invitation.invitedBy,
    });
    batch.update(invitationDocumentRef, {
      status: "completed",
      completedAt: FieldValue.serverTimestamp(),
      createdUid: authUser.uid,
    });
    await batch.commit();

    return Response.json({ message: "Your verified SmartRoad staff account is ready. You can now sign in." });
  } catch (error) {
    if (invitationRef) {
      const current = await invitationRef.get().catch(() => null);
      if (current?.data()?.status === "processing") {
        await invitationRef
          .update({ status: "pending", updatedAt: FieldValue.serverTimestamp() })
          .catch(() => undefined);
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
