import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";

import { adminAuth } from "@/lib/firebase/admin";
import {
  ApiError,
  errorResponse,
  findStaffDocument,
  getStaffAuthUid,
  requireAdministrator,
} from "@/lib/firebase/admin-staff";

const updateSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"),
    username: z.string().trim().min(2).max(60),
    role: z.enum(["Administrator", "Operator"]),
  }),
  z.object({ action: z.literal("archive") }),
  z.object({ action: z.literal("reactivate") }),
]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const administrator = await requireAdministrator(request);
    const { id } = await context.params;
    const input = updateSchema.parse(await request.json());
    const staffDocument = await findStaffDocument(id);
    if (!staffDocument?.exists) throw new ApiError("Staff record not found.", 404, "staff-not-found");

    if (input.action === "update") {
      await staffDocument.ref.update({
        username: input.username,
        role: input.role,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: administrator.token.uid,
      });
      return Response.json({ message: "Staff profile updated." });
    }

    const targetUid = await getStaffAuthUid(staffDocument);
    if (input.action === "archive" && targetUid === administrator.token.uid) {
      throw new ApiError("You cannot archive your own administrator account.", 409, "cannot-archive-self");
    }

    const shouldDisable = input.action === "archive";
    await adminAuth.updateUser(targetUid, { disabled: shouldDisable });
    try {
      await staffDocument.ref.update({
        uid: targetUid,
        authUid: targetUid,
        accountStatus: shouldDisable ? "archived" : "active",
        emailVerified: true,
        ...(shouldDisable
          ? { archivedAt: FieldValue.serverTimestamp(), archivedBy: administrator.token.uid }
          : { archivedAt: FieldValue.delete(), reactivatedAt: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      await adminAuth.updateUser(targetUid, { disabled: !shouldDisable }).catch(() => undefined);
      throw error;
    }

    return Response.json({
      message: shouldDisable ? "Staff account archived. Dashboard access is disabled." : "Staff account reactivated.",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Enter a valid staff action.", code: "invalid-input" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
