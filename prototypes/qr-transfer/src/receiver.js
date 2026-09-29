// The phone side: the camera's frames scanned for QR codes, the parts fed to
// the fountain decoder until the payload is whole; then how long it took,
// and the checksum to compare with the sender's.
import { checksum, inflate, kb } from "./shared.js";
import { URDecoder } from "@ngraveio/bc-ur";
import jsQR from "jsqr";

const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

// The browser's own detector where there is one (Chrome on Android), jsQR
// everywhere (Safari on the iPhone has none).
const native = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
for (const [value, label] of [...(native ? [["native", "BarcodeDetector (built in)"]] : []), ["jsqr", "jsQR"]]) {
  $("decoder").append(new Option(label, value));
}

let decoder, running = false, stream = null;
let t0 = 0, scans = 0, reads = 0, spent = 0;
const seen = new Set();

/** The centre square of the frame, at most 720 px — where the code is, and
 *  less for jsQR to search. */
function grab() {
  const w = video.videoWidth, h = video.videoHeight;
  const side = Math.min(w, h);
  const out = Math.min(side, 720);
  canvas.width = canvas.height = out;
  ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
}

async function read() {
  if ($("decoder").value === "native") {
    const codes = await native.detect(video);
    return codes[0]?.rawValue ?? null;
  }
  grab();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
}

async function loop() {
  if (!running) return;
  if (video.readyState >= 2) {
    const a = performance.now();
    const text = await read().catch(() => null);
    spent += performance.now() - a;
    scans++;
    if (text && /^UR:/i.test(text)) {
      reads++;
      if (!t0) t0 = performance.now();
      seen.add(text.toUpperCase());
      try { decoder.receivePart(text); } catch { /* a part of another payload: ignored */ }
      if (decoder.isComplete()) return finish();
    }
    show();
  }
  if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(loop);
  else requestAnimationFrame(loop);
}

function show() {
  const pct = Math.round(decoder.estimatedPercentComplete() * 100);
  $("progress").style.width = `${pct}%`;
  const secs = t0 ? ((performance.now() - t0) / 1000).toFixed(1) : "–";
  const need = decoder.expectedPartCount();
  $("status").textContent = `${pct}% · ${seen.size} distinct frames read${need ? ` (${need} fragments)` : ""} · ${secs} s · ` +
    `${reads}/${scans} scans found a code · ${(spent / Math.max(scans, 1)).toFixed(0)} ms a scan`;
}

async function finish() {
  running = false;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  show();
  $("progress").style.width = "100%";
  if (!decoder.isSuccess()) {
    $("result").textContent = `Failed: ${decoder.resultError()}`;
  } else {
    const compressed = new Uint8Array(decoder.resultUR().decodeCBOR());
    const raw = await inflate(compressed);
    $("result").textContent = `Done in ${secs} s — ${kb(raw.length)} (${kb(compressed.length)} compressed) from ${seen.size} frames · checksum ${await checksum(raw)}`;
    $("preview").textContent = new TextDecoder().decode(raw.slice(0, 400)) + (raw.length > 400 ? " …" : "");
  }
  stopCamera();
  $("again").hidden = false;
}

function reset() {
  decoder = new URDecoder();
  t0 = 0; scans = 0; reads = 0; spent = 0;
  seen.clear();
  $("progress").style.width = "0%";
  $("result").textContent = "";
  $("preview").textContent = "";
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function start() {
  reset();
  $("start").hidden = true;
  $("again").hidden = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    $("status").textContent = `No camera: ${e.name} — ${e.message}. The page must be on HTTPS, and the camera allowed.`;
    $("start").hidden = false;
    return;
  }
  video.srcObject = stream;
  await video.play();
  const s = stream.getVideoTracks()[0].getSettings();
  $("status").textContent = `Camera ${s.width}×${s.height} — point it at the code.`;
  running = true;
  loop();
}

$("start").addEventListener("click", start);
$("again").addEventListener("click", start);
