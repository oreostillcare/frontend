import { expect, type Page, type Route, test } from "@playwright/test";

const staffEmail = "staff@example.test";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: "application/json", status });
}

async function blockExternalFirebase(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "cookieEnabled", { configurable: true, get: () => false });
  });
  await page.route(/https:\/\/[^/]*(?:firebaseio\.com|firebaseapp\.com|googleapis\.com)\/.*/, (route) =>
    route.abort("blockedbyclient"),
  );
  await page.route("https://firestore.googleapis.com/**", (route) =>
    json(
      route,
      {
        error: {
          code: 403,
          message: "Firestore is disabled in Playwright tests.",
          status: "PERMISSION_DENIED",
        },
      },
      403,
    ),
  );
  await page.route(/https:\/\/(?:[^/]+\.)?(?:google-analytics\.com|googletagmanager\.com)\/.*/, (route) =>
    route.fulfill({ body: "", status: 204 }),
  );
}

function testIdToken() {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    aud: "playwright-test-project",
    auth_time: now,
    email: staffEmail,
    email_verified: true,
    exp: now + 3600,
    firebase: { sign_in_provider: "password" },
    iat: now,
    iss: "https://securetoken.google.com/playwright-test-project",
    sub: "playwright-staff-user",
    user_id: "playwright-staff-user",
  })}.signature`;
}

test.beforeEach(async ({ page }) => {
  await blockExternalFirebase(page);
});

test.describe("authentication and protected routes", () => {
  test("shows the existing generic failure for invalid login credentials", async ({ page }) => {
    await page.route("**/api/auth/resolve-identifier", (route) =>
      json(route, { code: "invalid-credential", error: "Invalid username/email or password." }, 401),
    );
    await page.goto("/login");

    await page.getByLabel("Username or Email").fill("unknown-user");
    await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
    await page.getByRole("button", { name: "Login" }).click();

    await expect(page.getByRole("alert").filter({ hasText: "Invalid username/email or password." })).toContainText(
      "Invalid username/email or password.",
    );
    await expect(page).toHaveURL(/\/login$/);
  });

  test("completes a login with mocked Firebase Authentication and navigates to the dashboard", async ({ page }) => {
    let signInRequestSeen = false;
    await page.route("**/api/auth/resolve-identifier", (route) => json(route, { email: staffEmail }));
    await page.route(
      /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:(?:signInWithPassword|lookup)(?:\?.*)?$/,
      async (route) => {
        const endpoint = new URL(route.request().url()).pathname;
        if (endpoint.endsWith(":lookup")) {
          await json(route, {
            users: [
              {
                displayName: "Playwright Staff",
                email: staffEmail,
                emailVerified: true,
                localId: "playwright-staff-user",
                passwordHash: "playwright-test-password-hash",
                providerUserInfo: [
                  {
                    displayName: "Playwright Staff",
                    email: staffEmail,
                    providerId: "password",
                    rawId: staffEmail,
                  },
                ],
              },
            ],
          });
          return;
        }

        signInRequestSeen = true;
        const payload = route.request().postDataJSON() as { email?: string; password?: string };
        expect(payload).toMatchObject({ email: staffEmail, password: "correct-test-password" });
        await json(route, {
          displayName: "Playwright Staff",
          email: staffEmail,
          expiresIn: "3600",
          idToken: testIdToken(),
          kind: "identitytoolkit#VerifyPasswordResponse",
          localId: "playwright-staff-user",
          refreshToken: "playwright-test-refresh-token",
          registered: true,
        });
      },
    );
    await page.goto("/login");

    await page.getByLabel("Username or Email").fill("staff-user");
    await page.getByLabel("Password", { exact: true }).fill("correct-test-password");
    const dashboardNavigation = page.waitForURL(/\/dashboard$/);
    await page.getByRole("button", { name: "Login" }).click();
    await dashboardNavigation;

    expect(signInRequestSeen).toBe(true);
  });

  test("redirects unauthenticated dashboard access to login with the requested path", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
    await expect(page.getByText("Sign in with your authorized Firebase account.")).toBeVisible();
  });

  test("protects nested staff dashboard routes as well", async ({ page }) => {
    await page.goto("/dashboard/staff");

    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard%2Fstaff$/);
  });
});

test.describe("password reset request", () => {
  test("prepares and sends a reset request without contacting Firebase", async ({ page }) => {
    let resetEmailRequestSeen = false;
    await page.route("**/api/auth/password-reset**", async (route) => {
      if (route.request().method() === "POST") {
        await json(route, {
          cooldownEndsAt: "2099-01-01T00:01:00.000Z",
          requestId: "playwright-reset-request",
        });
        return;
      }
      await json(route, { status: "active" });
    });
    await page.route("**/identitytoolkit.googleapis.com/v1/accounts:sendOobCode**", async (route) => {
      resetEmailRequestSeen = true;
      const payload = route.request().postDataJSON() as { email?: string; requestType?: string };
      expect(payload).toMatchObject({ email: staffEmail, requestType: "PASSWORD_RESET" });
      await json(route, { email: staffEmail });
    });
    await page.goto("/login");

    await page.getByRole("button", { name: "Forgot password?" }).click();
    await page.getByLabel("Email address").fill(staffEmail);
    await page.getByRole("button", { name: "Send reset email" }).click();

    await expect(page.getByText("Reset email sent", { exact: true })).toBeVisible();
    expect(resetEmailRequestSeen).toBe(true);
  });
});

test.describe("invitation and verification pages", () => {
  test("shows a verified invitation and completes it through mocked APIs", async ({ page }) => {
    await page.route("**/api/staff/invitations/verify**", (route) =>
      json(route, { email: staffEmail, role: "Operator", username: "playwright-staff" }),
    );
    await page.route("**/api/staff/invitations/complete", async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        password: "safe-password",
        token: "playwright-invitation-token",
      });
      await json(route, { message: "Your account is ready." });
    });
    await page.goto("/complete-invitation?token=playwright-invitation-token");

    await expect(page.getByText("playwright-staff", { exact: true })).toBeVisible();
    await expect(page.getByText(staffEmail, { exact: true })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("safe-password");
    await page.getByLabel("Confirm password").fill("safe-password");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Verified and active", { exact: true })).toBeVisible();
  });

  test("shows the invitation API error for an invalid token", async ({ page }) => {
    await page.route("**/api/staff/invitations/verify**", (route) =>
      json(route, { error: "This invitation link is invalid." }, 404),
    );
    await page.goto("/complete-invitation?token=invalid-token");

    await expect(page.getByText("Unable to continue", { exact: true })).toBeVisible();
    await expect(page.getByText("This invitation link is invalid.")).toBeVisible();
  });

  test("shows successful email verification from a mocked API", async ({ page }) => {
    await page.route("**/api/staff/email-change/verify", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ token: "playwright-verification-token" });
      await json(route, { message: "Email address verified." });
    });
    await page.goto("/verify-email-change?token=playwright-verification-token");

    await expect(page.getByText("Email verified", { exact: true })).toBeVisible();
    await expect(page.getByText("Email address verified.")).toBeVisible();
  });

  test("handles a missing verification token without making an API request", async ({ page }) => {
    let verificationRequestSeen = false;
    await page.route("**/api/staff/email-change/verify", async (route) => {
      verificationRequestSeen = true;
      await route.abort();
    });
    await page.goto("/verify-email-change");

    await expect(page.getByText("Verification failed", { exact: true })).toBeVisible();
    await expect(page.getByText("Email verification token is missing.")).toBeVisible();
    expect(verificationRequestSeen).toBe(false);
  });
});
