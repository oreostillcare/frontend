import { Timestamp } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { ApiError, errorResponse, hashToken } from "@/lib/firebase/admin-staff";

export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token")?.trim();
    if (!token) throw new ApiError("Invitation token is missing.", 400, "missing-token");

    const invitation = await adminDb.collection("pendingStaffInvitations").doc(hashToken(token)).get();
    const data = invitation.data();
    if (!invitation.exists || !data) throw new ApiError("This invitation link is invalid.", 404, "invalid-token");
    if (data.status !== "pending") throw new ApiError("This invitation link has already been used.", 410, "used-token");
    if (!(data.expiresAt instanceof Timestamp) || data.expiresAt.toMillis() <= Date.now()) {
      throw new ApiError("This invitation link has expired.", 410, "expired-token");
    }

    return Response.json({ email: data.email, username: data.username, role: data.role });
  } catch (error) {
    return errorResponse(error);
  }
}
