// Uses installed Edge; no browser download, credentials, or production changes.
import { chromium } from "@playwright/test";
import { writeFileSync, existsSync } from "node:fs";

const output = process.argv[2];
if (!output || existsSync(output)) throw new Error("Choose a new output JSON path");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const responses = [];
  page.on("response", response => {
    if (response.url().includes("/video/")) responses.push({ url: response.url(), status: response.status(), headers: response.headers() });
  });
  page.on("pageerror", error => errors.push(error.message));
  let dashboard;
  try {
    if (process.argv.includes("--streams-only")) throw new Error("Dashboard inspection skipped: previously checked");
    await page.goto("http://localhost:3000/dashboard/monitoring", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(5000);
    dashboard = { url: page.url(), images: await page.locator("img").count(),
      body: (await page.locator("body").innerText()).slice(0, 1200), errors };
    await page.screenshot({ path: output.replace(/\.json$/, "-dashboard.png") });
  } catch (error) {
    dashboard = { url: page.url(), error: String(error), errors };
  }
  // Use the same native img rendering and proxy URLs as the dashboard.
  await page.goto("http://localhost:3000/detection/api/health");
  const rendering = await page.evaluate(async (proxyOnly) => {
    document.body.replaceChildren();
    const samples = [];
    for (const base of proxyOnly ? ["/detection"] : ["http://127.0.0.1:5000", "/detection"]) {
      for (const id of [1, 2]) {
        const img = document.createElement("img");
        img.width = 480;
        img.height = 360;
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 24;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const sample = { url: `${base}/video/raw/camera/${id}`, onLoadMs: null, firstPixelsMs: null,
          changes: 0, readable: true, previous: null, width: 0, height: 0, error: null };
        img.crossOrigin = "anonymous";
        const began = performance.now();
        img.onload = () => { sample.onLoadMs = performance.now() - began; };
        img.onerror = () => { sample.error = "img error"; };
        img.src = sample.url;
        document.body.append(img);
        samples.push({ sample, img, canvas, context, began });
      }
    }
    const began = performance.now();
    let callbacks = 0;
    await new Promise(resolve => {
      const tick = () => {
        callbacks++;
        for (const item of samples) {
          const { sample, img, context, began } = item;
          if (!img.naturalWidth || !sample.readable) continue;
          try {
            context.drawImage(img, 0, 0, 32, 24);
            const pixels = context.getImageData(0, 0, 32, 24).data;
            let hash = 2166136261;
            for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
            if (sample.firstPixelsMs === null) sample.firstPixelsMs = performance.now() - began;
            if (sample.previous !== hash) sample.changes++;
            sample.previous = hash;
            sample.width = img.naturalWidth;
            sample.height = img.naturalHeight;
          } catch (error) { sample.readable = false; sample.error = String(error); }
        }
        if (performance.now() - began >= 12000) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const seconds = (performance.now() - began) / 1000;
    return { seconds, callbacks, samples: samples.map(({ sample }) => ({ ...sample, pixelChangeFps: sample.changes / seconds })),
      scope: "Pixel hash changes sampled with requestAnimationFrame; not sensor-to-display latency or exact unique-frame FPS" };
  }, process.argv.includes("--streams-only"));
  const report = { dashboard, rendering, responses };
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
