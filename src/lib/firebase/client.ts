import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.appId);
function configuredApp() {
  if (!isFirebaseConfigured) return null;
  if (getApps().length) return getApp();
  return initializeApp(firebaseConfig);
}
export const firebaseApp = configuredApp();
export const auth = firebaseApp ? getAuth(firebaseApp) : null;
export const database =
  firebaseApp && process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL
    ? getDatabase(firebaseApp, process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL)
    : null;

export async function initializeFirebaseAnalytics() {
  if (!firebaseApp || typeof window === "undefined") return null;
  const { getAnalytics, isSupported } = await import("firebase/analytics");
  return (await isSupported()) ? getAnalytics(firebaseApp) : null;
}
