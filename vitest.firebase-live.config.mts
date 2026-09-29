import { defineConfig } from "vitest/config";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const localEnvironment: Record<string, string> = {};
for (const fileName of [".env", ".env.local", ".env.test", ".env.test.local"]) {
  const filePath = resolve(process.cwd(), fileName);
  if (!existsSync(filePath)) continue;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const quoted = rawValue.match(/^(["'])(.*)\1$/);
    localEnvironment[key] = quoted?.[2] ?? rawValue;
  }
}
for (const [key, value] of Object.entries(localEnvironment)) {
  process.env[key] ??= value;
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["firebase-live-tests/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 30_000,
    clearMocks: true,
    restoreMocks: true,
  },
});
