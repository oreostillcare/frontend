import { type DocumentData, FieldValue, Timestamp } from "firebase-admin/firestore";
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

const createRequestSchema = z.object({ email: z.email() });
const requestIdSchema = z.string().min(20);
const updateRequestSchema = z.object({
  action: z.enum(["claim", "release", "complete"]),
  email: z.email(),
  requestId: requestIdSchema,
});
const RESET_COOLDOWN_MS = 180_000;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;
const CANCELLED_RESET_MESSAGE = "This password reset request has been cancelled. Please request a new reset link.";

function toMillis(value: unknown) {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value !== "string") return 0;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? 0 : milliseconds;
}

function timestampToIso(value: unknown) {
  return value instanceof Timestamp ? value.toDate().toISOString() : undefined;
}

function getRequestId(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  return requestIdSchema.parse(searchParams.get("requestId") ?? searchParams.get("token"));
}

function getRequestIdFromBody(input: { requestId?: string; token?: string }) {
  return requestIdSchema.parse(input.requestId ?? input.token);
}

function ensureActiveLatestRequest(
  session: DocumentData | undefined,
  staff: DocumentData | undefined,
  requestIdHash: string,
) {
  if (!session || session.status === "cancelled" || session.status === "completed") {
    throw new ApiError(CANCELLED_RESET_MESSAGE, 410, "inactive-reset-request");
  }
  if (
    (session.status !== "active" && session.status !== "pending") ||
    staff?.passwordResetRequestId !== requestIdHash
  ) {
    throw new ApiError(CANCELLED_RESET_MESSAGE, 410, "inactive-reset-request");
  }
  if (!(session.expiresAt instanceof Timestamp) || session.expiresAt.toMillis() <= Date.now()) {
    throw new ApiError(CANCELLED_RESET_MESSAGE, 410, "expired-reset-request");
  }
}

async function cancelResetRequest(requestIdHash: string, reason: "cancelled" | "expired" | "replaced") {
  const sessionRef = adminDb.collection("passwordResetSessions").doc(requestIdHash);

  return adminDb.runTransaction(async (transaction) => {
    const sessionDocument = await transaction.get(sessionRef);
    const session = sessionDocument.data();
    if (!sessionDocument.exists || !session) {
      throw new ApiError("This password reset request is invalid.", 404, "invalid-reset-request");
    }
    if (session.status === "completed") return "completed" as const;
    if (session.status === "cancelled") return "cancelled" as const;

    const staffRef = adminDb.collection("staff").doc(String(session.staffId));
    const staffDocument = await transaction.get(staffRef);
    const processingStartedAt = toMillis(session.processingStartedAt);
    if (processingStartedAt && processingStartedAt + PROCESSING_LEASE_MS > Date.now()) {
      throw new ApiError(
        "This password reset is already being completed and can no longer be cancelled.",
        409,
        "reset-in-progress",
      );
    }

    const cancelledAt = Timestamp.now();
    transaction.update(sessionRef, {
      status: "cancelled",
      cancellationReason: reason,
      cancelledAt,
      processingStartedAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (staffDocument.data()?.passwordResetRequestId === requestIdHash) {
      transaction.update(staffRef, {
        passwordResetStatus: "failed",
        passwordResetRequestId: FieldValue.delete(),
        passwordResetBaselineValidAfterTime: FieldValue.delete(),
        passwordResetCompletedAt: FieldValue.delete(),
        passwordReset: {
          requestId: requestIdHash,
          status: "cancelled",
          requestedAt: session.requestedAt ?? session.createdAt ?? cancelledAt,
          cancelledAt,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return "cancelled" as const;
  });
}

function firebasePasswordWasChanged(session: DocumentData, validAfterTime: number) {
  const baselineValidAfterTime = Number(session.baselineValidAfterTime) || 0;
  const requestedAt = toMillis(session.requestedAt ?? session.createdAt);
  return baselineValidAfterTime
    ? validAfterTime > baselineValidAfterTime
    : requestedAt > 0 && validAfterTime >= requestedAt;
}

async function completeResetRequest(requestIdHash: string, requireClaim: boolean) {
  const sessionRef = adminDb.collection("passwordResetSessions").doc(requestIdHash);
  const initialSessionDocument = await sessionRef.get();
  const initialSession = initialSessionDocument.data();
  if (!initialSessionDocument.exists || !initialSession) {
    throw new ApiError("This password reset request is invalid.", 404, "invalid-reset-request");
  }
  if (initialSession.status === "completed") return timestampToIso(initialSession.completedAt);

  const authUser = await adminAuth.getUser(String(initialSession.staffUid));
  const validAfterTime = Date.parse(authUser.tokensValidAfterTime || "") || 0;
  if (!firebasePasswordWasChanged(initialSession, validAfterTime)) {
    throw new ApiError(
      "Firebase has not confirmed that the password was changed.",
      409,
      "password-change-not-confirmed",
    );
  }

  return adminDb.runTransaction(async (transaction) => {
    const sessionDocument = await transaction.get(sessionRef);
    const session = sessionDocument.data();
    const staffRef = adminDb.collection("staff").doc(String(session?.staffId ?? initialSession.staffId));
    const staffDocument = await transaction.get(staffRef);
    ensureActiveLatestRequest(session, staffDocument.data(), requestIdHash);
    if (requireClaim && !session?.processingStartedAt) {
      throw new ApiError("This password reset request was not validated.", 409, "reset-not-claimed");
    }

    const completedAt = Timestamp.now();
    transaction.update(sessionRef, {
      status: "completed",
      completedAt,
      processingStartedAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(staffRef, {
      passwordResetStatus: "completed",
      passwordResetRequestId: FieldValue.delete(),
      passwordResetBaselineValidAfterTime: FieldValue.delete(),
      passwordResetCompletedAt: completedAt,
      passwordReset: {
        requestId: requestIdHash,
        status: "completed",
        requestedAt: session?.requestedAt ?? session?.createdAt ?? completedAt,
        completedAt,
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
    return completedAt.toDate().toISOString();
  });
}

export async function POST(request: Request) {
  try {
    const input = createRequestSchema.parse(await request.json());
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
    const requestId = createOpaqueToken();
    const requestIdHash = hashToken(requestId);
    const requestedAt = Timestamp.now();
    const expiresAt = expiresInHours(1);
    const sessionRef = adminDb.collection("passwordResetSessions").doc(requestIdHash);

    const resetRequest = await adminDb.runTransaction(async (transaction) => {
      const currentStaffDocument = await transaction.get(staffDocument.ref);
      const currentStaff = currentStaffDocument.data();
      if (!currentStaffDocument.exists || !currentStaff) {
        throw new ApiError("Staff record not found.", 404, "staff-not-found");
      }

      const previousRequestedAt = toMillis(currentStaff.passwordResetRequestedAt);
      const currentCooldownEnd = previousRequestedAt + RESET_COOLDOWN_MS;
      if (previousRequestedAt && currentCooldownEnd > Date.now()) {
        return { allowed: false as const, inProgress: false as const, cooldownEndsAt: currentCooldownEnd };
      }

      const previousRequestId =
        typeof currentStaff.passwordResetRequestId === "string" ? currentStaff.passwordResetRequestId : "";
      const previousSessionRef = previousRequestId
        ? adminDb.collection("passwordResetSessions").doc(previousRequestId)
        : null;
      const previousSessionDocument = previousSessionRef ? await transaction.get(previousSessionRef) : null;
      const previousSession = previousSessionDocument?.data();
      const previousProcessingStartedAt = toMillis(previousSession?.processingStartedAt);

      if (
        (previousSession?.status === "active" || previousSession?.status === "pending") &&
        previousProcessingStartedAt &&
        previousProcessingStartedAt + PROCESSING_LEASE_MS > Date.now()
      ) {
        return { allowed: false as const, inProgress: true as const, cooldownEndsAt: currentCooldownEnd };
      }

      if (previousSessionRef && (previousSession?.status === "active" || previousSession?.status === "pending")) {
        transaction.update(previousSessionRef, {
          status: "cancelled",
          cancellationReason: "replaced",
          cancelledAt: requestedAt,
          processingStartedAt: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      const baselineValidAfterTime = Date.parse(authUser.tokensValidAfterTime || "") || 0;
      transaction.set(sessionRef, {
        staffId: staffDocument.id,
        staffUid,
        email,
        status: "active",
        baselineValidAfterTime,
        requestedAt,
        createdAt: requestedAt,
        expiresAt,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(staffDocument.ref, {
        passwordResetStatus: "pending",
        passwordResetRequestId: requestIdHash,
        passwordResetRequestedAt: requestedAt,
        passwordResetBaselineValidAfterTime: baselineValidAfterTime,
        passwordResetCompletedAt: FieldValue.delete(),
        passwordReset: {
          requestId: requestIdHash,
          status: "active",
          requestedAt,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        allowed: true as const,
        inProgress: false as const,
        cooldownEndsAt: requestedAt.toMillis() + RESET_COOLDOWN_MS,
      };
    });

    if (!resetRequest.allowed) {
      if (resetRequest.inProgress) {
        return Response.json(
          {
            error: "The current password reset is already being completed. Wait for it to finish.",
            code: "reset-in-progress",
          },
          { status: 409 },
        );
      }
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
      message: "Password reset request started.",
      requestId,
      trackingToken: requestId,
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
    const requestId = getRequestId(request);
    const requestIdHash = hashToken(requestId);
    const sessionRef = adminDb.collection("passwordResetSessions").doc(requestIdHash);
    const sessionDocument = await sessionRef.get();
    const session = sessionDocument.data();
    if (!sessionDocument.exists || !session) {
      throw new ApiError("This password reset request is invalid.", 404, "invalid-reset-request");
    }
    if (session.status === "completed") {
      return Response.json({ status: "completed", completedAt: timestampToIso(session.completedAt) });
    }
    if (session.status === "cancelled") {
      throw new ApiError(CANCELLED_RESET_MESSAGE, 410, "inactive-reset-request");
    }
    if (!(session.expiresAt instanceof Timestamp) || session.expiresAt.toMillis() <= Date.now()) {
      await cancelResetRequest(requestIdHash, "expired");
      throw new ApiError(CANCELLED_RESET_MESSAGE, 410, "expired-reset-request");
    }

    const staffDocument = await adminDb.collection("staff").doc(String(session.staffId)).get();
    if (staffDocument.data()?.passwordResetRequestId !== requestIdHash) {
      await cancelResetRequest(requestIdHash, "replaced");
      throw new ApiError(CANCELLED_RESET_MESSAGE, 410, "inactive-reset-request");
    }

    const authUser = await adminAuth.getUser(String(session.staffUid));
    const validAfterTime = Date.parse(authUser.tokensValidAfterTime || "") || 0;
    if (!firebasePasswordWasChanged(session, validAfterTime)) {
      return Response.json({ status: "active", requestedAt: timestampToIso(session.requestedAt) });
    }

    const completedAt = await completeResetRequest(requestIdHash, false);
    return Response.json({ status: "completed", completedAt });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Password reset request ID is missing." }, { status: 400 });
    }
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const input = updateRequestSchema.parse(await request.json());
    const email = normalizeEmail(input.email);
    const requestIdHash = hashToken(input.requestId);
    const sessionRef = adminDb.collection("passwordResetSessions").doc(requestIdHash);

    if (input.action === "complete") {
      const completedAt = await completeResetRequest(requestIdHash, true);
      return Response.json({ status: "completed", completedAt });
    }

    const initialSession = (await sessionRef.get()).data();
    if (!initialSession || !(initialSession.expiresAt instanceof Timestamp)) {
      throw new ApiError(CANCELLED_RESET_MESSAGE, 410, "inactive-reset-request");
    }
    if (initialSession.expiresAt.toMillis() <= Date.now()) {
      await cancelResetRequest(requestIdHash, "expired");
      throw new ApiError(CANCELLED_RESET_MESSAGE, 410, "expired-reset-request");
    }

    const status = await adminDb.runTransaction(async (transaction) => {
      const sessionDocument = await transaction.get(sessionRef);
      const session = sessionDocument.data();
      const staffRef = adminDb.collection("staff").doc(String(session?.staffId ?? initialSession.staffId));
      const staffDocument = await transaction.get(staffRef);
      ensureActiveLatestRequest(session, staffDocument.data(), requestIdHash);
      if (normalizeEmail(String(session?.email ?? "")) !== email) {
        throw new ApiError(CANCELLED_RESET_MESSAGE, 410, "reset-email-mismatch");
      }

      if (input.action === "claim") {
        transaction.update(sessionRef, {
          processingStartedAt: Timestamp.now(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return "active" as const;
      }

      transaction.update(sessionRef, {
        processingStartedAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return "active" as const;
    });

    return Response.json({ status });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "A valid password reset request is required." }, { status: 400 });
    }
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const input = (await request.json()) as { requestId?: string; token?: string };
    const requestId = getRequestIdFromBody(input);
    const status = await cancelResetRequest(hashToken(requestId), "cancelled");
    return Response.json({ status });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "A valid password reset request ID is required." }, { status: 400 });
    }
    return errorResponse(error);
  }
}
