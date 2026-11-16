import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// This checkout can live inside a workspace that owns the shared .env.
// Load defaults before reading config; explicit process/test values take precedence.
const workspaceEnv = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(workspaceEnv)) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(workspaceEnv, "utf8")))) {
    process.env[name] ??= value;
  }
}

/** @type {import('next').NextConfig} */
const detectionBackendUrl = (process.env.DETECTION_BACKEND_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const allowedDevOrigins = (
  process.env.DASHBOARD_ALLOWED_DEV_ORIGINS ||
  "192.168.0.103,192.168.56.1,192.168.1.12,169.254.199.14,192.168.1.11,192.168.137.97,10.201.131.234"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig = {
  reactCompiler: true,
  allowedDevOrigins,
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
  async rewrites() {
    return [
      {
        source: "/detection/:path*",
        destination: `${detectionBackendUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
