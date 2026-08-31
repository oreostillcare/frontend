import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";

import {
  ApiError,
  errorResponse,
  findStaffDocument,
  requireAdministrator,
} from "@/lib/firebase/admin-staff";
import { archiveStaffMember, restoreStaffMember } from "@/lib/firebase/staff-lifecycle";

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

    return Response.json(
      input.action === "archive"
        ? await archiveStaffMember(staffDocument.id, administrator.token.uid)
        : await restoreStaffMember(staffDocument.id),
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Enter a valid staff action.", code: "invalid-input" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
