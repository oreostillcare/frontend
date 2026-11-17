import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const PROJECT_ID = "demo-smartroad";
const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const authEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;

function assertSafeEmulatorTarget() {
  if (process.env.GCLOUD_PROJECT !== PROJECT_ID && process.env.FIREBASE_ADMIN_PROJECT_ID !== PROJECT_ID) {
    throw new Error(`Firebase lifecycle tests require project ${PROJECT_ID}.`);
  }
  for (const [name, host] of [
    ["FIRESTORE_EMULATOR_HOST", firestoreEmulatorHost],
    ["FIREBASE_AUTH_EMULATOR_HOST", authEmulatorHost],
  ]) {
    if (!host || !/^(localhost|127\.0\.0\.1):\d+$/.test(host)) {
      throw new Error(`Refusing Firebase lifecycle tests without a loopback ${name}; received ${host || "unset"}.`);
    }
  }
}

const userIds = new Set<string>();
let adminAuth: typeof import("../src/lib/firebase/admin")["adminAuth"];
let adminDb: typeof import("../src/lib/firebase/admin")["adminDb"];
let lifecycle: typeof import("../src/lib/firebase/staff-lifecycle");

function newUid(label: string) {
  return `emulator-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createStaff(
  role: "Administrator" | "Operator",
  options: { archived?: boolean; verified?: boolean } = {},
) {
  const uid = newUid(role.toLowerCase());
  const email = `${uid}@example.test`;
  userIds.add(uid);
  await adminAuth.createUser({
    uid,
    email,
    emailVerified: options.verified ?? true,
    disabled: options.archived ?? false,
    password: "firebase-emulator-password",
  });
  await adminDb
    .collection("staff")
    .doc(uid)
    .set({
      accountStatus: options.archived ? "archived" : "active",
      ...(options.archived ? { archivedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } : {}),
      authUid: uid,
      email,
      emailVerified: options.verified ?? true,
      normalizedEmail: email,
      role,
      status: options.archived ? "archived" : "active",
      uid,
      username: uid,
    });
  return { uid, email };
}

beforeAll(async () => {
  assertSafeEmulatorTarget();
  process.env.FIREBASE_ADMIN_PROJECT_ID = PROJECT_ID;
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  const admin = await import("../src/lib/firebase/admin");
  adminAuth = admin.adminAuth;
  adminDb = admin.adminDb;
  lifecycle = await import("../src/lib/firebase/staff-lifecycle");
});

beforeEach(async () => {
  assertSafeEmulatorTarget();
  const response = await fetch(
    `http://${firestoreEmulatorHost}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(`Unable to clear isolated Firestore emulator data (${response.status}).`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const uid of userIds) await adminAuth.deleteUser(uid).catch(() => undefined);
  userIds.clear();
});

afterAll(async () => {
  const { getApps, deleteApp } = await import("firebase-admin/app");
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe("staff lifecycle against Auth and Firestore emulators", () => {
  // Emulator transaction retries use backoff; this is an invariant test, not a latency bound.
  test("simultaneous administrator demotions leave exactly one active administrator", async () => {
    const first = await createStaff("Administrator");
    const second = await createStaff("Administrator");

    const outcomes = await Promise.allSettled([
      lifecycle.updateStaffProfile(first.uid, { role: "Operator" }),
      lifecycle.updateStaffProfile(second.uid, { role: "Operator" }),
    ]);
    const completed = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    const administrators = await adminDb.collection("staff").where("role", "==", "Administrator").get();

    expect(completed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: "last-administrator" } });
    expect(administrators.size).toBe(1);
  }, 30_000);

  test("an archive reservation blocks a concurrent demotion of the last other administrator", async () => {
    const archivedAdmin = await createStaff("Administrator");
    const remainingAdmin = await createStaff("Administrator");
    let archiveReserved!: () => void;
    let releaseAuth!: () => void;
    const reserved = new Promise<void>((resolve) => (archiveReserved = resolve));
    const hold = new Promise<void>((resolve) => (releaseAuth = resolve));
    const updateUser = adminAuth.updateUser.bind(adminAuth);
    vi.spyOn(adminAuth, "updateUser").mockImplementation(async (uid, properties) => {
      if (uid === archivedAdmin.uid && properties.disabled === true) {
        archiveReserved();
        await hold;
      }
      return updateUser(uid, properties);
    });

    const archiving = lifecycle.archiveStaffMember(archivedAdmin.uid, remainingAdmin.uid);
    await reserved;
    try {
      await expect(lifecycle.updateStaffProfile(remainingAdmin.uid, { role: "Operator" })).rejects.toMatchObject({
        code: "last-administrator",
      });
    } finally {
      releaseAuth();
      await archiving.catch(() => undefined);
    }
    await expect(archiving).resolves.toMatchObject({ message: expect.stringContaining("archived") });

    const archived = await adminDb.collection("staff").doc(archivedAdmin.uid).get();
    const remaining = await adminDb.collection("staff").doc(remainingAdmin.uid).get();
    expect(archived.data()).toMatchObject({ accountStatus: "archived" });
    expect(remaining.data()).toMatchObject({ role: "Administrator", accountStatus: "active" });
  });

  test("an interrupted archived reservation rejects mutation and restore and is skipped by cleanup", async () => {
    const staff = await createStaff("Operator", { archived: true, verified: false });
    const operationId = "interrupted-archive-operation";
    await adminDb.collection("staff").doc(staff.uid).update({ lifecycleOperationId: operationId });

    await expect(lifecycle.updateStaffProfile(staff.uid, { username: "must-not-change" })).rejects.toMatchObject({
      code: "staff-operation-in-progress",
    });
    await expect(lifecycle.restoreStaffMember(staff.uid)).rejects.toMatchObject({
      code: "staff-operation-in-progress",
    });
    const cleanup = await lifecycle.cleanupArchivedUnverifiedAccounts();

    expect(cleanup.deleted).toBe(0);
    const [stored, authUser] = await Promise.all([
      adminDb.collection("staff").doc(staff.uid).get(),
      adminAuth.getUser(staff.uid),
    ]);
    expect(stored.data()).toMatchObject({ accountStatus: "archived", lifecycleOperationId: operationId });
    expect(authUser.disabled).toBe(true);
  });

  test("cleanup skips an account while its restore is pending", async () => {
    const staff = await createStaff("Operator", { archived: true, verified: false });
    let restoreReserved!: () => void;
    let releaseAuth!: () => void;
    const reserved = new Promise<void>((resolve) => (restoreReserved = resolve));
    const hold = new Promise<void>((resolve) => (releaseAuth = resolve));
    const updateUser = adminAuth.updateUser.bind(adminAuth);
    vi.spyOn(adminAuth, "updateUser").mockImplementation(async (uid, properties) => {
      if (uid === staff.uid && properties.disabled === false) {
        restoreReserved();
        await hold;
      }
      return updateUser(uid, properties);
    });

    const restoring = lifecycle.restoreStaffMember(staff.uid);
    await reserved;
    try {
      const cleanup = await lifecycle.cleanupArchivedUnverifiedAccounts();
      const stillPresent = await adminDb.collection("staff").doc(staff.uid).get();
      expect(cleanup.deleted).toBe(0);
      expect(stillPresent.data()?.lifecycleOperationId).toBeTruthy();
    } finally {
      releaseAuth();
      await restoring.catch(() => undefined);
    }
    await expect(restoring).resolves.toMatchObject({ message: expect.stringContaining("restored") });
  });

  test("a normal restore reenables Auth and clears the archived reservation", async () => {
    const staff = await createStaff("Operator", { archived: true });

    await expect(lifecycle.restoreStaffMember(staff.uid)).resolves.toMatchObject({
      message: expect.stringContaining("restored"),
    });

    const [stored, authUser] = await Promise.all([
      adminDb.collection("staff").doc(staff.uid).get(),
      adminAuth.getUser(staff.uid),
    ]);
    expect(stored.data()).toMatchObject({ accountStatus: "active", role: "Operator" });
    expect(stored.data()?.lifecycleOperationId).toBeUndefined();
    expect(authUser.disabled).toBe(false);
  });
});
