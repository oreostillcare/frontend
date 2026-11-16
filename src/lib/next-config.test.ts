import { expect, it } from "vitest";

import { execFileSync } from "node:child_process";

it("keeps explicit backend and Firebase test settings ahead of shared environment defaults", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import config from './next.config.mjs';
       console.log(JSON.stringify({
         origins: config.allowedDevOrigins,
         rewrites: await config.rewrites(),
         project: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
       }));`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DASHBOARD_ALLOWED_DEV_ORIGINS: "fixture.invalid,second.invalid",
        DETECTION_BACKEND_URL: "http://127.0.0.1:5999/",
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: "isolated-test-project",
      },
    },
  );
  expect(JSON.parse(output)).toEqual({
    origins: ["fixture.invalid", "second.invalid"],
    rewrites: [{ source: "/detection/:path*", destination: "http://127.0.0.1:5999/:path*" }],
    project: "isolated-test-project",
  });
});
