import { expect, type Page, test } from "@playwright/test";

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  actionContinueUrl,
  applyEmailVerificationCode,
  hashToken,
  resetFirebaseEmulators,
  setDocumentTiming,
  signInToAuthEmulator,
  waitForOobCode,
} from "./emulator-helpers";

const NEW_PASSWORD = "firebase-emulator-password-updated";
const INVITED_EMAIL = "invited-operator@example.test";
const INVITED_PASSWORD = "invited-emulator-password";
const CHANGED_EMAIL = "firebase-admin-updated@example.test";

async function mockDetectionBackend(page: Page) {
  await page.route("**/detection/api/system/status", async (route) => {
    await route.fulfill({
      json: {
        status: "offline",
        powerSource: "Unknown",
        yoloOnline: false,
        cameraStatus: { online: 0, total: 0 },
        cameras: [],
        nodeA: { signal: "UNKNOWN", online: false },
        nodeB: { signal: "UNKNOWN", online: false },
      },
    });
  });
  await page.route("**/detection/api/cameras", async (route) => {
    await route.fulfill({ json: [] });
  });
}

async function login(page: Page, identifier = ADMIN_USERNAME, password = ADMIN_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Username or Email").fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Login" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function startPasswordReset(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Email address").fill(ADMIN_EMAIL);
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/password-reset" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send reset email" }).click();
  const response = await responsePromise;
  const payload = (await response.json()) as { requestId?: string };
  expect(response.ok()).toBe(true);
  expect(payload.requestId).toBeTruthy();
  await expect(page.getByText("Reset email sent", { exact: true })).toBeVisible();
  return payload.requestId as string;
}

function passwordResetUrl(oobCode: string, requestId: string) {
  return `/reset-password?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}&requestId=${encodeURIComponent(
    requestId,
  )}`;
}

async function createInvitation(page: Page) {
  await login(page);
  await page.goto("/dashboard/staff");
  await expect(page.getByRole("heading", { name: "Staff Information" })).toBeVisible();
  await page.getByRole("button", { name: "Add staff" }).click();
  await page.getByLabel("Username").fill("invited-operator");
  await page.getByLabel("Email address").fill(INVITED_EMAIL);
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/staff/invitations" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send verification email" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  return waitForOobCode("VERIFY_EMAIL", INVITED_EMAIL);
}

async function startEmailChange(page: Page) {
  await login(page);
  await page.goto("/dashboard/staff");
  await expect(page.getByRole("cell", { name: ADMIN_USERNAME, exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Edit ${ADMIN_USERNAME}` }).click();
  await page.getByLabel("Email address").fill(CHANGED_EMAIL);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/email-change") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  await expect(page.getByText("Waiting for email verification", { exact: true })).toBeVisible();
  return waitForOobCode("VERIFY_EMAIL", CHANGED_EMAIL);
}

test.beforeEach(async ({ page }) => {
  await resetFirebaseEmulators();
  await mockDetectionBackend(page);
});

test("login and protected staff data use the Firebase Auth and Firestore emulators", async ({ page }) => {
  await login(page);

  await page.goto("/dashboard/account");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: ADMIN_USERNAME })).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: ADMIN_EMAIL })).toBeVisible();
  await expect(page.getByText("Administrator", { exact: true }).first()).toBeVisible();

  await page.goto("/dashboard/staff");
  await expect(page.getByRole("heading", { name: "Staff Information" })).toBeVisible();
  await expect(page.getByRole("cell", { name: ADMIN_USERNAME, exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: ADMIN_EMAIL, exact: true })).toBeVisible();
});

test("completes a real password-reset link and accepts the new password", async ({ page }) => {
  const requestId = await startPasswordReset(page);
  const action = await waitForOobCode("PASSWORD_RESET", ADMIN_EMAIL);

  await page.waitForTimeout(1_100);
  await page.goto(passwordResetUrl(action.oobCode, requestId));
  await expect(page.getByLabel("Email address")).toHaveValue(ADMIN_EMAIL);
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Password reset successful", { exact: true })).toBeVisible();

  await expect(signInToAuthEmulator(ADMIN_EMAIL, NEW_PASSWORD)).resolves.toMatchObject({ email: ADMIN_EMAIL });
  await expect(signInToAuthEmulator(ADMIN_EMAIL, ADMIN_PASSWORD)).rejects.toThrow();
});

test("enforces the password-reset resend cooldown", async ({ page, request }) => {
  await startPasswordReset(page);
  const cooldownResponse = await request.post("/api/auth/password-reset", { data: { email: ADMIN_EMAIL } });
  expect(cooldownResponse.status()).toBe(429);
  await expect(cooldownResponse.json()).resolves.toMatchObject({ code: "reset-cooldown" });
});

test("rejects a password-reset link after its timeout", async ({ page }) => {
  const requestId = await startPasswordReset(page);
  const action = await waitForOobCode("PASSWORD_RESET", ADMIN_EMAIL);

  await setDocumentTiming("passwordResetSessions", hashToken(requestId), { expiresAt: Date.now() - 1_000 });
  await page.goto(passwordResetUrl(action.oobCode, requestId));
  await expect(page.getByText("Unable to reset password", { exact: true })).toBeVisible();
  await expect(page.getByText(/cancelled|new reset link/i)).toBeVisible();
});

test("cancels a reset request and rejects its previously issued link", async ({ page }) => {
  const requestId = await startPasswordReset(page);
  const action = await waitForOobCode("PASSWORD_RESET", ADMIN_EMAIL);

  await page.getByRole("button", { name: "Cancel reset" }).click();
  await expect(page.getByText("Password reset cancelled", { exact: true })).toBeVisible();
  await page.goto(passwordResetUrl(action.oobCode, requestId));
  await expect(page.getByText("Unable to reset password", { exact: true })).toBeVisible();
  await expect(page.getByText(/cancelled|new reset link/i)).toBeVisible();
});

test("verifies an invitation link, activates the account, and prevents link reuse", async ({ page }) => {
  const action = await createInvitation(page);
  await applyEmailVerificationCode(action.oobCode);
  const invitationUrl = actionContinueUrl(action);

  await page.goto(invitationUrl);
  await expect(page.getByText("invited-operator", { exact: true })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(INVITED_PASSWORD);
  await page.getByLabel("Confirm password").fill(INVITED_PASSWORD);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Verified and active", { exact: true })).toBeVisible();
  await expect(signInToAuthEmulator(INVITED_EMAIL, INVITED_PASSWORD)).resolves.toMatchObject({ email: INVITED_EMAIL });

  await page.goto(invitationUrl);
  await expect(page.getByText("Unable to continue", { exact: true })).toBeVisible();
  await expect(page.getByText(/already been used/i)).toBeVisible();
});

test("expires an invitation, enforces resend cooldown, and issues a replacement link", async ({ page, request }) => {
  const originalAction = await createInvitation(page);
  const invitationToken = new URL(actionContinueUrl(originalAction)).searchParams.get("token");
  expect(invitationToken).toBeTruthy();
  const invitationId = hashToken(invitationToken as string);
  const now = Date.now();
  await setDocumentTiming("pendingStaffInvitations", invitationId, {
    expiresAt: now - 60_000,
    verificationSentAt: now - 60 * 60 * 1000 - 1,
    verificationResendAvailableAt: now + 60_000,
  });

  const administrator = await signInToAuthEmulator(ADMIN_EMAIL, ADMIN_PASSWORD);
  const headers = { Authorization: `Bearer ${administrator.idToken}` };
  const cooldownResponse = await request.post("/api/staff/resend-verification", {
    data: { email: INVITED_EMAIL },
    headers,
  });
  expect(cooldownResponse.status()).toBe(429);
  await expect(cooldownResponse.json()).resolves.toMatchObject({ code: "verification-resend-cooldown" });

  await setDocumentTiming("pendingStaffInvitations", invitationId, {
    verificationResendAvailableAt: Date.now() - 1_000,
  });
  const resendResponse = await request.post("/api/staff/resend-verification", {
    data: { email: INVITED_EMAIL },
    headers,
  });
  expect(resendResponse.ok()).toBe(true);
  const replacementAction = await waitForOobCode("VERIFY_EMAIL", INVITED_EMAIL);
  expect(replacementAction.oobCode).not.toBe(originalAction.oobCode);

  await page.goto(actionContinueUrl(originalAction));
  await expect(page.getByText("Unable to continue", { exact: true })).toBeVisible();
  await expect(page.getByText(/expired/i)).toBeVisible();
});

test("verifies an email-change link and moves Firebase login to the new address", async ({ page }) => {
  const action = await startEmailChange(page);
  await applyEmailVerificationCode(action.oobCode);

  await page.goto(actionContinueUrl(action));
  await expect(page.getByText("Email verified", { exact: true })).toBeVisible();
  await expect(page.getByText(/Email updated successfully/i)).toBeVisible();
  await expect(signInToAuthEmulator(CHANGED_EMAIL, ADMIN_PASSWORD)).resolves.toMatchObject({ email: CHANGED_EMAIL });
  await expect(signInToAuthEmulator(ADMIN_EMAIL, ADMIN_PASSWORD)).rejects.toThrow();
});

test("cancels a pending email change and rejects its verification page", async ({ page }) => {
  const action = await startEmailChange(page);

  await page.getByRole("button", { name: "Cancel verification" }).click();
  await expect(page.getByRole("dialog", { name: "Edit staff member" })).not.toBeVisible();
  await page.goto(actionContinueUrl(action));
  await expect(page.getByText("Verification failed", { exact: true })).toBeVisible();
  await expect(page.getByText(/cancelled or replaced/i)).toBeVisible();
  await expect(signInToAuthEmulator(ADMIN_EMAIL, ADMIN_PASSWORD)).resolves.toMatchObject({ email: ADMIN_EMAIL });
});

test("rejects an email-change link after its verification timeout", async ({ page }) => {
  const action = await startEmailChange(page);
  const verificationToken = new URL(actionContinueUrl(action)).searchParams.get("token");
  expect(verificationToken).toBeTruthy();
  await page.goto("/verify-email-change");
  await setDocumentTiming("staffEmailChanges", hashToken(verificationToken as string), {
    expiresAt: Date.now() - 1_000,
  });
  await applyEmailVerificationCode(action.oobCode);

  await page.goto(actionContinueUrl(action));
  await expect(page.getByText("Verification failed", { exact: true })).toBeVisible();
  await expect(page.getByText(/expired/i)).toBeVisible();
  await expect(signInToAuthEmulator(ADMIN_EMAIL, ADMIN_PASSWORD)).resolves.toMatchObject({ email: ADMIN_EMAIL });
});
