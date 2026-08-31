import "server-only";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function getAdminApp() {
  const existingApp = getApps()[0];
  if (existingApp) return existingApp;

  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");

  const missingVariables = [
    !projectId && "FIREBASE_ADMIN_PROJECT_ID",
    !clientEmail && "FIREBASE_ADMIN_CLIENT_EMAIL",
    !privateKey && "FIREBASE_ADMIN_PRIVATE_KEY",
  ].filter((variable): variable is string => Boolean(variable));

  if (missingVariables.length > 0) {
    throw new Error(`Firebase Admin configuration error: missing ${missingVariables.join(", ")}.`);
  }

  return initializeApp({
    projectId,
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

const adminApp = getAdminApp();

export const adminAuth = getAuth(adminApp);
export const adminDb = getFirestore(adminApp);
