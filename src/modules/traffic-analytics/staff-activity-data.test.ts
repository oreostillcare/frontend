import { describe, expect, it } from "vitest";

import {
  buildOperatingHoursSeries,
  enrichSessionTimes,
  filterStaffActivity,
  type OperatingHoursStaff,
  type StaffActivityRecord,
} from "./staff-activity-data";

const activity = (occurredAt: string): StaffActivityRecord => ({
  activity: "Logged in",
  actorUid: "staff-1",
  id: occurredAt,
  name: "Staff One",
  occurredAt: new Date(occurredAt),
  role: "Administrator",
  username: "staff.one",
});

describe("filterStaffActivity", () => {
  const now = new Date("2026-11-18T10:00:00.000Z");
  const activities = [activity("2026-11-18T09:00:00.000Z"), activity("2026-11-17T09:00:00.000Z")];

  it("filters activity by the selected range", () => {
    expect(filterStaffActivity(activities, "24h", now)).toHaveLength(1);
    expect(filterStaffActivity(activities, "7d", now)).toHaveLength(2);
  });

  it("filters activity to the selected Manila calendar day", () => {
    expect(filterStaffActivity(activities, "30d", now, new Date("2026-11-17T04:00:00.000Z"))).toHaveLength(1);
  });

  it("retains session timestamps while preserving the action timestamp", () => {
    const loginAt = new Date("2026-11-18T08:00:00.000Z");
    const logoutAt = new Date("2026-11-18T09:00:00.000Z");
    const actionAt = new Date("2026-11-18T08:30:00.000Z");
    const records = enrichSessionTimes([
      { ...activity(loginAt.toISOString()), activity: "Logged in", loginAt },
      { ...activity(logoutAt.toISOString()), activity: "Logged out", logoutAt },
      { ...activity(actionAt.toISOString()), activity: "Archived Staff One's account" },
    ]);

    expect(records[0]?.logoutAt).toEqual(logoutAt);
    expect(records[1]?.loginAt).toEqual(loginAt);
    expect(records[2]?.loginAt).toEqual(loginAt);
    expect(records[2]?.occurredAt).toEqual(actionAt);
    expect(records[2]?.logoutAt).toEqual(logoutAt);
  });

  it("summarizes online hours by username and selected role", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    const loginAt = new Date("2026-11-18T08:00:00.000Z");
    const logoutAt = new Date("2026-11-18T09:30:00.000Z");

    const data = buildOperatingHoursSeries(
      [
        { ...activity(loginAt.toISOString()), activity: "Logged in", loginAt, logoutAt },
        {
          ...activity("2026-11-18T07:00:00.000Z"),
          activity: "Logged in",
          loginAt: new Date("2026-11-18T07:00:00.000Z"),
          role: "Operator",
          username: "operator.one",
        },
      ],
      "24h",
      "Administrator",
      now,
    );

    expect(data).toEqual([{ hours: 1.5, name: "Staff One", role: "Administrator", username: "staff.one" }]);
  });

  it("includes active staff with zero hours and excludes archived staff from the directory", () => {
    const staff: OperatingHoursStaff[] = [
      { name: "Staff One", role: "Administrator", uid: "staff-1", username: "staff.one" },
      { name: "Operator One", role: "Operator", uid: "operator-1", username: "operator.one" },
    ];

    const data = buildOperatingHoursSeries(
      [
        { ...activity("2026-11-18T08:00:00.000Z"), loginAt: new Date("2026-11-18T08:00:00.000Z") },
        {
          ...activity("2026-11-18T08:00:00.000Z"),
          actorUid: "archived-1",
          loginAt: new Date("2026-11-18T08:00:00.000Z"),
          username: "archived.staff",
        },
      ],
      "24h",
      "all",
      new Date("2026-11-18T10:00:00.000Z"),
      undefined,
      staff,
    );

    expect(data).toEqual([
      { hours: 2, name: "Staff One", role: "Administrator", username: "staff.one" },
      { hours: 0, name: "Operator One", role: "Operator", username: "operator.one" },
    ]);
  });
});
