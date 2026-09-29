import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

import { createHash } from "node:crypto";

export const PROJECT_ID = "demo-smartroad";
export const ADMIN_USER_ID = "firebase-emulator-admin";
export const ADMIN_USERNAME = "emulator-admin";
export const ADMIN_EMAIL = "firebase-admin@example.test";
export const ADMIN_PASSWORD = "firebase-emulator-password";

let appSequence = 0;

function authHost() {
  return process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
}

function firestoreHost() {
  return process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
}

function configureEmulatorEnvironment() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost();
  process.env.FIRESTORE_EMULATOR_HOST = firestoreHost();
  process.env.GCLOUD_PROJECT = PROJECT_ID;
}

async function clearEmulator(url: string) {
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) throw new Error(`Unable to clear Firebase emulator data (${response.status}).`);
}

async function withAdminApp<T>(callback: (app: ReturnType<typeof initializeApp>) => Promise<T>) {
  configureEmulatorEnvironment();
  appSequence += 1;
  const app = initializeApp({ projectId: PROJECT_ID }, `firebase-emulator-test-${Date.now()}-${appSequence}`);
  try {
    return await callback(app);
  } finally {
    await deleteApp(app);
  }
}

export async function resetFirebaseEmulators() {
  configureEmulatorEnvironment();
  await clearEmulator(`http://${authHost()}/emulator/v1/projects/${PROJECT_ID}/accounts`);
  await clearEmulator(`http://${firestoreHost()}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`);

  await withAdminApp(async (app) => {
    await getAuth(app).createUser({
      uid: ADMIN_USER_ID,
      displayName: "Firebase Emulator Admin",
      email: ADMIN_EMAIL,
      emailVerified: true,
      password: ADMIN_PASSWORD,
    });
    await getFirestore(app).collection("staff").doc(ADMIN_USER_ID).set({
      uid: ADMIN_USER_ID,
      authUid: ADMIN_USER_ID,
      username: ADMIN_USERNAME,
      email: ADMIN_EMAIL,
      normalizedEmail: ADMIN_EMAIL,
      role: "Administrator",
      accountStatus: "active",
      status: "active",
      emailVerified: true,
      dateJoined: "2026-09-29",
      createdAt: Timestamp.now(),
      emailChangeStatus: "none",
      passwordResetStatus: "idle",
    });
  });
}

interface AuthResponse {
  email?: string;
  idToken?: string;
  localId?: string;
  error?: {
    message?: string;
  };
}

async function authRequest(path: string, body: Record<string, unknown>) {
  const response = await fetch(
    `http://${authHost()}/identitytoolkit.googleapis.com/v1/accounts:${path}?key=firebase-emulator-api-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const payload = (await response.json()) as AuthResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Firebase Auth emulator request failed (${response.status}).`);
  }
  return payload;
}

export async function signInToAuthEmulator(email: string, password: string) {
  const payload = await authRequest("signInWithPassword", { email, password, returnSecureToken: true });
  if (!payload.idToken || !payload.localId) throw new Error("Firebase Auth emulator did not return a signed-in user.");
  return { email: payload.email ?? email, idToken: payload.idToken, localId: payload.localId };
}

export async function applyEmailVerificationCode(oobCode: string) {
  await authRequest("update", { oobCode });
}

export interface EmulatorOobCode {
  email: string;
  newEmail?: string;
  requestType: "PASSWORD_RESET" | "VERIFY_EMAIL" | "VERIFY_AND_CHANGE_EMAIL";
  oobCode: string;
  oobLink: string;
}

async function listOobCodes() {
  const response = await fetch(`http://${authHost()}/emulator/v1/projects/${PROJECT_ID}/oobCodes`);
  if (!response.ok) throw new Error(`Unable to read Firebase emulator email actions (${response.status}).`);
  return ((await response.json()) as { oobCodes?: EmulatorOobCode[] }).oobCodes ?? [];
}

export async function waitForOobCode(requestType: EmulatorOobCode["requestType"], email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const deadline = Date.now() + 5_000;
  do {
    const matches = (await listOobCodes()).filter(
      (record) => record.requestType === requestType && record.email.toLowerCase() === normalizedEmail,
    );
    const record = matches.at(-1);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Firebase emulator did not create a ${requestType} action for ${email}.`);
}

export function actionContinueUrl(record: EmulatorOobCode) {
  const continueUrl = new URL(record.oobLink).searchParams.get("continueUrl");
  if (!continueUrl) throw new Error("Firebase emulator action is missing its continue URL.");
  return continueUrl;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function setDocumentTiming(
  collection: "passwordResetSessions" | "pendingStaffInvitations" | "staffEmailChanges",
  documentId: string,
  fields: Record<string, number>,
) {
  await withAdminApp(async (app) => {
    const timestamps = Object.fromEntries(
      Object.entries(fields).map(([field, milliseconds]) => [field, Timestamp.fromMillis(milliseconds)]),
    );
    await getFirestore(app).collection(collection).doc(documentId).set(timestamps, { merge: true });
  });
}
