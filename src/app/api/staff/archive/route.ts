import { z } from "zod";

import { errorResponse, requireAdministrator } from "@/lib/firebase/admin-staff";
import { archiveStaffMember } from "@/lib/firebase/staff-lifecycle";

const archiveSchema = z.object({ staffId: z.string().trim().min(1) });

export async function POST(request: Request) {
  try {
    const administrator = await requireAdministrator(request);
    const input = archiveSchema.parse(await request.json());
    return Response.json(await archiveStaffMember(input.staffId, administrator.token.uid));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "A valid staff account is required.", code: "invalid-input" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
