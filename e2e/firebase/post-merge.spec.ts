import { expect, type Page, test } from "@playwright/test";

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_USER_ID,
  ADMIN_USERNAME,
  PROJECT_ID,
  resetFirebaseEmulators,
  signInToAuthEmulator,
} from "./emulator-helpers";

function assertSafeEmulatorTarget() {
  if (
    process.env.GCLOUD_PROJECT !== PROJECT_ID ||
    process.env.FIREBASE_ADMIN_PROJECT_ID !== PROJECT_ID ||
    !/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST || "") ||
    !/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || "")
  ) {
    throw new Error("Post-merge browser checks require demo-smartroad and loopback Auth and Firestore emulators.");
  }
}

async function mockDetectionBackend(page: Page) {
  await page.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    const externalFirebaseHost =
      /(?:^|\.)firebaseio\.com$/.test(hostname) ||
      /(?:^|\.)firebaseapp\.com$/.test(hostname) ||
      /(?:^|\.)firebase\.com$/.test(hostname) ||
      /^(?:identitytoolkit|securetoken|firestore|firebaseinstallations|firebasestorage)\.googleapis\.com$/.test(
        hostname,
      );
    return externalFirebaseHost ? route.abort() : route.continue();
  });
  await page.route("**/detection/api/system/status", (route) =>
    route.fulfill({
      json: {
        status: "offline",
        powerSource: "Unknown",
        yoloOnline: false,
        cameraStatus: { online: 0, total: 0 },
        cameras: [],
        nodeA: { signal: "UNKNOWN", online: false },
        nodeB: { signal: "UNKNOWN", online: false },
      },
    }),
  );
  await page.route("**/detection/api/cameras", (route) => route.fulfill({ json: [] }));
}

async function createOperatorToken() {
  assertSafeEmulatorTarget();
  const { initializeApp, deleteApp } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({ projectId: PROJECT_ID }, `post-merge-operator-${Date.now()}`);
  try {
    const uid = `post-merge-operator-${Date.now()}`;
    const email = `${uid}@example.test`;
    await getAuth(app).createUser({ uid, email, emailVerified: true, password: "firebase-emulator-password" });
    await getFirestore(app).collection("staff").doc(uid).set({
      uid,
      authUid: uid,
      username: uid,
      email,
      normalizedEmail: email,
      role: "Operator",
      accountStatus: "active",
      status: "active",
      emailVerified: true,
    });
    return await signInToAuthEmulator(email, "firebase-emulator-password");
  } finally {
    await deleteApp(app);
  }
}

test.beforeEach(async ({ page }) => {
  assertSafeEmulatorTarget();
  await resetFirebaseEmulators();
  await mockDetectionBackend(page);
});

test("records login and logout, restricts activity reads to admins, and protects routes after sign-out", async ({
  page,
  request,
}) => {
  assertSafeEmulatorTarget();
  await page.goto("/login");
  await page.getByLabel("Username or Email").fill(ADMIN_USERNAME);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  const authSignInResponse = page.waitForResponse(
    (response) => response.url().includes("/accounts:signInWithPassword") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Login" }).click();
  const authResponse = await authSignInResponse;
  const authResponseUrl = new URL(authResponse.url());
  expect(["localhost", "127.0.0.1"]).toContain(authResponseUrl.hostname);
  expect(authResponseUrl.port).toBe(process.env.FIREBASE_AUTH_EMULATOR_HOST?.split(":")[1]);
  expect(authResponse.ok()).toBe(true);
  await page.waitForURL(/\/dashboard$/);
  await expect(page).toHaveURL(/\/dashboard$/);

  const administrator = await signInToAuthEmulator(ADMIN_EMAIL, ADMIN_PASSWORD);
  const administratorHeaders = { Authorization: `Bearer ${administrator.idToken}` };
  const activityResponse = await request.get("/api/staff/activity", { headers: administratorHeaders });
  expect(activityResponse.ok()).toBe(true);
  await expect(activityResponse.json()).resolves.toMatchObject({
    activities: [expect.objectContaining({ activity: "Logged in", actorUid: ADMIN_USER_ID })],
  });

  const operator = await createOperatorToken();
  const operatorResponse = await request.get("/api/staff/activity", {
    headers: { Authorization: `Bearer ${operator.idToken}` },
  });
  expect(operatorResponse.status()).toBe(403);
  expect((await request.get("/api/staff/activity")).status()).toBe(401);

  await page.locator(`[aria-label="Open account menu for ${ADMIN_USERNAME}"]`).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login(?:\?next=%2Fdashboard)?$/i);
  await page.goto("/dashboard/account");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard%2Faccount$/);

  await expect
    .poll(async () => {
      const response = await request.get("/api/staff/activity", { headers: administratorHeaders });
      const payload = (await response.json()) as { activities?: Array<{ activity: string; actorUid: string }> };
      return payload.activities?.some(
        (activity) => activity.activity === "Logged out" && activity.actorUid === ADMIN_USER_ID,
      );
    })
    .toBe(true);
});
