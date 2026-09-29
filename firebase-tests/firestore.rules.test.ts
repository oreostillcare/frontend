import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, setLogLevel } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PROJECT_ID = "demo-smartroad";
const [firestoreHost, firestorePort = "8080"] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");

let testEnvironment: RulesTestEnvironment;

async function seedStaff(uid: string, role: "Administrator" | "Operator") {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "staff", uid), {
      accountStatus: "active",
      email: `${uid}@example.test`,
      normalizedEmail: `${uid}@example.test`,
      role,
      status: "active",
      uid,
      username: uid,
    });
  });
}

beforeAll(async () => {
  setLogLevel("silent");
  const rules = await readFile(fileURLToPath(new URL("../firestore.rules", import.meta.url)), "utf8");
  testEnvironment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: firestoreHost,
      port: Number(firestorePort),
      rules,
    },
  });
});

beforeEach(async () => {
  await testEnvironment.clearFirestore();
});

afterAll(async () => {
  await testEnvironment.cleanup();
});

describe("Firestore security rules", () => {
  test("reject unauthenticated staff reads", async () => {
    const database = testEnvironment.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(database, "staff", "administrator")));
  });

  test("allow active staff to read traffic events but reject client writes", async () => {
    await seedStaff("operator", "Operator");
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "trafficEvents", "event-1"), { vehicleCount: 4 });
    });
    const database = testEnvironment.authenticatedContext("operator", { email: "operator@example.test" }).firestore();

    await assertSucceeds(getDoc(doc(database, "trafficEvents", "event-1")));
    await assertFails(setDoc(doc(database, "trafficEvents", "event-2"), { vehicleCount: 2 }));
  });

  test("allow administrators to read other staff while operators can only read themselves", async () => {
    await seedStaff("administrator", "Administrator");
    await seedStaff("operator", "Operator");
    const administratorDatabase = testEnvironment
      .authenticatedContext("administrator", { email: "administrator@example.test" })
      .firestore();
    const operatorDatabase = testEnvironment
      .authenticatedContext("operator", { email: "operator@example.test" })
      .firestore();

    await assertSucceeds(getDoc(doc(administratorDatabase, "staff", "operator")));
    await assertSucceeds(getDoc(doc(operatorDatabase, "staff", "operator")));
    await assertFails(getDoc(doc(operatorDatabase, "staff", "administrator")));
  });
});
