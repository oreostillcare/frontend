import "server-only";

import { Timestamp } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";

import { getEmailTemplateDefinition } from "./email-template-catalog";
import { isMailjetConfigured, sendMailjetMessage } from "./mailjet-client";

type SystemEvent = {
  eventId: string;
  eventType: string;
  component: string;
  severity: "info" | "warning" | "critical";
  message: string;
  eventStatus: "observed" | "active" | "resolved";
  nodeId: string;
  laneId?: string;
  occurredAt: Date;
};

type Recipient = { email: string };

type NotificationResult = {
  provider: "mailjet";
  status: "skipped" | "accepted" | "failed";
  reason?: string;
  attempts: number;
  lastAttemptAt?: Timestamp;
  recipientResults?: Array<{ email: string; status: "accepted" | "failed"; messageId?: string }>;
};

const eventLabels: Record<string, string> = {
  camera_unavailable: "Camera unavailable",
  camera_disconnected: "Camera disconnected",
  camera_stale: "Camera feed stale",
  camera_health: "Camera connection restored",
  detector_unavailable: "Vehicle detector unavailable",
  esp32_disconnected: "ESP32 node unreachable",
  wifi_disconnected: "Node Wi-Fi disconnected",
  traffic_controller_error: "Traffic controller error",
};

function humanize(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatNode(value: string) {
  if (value === "system") return "System";
  return humanize(value);
}

function formatLane(value: string | undefined) {
  return value ? humanize(value) : "System";
}

function formatTime(value: Date) {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(value);
}

function recommendedAction(event: SystemEvent) {
  if (event.eventStatus === "resolved") return "No action is required; continue monitoring the system.";
  if (event.eventType.startsWith("camera_")) return "Check the camera USB connection, power supply, and stream health.";
  if (event.eventType === "detector_unavailable") return "Check the vehicle detection service and model runtime.";
  if (event.eventType === "esp32_disconnected")
    return "Inspect the node power, network, and ESP32 controller connection.";
  if (event.eventType === "wifi_disconnected") return "Restore the node Wi-Fi connection and verify connectivity.";
  if (event.eventType === "traffic_controller_error")
    return "Inspect the controller before resuming traffic operations.";
  return "Review the SmartRoad System Logs and take the required action.";
}

function render(template: string, values: Record<string, string>) {
  return template.replace(/{{\s*([\w]+)\s*}}/g, (_, key: string) => values[key] ?? "");
}

async function loadActiveRecipients(): Promise<Recipient[]> {
  const snapshot = await adminDb.collection("staff").get();
  const recipients = new Map<string, Recipient>();
  for (const document of snapshot.docs) {
    const data = document.data() as Record<string, unknown>;
    const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
    const archived = data.accountStatus === "archived" || data.status === "archived";
    const disabled = data.disabled === true || data.active === false;
    if (email && !archived && !disabled) recipients.set(email, { email });
  }
  return [...recipients.values()];
}

function buildNotification(event: SystemEvent) {
  const template = getEmailTemplateDefinition(event.severity === "critical" ? "major-event" : "system-alert");
  if (!template) throw new Error("System email template is missing.");
  const values = {
    severity: event.severity,
    event: eventLabels[event.eventType] ?? humanize(event.eventType),
    node: formatNode(event.nodeId),
    lane: formatLane(event.laneId),
    time: formatTime(event.occurredAt),
    status: event.eventStatus,
    details: event.message,
    action: recommendedAction(event),
  };
  return {
    subject: render(template.subject, values),
    text: render(template.textBody, values),
    html: render(template.htmlBody, values),
  };
}

export async function notifySystemEvent(
  reference: { update: (value: Record<string, unknown>) => Promise<unknown> },
  event: SystemEvent,
) {
  // Notify on the first warning and on critical escalation; retry warnings stay in Firestore
  // without consuming Mailjet quota for every health-check interval.
  const eligible = event.severity === "critical" || (event.severity === "warning" && event.eventStatus === "observed");
  if (!eligible || !isMailjetConfigured()) {
    const notification: NotificationResult = {
      provider: "mailjet",
      status: "skipped",
      reason: !eligible ? "severity_not_eligible" : "mailjet_not_configured",
      attempts: 0,
    };
    await reference.update({ notification });
    return notification;
  }

  const recipients = await loadActiveRecipients();
  if (recipients.length === 0) {
    const notification: NotificationResult = {
      provider: "mailjet",
      status: "skipped",
      reason: "no_active_recipients",
      attempts: 0,
    };
    await reference.update({ notification });
    return notification;
  }

  const email = buildNotification(event);
  const recipientResults: NonNullable<NotificationResult["recipientResults"]> = [];
  for (const recipient of recipients) {
    try {
      const result = await sendMailjetMessage({ ...email, to: recipient.email, customId: event.eventId });
      recipientResults.push({ email: recipient.email, status: "accepted", messageId: result.messageId });
    } catch {
      recipientResults.push({ email: recipient.email, status: "failed" });
    }
  }

  const accepted = recipientResults.filter((result) => result.status === "accepted").length;
  const notification: NotificationResult = {
    provider: "mailjet",
    status: accepted === recipientResults.length ? "accepted" : "failed",
    attempts: 1,
    lastAttemptAt: Timestamp.now(),
    recipientResults,
  };
  await reference.update({ notification });
  return notification;
}
