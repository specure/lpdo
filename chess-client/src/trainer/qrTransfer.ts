// A chapter to the phone by animated QR code (#327): the package's JSON,
// compressed, split by a fountain code (BC-UR, as crypto wallets pass
// transactions between devices) into frames the phone picks up in any order
// — missing some only makes it a little slower. Shared by the desktop
// (sending) and the phone trainer (receiving). See
// docs/design/opening-repertoire.md, "Taking chapters to the phone": measured
// on an iPhone, 400 bytes a frame at 10 frames a second reads steadily.

import { validate, type LpdoChapter } from "./format";

/** Bytes a frame, and frames a second — the steady setting measured. */
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
  /** Distinct fragments: about how many frames a perfect reading needs. */
  fragments: number;
  /** The compressed size, in bytes. */
  bytes: number;
  next(): string;
}

export async function encodeChapter(chapter: LpdoChapter, fragmentBytes = FRAGMENT_BYTES): Promise<Frames> {
  const { UR, UREncoder } = await loadBcur();
  const { Buffer } = await import("buffer");
  const raw = new TextEncoder().encode(JSON.stringify(chapter));
  const compressed = await pipe(raw, new CompressionStream("deflate-raw"));
  const enc = new UREncoder(UR.fromBuffer(Buffer.from(compressed)), fragmentBytes);
  // Upper case: QR's alphanumeric mode packs it denser.
  return { fragments: enc.fragmentsLength, bytes: compressed.length, next: () => enc.nextPart().toUpperCase() };
}

/** Reading the frames: `receive` each code's text (in any order, repeats and
 *  strangers ignored) until `done`, then `chapter()`. */
export interface Receiver {
  receive(text: string): void;
  /** 0–1. */
  progress(): number;
  done(): boolean;
  /** The chapter read — or an error saying what is wrong. */
  chapter(): Promise<LpdoChapter>;
}

export async function receiver(): Promise<Receiver> {
  const { URDecoder } = await loadBcur();
  const dec = new URDecoder();
  return {
    receive(text) {
      if (!/^UR:/i.test(text)) return;
      try { dec.receivePart(text.toLowerCase()); } catch { /* a part of another code */ }
    },
    progress: () => (dec.isComplete() ? 1 : dec.estimatedPercentComplete()),
    done: () => dec.isComplete(),
    async chapter() {
      if (!dec.isSuccess()) throw new Error(`The code could not be read: ${dec.resultError()}`);
      const compressed = new Uint8Array(dec.resultUR().decodeCBOR());
      const raw = await pipe(compressed, new DecompressionStream("deflate-raw"));
      const pkg = JSON.parse(new TextDecoder().decode(raw)) as LpdoChapter;
      const problem = validate(pkg);
      if (problem) throw new Error(`The code is ${problem}`);
      return pkg;
    },
  };
}
