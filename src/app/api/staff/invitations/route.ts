import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminAuth, adminDb } from "@/lib/firebase/admin";
import {
  ApiError,
  createOpaqueToken,
  errorResponse,
  expiresInHours,
  findStaffByEmail,
  hashToken,
  normalizeEmail,
  requireAdministrator,
} from "@/lib/firebase/admin-staff";

const invitationSchema = z.object({
  email: z.email(),
  username: z.string().trim().min(2).max(60),
  role: z.enum(["Administrator", "Operator"]),
});

export async function POST(request: Request) {
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

    const pendingInvitations = await adminDb
      .collection("pendingStaffInvitations")
      .where("normalizedEmail", "==", email)
      .get();
    const hasLiveInvitation = pendingInvitations.docs.some((document) => {
      const data = document.data();
      return data.status === "pending" && data.expiresAt instanceof Timestamp && data.expiresAt.toMillis() > Date.now();
    });
    if (hasLiveInvitation) {
      throw new ApiError("A valid invitation is already pending for this email address.", 409, "invitation-pending");
    }

    const token = createOpaqueToken();
    const tokenHash = hashToken(token);
    const expiresAt = expiresInHours(24);
    const invitationRef = adminDb.collection("pendingStaffInvitations").doc(tokenHash);
    await invitationRef.set({
      email,
      normalizedEmail: email,
      username: input.username,
      role: input.role,
      status: "pending",
      createdAt: Timestamp.now(),
      expiresAt,
      invitedBy: administrator.token.uid,
    });

    return Response.json({
      message: `Invitation prepared for ${email}.`,
      email,
      verificationToken: token,
      temporaryPassword: createOpaqueToken(),
      expiresAt: expiresAt.toDate().toISOString(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "Enter a valid email, username, and role.", code: "invalid-input" },
        { status: 400 },
      );
    }
    return errorResponse(error);
  }
}

const cancellationSchema = z.object({ token: z.string().min(20) });

export async function DELETE(request: Request) {
  try {
    await requireAdministrator(request);
    const input = cancellationSchema.parse(await request.json());
    const invitationRef = adminDb.collection("pendingStaffInvitations").doc(hashToken(input.token));
    const invitation = await invitationRef.get();
    const data = invitation.data();

    if (invitation.exists && data?.status === "pending") {
      const email = normalizeEmail(String(data.email || ""));
      if (email) {
        const staff = await findStaffByEmail(email);
        if (!staff) {
          try {
            const pendingUser = await adminAuth.getUserByEmail(email);
            await adminAuth.deleteUser(pendingUser.uid);
          } catch (error) {
            if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
          }
        }
      }
      await invitationRef.delete();
    }

    return Response.json({ message: "Pending invitation cancelled." });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Invitation token is invalid.", code: "invalid-token" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
