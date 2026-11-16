import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { adminDb } from "./admin";
import type { AuthenticatedStaff } from "./admin-staff";

export type StaffActivityKind = "login" | "logout" | "action";

export type StaffActivityFields = {
  actorEmail: string;
  actorName: string;
  actorRole: AuthenticatedStaff["role"];
  actorUid: string;
  activity: string;
  kind?: StaffActivityKind;
  name?: string;
  targetEmail?: string;
};

async function writeStaffActivity({
  actorEmail,
  actorName,
  actorRole,
  actorUid,
  activity,
  kind = "action",
  name,
  targetEmail,
}: StaffActivityFields) {
  const now = Timestamp.now();
  await adminDb.collection("staffActivity").add({
    actorEmail,
    actorName,
    actorRole,
    activity,
    name: name ? name : actorName,
    occurredAt: now,
    ...(kind === "login" ? { loginAt: now } : {}),
    ...(kind === "logout" ? { logoutAt: now } : {}),
    ...(targetEmail ? { targetEmail } : {}),
    actorUid,
    createdAt: FieldValue.serverTimestamp(),
  });
}

export function recordStaffActivity({
  actor,
  activity,
  kind = "action",
  name,
  targetEmail,
}: {
  actor: AuthenticatedStaff;
  activity: string;
  kind?: StaffActivityKind;
  name?: string;
  targetEmail?: string;
}) {
  return writeStaffActivity({
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: actor.role,
    actorUid: actor.token.uid,
    activity,
    kind,
    name,
    targetEmail,
  });
}

export function recordStaffActivityFields(fields: StaffActivityFields) {
  return writeStaffActivity(fields);
}
