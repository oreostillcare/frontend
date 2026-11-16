"use client";

// Polls the authenticated server feed so Firestore rules and legacy staff IDs do not block the audit table.

import { auth } from "@/lib/firebase/client";

export interface StaffActivityRecord {
  id: string;
  actorUid: string;
  loginAt?: Date;
  logoutAt?: Date;
  occurredAt: Date;
  role: "Administrator" | "Operator";
  name: string;
  activity: string;
}

function toDate(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function mapActivity(id: string, data: Record<string, unknown>): StaffActivityRecord | null {
  const occurredAt = toDate(data.occurredAt) ?? toDate(data.createdAt);
  const role = data.actorRole === "Administrator" ? "Administrator" : "Operator";
  const name = typeof data.actorName === "string" && data.actorName.trim() ? data.actorName.trim() : "Unknown staff";
  const activity = typeof data.activity === "string" ? data.activity.trim() : "";
  if (!occurredAt || !activity) return null;

  return {
    activity,
    actorUid: typeof data.actorUid === "string" && data.actorUid ? data.actorUid : name,
    id,
    loginAt: toDate(data.loginAt),
    logoutAt: toDate(data.logoutAt),
    name,
    occurredAt,
    role,
  };
}

export function subscribeToStaffActivity(
  onData: (activities: StaffActivityRecord[]) => void,
  onError: (error: Error) => void,
) {
  const firebaseAuth = auth;
  if (!firebaseAuth) {
    onData([]);
    return () => undefined;
  }

  let stopped = false;
  const load = async () => {
    const user = firebaseAuth.currentUser;
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/staff/activity", { headers: { Authorization: `Bearer ${token}` } });
      const payload = (await response.json()) as { activities?: Record<string, unknown>[]; error?: string };
      if (!response.ok) throw new Error(payload.error ? payload.error : "Unable to load staff activity.");
      if (stopped) return;
      const records = (payload.activities ?? [])
        .map((activity) => mapActivity(String(activity.id || ""), activity))
        .filter((activity): activity is StaffActivityRecord => activity !== null);
      onData(enrichSessionTimes(records));
    } catch (cause) {
      if (!stopped) onError(cause instanceof Error ? cause : new Error("Unable to load staff activity."));
    }
  };

  void load();
  const intervalId = window.setInterval(() => void load(), 3000);
  return () => {
    stopped = true;
    window.clearInterval(intervalId);
  };
}

function enrichSessionTimes(records: StaffActivityRecord[]) {
  const byActor = new Map<string, StaffActivityRecord[]>();
  for (const record of records) {
    const actorRecords = byActor.get(record.actorUid) ?? [];
    actorRecords.push(record);
    byActor.set(record.actorUid, actorRecords);
  }

  return records.map((record) => {
    const actorRecords = byActor.get(record.actorUid) ?? [];
    const loginTimes = actorRecords
      .map((candidate) => candidate.loginAt)
      .filter((value): value is Date => value !== undefined && value.getTime() <= record.occurredAt.getTime());
    const logoutTimes = actorRecords
      .map((candidate) => candidate.logoutAt)
      .filter((value): value is Date => value !== undefined && value.getTime() >= record.occurredAt.getTime());
    return {
      ...record,
      loginAt: record.loginAt ?? loginTimes.sort((left, right) => right.getTime() - left.getTime())[0],
      logoutAt: record.logoutAt ?? logoutTimes.sort((left, right) => left.getTime() - right.getTime())[0],
    };
  });
}
