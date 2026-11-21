import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { authenticateStaff, errorResponse, formatStaffDisplayName, requireAdministrator } from "@/lib/firebase/admin-staff";
import { recordStaffActivity } from "@/shared/firebase/staff-activity";

const activitySchema = z.object({ event: z.enum(["login", "logout"]) });

function serializeTimestamp(value: unknown) {
  return value instanceof Timestamp ? value.toDate().toISOString() : undefined;
}

export async function GET(request: Request) {
  try {
    await requireAdministrator(request);
    const [snapshot, staffSnapshot] = await Promise.all([
      adminDb.collection("staffActivity").orderBy("occurredAt", "desc").limit(250).get(),
      adminDb.collection("staff").get(),
    ]);
    return Response.json({
      activities: snapshot.docs.map((document) => {
        const data = document.data();
        return {
          id: document.id,
          activity: String(data.activity || ""),
          actorRole: data.actorRole,
          actorName: String(data.actorName || data.name || "Unknown staff"),
          actorUsername: String(data.actorUsername || data.username || ""),
          actorUid: String(data.actorUid || ""),
          occurredAt: serializeTimestamp(data.occurredAt),
          loginAt: serializeTimestamp(data.loginAt),
          logoutAt: serializeTimestamp(data.logoutAt),
        };
      }),
      staff: staffSnapshot.docs
        .map((document) => {
          const data = document.data();
          let role: "Administrator" | "Operator" | null = null;
          if (data.role === "Administrator") role = "Administrator";
          if (data.role === "Operator") role = "Operator";
          const archived = data.accountStatus === "archived" || data.status === "archived";
          if (!role || archived) return null;
          let uid = document.id;
          if (typeof data.uid === "string" && data.uid.trim()) uid = data.uid.trim();
          else if (typeof data.authUid === "string" && data.authUid.trim()) uid = data.authUid.trim();
          return {
            name: formatStaffDisplayName(data),
            role,
            uid,
            username:
              typeof data.username === "string" && data.username.trim()
                ? data.username.trim()
                : formatStaffDisplayName(data),
          };
        })
        .filter(
          (staff): staff is { name: string; role: "Administrator" | "Operator"; uid: string; username: string } =>
            staff !== null,
        ),
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
