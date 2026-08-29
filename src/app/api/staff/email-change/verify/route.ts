import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { ApiError, errorResponse, hashToken } from "@/lib/firebase/admin-staff";
import { reconcileEmailChange } from "@/lib/firebase/email-change-status";

const completionSchema = z.object({ token: z.string().min(20) });

async function readRequest(token: string) {
  const reference = adminDb.collection("staffEmailChanges").doc(hashToken(token));
  const snapshot = await reference.get();
  const data = snapshot.data();
  if (!snapshot.exists || !data) throw new ApiError("This email verification link is invalid.", 404, "invalid-token");
  if (data.status === "completed") return { reference, data };
  if (data.status !== "pending") {
    throw new ApiError("This email verification link has already been used or cancelled.", 410, "used-token");
  }
  if (!(data.expiresAt instanceof Timestamp) || data.expiresAt.toMillis() <= Date.now()) {
    throw new ApiError("This email verification link has expired.", 410, "expired-token");
  }
  return { reference, data };
}

export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token")?.trim();
    if (!token) throw new ApiError("Email verification token is missing.", 400, "missing-token");
    const { data } = await readRequest(token);
    return Response.json({ newEmail: data.newEmail, status: data.status });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = completionSchema.parse(await request.json());
    const requestId = hashToken(input.token);
    const result = await reconcileEmailChange(requestId);
    if (result.status !== "completed") {
      throw new ApiError("Open the Firebase verification email before continuing.", 409, "email-unverified");
    }
    return Response.json({
      status: "completed",
      message: "Email updated successfully. Use the new email address the next time you sign in.",
      email: result.newEmail,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Email verification token is invalid.", code: "invalid-token" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
