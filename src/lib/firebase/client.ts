import { getApp, getApps, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";

export const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.appId);
export const firebaseEmulatorSettings =
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true"
    ? {
        host: process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST || "127.0.0.1",
        authPort: Number(process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT || 9099),
        firestorePort: Number(process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT || 8080),
      }
    : null;

function configuredApp() {
  if (!isFirebaseConfigured) return null;
  if (getApps().length) return getApp();
  return initializeApp(firebaseConfig);
}

export const firebaseApp = configuredApp();
export const auth = firebaseApp ? getAuth(firebaseApp) : null;
export const db = firebaseApp ? getFirestore(firebaseApp) : null;
export const database =
  firebaseApp && process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL
    ? getDatabase(firebaseApp, process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL)
    : null;

type FirebaseEmulatorState = typeof globalThis & {
  __smartRoadAuthEmulatorConnected?: boolean;
  __smartRoadFirestoreEmulatorConnected?: boolean;
};

if (firebaseEmulatorSettings && typeof window !== "undefined") {
  const emulatorState = globalThis as FirebaseEmulatorState;

  if (auth && !emulatorState.__smartRoadAuthEmulatorConnected) {
    connectAuthEmulator(auth, `http://${firebaseEmulatorSettings.host}:${firebaseEmulatorSettings.authPort}`, {
      disableWarnings: true,
    });
    emulatorState.__smartRoadAuthEmulatorConnected = true;
  }
  if (db && !emulatorState.__smartRoadFirestoreEmulatorConnected) {
    connectFirestoreEmulator(db, firebaseEmulatorSettings.host, firebaseEmulatorSettings.firestorePort);
    emulatorState.__smartRoadFirestoreEmulatorConnected = true;
  }
}

export async function initializeFirebaseAnalytics() {
  if (!firebaseApp || firebaseEmulatorSettings || typeof window === "undefined") return null;
  const { getAnalytics, isSupported } = await import("firebase/analytics");
  return (await isSupported()) ? getAnalytics(firebaseApp) : null;
}
