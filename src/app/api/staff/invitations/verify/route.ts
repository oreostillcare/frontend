import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { ApiError, errorResponse, getStaffInvitationExpirationMillis, hashToken } from "@/lib/firebase/admin-staff";
import { deletePendingInvitationAuthUser } from "@/lib/firebase/staff-lifecycle";

function rejectedInvitation(status: unknown): never {
  if (status === "cancelled") throw new ApiError("This invitation was cancelled.", 410, "cancelled-token");
  if (status === "expired" || status === "expiring" || status === "superseded") {
    throw new ApiError("This invitation link has expired.", 410, "expired-token");
  }
  if (status === "completed") {
    throw new ApiError("This invitation link has already been used.", 410, "used-token");
  }
  throw new ApiError("This invitation link is invalid.", 404, "invalid-token");
}

export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token")?.trim();
    if (!token) throw new ApiError("Invitation token is missing.", 400, "missing-token");

    const invitation = await adminDb.collection("pendingStaffInvitations").doc(hashToken(token)).get();
    const data = invitation.data();
    if (!invitation.exists || !data) throw new ApiError("This invitation link is invalid.", 404, "invalid-token");
    if (data.status !== "pending") rejectedInvitation(data.status);
    if (getStaffInvitationExpirationMillis(data) <= Timestamp.now().toMillis()) {
      await invitation.ref.update({
        status: "expired",
        expiredAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await deletePendingInvitationAuthUser(data).catch((error) => {
        console.error("Unable to delete the expired pending Firebase user:", error);
      });
      throw new ApiError("This invitation link has expired.", 410, "expired-token");
    }

    return Response.json({ email: data.email, username: data.username, role: data.role });
  } catch (error) {
    return errorResponse(error);
  }
}
