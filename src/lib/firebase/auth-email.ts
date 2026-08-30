"use client";

import { deleteApp, FirebaseError, initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  inMemoryPersistence,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signOut,
  type User,
} from "firebase/auth";

import { auth, firebaseConfig, isFirebaseConfigured } from "./client";

let verificationAppSequence = 0;

function requirePrimaryAuth() {
  if (!auth || !isFirebaseConfigured) {
    throw new Error("Firebase Authentication is not configured.");
  }
  return auth;
}

export function getFirebaseEmailError(error: unknown) {
  if (!(error instanceof FirebaseError)) {
    return error instanceof Error ? error.message : "Firebase could not send the email.";
  }

  if (error.code === "auth/operation-not-allowed") {
    return "Enable Email/Password in Firebase Authentication > Sign-in method, then try again.";
  }
  if (error.code === "auth/unauthorized-continue-uri") {
    return "Add this website domain in Firebase Authentication > Settings > Authorized domains.";
  }
  if (error.code === "auth/too-many-requests" || error.code === "auth/quota-exceeded") {
    return "Firebase's free email limit was reached or too many requests were made. Try again later.";
  }
  if (error.code === "auth/email-already-in-use") {
    return "A Firebase Authentication account already uses this email address.";
  }
  if (error.code === "auth/invalid-email") return "Enter a valid email address.";
  if (error.code === "auth/network-request-failed") return "Unable to reach Firebase. Check your connection.";

  return error.message || "Firebase could not send the email.";
}

export async function sendNativePasswordReset(email: string, requestId: string) {
  const primaryAuth = requirePrimaryAuth();
  const continueUrl = new URL("/login", window.location.origin);
  continueUrl.searchParams.set("passwordReset", "success");
  continueUrl.searchParams.set("requestId", requestId);
  await sendPasswordResetEmail(primaryAuth, email.trim().toLowerCase(), { url: continueUrl.toString() });
}

export async function createPendingVerifiedAccount(email: string, temporaryPassword: string, continueUrl: string) {
  if (!isFirebaseConfigured) throw new Error("Firebase Authentication is not configured.");

  verificationAppSequence += 1;
  const secondaryApp = initializeApp(
    firebaseConfig,
    `smartroad-email-verification-${Date.now()}-${verificationAppSequence}`,
  );
  const secondaryAuth = getAuth(secondaryApp);
  let pendingUser: User | null = null;

  try {
    await setPersistence(secondaryAuth, inMemoryPersistence);
    const credential = await createUserWithEmailAndPassword(
      secondaryAuth,
      email.trim().toLowerCase(),
      temporaryPassword,
    );
    pendingUser = credential.user;
    await sendEmailVerification(pendingUser, { url: continueUrl });
  } catch (error) {
    if (pendingUser) await deleteUser(pendingUser).catch(() => undefined);
    throw new Error(getFirebaseEmailError(error));
  } finally {
    await signOut(secondaryAuth).catch(() => undefined);
    await deleteApp(secondaryApp).catch(() => undefined);
  }
}
