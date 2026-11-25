import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { notifySystemEvent } from "@/modules/notifications/system-event-notifications";

export const runtime = "nodejs";

const systemEventSchema = z.object({
  occurredAt: z.string().datetime({ offset: true }),
  eventType: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(40),
  component: z.string().trim().min(1).max(80),
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string().trim().min(1).max(240),
  eventStatus: z.enum(["observed", "active", "resolved"]),
  nodeId: z.enum(["system", "node-a", "node-b"]),
  laneId: z.string().trim().min(1).max(40).optional(),
});

export async function POST(request: Request) {
  const ingestSecret = process.env.SYSTEM_LOGS_SECRET || process.env.TRAFFIC_INGEST_SECRET || process.env.CRON_SECRET;
  if (!ingestSecret) {
    return Response.json({ success: false, message: "System log secret is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${ingestSecret}`) {
    return Response.json({ success: false, message: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = systemEventSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { success: false, message: "Invalid system event.", issues: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  try {
    const event = parsed.data;
    const reference = await adminDb.collection("systemEvents").add({
      ...event,
      occurredAt: new Date(event.occurredAt),
      createdAt: new Date(),
      source: "backend",
      notification: {
        provider: "mailjet",
        status: "pending",
        attempts: 0,
      },
    });
    try {
      await notifySystemEvent(reference, { ...event, eventId: reference.id, occurredAt: new Date(event.occurredAt) });
    } catch (notificationError) {
      // Keep the persisted event usable even when a provider or recipient lookup is unavailable.
      console.error("System event notification dispatch failed:", notificationError);
      await reference
        .update({
          notification: {
            provider: "mailjet",
            status: "failed",
            reason: "dispatch_failed",
            attempts: 1,
          },
        })
        .catch(() => undefined);
    }
    return Response.json({ success: true, eventId: reference.id });
  } catch (error) {
    console.error("System event persistence failed:", error);
    return Response.json({ success: false, message: "Firestore system event write failed." }, { status: 500 });
  }
}
