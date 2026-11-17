import { afterEach, expect, it, vi } from "vitest";

import { resetFirebaseEmulators } from "../../../e2e/firebase/emulator-helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  ["production.example:9099", "127.0.0.1:8080"],
  ["127.0.0.1:9099", "production.example:8080"],
  ["user@127.0.0.1:9099", "127.0.0.1:8080"],
  ["127.0.0.1:9099/path", "127.0.0.1:8080"],
])("rejects unsafe emulator reset destinations before any request: %s / %s", async (authHost, firestoreHost) => {
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", authHost);
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", firestoreHost);
  await expect(resetFirebaseEmulators()).rejects.toThrow("loopback emulator host");
  expect(network).not.toHaveBeenCalled();
});
