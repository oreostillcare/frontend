import { defineConfig, devices } from "@playwright/test";

process.env.METADATA_SERVER_DETECTION ??= "none";

const projectId = "demo-smartroad";
const baseURL = "http://127.0.0.1:3200";
const authEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const [browserEmulatorHost, authEmulatorPort = "9099"] = authEmulatorHost.split(":");
const [, firestoreEmulatorPort = "8080"] = firestoreEmulatorHost.split(":");

export default defineConfig({
  testDir: "./e2e/firebase",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  reporter: [["html", { open: "never", outputFolder: "playwright-report/firebase" }]],
  globalSetup: "./e2e/firebase/global-setup.ts",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-firebase-emulator",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3200",
    env: {
      APP_BASE_URL: baseURL,
      FIREBASE_ADMIN_PROJECT_ID: projectId,
      FIREBASE_AUTH_EMULATOR_HOST: authEmulatorHost,
      FIRESTORE_EMULATOR_HOST: firestoreEmulatorHost,
      GCLOUD_PROJECT: projectId,
      METADATA_SERVER_DETECTION: "none",
      NEXT_PUBLIC_FIREBASE_API_KEY: "firebase-emulator-api-key",
      NEXT_PUBLIC_FIREBASE_APP_ID: "1:123456789:web:firebase-emulator",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${projectId}.firebaseapp.com`,
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: authEmulatorPort,
      NEXT_PUBLIC_FIREBASE_DATABASE_URL: "",
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: browserEmulatorHost,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
      NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: firestoreEmulatorPort,
      NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
  },
});
