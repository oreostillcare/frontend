/** @type {import('next').NextConfig} */
const detectionBackendUrl = (process.env.DETECTION_BACKEND_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const allowedDevOrigins = (process.env.DASHBOARD_ALLOWED_DEV_ORIGINS || "192.168.0.103,192.168.56.1,192.168.1.12")
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
