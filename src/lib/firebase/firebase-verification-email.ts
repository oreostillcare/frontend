import "server-only";

import { adminAuth } from "./admin";
import { ApiError } from "./admin-staff";

const FIREBASE_AUTH_API = "https://identitytoolkit.googleapis.com/v1/accounts";

interface FirebaseRestErrorPayload {
  error?: {
    message?: string;
  };
}

interface CustomTokenExchangeResponse {
  idToken?: string;
}

function firebaseErrorCode(payload: FirebaseRestErrorPayload) {
  return payload.error?.message?.split(" : ")[0]?.trim() || "FIREBASE_EMAIL_ERROR";
}

function verificationEmailError(code: string) {
  if (code === "INVALID_CONTINUE_URI" || code === "UNAUTHORIZED_DOMAIN" || code === "DOMAIN_NOT_WHITELISTED") {
    return new ApiError(
      "Add this website domain in Firebase Authentication > Settings > Authorized domains, then try again.",
      409,
      "unauthorized-continue-domain",
    );
  }
  if (code === "TOO_MANY_ATTEMPTS_TRY_LATER" || code === "QUOTA_EXCEEDED") {
    return new ApiError(
      "Firebase temporarily limited verification emails. Wait a few minutes before trying again.",
      429,
      "verification-rate-limited",
    );
  }
  if (code === "USER_DISABLED") {
    return new ApiError("Restore this pending account before resending verification.", 409, "account-archived");
  }
  if (code === "EMAIL_NOT_FOUND" || code === "USER_NOT_FOUND") {
    return new ApiError("The pending Firebase Authentication user was not found.", 409, "missing-auth-user");
  }
  return new ApiError("Firebase could not send the verification email. Try again.", 502, "verification-email-failed");
}

async function firebaseAuthRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError(
      "Firebase Authentication is not configured on this server.",
      503,
      "firebase-auth-not-configured",
    );
  }

  const response = await fetch(`${FIREBASE_AUTH_API}:${path}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as T & FirebaseRestErrorPayload;
  if (!response.ok) throw verificationEmailError(firebaseErrorCode(payload));
  return payload;
}

export async function sendFirebaseVerificationEmail(uid: string, email: string, continueUrl: string) {
  const customToken = await adminAuth.createCustomToken(uid);
  const exchange = await firebaseAuthRequest<CustomTokenExchangeResponse>("signInWithCustomToken", {
    token: customToken,
    returnSecureToken: true,
  });
  if (!exchange.idToken) {
    throw new ApiError("Firebase could not authorize the verification email.", 502, "verification-email-failed");
  }

  try {
    await firebaseAuthRequest("sendOobCode", {
      requestType: "VERIFY_EMAIL",
      email,
      idToken: exchange.idToken,
      continueUrl,
    });
  } finally {
    await adminAuth.revokeRefreshTokens(uid).catch((error) => {
      console.error("Unable to revoke the temporary verification-email session:", error);
    });
  }
}
