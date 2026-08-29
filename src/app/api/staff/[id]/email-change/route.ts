import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminAuth, adminDb } from "@/lib/firebase/admin";
import {
  ApiError,
  createOpaqueToken,
  errorResponse,
  expiresInHours,
  findStaffByEmail,
  findStaffDocument,
  getStaffAuthUid,
  hashToken,
  normalizeEmail,
  requireAdministrator,
} from "@/lib/firebase/admin-staff";
import { reconcileEmailChange } from "@/lib/firebase/email-change-status";

const emailSchema = z.object({ email: z.email() });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdministrator(request);
    const { id } = await context.params;
    const staffDocument = await findStaffDocument(id);
    if (!staffDocument?.exists) throw new ApiError("Staff record not found.", 404, "staff-not-found");
    const staff = staffDocument.data();
    if (!staff) throw new ApiError("Staff record not found.", 404, "staff-not-found");

    if (staff.emailChangeStatus === "completed") {
      const completedAt =
        staff.emailChangeCompletedAt instanceof Timestamp
          ? staff.emailChangeCompletedAt.toDate().toISOString()
          : undefined;
      return Response.json({ status: "completed", email: staff.email, completedAt });
    }

    const requestId = typeof staff.emailChangeRequestId === "string" ? staff.emailChangeRequestId : "";
    if (!requestId) return Response.json({ status: "idle", email: staff.email });

    const result = await reconcileEmailChange(requestId, staffDocument.id);
    return Response.json({ status: result.status, email: result.newEmail, completedAt: result.completedAt });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const administrator = await requireAdministrator(request);
    const { id } = await context.params;
    const input = emailSchema.parse(await request.json());
    const newEmail = normalizeEmail(input.email);
    const staffDocument = await findStaffDocument(id);
    if (!staffDocument?.exists) throw new ApiError("Staff record not found.", 404, "staff-not-found");
    const staff = staffDocument.data();
    if (!staff) throw new ApiError("Staff record not found.", 404, "staff-not-found");
    const currentEmail = normalizeEmail(String(staff.email || ""));
    if (newEmail === currentEmail) throw new ApiError("Enter a different email address.", 400, "email-unchanged");
    if (staff.accountStatus === "archived" || staff.status === "archived") {
      throw new ApiError("Reactivate this account before changing its email.", 409, "account-archived");
    }

    const duplicateStaff = await findStaffByEmail(newEmail);
    if (duplicateStaff && duplicateStaff.id !== staffDocument.id) {
      throw new ApiError("A staff account already uses this email address.", 409, "email-already-in-use");
    }
    const pendingEmailOwner = await adminDb.collection("staff").where("pendingEmail", "==", newEmail).limit(1).get();
    if (pendingEmailOwner.docs.some((document) => document.id !== staffDocument.id)) {
      throw new ApiError("This email is already pending verification for another staff account.", 409, "email-pending");
    }

    const targetUid = await getStaffAuthUid(staffDocument);
    try {
      const existingAuthUser = await adminAuth.getUserByEmail(newEmail);
      if (existingAuthUser.uid !== targetUid) {
        throw new ApiError("A Firebase Authentication account already uses this email.", 409, "auth-email-in-use");
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    }

    const token = createOpaqueToken();
    const tokenHash = hashToken(token);
    const expiresAt = expiresInHours(24);
    const requestRef = adminDb.collection("staffEmailChanges").doc(tokenHash);

    const batch = adminDb.batch();
    if (typeof staff.emailChangeRequestId === "string") {
      batch.set(
        adminDb.collection("staffEmailChanges").doc(staff.emailChangeRequestId),
        { status: "superseded", supersededAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    batch.set(requestRef, {
      staffId: staffDocument.id,
      staffUid: targetUid,
      oldEmail: currentEmail,
      newEmail,
      normalizedNewEmail: newEmail,
      status: "pending",
      createdAt: Timestamp.now(),
      expiresAt,
      requestedBy: administrator.token.uid,
    });
    batch.update(staffDocument.ref, {
      pendingEmail: newEmail,
      emailChangeStatus: "pending",
      emailChangeRequestId: tokenHash,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();

    return Response.json({
      message: `Email verification prepared for ${newEmail}.`,
      email: newEmail,
      verificationToken: token,
      temporaryPassword: createOpaqueToken(),
      expiresAt: expiresAt.toDate().toISOString(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Enter a valid email address.", code: "invalid-email" }, { status: 400 });
    }
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdministrator(request);
    const { id } = await context.params;
    const staffDocument = await findStaffDocument(id);
    if (!staffDocument?.exists) throw new ApiError("Staff record not found.", 404, "staff-not-found");
    const staff = staffDocument.data();
    if (!staff) throw new ApiError("Staff record not found.", 404, "staff-not-found");

    if (staff.emailChangeStatus === "completed") {
      return Response.json({
        message: "The email was already verified and updated.",
        status: "completed",
      });
    }
    if (
      staff.emailChangeStatus !== "pending" ||
      typeof staff.emailChangeRequestId !== "string" ||
      !staff.pendingEmail
    ) {
      return Response.json({ message: "There is no pending email verification to cancel.", status: "idle" });
    }

    const targetUid = await getStaffAuthUid(staffDocument);
    const claim = await adminDb.runTransaction(async (transaction) => {
      const currentStaffDocument = await transaction.get(staffDocument.ref);
      const currentStaff = currentStaffDocument.data();
      if (!currentStaffDocument.exists || !currentStaff) {
        throw new ApiError("Staff record not found.", 404, "staff-not-found");
      }
      if (currentStaff.emailChangeStatus === "completed") {
        return { status: "completed" as const };
      }

      const requestId = typeof currentStaff.emailChangeRequestId === "string" ? currentStaff.emailChangeRequestId : "";
      const pendingEmail = normalizeEmail(String(currentStaff.pendingEmail || ""));
      if (currentStaff.emailChangeStatus !== "pending" || !requestId || !pendingEmail) {
        return { status: "idle" as const };
      }

      const requestRef = adminDb.collection("staffEmailChanges").doc(requestId);
      const requestDocument = await transaction.get(requestRef);
      const requestData = requestDocument.data();
      if (!requestDocument.exists || !requestData) {
        throw new ApiError("This email verification request no longer exists.", 404, "invalid-email-change");
      }
      if (requestData.status === "completed") return { status: "completed" as const };
      if (requestData.status !== "pending") {
        throw new ApiError("This email verification is already being processed.", 409, "email-change-processing");
      }

      transaction.update(requestRef, {
        status: "cancelling",
        cancellingAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { status: "claimed" as const, pendingEmail, requestId };
    });

    if (claim.status === "completed") {
      return Response.json({
        message: "The email was already verified and updated.",
        status: "completed",
      });
    }
    if (claim.status === "idle") {
      return Response.json({ message: "There is no pending email verification to cancel.", status: "idle" });
    }

    try {
      try {
        const pendingUser = await adminAuth.getUserByEmail(claim.pendingEmail);
        if (pendingUser.uid !== targetUid) await adminAuth.deleteUser(pendingUser.uid);
      } catch (error) {
        if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
      }

      const requestRef = adminDb.collection("staffEmailChanges").doc(claim.requestId);
      await adminDb.runTransaction(async (transaction) => {
        const currentStaffDocument = await transaction.get(staffDocument.ref);
        const currentRequestDocument = await transaction.get(requestRef);
        const currentStaff = currentStaffDocument.data();
        const currentRequest = currentRequestDocument.data();

        if (currentStaff?.emailChangeRequestId === claim.requestId) {
          transaction.update(staffDocument.ref, {
            pendingEmail: FieldValue.delete(),
            emailChangeStatus: "none",
            emailChangeRequestId: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        if (currentRequest?.status === "cancelling") {
          transaction.update(requestRef, {
            status: "cancelled",
            cancelledAt: FieldValue.serverTimestamp(),
            cancellingAt: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      });
    } catch (error) {
      const requestRef = adminDb.collection("staffEmailChanges").doc(claim.requestId);
      await adminDb
        .runTransaction(async (transaction) => {
          const requestDocument = await transaction.get(requestRef);
          if (requestDocument.data()?.status === "cancelling") {
            transaction.update(requestRef, {
              status: "pending",
              cancellingAt: FieldValue.delete(),
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
        })
        .catch(() => undefined);
      throw error;
    }

    return Response.json({
      message: "Email verification cancelled. The original login email remains active.",
      status: "cancelled",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
