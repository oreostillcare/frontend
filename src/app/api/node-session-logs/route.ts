import { authenticateStaff, errorResponse } from "@/lib/firebase/admin-staff";
import { readNodeSessionLogs } from "@/modules/node-session-logs/node-session-log-service";

export async function GET(request: Request) {
  try {
    await authenticateStaff(request);
    return Response.json({ logs: await readNodeSessionLogs() });
  } catch (error) {
    return errorResponse(error);
  }
}
