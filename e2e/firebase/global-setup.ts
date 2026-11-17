import { type FullConfig, request } from "@playwright/test";

import { resetFirebaseEmulators } from "./emulator-helpers";

export default async function globalSetup(config: FullConfig) {
  await resetFirebaseEmulators();
  const baseURL = config.projects[0].use.baseURL;
  if (!baseURL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) {
    throw new Error("Firebase browser verification requires a loopback application server.");
  }
  const context = await request.newContext({ baseURL });
  try {
    const pages = [
      "/login",
      "/dashboard",
      "/dashboard/staff",
      "/dashboard/account",
      "/reset-password",
      "/complete-invitation",
      "/verify-email-change",
    ];
    const apis = [
      "/api/auth/resolve-identifier",
      "/api/auth/password-reset",
      "/api/staff/activity",
      "/api/staff/invitations",
      "/api/staff/invitations/verify",
      "/api/staff/invitations/complete",
      "/api/staff/resend-verification",
      "/api/staff/emulator-placeholder/email-change",
      "/api/staff/email-change/verify",
    ];
    // Warm API modules too: cold compilation must not consume authentication assertion time.
    for (const path of [...pages, ...apis]) {
      const response = await context.get(path, { timeout: 120_000 });
      const expected = path.startsWith("/api/") ? [400, 401, 404, 405] : [200];
      if (!expected.includes(response.status())) throw new Error(`Test route ${path} returned ${response.status()}.`);
    }
  } finally {
    await context.dispose();
  }
}
