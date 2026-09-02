import { beforeEach, describe, expect, it, vi } from "vitest";

const apiErrors = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      public status = 400,
      public code = "bad-request",
    ) {
      super(message);
    }
  }

  return { ApiError };
});

vi.mock("./admin-staff", () => apiErrors);

import { sendFirebaseVerificationEmail } from "./firebase-verification-email";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("sendFirebaseVerificationEmail", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "test-api-key");
  });

  it("fails before making a request when the Firebase API key is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "");

    await expect(
      sendFirebaseVerificationEmail("staff@example.com", "temporary-password", "https://app.example/complete"),
    ).rejects.toMatchObject({ code: "firebase-auth-not-configured", status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs in with the temporary password before sending the verification OOB code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ idToken: "firebase-id-token" }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: "staff@example.com" }));

    await sendFirebaseVerificationEmail(
      "staff@example.com",
      "temporary-password",
      "https://app.example/complete-invitation?token=opaque-token",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=test-api-key",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      email: "staff@example.com",
      password: "temporary-password",
      returnSecureToken: true,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=test-api-key",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      continueUrl: "https://app.example/complete-invitation?token=opaque-token",
      idToken: "firebase-id-token",
      requestType: "VERIFY_EMAIL",
    });
  });

  it("rejects a successful sign-in response that has no ID token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await expect(
      sendFirebaseVerificationEmail("staff@example.com", "temporary-password", "https://app.example/complete"),
    ).rejects.toMatchObject({ code: "verification-email-failed", status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["INVALID_CONTINUE_URI", "unauthorized-continue-domain", 409],
    ["UNAUTHORIZED_DOMAIN", "unauthorized-continue-domain", 409],
    ["DOMAIN_NOT_WHITELISTED", "unauthorized-continue-domain", 409],
    ["TOO_MANY_ATTEMPTS_TRY_LATER", "verification-rate-limited", 429],
    ["QUOTA_EXCEEDED", "verification-rate-limited", 429],
    ["EMAIL_NOT_FOUND", "missing-auth-user", 409],
    ["USER_NOT_FOUND", "missing-auth-user", 409],
    ["SOMETHING_ELSE", "verification-email-failed", 502],
  ])("maps Firebase REST error %s to %s", async (firebaseCode, expectedCode, expectedStatus) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: `${firebaseCode} : details` } }, 400));

    await expect(
      sendFirebaseVerificationEmail("staff@example.com", "temporary-password", "https://app.example/complete"),
    ).rejects.toMatchObject({ code: expectedCode, status: expectedStatus });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps an OOB request failure after a successful sign-in", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ idToken: "firebase-id-token" }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "QUOTA_EXCEEDED" } }, 429));

    await expect(
      sendFirebaseVerificationEmail("staff@example.com", "temporary-password", "https://app.example/complete"),
    ).rejects.toMatchObject({ code: "verification-rate-limited", status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
