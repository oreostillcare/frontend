import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import dgram from "node:dgram";
import os from "node:os";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const args = process.argv.slice(2);

function optionValue(name) {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function defaultRouteAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const finish = (address) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // The socket can already be closed when route discovery fails.
      }
      resolve(address);
    };
    const timeout = setTimeout(() => finish("127.0.0.1"), 1000);

    socket.once("error", () => finish("127.0.0.1"));
    socket.connect(53, "1.1.1.1", () => finish(socket.address().address));
  });
}

function connectedWifiSsid() {
  if (process.platform !== "win32") return undefined;

  try {
    const output = execFileSync("netsh", ["wlan", "show", "interfaces"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return output.match(/^\s*SSID\s*:\s*(.+?)\s*$/im)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function interfaceIpv4(interfaceName) {
  return os
    .networkInterfaces()
    [interfaceName]?.find((address) => address.family === "IPv4" && !address.internal)?.address;
}

const requestedHostname = optionValue("--hostname");
const requiredSsid = process.env.DASHBOARD_WIFI_SSID?.trim() || "linksys";
const wifiInterface = process.env.DASHBOARD_WIFI_INTERFACE?.trim() || "Wi-Fi";
let hostname = requestedHostname;

if (!hostname && process.platform === "win32") {
  const ssid = connectedWifiSsid();
  if (ssid?.toLocaleLowerCase() !== requiredSsid.toLocaleLowerCase()) {
    console.error(
      `Connect this laptop to Wi-Fi SSID "${requiredSsid}" before starting the dashboard. ` +
        `Current SSID: "${ssid || "unavailable"}".`,
    );
    process.exit(1);
  }

  hostname = interfaceIpv4(wifiInterface);
  if (!hostname) {
    console.error(`No IPv4 address was found for the "${wifiInterface}" adapter.`);
    process.exit(1);
  }
}

hostname ||= await defaultRouteAddress();
const nextArgs = requestedHostname ? args : ["--hostname", hostname, ...args];
const allowedDevOrigins = new Set(
  (process.env.DASHBOARD_ALLOWED_DEV_ORIGINS || "localhost,127.0.0.1")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

if (hostname !== "0.0.0.0" && hostname !== "::") allowedDevOrigins.add(hostname);

const child = spawn(process.execPath, [nextBin, "dev", ...nextArgs], {
  env: {
    ...process.env,
    DASHBOARD_ALLOWED_DEV_ORIGINS: [...allowedDevOrigins].join(","),
  },
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Unable to start Next.js: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
