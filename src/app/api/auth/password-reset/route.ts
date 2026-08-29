import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminAuth, adminDb } from "@/lib/firebase/admin";
import {
  ApiError,
  createOpaqueToken,
  errorResponse,
  expiresInHours,
  findStaffByEmail,
  getStaffAuthUid,
  hashToken,
  normalizeEmail,
} from "@/lib/firebase/admin-staff";

const requestSchema = z.object({ email: z.email() });
const tokenSchema = z.object({ token: z.string().min(20) });
const RESET_COOLDOWN_MS = 180_000;

function toMillis(value: unknown) {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value !== "string") return 0;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? 0 : milliseconds;
}

function timestampToIso(value: unknown) {
  return value instanceof Timestamp ? value.toDate().toISOString() : undefined;
}

async function markSessionFailed(tokenHash: string) {
  const sessionRef = adminDb.collection("passwordResetSessions").doc(tokenHash);
  await adminDb.runTransaction(async (transaction) => {
    const sessionDocument = await transaction.get(sessionRef);
    const session = sessionDocument.data();
    if (!sessionDocument.exists || !session || session.status === "completed") return;

    const staffRef = adminDb.collection("staff").doc(String(session.staffId));
    const staffDocument = await transaction.get(staffRef);
    transaction.update(sessionRef, {
      status: "failed",
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (staffDocument.data()?.passwordResetRequestId === tokenHash) {
      transaction.update(staffRef, {
        passwordResetStatus: "failed",
        passwordResetRequestId: FieldValue.delete(),
        passwordResetBaselineValidAfterTime: FieldValue.delete(),
        passwordResetRequestedAt: FieldValue.delete(),
        passwordResetFailedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    const email = normalizeEmail(input.email);
    const staffDocument = await findStaffByEmail(email);
    if (!staffDocument?.exists) {
      throw new ApiError("No staff account uses this email address.", 404, "staff-not-found");
    }
    const staff = staffDocument.data();
    if (!staff) throw new ApiError("Staff record not found.", 404, "staff-not-found");
    if (staff.accountStatus === "archived" || staff.status === "archived") {
      throw new ApiError("This staff account is archived. Contact an administrator.", 409, "account-archived");
    }

    const staffUid = await getStaffAuthUid(staffDocument);
    const authUser = await adminAuth.getUser(staffUid);
    const trackingToken = createOpaqueToken();
    const tokenHash = hashToken(trackingToken);
    const requestedAt = Timestamp.now();
    const expiresAt = expiresInHours(1);
    const sessionRef = adminDb.collection("passwordResetSessions").doc(tokenHash);

    const resetRequest = await adminDb.runTransaction(async (transaction) => {
      const currentStaffDocument = await transaction.get(staffDocument.ref);
      const currentStaff = currentStaffDocument.data();
      if (!currentStaffDocument.exists || !currentStaff) {
        throw new ApiError("Staff record not found.", 404, "staff-not-found");
      }

      const previousRequestedAt = toMillis(currentStaff.passwordResetRequestedAt);
      const currentCooldownEnd = previousRequestedAt + RESET_COOLDOWN_MS;
      if (previousRequestedAt && currentCooldownEnd > Date.now()) {
        return { allowed: false as const, cooldownEndsAt: currentCooldownEnd };
      }

      if (typeof currentStaff.passwordResetRequestId === "string") {
        transaction.set(
          adminDb.collection("passwordResetSessions").doc(currentStaff.passwordResetRequestId),
          { status: "superseded", supersededAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      }
      transaction.set(sessionRef, {
        staffId: staffDocument.id,
        staffUid,
        email,
        status: "pending",
        baselineValidAfterTime: Date.parse(authUser.tokensValidAfterTime || "") || 0,
        createdAt: requestedAt,
        expiresAt,
      });
      transaction.update(staffDocument.ref, {
        passwordResetStatus: "pending",
        passwordResetRequestId: tokenHash,
        passwordResetRequestedAt: requestedAt,
        passwordResetBaselineValidAfterTime: Date.parse(authUser.tokensValidAfterTime || "") || 0,
        passwordResetCompletedAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { allowed: true as const, cooldownEndsAt: requestedAt.toMillis() + RESET_COOLDOWN_MS };
    });

    if (!resetRequest.allowed) {
      return Response.json(
        {
          error: "A password reset email was sent recently. Wait for the countdown before resending.",
          code: "reset-cooldown",
          cooldownEndsAt: new Date(resetRequest.cooldownEndsAt).toISOString(),
        },
        { status: 429 },
      );
    }

    return Response.json({
      message: "Password reset tracking started.",
      trackingToken,
      expiresAt: expiresAt.toDate().toISOString(),
      cooldownEndsAt: new Date(resetRequest.cooldownEndsAt).toISOString(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Enter a valid email address.", code: "invalid-email" }, { status: 400 });
    }
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const trackingToken = new URL(request.url).searchParams.get("token")?.trim();
    if (!trackingToken || trackingToken.length < 20) {
      throw new ApiError("Password reset tracking token is missing.", 400, "missing-token");
    }

    const tokenHash = hashToken(trackingToken);
    const sessionRef = adminDb.collection("passwordResetSessions").doc(tokenHash);
    const sessionDocument = await sessionRef.get();
    const session = sessionDocument.data();
    if (!sessionDocument.exists || !session) {
      throw new ApiError("This password reset session is invalid.", 404, "invalid-reset-session");
    }
    if (session.status === "completed") {
      return Response.json({ status: "completed", completedAt: timestampToIso(session.completedAt) });
    }
    if (session.status !== "pending") {
      throw new ApiError("This password reset session is no longer active.", 410, "inactive-reset-session");
    }
    if (!(session.expiresAt instanceof Timestamp) || session.expiresAt.toMillis() <= Date.now()) {
      await markSessionFailed(tokenHash);
      throw new ApiError("This password reset session has expired.", 410, "expired-reset-session");
    }

    const authUser = await adminAuth.getUser(String(session.staffUid));
    const validAfterTime = Date.parse(authUser.tokensValidAfterTime || "") || 0;
    const baselineValidAfterTime = Number(session.baselineValidAfterTime) || 0;
    const createdAt = session.createdAt instanceof Timestamp ? session.createdAt.toMillis() : 0;
    const completed = baselineValidAfterTime
      ? validAfterTime > baselineValidAfterTime
      : createdAt > 0 && validAfterTime >= createdAt;
    if (!completed) return Response.json({ status: "pending" });

    const completedAt = Timestamp.now();
    const staffRef = adminDb.collection("staff").doc(String(session.staffId));
    await adminDb.runTransaction(async (transaction) => {
      const currentSessionDocument = await transaction.get(sessionRef);
      const currentStaffDocument = await transaction.get(staffRef);
      if (currentSessionDocument.data()?.status !== "pending") return;

      transaction.update(sessionRef, {
        status: "completed",
        completedAt,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (currentStaffDocument.data()?.passwordResetRequestId === tokenHash) {
        transaction.update(staffRef, {
          passwordResetStatus: "completed",
          passwordResetRequestId: FieldValue.delete(),
          passwordResetBaselineValidAfterTime: FieldValue.delete(),
          passwordResetCompletedAt: completedAt,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });

    return Response.json({ status: "completed", completedAt: completedAt.toDate().toISOString() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const input = tokenSchema.parse(await request.json());
    await markSessionFailed(hashToken(input.token));
    return Response.json({ status: "failed" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "A valid reset tracking token is required." }, { status: 400 });
    }
    return errorResponse(error);
  }
}
