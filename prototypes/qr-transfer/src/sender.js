// The desktop side: a payload, compressed, played as an endless loop of
// fountain-coded QR frames (BC-UR). Every setting is a slider, to find what
// the phone reads fastest.
import { checksum, deflate, kb } from "./shared.js";
import { UR, UREncoder } from "@ngraveio/bc-ur";
import QRCode from "qrcode";

const $ = (id) => document.getElementById(id);
let payload = null;          // { name, raw, compressed, sum }
let timer = null;
let shown = 0;

// Chess-comment-like text: compresses about as a real chapter does, unlike
// random bytes.
const WORDS = ("the a to of and in is with this move white black knight bishop rook queen king pawn " +
  "center square file diagonal attack defend pressure structure plan idea after before now here " +
  "position advantage better worse equal strong weak important typical line variation main side " +
  "develop castle break push exchange capture threat against because while which would could should " +
  "e4 d4 c4 Nf3 Nc3 Bg2 g3 e5 d5 c5 Nf6 Nc6 Be7 O-O Re1 Qc2 b3 Bb2 a3 h3 f4 Nd5 Bb4 Bc5 exd4 cxd5").split(" ");
function synthText(bytes) {
  let s = "";
  let n = 1;
  while (s.length < bytes) {
    s += `${n}. ${WORDS[WORDS.length - 1 - (Math.random() * 26 | 0)]} {`;
    const len = 8 + (Math.random() * 30 | 0);
    for (let i = 0; i < len; i++) s += WORDS[Math.random() * WORDS.length | 0] + " ";
    s += "} ";
    n++;
  }
  return new TextEncoder().encode(s.slice(0, bytes));
}

async function setPayload(name, raw) {
  stop();
  const compressed = await deflate(raw);
  payload = { name, raw, compressed, sum: await checksum(raw) };
  $("payload").textContent = `${name}: ${kb(raw.length)} → ${kb(compressed.length)} compressed · checksum ${payload.sum}`;
  $("play").disabled = false;
  describe();
}

function settings() {
  return { frag: +$("frag").value, fps: +$("fps").value, ecc: $("ecc").value, size: +$("size").value };
}

function describe() {
  const s = settings();
  $("fragOut").textContent = s.frag;
  $("fpsOut").textContent = s.fps;
  $("sizeOut").textContent = s.size;
  if (!payload) return;
  const enc = new UREncoder(UR.fromBuffer(Buffer.from(payload.compressed)), s.frag);
  const part = enc.nextPart().toUpperCase();
  const qr = QRCode.create(part, { errorCorrectionLevel: s.ecc });
  $("code").textContent = `${enc.fragmentsLength} fragments · ${part.length} characters a frame · QR version ${qr.version} (${qr.modules.size}×${qr.modules.size}) · at least ${(enc.fragmentsLength / s.fps).toFixed(1)} s for one pass`;
}

function play() {
  stop();
  const s = settings();
  const enc = new UREncoder(UR.fromBuffer(Buffer.from(payload.compressed)), s.frag);
  shown = 0;
  const canvas = $("qr");
  const t0 = performance.now();
  const tick = () => {
    const part = enc.nextPart().toUpperCase();
    QRCode.toCanvas(canvas, part, { errorCorrectionLevel: s.ecc, width: s.size, margin: 2 });
    shown++;
    $("frame").textContent = `frame ${shown} · ${part.slice(0, part.indexOf("/", 9))} · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  };
  tick();
  timer = setInterval(tick, 1000 / s.fps);
  $("play").disabled = true;
  $("stop").disabled = false;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  $("play").disabled = !payload;
  $("stop").disabled = true;
}

$("file").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (f) await setPayload(f.name, new Uint8Array(await f.arrayBuffer()));
});
$("synth").addEventListener("click", () => setPayload(`generated ${$("synthKb").value} KB`, synthText(+$("synthKb").value * 1024)));
for (const id of ["frag", "fps", "ecc", "size"]) $(id).addEventListener("input", () => { describe(); if (timer) play(); });
$("play").addEventListener("click", play);
$("stop").addEventListener("click", stop);

// The receiver's address, as a QR code for the phone's camera app.
const link = `${location.protocol}//${location.host}/receive.html`;
QRCode.toCanvas($("link"), link, { width: 180, margin: 1 });
$("linkText").textContent = link;
describe();
