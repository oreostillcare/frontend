import { z } from "zod";

import { errorResponse, requireAdministrator } from "@/lib/firebase/admin-staff";
import { restoreStaffMember } from "@/lib/firebase/staff-lifecycle";

const restoreSchema = z.object({ staffId: z.string().trim().min(1) });

export async function POST(request: Request) {
  try {
    await requireAdministrator(request);
    const input = restoreSchema.parse(await request.json());
    return Response.json(await restoreStaffMember(input.staffId));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "A valid staff account is required.", code: "invalid-input" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
