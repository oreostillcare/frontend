import { authenticateStaff, errorResponse } from "@/lib/firebase/admin-staff";
import {
  readNodeStates,
  transitionNodeState,
  transitionSchema,
} from "@/modules/live-maps/node-state-lifecycle-service";

export async function GET(request: Request) {
  try {
    await authenticateStaff(request);
    return Response.json({ states: await readNodeStates() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const staff = await authenticateStaff(request);
    const transition = transitionSchema.parse(await request.json());
    await transitionNodeState(transition, staff);

    return Response.json({ states: await readNodeStates() });
  } catch (error) {
    return errorResponse(error);
  }
}
