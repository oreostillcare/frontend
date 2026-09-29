import { expect, test } from "@playwright/test";

test("login and staff data use the Firebase Auth and Firestore emulators", async ({ page }) => {
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

  await page.goto("/login");

  await page.getByLabel("Username or Email").fill("emulator-admin");
  await page.getByLabel("Password", { exact: true }).fill("firebase-emulator-password");
  await page.getByRole("button", { name: "Login" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/dashboard/account");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: "emulator-admin" })).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: "firebase-admin@example.test" })).toBeVisible();
  await expect(page.getByText("Administrator", { exact: true }).first()).toBeVisible();

  await page.goto("/dashboard/staff");
  await expect(page.getByRole("heading", { name: "Staff Information" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "emulator-admin", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "firebase-admin@example.test", exact: true })).toBeVisible();
});
