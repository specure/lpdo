// What sender and receiver share: bc-ur's Node expectations met in the
// browser, compression and a checksum.
import { Buffer } from "buffer";

globalThis.Buffer = Buffer;
// Node's `assert` (bc-ur uses it) reaches for `process`.
globalThis.process ??= { env: {}, browser: true, version: "", versions: {}, nextTick: (f, ...a) => queueMicrotask(() => f(...a)) };

/** deflate-raw with the browser's own CompressionStream. */
export async function deflate(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

export async function inflate(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}

/** The first 12 hex digits of the SHA-256 — enough to see both ends agree. */
export async function checksum(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
