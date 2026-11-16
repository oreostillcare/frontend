import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";

import {
  ApiError,
  errorResponse,
  findStaffDocument,
  formatStaffDisplayName,
  requireAdministrator,
} from "@/lib/firebase/admin-staff";
import { archiveStaffMember, assertNotLastAdministrator, restoreStaffMember } from "@/lib/firebase/staff-lifecycle";
import { recordStaffActivity } from "@/lib/firebase/staff-activity";

const updateSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"),
    firstName: z.string().trim().max(60).default(""),
    middleInitial: z.string().trim().max(1).default(""),
    lastName: z.string().trim().max(60).default(""),
    username: z.string().trim().min(2).max(60),
    role: z.enum(["Administrator", "Operator"]),
    email: z.email().optional(),
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
    const currentStaff = staffDocument.data();
    const targetName = formatStaffDisplayName(currentStaff ?? {});

    if (input.action === "update") {
      if (currentStaff?.role === "Administrator" && input.role === "Operator") {
        await assertNotLastAdministrator(currentStaff);
      }
      await staffDocument.ref.update({
        firstName: input.firstName,
        middleInitial: input.middleInitial.toUpperCase(),
        lastName: input.lastName,
        username: input.username,
        role: input.role,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: administrator.token.uid,
      });
      const updatedName = formatStaffDisplayName({
        firstName: input.firstName,
        middleInitial: input.middleInitial,
        lastName: input.lastName,
        username: input.username,
      });
      const editedFields = [];
      if (
        input.firstName !== String(currentStaff?.firstName || "") ||
        input.middleInitial.toUpperCase() !== String(currentStaff?.middleInitial || currentStaff?.middleName || "").toUpperCase() ||
        input.lastName !== String(currentStaff?.lastName || "")
      ) {
        editedFields.push("name");
      }
      if (input.username !== currentStaff?.username) editedFields.push("username");
      if (input.email && input.email.toLowerCase() !== String(currentStaff?.email || "").toLowerCase()) {
        editedFields.push("email");
      }
      const activityParts = editedFields.length > 0 ? [`Edited ${editedFields.join(", ")}`] : [];
      if (input.role !== currentStaff?.role) activityParts.push(`Changed role to ${input.role}`);
      if (activityParts.length > 0) {
        await recordStaffActivity({ actor: administrator, activity: activityParts.join("; "), name: updatedName }).catch(
          () => undefined,
        );
      }
      return Response.json({ message: "Staff profile updated." });
    }

    const result =
      input.action === "archive"
        ? await archiveStaffMember(staffDocument.id, administrator.token.uid)
        : await restoreStaffMember(staffDocument.id);
    await recordStaffActivity({
      actor: administrator,
      activity: input.action === "archive" ? `Archived ${targetName}'s account` : `Unarchived ${targetName}'s account`,
      name: targetName,
    }).catch(() => undefined);
    return Response.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Enter a valid staff action.", code: "invalid-input" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
