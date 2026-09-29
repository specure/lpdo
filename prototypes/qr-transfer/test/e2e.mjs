// End-to-end check of the QR transfer prototype without a phone: the sender's
// frames rendered into a .y4m video, which headless Chrome plays as its
// camera; the receiver page scans it and must end with the same checksum.
//
// usage: npm run e2e -- <payload file> [bytesPerFrame=300] [fps=8] [noise=0]
// (Chrome at /usr/bin/google-chrome; the video is written to the OS temp dir)
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { readFileSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import bcur from "@ngraveio/bc-ur";
import QRCode from "qrcode";

const PROTO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const { UR, UREncoder } = bcur;

const [file, fragArg = "300", fpsArg = "8", noiseArg = "0"] = process.argv.slice(2);
const frag = +fragArg, fps = +fpsArg, noise = +noiseArg;
const raw = readFileSync(file);
const sum = createHash("sha256").update(raw).digest("hex").slice(0, 12);
const enc = new UREncoder(UR.fromBuffer(deflateRawSync(raw, { level: 9 })), frag);

// The video: each QR frame one video frame at `fps`, three passes' worth.
const W = 480;
const video = `${tmpdir()}/lpdo-qr-camera-${process.pid}.y4m`;
const fd = openSync(video, "w");
writeSync(fd, `YUV4MPEG2 W${W} H${W} F${fps}:1 Ip A1:1 C420jpeg\n`);
const frames = enc.fragmentsLength * 3;
let version = 0;
for (let f = 0; f < frames; f++) {
  const qr = QRCode.create(enc.nextPart().toUpperCase(), { errorCorrectionLevel: "M" });
  version = qr.version;
  const n = qr.modules.size, quiet = 4;
  const scale = Math.floor(W * 0.9 / (n + 2 * quiet));
  const off = Math.floor((W - scale * (n + 2 * quiet)) / 2) + quiet * scale;
  const y = Buffer.alloc(W * W, 200); // grey surround, as a monitor in a room
  for (let r = 0; r < n + 2 * quiet; r++) for (let c = 0; c < n + 2 * quiet; c++) {
    const mr = r - quiet, mc = c - quiet;
    const dark = mr >= 0 && mc >= 0 && mr < n && mc < n && qr.modules.get(mr, mc);
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const py = off - quiet * scale + r * scale + dy, px = off - quiet * scale + c * scale + dx;
      if (py < 0 || px < 0 || py >= W || px >= W) continue;
      let v = dark ? 40 : 235;
      if (noise) v = Math.max(0, Math.min(255, v + (Math.random() - 0.5) * 2 * noise));
      y[py * W + px] = v;
    }
  }
  writeSync(fd, "FRAME\n");
  writeSync(fd, y);
  writeSync(fd, Buffer.alloc(W * W / 2, 128));
}
closeSync(fd);
console.log(`payload ${raw.length} B, ${enc.fragmentsLength} fragments of ${frag} B, QR version ${version}, ${frames} video frames at ${fps} fps, checksum ${sum}`);

// The prototype's dev server (HTTPS, self-signed).
const server = spawn(`${PROTO}/node_modules/.bin/vite`, ["--port", "5444", "--strictPort"], { cwd: PROTO, stdio: ["ignore", "pipe", "pipe"], detached: true });
server.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((ok) => server.stdout.on("data", (d) => { if (/Local/.test(String(d))) ok(); }));

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${video}`],
});
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  // The sender page loads and draws a code.
  await page.goto("https://localhost:5444/");
  await page.click("#synth");
  await page.waitForFunction(() => !document.querySelector("#play").disabled, null, { timeout: 8000 })
    .catch(() => { console.log("sender never ready; errors:", errors); throw new Error("sender"); });
  await page.click("#play");
  await page.waitForTimeout(500);
  console.log("sender:", (await page.textContent("#code")).trim(), "|", (await page.textContent("#frame")).trim());

  // The receiver scans the fake camera.
  await page.goto("https://localhost:5444/receive.html");
  await page.click("#start");
  const t = Date.now();
  await page.waitForFunction(() => document.querySelector("#result").textContent.length > 0, null, { timeout: 60000 })
    .catch(() => {});
  console.log("receiver:", (await page.textContent("#status")).trim());
  const result = (await page.textContent("#result")).trim();
  console.log("result:", result || `(none after ${((Date.now() - t) / 1000).toFixed(0)} s)`);
  console.log(result.includes(sum) ? "CHECKSUM MATCHES" : "CHECKSUM MISSING");
  if (errors.length) console.log("page errors:", errors);
} finally {
  await browser.close();
  process.kill(-server.pid);
  rmSync(video, { force: true });
}
