import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";

import { adminAuth, adminDb } from "@/lib/firebase/admin";
import {
  ApiError,
  createOpaqueToken,
  errorResponse,
  expiresInHours,
  findStaffByEmail,
  getRequestOrigin,
  hashToken,
  normalizeEmail,
  requireAdministrator,
} from "@/lib/firebase/admin-staff";
import { sendFirebaseVerificationEmail } from "@/lib/firebase/firebase-verification-email";
import { cancelPendingInvitation } from "@/lib/firebase/staff-lifecycle";

const invitationSchema = z.object({
  email: z.email(),
  username: z.string().trim().min(2).max(60),
  role: z.enum(["Administrator", "Operator"]),
});

export async function POST(request: Request) {
  let invitationRef: FirebaseFirestore.DocumentReference | null = null;
  let createdUid = "";

  try {
    const administrator = await requireAdministrator(request);
    const input = invitationSchema.parse(await request.json());
    const email = normalizeEmail(input.email);

    const existingStaff = await findStaffByEmail(email);
    if (existingStaff) {
      throw new ApiError("A staff account already uses this email address.", 409, "email-already-in-use");
    }
    const pendingEmailOwner = await adminDb.collection("staff").where("pendingEmail", "==", email).limit(1).get();
    if (!pendingEmailOwner.empty) {
      throw new ApiError("This email is already pending verification for another staff account.", 409, "email-pending");
    }

    const pendingInvitations = await adminDb
      .collection("pendingStaffInvitations")
      .where("normalizedEmail", "==", email)
      .get();
    const pendingInvitation = pendingInvitations.docs.find((document) => {
      const status = document.data().status;
      return status === "pending" || status === "expired";
    });
    if (pendingInvitation) {
      throw new ApiError(
        "An invitation already exists for this email. Resend verification from the staff table.",
        409,
        "invitation-pending",
      );
    }
    if (pendingInvitations.docs.some((document) => document.data().status === "archived")) {
      throw new ApiError(
        "An archived invitation uses this email. Restore it from the Archived tab.",
        409,
        "invitation-archived",
      );
    }

    try {
      await adminAuth.getUserByEmail(email);
      throw new ApiError(
        "This email already exists in Firebase Authentication but has no staff profile.",
        409,
        "auth-email-already-in-use",
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    }

    const token = createOpaqueToken();
    const tokenHash = hashToken(token);
    const expiresAt = expiresInHours(1);
    const temporaryPassword = createOpaqueToken();
    const authUser = await adminAuth.createUser({
      email,
      password: temporaryPassword,
      displayName: input.username,
      emailVerified: false,
      disabled: false,
    });
    createdUid = authUser.uid;
    invitationRef = adminDb.collection("pendingStaffInvitations").doc(tokenHash);
    await invitationRef.set({
      authUid: authUser.uid,
      email,
      normalizedEmail: email,
      username: input.username,
      role: input.role,
      tokenHash,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      invitedBy: administrator.token.uid,
    });

    const invitationUrl = new URL("/complete-invitation", getRequestOrigin(request));
    invitationUrl.searchParams.set("token", token);
    await sendFirebaseVerificationEmail(email, temporaryPassword, invitationUrl.toString());
    await invitationRef.update({
      verificationDeliveryStatus: "sent",
      verificationSentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return Response.json({
      success: true,
      message: `Invitation email sent to ${email}.`,
      email,
      expiresAt: expiresAt.toDate().toISOString(),
    });
  } catch (error) {
    await Promise.all([
      invitationRef?.delete().catch(() => undefined),
      createdUid ? adminAuth.deleteUser(createdUid).catch(() => undefined) : Promise.resolve(),
    ]);
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "Enter a valid email, username, and role.", code: "invalid-input" },
        { status: 400 },
      );
    }
    return errorResponse(error);
  }
}

const cancellationSchema = z.union([
  z.object({ token: z.string().min(20) }),
  z.object({ invitationId: z.string().startsWith("invitation:") }),
]);

export async function DELETE(request: Request) {
  try {
    await requireAdministrator(request);
    const input = cancellationSchema.parse(await request.json());
    const invitationId = "token" in input ? `invitation:${hashToken(input.token)}` : input.invitationId;
    return Response.json(await cancelPendingInvitation(invitationId));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Pending invitation is invalid.", code: "invalid-invitation" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
