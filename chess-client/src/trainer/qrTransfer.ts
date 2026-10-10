// A chapter to the phone by animated QR code (#327): the package's JSON,
// compressed, split by a fountain code (BC-UR, as crypto wallets pass
// transactions between devices) into frames the phone picks up in any order
// — missing some only makes it a little slower. Shared by the desktop
// (sending) and the phone trainer (receiving). See
// docs/design/opening-repertoire.md, "Taking chapters to the phone": measured
// on an iPhone, 400 bytes a frame at 10 frames a second reads steadily.

import { validate, type LpdoChapter } from "./format";

/** Bytes a frame, and frames a second — the steady setting measured (the
 *  desktop's own, set in Maintenance, are in lib/qrSettings). */
export const FRAGMENT_BYTES = 400;
export const FRAMES_PER_SECOND = 10;

type Bcur = typeof import("@ngraveio/bc-ur");

let bcur: Promise<Bcur> | null = null;

/** bc-ur, with what it expects of Node met first (it was written for Node:
 *  Buffer, `assert` reaching for `process`, `global`). Loaded on demand —
 *  only the transfer needs it. */
function loadBcur(): Promise<Bcur> {
  bcur ??= (async () => {
    const { Buffer } = await import("buffer");
    const g = globalThis as Record<string, unknown>;
    g.Buffer ??= Buffer;
    g.global ??= globalThis;
    g.process ??= { env: {}, browser: true, version: "", versions: {}, nextTick: (f: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => f(...a)) };
    return import("@ngraveio/bc-ur");
  })();
  return bcur;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

/** The frames of a chapter, endlessly: `next()` gives the text of the next
 *  QR code. */
export interface Frames {
  /** The parts the chapter is cut in: a reading takes about PARTS_NEEDED ×
   *  as many frames, more when the phone misses some. */
  fragments: number;
  /** The compressed size, in bytes. */
  bytes: number;
  next(): string;
}

export function encodeChapter(chapter: LpdoChapter, fragmentBytes = FRAGMENT_BYTES): Promise<Frames> {
  return encode(chapter, fragmentBytes);
}

/** A test of the transfer (Maintenance → Sending to the phone): not a
 *  chapter — the trainer keeps nothing and shows how the reading went. */
export interface QrTest {
  format: "lpdo-qr-test";
  version: 1;
  sent: string;
  /** The settings it was sent with. */
  bytes: number;
  fps: number;
  size: number;
  /** Random, so it compresses no more than a chapter does. */
  filler: string;
}

export const TEST_FORMAT = "lpdo-qr-test";

/** A test about `kb` KB compressed — a chapter's size — sent with these
 *  settings. */
export function encodeTest(kb: number, s: { bytes: number; fps: number; size: number }): Promise<Frames> {
  // Base64 of random bytes: deflate takes it back to about the bytes.
  const random = new Uint8Array(Math.round(kb * 1024));
  crypto.getRandomValues(random);
  let filler = "";
  for (const b of random) filler += String.fromCharCode(b);
  const test: QrTest = { format: TEST_FORMAT, version: 1, sent: new Date().toISOString(), bytes: s.bytes, fps: s.fps, size: s.size, filler: btoa(filler) };
  return encode(test, s.bytes);
}

async function encode(payload: object, fragmentBytes: number): Promise<Frames> {
  const { UR, UREncoder } = await loadBcur();
  const { Buffer } = await import("buffer");
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const compressed = await pipe(raw, new CompressionStream("deflate-raw"));
  const enc = new UREncoder(UR.fromBuffer(Buffer.from(compressed)), fragmentBytes);
  // Upper case: QR's alphanumeric mode packs it denser.
  return { fragments: enc.fragmentsLength, bytes: compressed.length, next: () => enc.nextPart().toUpperCase() };
}

/** Reading the frames: `receive` each code's text (in any order, repeats and
 *  strangers ignored) until `done`, then `chapter()`. */
export interface Receiver {
  receive(text: string): void;
  /** 0–1: the distinct parts read against about what it takes, or the
   *  parts decoded when more. */
  progress(): number;
  /** Distinct parts read, and the parts the chapter is cut in (0 before the
   *  first). */
  parts(): { read: number; of: number };
  done(): boolean;
  /** What was read: a chapter, or a test of the transfer — or an error
   *  saying what is wrong. */
  payload(): Promise<{ kind: "chapter"; chapter: LpdoChapter } | { kind: "test"; test: QrTest }>;
}

/** Distinct parts a reading takes, typically, per part the chapter is cut
 *  in. */
export const PARTS_NEEDED = 1.5;

export async function receiver(): Promise<Receiver> {
  const { URDecoder } = await loadBcur();
  const dec = new URDecoder();
  // The library's own estimate counts every reading, the same frame read
  // twice too, against 1.75 × the parts: it stopped at 40–80%. Distinct
  // parts instead, against what it takes: the mixed parts the loop shows
  // after the first pass carry less each — measured, 1.3–1.9 × the parts
  // (docs/design/opening-repertoire.md).
  const seen = new Set<number>();
  let of = 0;
  return {
    receive(text) {
      if (!/^UR:/i.test(text)) return;
      // "UR:BYTES/12-45/…": part 12 of 45 (a chapter in one code has none).
      const m = /^UR:[^/]+\/(\d+)-(\d+)\//i.exec(text);
      try {
        if (dec.receivePart(text.toLowerCase()) && m) { seen.add(+m[1]); of = +m[2]; }
      } catch { /* a part of another code */ }
    },
    progress: () => (dec.isComplete() ? 1 : of ? Math.max(dec.getProgress(), Math.min(0.97, seen.size / (of * PARTS_NEEDED))) : 0),
    parts: () => ({ read: seen.size, of }),
    done: () => dec.isComplete(),
    async payload() {
      if (!dec.isSuccess()) throw new Error(`The code could not be read: ${dec.resultError()}`);
      const compressed = new Uint8Array(dec.resultUR().decodeCBOR());
      const raw = await pipe(compressed, new DecompressionStream("deflate-raw"));
      const read = JSON.parse(new TextDecoder().decode(raw)) as { format?: string };
      if (read.format === TEST_FORMAT) return { kind: "test" as const, test: read as QrTest };
      const pkg = read as LpdoChapter;
      const problem = validate(pkg);
      if (problem) throw new Error(`The code is ${problem}`);
      return { kind: "chapter" as const, chapter: pkg };
    },
  };
}
