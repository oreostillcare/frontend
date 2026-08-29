import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminAuth, adminDb } from "@/lib/firebase/admin";
import {
  ApiError,
  authenticateStaff,
  errorResponse,
  findStaffDocument,
  getStaffAuthUid,
} from "@/lib/firebase/admin-staff";

const RESET_COOLDOWN_MS = 180_000;
const resetSchema = z.object({ staffId: z.string().trim().min(1) });

function toMillis(value: unknown) {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    return Number.isNaN(milliseconds) ? 0 : milliseconds;
  }
  return 0;
}

async function loadResetTarget(request: Request, staffId: string) {
  const requester = await authenticateStaff(request);
  const staffDocument = await findStaffDocument(staffId);

  if (!staffDocument?.exists) throw new ApiError("Staff record not found.", 404, "staff-not-found");
  if (requester.role !== "Administrator" && requester.documentId !== staffDocument.id) {
    throw new ApiError("You can only reset your own password.", 403, "forbidden");
  }

  const staff = staffDocument.data();
  if (!staff) throw new ApiError("Staff record not found.", 404, "staff-not-found");
  if (staff.accountStatus === "archived" || staff.status === "archived") {
    throw new ApiError("Reactivate this account before sending a password reset.", 409, "account-archived");
  }

  const authUid = await getStaffAuthUid(staffDocument);
  const authUser = await adminAuth.getUser(authUid);
  return { staffDocument, staff, authUser };
}

export async function POST(request: Request) {
  try {
    const input = resetSchema.parse(await request.json());
    const { staffDocument, authUser } = await loadResetTarget(request, input.staffId);
    const baselineValidAfterTime = Date.parse(authUser.tokensValidAfterTime || "") || 0;

    const result = await adminDb.runTransaction(async (transaction) => {
      const current = await transaction.get(staffDocument.ref);
      const requestedAt = toMillis(current.data()?.passwordResetRequestedAt);
      const existingCooldownEnd = requestedAt + RESET_COOLDOWN_MS;
      if (requestedAt && existingCooldownEnd > Date.now()) {
        return { allowed: false, cooldownEndsAt: existingCooldownEnd };
      }

      transaction.update(staffDocument.ref, {
        passwordResetRequestedAt: FieldValue.serverTimestamp(),
        passwordResetStatus: "pending",
        passwordResetBaselineValidAfterTime: baselineValidAfterTime,
        passwordResetCompletedAt: FieldValue.delete(),
        passwordResetRequestId: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { allowed: true, cooldownEndsAt: Date.now() + RESET_COOLDOWN_MS };
    });

    if (!result.allowed) {
      return Response.json(
        {
          error: "A password reset email was sent recently. Wait for the cooldown before resending.",
          code: "reset-cooldown",
          cooldownEndsAt: new Date(result.cooldownEndsAt).toISOString(),
        },
        { status: 429 },
      );
    }

    return Response.json({
      message: "Password reset request authorized.",
      cooldownEndsAt: new Date(result.cooldownEndsAt).toISOString(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "A valid staff account is required.", code: "invalid-input" }, { status: 400 });
    }
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const staffId = new URL(request.url).searchParams.get("staffId")?.trim();
    if (!staffId) throw new ApiError("A staff account is required.", 400, "missing-staff");
    const { staffDocument, staff, authUser } = await loadResetTarget(request, staffId);
    const requestedAt = toMillis(staff.passwordResetRequestedAt);
    const completedAt = toMillis(staff.passwordResetCompletedAt);

    if (!requestedAt) return Response.json({ status: "idle" });
    if (staff.passwordResetStatus === "completed" || completedAt >= requestedAt) {
      return Response.json({
        status: "completed",
        completedAt: completedAt ? new Date(completedAt).toISOString() : undefined,
      });
    }

    const validAfterTime = Date.parse(authUser.tokensValidAfterTime || "") || 0;
    const baselineValidAfterTime = Number(staff.passwordResetBaselineValidAfterTime) || 0;
    const completed = baselineValidAfterTime ? validAfterTime > baselineValidAfterTime : validAfterTime >= requestedAt;

    if (!completed) {
      return Response.json({ status: "pending", requestedAt: new Date(requestedAt).toISOString() });
    }

    await staffDocument.ref.update({
      passwordResetStatus: "completed",
      passwordResetCompletedAt: FieldValue.serverTimestamp(),
      passwordResetBaselineValidAfterTime: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return Response.json({ status: "completed", completedAt: new Date().toISOString() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const input = resetSchema.parse(await request.json());
    const { staffDocument } = await loadResetTarget(request, input.staffId);
    await staffDocument.ref.update({
      passwordResetStatus: "failed",
      passwordResetRequestedAt: FieldValue.delete(),
      passwordResetBaselineValidAfterTime: FieldValue.delete(),
      passwordResetFailedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return Response.json({ status: "failed" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "A valid staff account is required.", code: "invalid-input" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
