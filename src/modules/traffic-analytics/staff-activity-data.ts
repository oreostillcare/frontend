"use client";

// Polls the authenticated server feed so Firestore rules and legacy staff IDs do not block the audit table.

import { auth } from "@/lib/firebase/client";

import { getManilaDayBounds, type TrafficRange } from "./analytics-sample-data";

export interface StaffActivityRecord {
  id: string;
  actorUid: string;
  username: string;
  loginAt?: Date;
  logoutAt?: Date;
  occurredAt: Date;
  role: "Administrator" | "Operator";
  name: string;
  activity: string;
}

export type StaffRoleFilter = "all" | StaffActivityRecord["role"];

export interface OperatingHoursPoint {
  name: string;
  username: string;
  hours: number;
  role: StaffActivityRecord["role"];
}

export type OperatingHoursStaff = Pick<OperatingHoursPoint, "name" | "role" | "username"> & { uid: string };

const DAY_MS = 24 * 60 * 60 * 1000;

function getActivityBounds(range: TrafficRange, now: Date, specificDate?: Date) {
  const specificDay = specificDate ? getManilaDayBounds(specificDate) : undefined;
  const start =
    specificDay?.start ??
    (range === "24h" ? now.getTime() - DAY_MS : getManilaDayBounds(now).start - (range === "7d" ? 6 : 29) * DAY_MS);
  return { end: specificDay?.endExclusive ?? now.getTime(), start };
}

export function filterStaffActivity(
  activities: StaffActivityRecord[],
  range: TrafficRange,
  now: Date,
  specificDate?: Date,
) {
  const { end, start } = getActivityBounds(range, now, specificDate);

  return activities.filter((activity) => {
    const timestamp = activity.occurredAt.getTime();
    return timestamp >= start && timestamp <= end;
  });
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
  const username =
    typeof data.actorUsername === "string" && data.actorUsername.trim() ? data.actorUsername.trim() : name;
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
    username,
  };
}

export function subscribeToStaffActivity(
  onData: (activities: StaffActivityRecord[], staff: OperatingHoursStaff[]) => void,
  onError: (error: Error) => void,
) {
  const firebaseAuth = auth;
  if (!firebaseAuth) {
    onData([], []);
    return () => undefined;
  }

  let stopped = false;
  const load = async () => {
    const user = firebaseAuth.currentUser;
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/staff/activity", { headers: { Authorization: `Bearer ${token}` } });
      const payload = (await response.json()) as {
        activities?: Record<string, unknown>[];
        error?: string;
        staff?: OperatingHoursStaff[];
      };
      if (!response.ok) throw new Error(payload.error ? payload.error : "Unable to load staff activity.");
      if (stopped) return;
      const records = (payload.activities ?? [])
        .map((activity) => mapActivity(String(activity.id || ""), activity))
        .filter((activity): activity is StaffActivityRecord => activity !== null);
      onData(enrichSessionTimes(records), payload.staff ?? []);
    } catch (cause) {
      if (!stopped) onError(cause instanceof Error ? cause : new Error("Unable to load staff activity."));
    }
  };

  void load();
  // shortcut: polling is used for the existing server feed; use 30s to avoid exhausting Firestore quota.
  const intervalId = window.setInterval(() => void load(), 30_000);
  return () => {
    stopped = true;
    window.clearInterval(intervalId);
  };
}

export function enrichSessionTimes(records: StaffActivityRecord[]) {
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

export function buildOperatingHoursSeries(
  activities: StaffActivityRecord[],
  range: TrafficRange,
  roleFilter: StaffRoleFilter,
  now: Date,
  specificDate?: Date,
  staff: OperatingHoursStaff[] = [],
): OperatingHoursPoint[] {
  const { end, start } = getActivityBounds(range, now, specificDate);
  const totals = new Map<string, OperatingHoursPoint>();
  const staffByUid = new Map(staff.map((member) => [member.uid, member]));
  const staffByUsername = new Map(staff.map((member) => [member.username, member]));

  for (const member of staff) {
    if (roleFilter === "all" || member.role === roleFilter) {
      totals.set(member.uid, { hours: 0, name: member.name, role: member.role, username: member.username });
    }
  }

  for (const activity of activities) {
    if (
      activity.activity !== "Logged in" ||
      !activity.loginAt ||
      (roleFilter !== "all" && activity.role !== roleFilter) ||
      (staff.length > 0 && !staffByUid.has(activity.actorUid) && !staffByUsername.has(activity.username))
    ) {
      continue;
    }

    const sessionStart = Math.max(activity.loginAt.getTime(), start);
    const sessionEnd = Math.min(activity.logoutAt?.getTime() ?? end, end);
    if (sessionEnd <= sessionStart) continue;

    const member = staffByUid.get(activity.actorUid) ?? staffByUsername.get(activity.username);
    const key = member?.uid ?? activity.username;
    const current =
      totals.get(key) ??
      ({ hours: 0, name: member?.name ?? activity.name, role: member?.role ?? activity.role, username: member?.username ?? activity.username });
    current.hours += (sessionEnd - sessionStart) / (60 * 60 * 1000);
    totals.set(key, current);
  }

  return Array.from(totals.values())
    .map((point) => ({ ...point, hours: Math.round(point.hours * 100) / 100 }))
    .sort((first, second) => second.hours - first.hours || first.username.localeCompare(second.username));
}
