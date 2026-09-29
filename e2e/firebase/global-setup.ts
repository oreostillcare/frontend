import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const PROJECT_ID = "demo-smartroad";
const USER_ID = "firebase-emulator-admin";
const USER_EMAIL = "firebase-admin@example.test";
const USER_PASSWORD = "firebase-emulator-password";

async function clearEmulator(url: string) {
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) throw new Error(`Unable to clear Firebase emulator data (${response.status}).`);
}

export default async function globalSetup() {
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
  process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
  process.env.GCLOUD_PROJECT = PROJECT_ID;

  await clearEmulator(`http://${authHost}/emulator/v1/projects/${PROJECT_ID}/accounts`);
  await clearEmulator(`http://${firestoreHost}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`);

  const app = initializeApp({ projectId: PROJECT_ID }, "firebase-emulator-e2e-seed");
  try {
    await getAuth(app).createUser({
      uid: USER_ID,
      displayName: "Firebase Emulator Admin",
      email: USER_EMAIL,
      emailVerified: true,
      password: USER_PASSWORD,
    });
    await getFirestore(app).collection("staff").doc(USER_ID).set({
      uid: USER_ID,
      authUid: USER_ID,
      username: "emulator-admin",
      email: USER_EMAIL,
      normalizedEmail: USER_EMAIL,
      role: "Administrator",
      accountStatus: "active",
      status: "active",
      emailVerified: true,
      dateJoined: "2026-09-29",
      createdAt: Timestamp.now(),
      emailChangeStatus: "none",
      passwordResetStatus: "idle",
    });
  } finally {
    await deleteApp(app);
  }
}
