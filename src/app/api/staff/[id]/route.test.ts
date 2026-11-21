import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAdminFirestore } from "@/test/firebase-admin-firestore";

const firebaseAdmin = vi.hoisted(() => ({
  adminAuth: { verifyIdToken: vi.fn() },
  adminDb: { collection: vi.fn(), runTransaction: vi.fn() },
  recordStaffActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/firebase/admin", () => firebaseAdmin);
vi.mock("@/shared/firebase/staff-activity", () => ({ recordStaffActivity: firebaseAdmin.recordStaffActivity }));

import { PATCH } from "./route";

describe("staff profile updates", () => {
  let firestore: ReturnType<typeof createFakeAdminFirestore>;

  beforeEach(() => {
    vi.clearAllMocks();
    firestore = createFakeAdminFirestore();
    Object.assign(firebaseAdmin.adminDb, firestore.api);
    firebaseAdmin.adminAuth.verifyIdToken.mockImplementation(async (uid: string) => ({ uid }));
  });

  function seedAdministrator(id: string) {
    firestore.seed("staff", id, { uid: id, role: "Administrator", accountStatus: "active", username: id });
  }

  function demote(id: string) {
    return PATCH(
      new Request(`http://localhost/api/staff/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${id}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", username: id, role: "Operator" }),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("returns a conflict when demoting the last administrator", async () => {
    seedAdministrator("admin-a");
    const response = await demote("admin-a");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "last-administrator" });
    expect(firestore.get("staff", "admin-a")?.role).toBe("Administrator");
  });

  it("keeps one administrator when two profile requests demote concurrently", async () => {
    seedAdministrator("admin-a");
    seedAdministrator("admin-b");
    const responses = await Promise.all([demote("admin-a"), demote("admin-b")]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(firestore.documents("staff").filter((document) => document.data()?.role === "Administrator")).toHaveLength(
      1,
    );
  });

  it("records each edited field with the affected staff member", async () => {
    firestore.seed("staff", "staff-1", {
      uid: "staff-1",
      role: "Operator",
      accountStatus: "active",
      email: "old@example.com",
      firstName: "Old",
      lastName: "Name",
      middleInitial: "A",
      username: "old.user",
    });
    firestore.seed("staff", "admin-1", { uid: "admin-1", role: "Administrator", accountStatus: "active" });

    const response = await PATCH(
      new Request("http://localhost/api/staff/staff-1", {
        method: "PATCH",
        headers: { Authorization: "Bearer admin-1", "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          firstName: "New",
          middleInitial: "B",
          lastName: "Name",
          username: "new.user",
          role: "Administrator",
          email: "new@example.com",
        }),
      }),
      { params: Promise.resolve({ id: "staff-1" }) },
    );

    expect(response.status).toBe(200);
    expect(firebaseAdmin.recordStaffActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        activity: "Edited Name, New B.'s name; Edited Name, New B.'s username; Edited Name, New B.'s email; Changed Name, New B.'s role to Administrator",
      }),
    );
  });
});
