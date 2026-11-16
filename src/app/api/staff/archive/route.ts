import { z } from "zod";

import {
  errorResponse,
  findStaffDocument,
  formatStaffDisplayName,
  requireAdministrator,
} from "@/lib/firebase/admin-staff";
import { recordStaffActivity } from "@/lib/firebase/staff-activity";
import { archiveStaffMember } from "@/lib/firebase/staff-lifecycle";

const archiveSchema = z.object({ staffId: z.string().trim().min(1) });

export async function POST(request: Request) {
  try {
    const administrator = await requireAdministrator(request);
    const input = archiveSchema.parse(await request.json());
    const staffDocument = await findStaffDocument(input.staffId);
    const targetName = formatStaffDisplayName(staffDocument?.data() ?? {});
    const result = await archiveStaffMember(input.staffId, administrator.token.uid);
    await recordStaffActivity({
      actor: administrator,
      activity: `Archived ${targetName}'s account`,
      name: targetName,
    }).catch(() => undefined);
    return Response.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "A valid staff account is required.", code: "invalid-input" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
