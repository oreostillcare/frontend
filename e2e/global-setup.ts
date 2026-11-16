import { type FullConfig, request } from "@playwright/test";

export default async function globalSetup(config: FullConfig) {
  const context = await request.newContext({ baseURL: config.projects[0].use.baseURL });
  try {
    // Compile the protected routes before test timers start; redirects still run in the browser.
    for (const path of ["/login", "/dashboard", "/dashboard/staff"]) {
      const response = await context.get(path, { timeout: 120_000 });
      if (!response.ok()) throw new Error(`Browser test route ${path} returned ${response.status()}.`);
    }
  } finally {
    await context.dispose();
  }
}
