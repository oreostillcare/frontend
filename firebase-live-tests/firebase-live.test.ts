import { expect, test } from "vitest";

import { createSign, randomBytes, randomUUID } from "node:crypto";

interface GoogleApiResponse {
  email?: string;
  emailVerified?: boolean;
  idToken?: string;
  localId?: string;
  oobLink?: string;
  users?: Array<{
    email?: string;
    emailVerified?: boolean;
    localId?: string;
  }>;
  error?: {
    message?: string;
  };
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Online Firebase test configuration is missing ${name}.`);
  return value;
}

function serviceAccountToken(audience: string, clientEmail: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const encodedClaims = Buffer.from(
    JSON.stringify({ iss: clientEmail, sub: clientEmail, aud: audience, iat: now, exp: now + 3600 }),
  ).toString("base64url");
  const unsignedToken = `${encodedHeader}.${encodedClaims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  return `${unsignedToken}.${signer.sign(privateKey).toString("base64url")}`;
}

async function requestJson(url: string, init: RequestInit) {
  const response = await fetchWithRetry(url, init);
  const text = await response.text();
  const payload = (text ? JSON.parse(text) : {}) as GoogleApiResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Firebase request failed (${response.status}).`);
  }
  return payload;
}

async function fetchWithRetry(url: string, init: RequestInit) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(`Firebase request returned ${response.status}.`);
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw lastError instanceof Error ? lastError : new Error("Firebase request failed after three attempts.");
}

async function identityToolkitRequest(
  apiKey: string,
  operation: "signInWithPassword" | "resetPassword" | "update",
  body: Record<string, unknown>,
) {
  return requestJson(
    `https://identitytoolkit.googleapis.com/v1/accounts:${operation}?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

async function signIn(apiKey: string, email: string, password: string) {
  const payload = await identityToolkitRequest(apiKey, "signInWithPassword", {
    email,
    password,
    returnSecureToken: true,
  });
  if (!payload.idToken || !payload.localId) throw new Error("Online Firebase sign-in did not return an ID token.");
  return { idToken: payload.idToken, localId: payload.localId, email: payload.email ?? email };
}

function actionCode(link: string | undefined) {
  if (!link) throw new Error("Firebase Admin API did not return an action link.");
  const code = new URL(link).searchParams.get("oobCode");
  if (!code) throw new Error("Firebase action link did not contain an oobCode.");
  return code;
}

test("online Firebase supports temporary staff auth, rules, password reset, and email change", async () => {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("Online Firebase tests refuse to run while emulator environment variables are set.");
  }
  if (process.env.FIREBASE_LIVE_TEST_ALLOW_WRITES !== "true") {
    throw new Error(
      "Set FIREBASE_LIVE_TEST_ALLOW_WRITES=true to acknowledge temporary writes to the configured online project.",
    );
  }

  const projectId = requiredEnvironment("FIREBASE_ADMIN_PROJECT_ID");
  const publicProjectId = requiredEnvironment("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
  if (projectId !== publicProjectId) {
    throw new Error("Firebase web and Admin credentials target different projects; refusing online test writes.");
  }

  const apiKey = requiredEnvironment("NEXT_PUBLIC_FIREBASE_API_KEY");
  const clientEmail = requiredEnvironment("FIREBASE_ADMIN_CLIENT_EMAIL");
  const privateKey = requiredEnvironment("FIREBASE_ADMIN_PRIVATE_KEY").replace(/\\n/g, "\n");
  const adminIdentityToken = serviceAccountToken("https://identitytoolkit.googleapis.com/", clientEmail, privateKey);
  const adminFirestoreToken = serviceAccountToken("https://firestore.googleapis.com/", clientEmail, privateKey);
  const uniqueId = `${Date.now()}-${randomUUID()}`;
  const uid = `smartroad-live-test-${uniqueId}`;
  const originalEmail = `smartroad-live-test-${uniqueId}@example.com`;
  const changedEmail = `smartroad-live-test-changed-${uniqueId}@example.com`;
  const originalPassword = `Live-${randomBytes(12).toString("hex")}!`;
  const changedPassword = `Reset-${randomBytes(12).toString("hex")}!`;
  const deniedTrafficEventId = `smartroad-live-test-${uniqueId}`;
  const adminIdentityUrl = `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`;
  const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
  const staffUrl = `${firestoreUrl}/staff/${encodeURIComponent(uid)}`;
  const deniedTrafficUrl = `${firestoreUrl}/trafficEvents/${encodeURIComponent(deniedTrafficEventId)}`;
  const adminHeaders = (token: string) => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
  const adminIdentityRequest = (operation: string, body: Record<string, unknown>) =>
    requestJson(`${adminIdentityUrl}${operation}`, {
      method: "POST",
      headers: adminHeaders(adminIdentityToken),
      body: JSON.stringify(body),
    });
  const deleteTemporaryDocument = (url: string) =>
    requestJson(url, { method: "DELETE", headers: adminHeaders(adminFirestoreToken) }).catch(() => undefined);

  try {
    const createdUser = await adminIdentityRequest("/accounts", {
      localId: uid,
      email: originalEmail,
      emailVerified: true,
      password: originalPassword,
      displayName: "SmartRoad Live Test",
    });
    expect(createdUser.localId).toBe(uid);

    await requestJson(staffUrl, {
      method: "PATCH",
      headers: adminHeaders(adminFirestoreToken),
      body: JSON.stringify({
        fields: {
          uid: { stringValue: uid },
          authUid: { stringValue: uid },
          username: { stringValue: uid },
          email: { stringValue: originalEmail },
          normalizedEmail: { stringValue: originalEmail },
          role: { stringValue: "Operator" },
          accountStatus: { stringValue: "active" },
          status: { stringValue: "active" },
          emailVerified: { booleanValue: true },
          dateJoined: { stringValue: new Date().toISOString().slice(0, 10) },
          createdAt: { timestampValue: new Date().toISOString() },
          emailChangeStatus: { stringValue: "none" },
          passwordResetStatus: { stringValue: "idle" },
          testRecord: { booleanValue: true },
        },
      }),
    });

    const initialSignIn = await signIn(apiKey, originalEmail, originalPassword);
    expect(initialSignIn.localId).toBe(uid);

    const staffResponse = await fetchWithRetry(staffUrl, {
      headers: { Authorization: `Bearer ${initialSignIn.idToken}` },
    });
    expect(staffResponse.status).toBe(200);

    const deniedWriteResponse = await fetchWithRetry(deniedTrafficUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${initialSignIn.idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: { testRecord: { booleanValue: true } } }),
    });
    expect(deniedWriteResponse.status).toBe(403);

    const passwordResetAction = await adminIdentityRequest("/accounts:sendOobCode", {
      requestType: "PASSWORD_RESET",
      email: originalEmail,
      returnOobLink: true,
    });
    await identityToolkitRequest(apiKey, "resetPassword", {
      oobCode: actionCode(passwordResetAction.oobLink),
      newPassword: changedPassword,
    });
    await expect(signIn(apiKey, originalEmail, originalPassword)).rejects.toThrow();
    await expect(signIn(apiKey, originalEmail, changedPassword)).resolves.toMatchObject({ localId: uid });

    const emailChangeAction = await adminIdentityRequest("/accounts:sendOobCode", {
      requestType: "VERIFY_AND_CHANGE_EMAIL",
      email: originalEmail,
      newEmail: changedEmail,
      returnOobLink: true,
    });
    await identityToolkitRequest(apiKey, "update", { oobCode: actionCode(emailChangeAction.oobLink) });
    await expect(signIn(apiKey, changedEmail, changedPassword)).resolves.toMatchObject({ localId: uid });
    await expect(signIn(apiKey, originalEmail, changedPassword)).rejects.toThrow();

    const updatedUser = await adminIdentityRequest("/accounts:lookup", { localId: [uid] });
    expect(updatedUser.users?.[0]).toMatchObject({ localId: uid, email: changedEmail, emailVerified: true });
  } finally {
    await Promise.allSettled([
      deleteTemporaryDocument(deniedTrafficUrl),
      deleteTemporaryDocument(staffUrl),
      adminIdentityRequest("/accounts:delete", { localId: uid }),
    ]);
  }
});
