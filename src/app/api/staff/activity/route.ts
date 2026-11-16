import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { authenticateStaff, errorResponse, requireAdministrator } from "@/lib/firebase/admin-staff";
import { recordStaffActivity } from "@/lib/firebase/staff-activity";

const activitySchema = z.object({ event: z.enum(["login", "logout"]) });

function serializeTimestamp(value: unknown) {
  return value instanceof Timestamp ? value.toDate().toISOString() : undefined;
}

export async function GET(request: Request) {
  try {
    await requireAdministrator(request);
    const snapshot = await adminDb.collection("staffActivity").orderBy("occurredAt", "desc").limit(250).get();
    return Response.json({
      activities: snapshot.docs.map((document) => {
        const data = document.data();
        return {
          id: document.id,
          activity: String(data.activity || ""),
          actorRole: data.actorRole,
          actorName: String(data.actorName || data.name || "Unknown staff"),
          actorUid: String(data.actorUid || ""),
          occurredAt: serializeTimestamp(data.occurredAt),
          loginAt: serializeTimestamp(data.loginAt),
          logoutAt: serializeTimestamp(data.logoutAt),
        };
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const staff = await authenticateStaff(request);
    const { event } = activitySchema.parse(await request.json());
    await recordStaffActivity({
      actor: staff,
      activity: event === "login" ? "Logged in" : "Logged out",
      kind: event,
    });
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "A valid activity event is required.", code: "invalid-input" }, { status: 400 });
    }
    return errorResponse(error);
  }
}
