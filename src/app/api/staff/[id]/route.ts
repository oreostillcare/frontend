import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";

import {
  ApiError,
  errorResponse,
  findStaffDocument,
  formatStaffDisplayName,
  requireAdministrator,
} from "@/lib/firebase/admin-staff";
import { recordStaffActivity } from "@/shared/firebase/staff-activity";
import { archiveStaffMember, restoreStaffMember, updateStaffProfile } from "@/lib/firebase/staff-lifecycle";

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
    let currentStaff = staffDocument.data();
    const targetName = formatStaffDisplayName(currentStaff ?? {});

    if (input.action === "update") {
      const previousStaff = currentStaff ?? {};
      currentStaff = await updateStaffProfile(staffDocument.id, {
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
        input.firstName !== String(previousStaff.firstName || "") ||
        input.middleInitial.toUpperCase() !==
          String(previousStaff.middleInitial || previousStaff.middleName || "").toUpperCase() ||
        input.lastName !== String(previousStaff.lastName || "")
      ) {
        editedFields.push("name");
      }
      if (input.username !== previousStaff.username) editedFields.push("username");
      if (input.email && input.email.toLowerCase() !== String(previousStaff.email || "").toLowerCase()) {
        editedFields.push("email");
      }
      const activityTarget = updatedName || targetName;
      const activityParts = editedFields.map((field) => `Edited ${activityTarget}'s ${field}`);
      if (input.role !== previousStaff.role) activityParts.push(`Changed ${activityTarget}'s role to ${input.role}`);
      if (activityParts.length > 0) {
        await recordStaffActivity({
          actor: administrator,
          activity: activityParts.join("; "),
          name: activityTarget,
        }).catch(() => undefined);
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
