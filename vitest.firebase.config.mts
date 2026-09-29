import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["firebase-tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
