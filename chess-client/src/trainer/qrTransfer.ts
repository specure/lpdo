// A chapter to the phone by animated QR code (#327): the package's JSON,
// compressed, split by a fountain code (BC-UR, as crypto wallets pass
// transactions between devices) into frames the phone picks up in any order
// — missing some only makes it a little slower. Shared by the desktop
// (sending) and the phone trainer (receiving). See
// docs/design/opening-repertoire.md, "Taking chapters to the phone": measured
// on an iPhone, 400 bytes a frame at 10 frames a second reads steadily.
//
// The frames are bc-ur's; the reading is not. Its decoder only peels — a
// mixed part counts once the others mixed into it are known — and its mixes
// are heavy (a degree drawn from 1/d: 24 of 133 parts on average), so a
// phone that joins after the first, plain pass needed 1.9–2.4 × the parts
// (a 52 KB chapter: 250–320 frames, half of them useless until the end).
// The reader here solves the parts as a system over GF(2) instead: every
// frame that is not a repeat of what it has counts, and the reading ends at
// the parts the chapter is cut in plus a few — measured 1.03–1.11 ×
// whenever the phone joins, with a third or half the frames missed.

import { validate, type LpdoChapter } from "./format";

/** Bytes a frame, and frames a second — the steady setting measured (the
 *  desktop's own, set in Maintenance, are in lib/qrSettings). */
export const FRAGMENT_BYTES = 400;
export const FRAMES_PER_SECOND = 10;

type Bcur = typeof import("@ngraveio/bc-ur");

let node: Promise<void> | null = null;

/** What bc-ur expects of Node, met first (it was written for Node: Buffer,
 *  `assert` reaching for `process`, `global`). */
function nodeGlobals(): Promise<void> {
  node ??= (async () => {
    const { Buffer } = await import("buffer");
    const g = globalThis as Record<string, unknown>;
    g.Buffer ??= Buffer;
    g.global ??= globalThis;
    g.process ??= { env: {}, browser: true, version: "", versions: {}, nextTick: (f: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => f(...a)) };
  })();
  return node;
}

let bcur: Promise<Bcur> | null = null;

/** bc-ur's encoder. Loaded on demand — only the transfer needs it. */
function loadBcur(): Promise<Bcur> {
  bcur ??= nodeGlobals().then(() => import("@ngraveio/bc-ur"));
  return bcur;
}

/** The pieces of bc-ur a frame is read with: its text to the part's bytes,
 *  and which parts of the chapter a frame mixes — the same rule as its
 *  encoder, from the frame's number alone, so the frames need not change. */
async function loadParts() {
  await nodeGlobals();
  const [bytewords, cbor, fountain, utils, { Buffer }] = await Promise.all([
    import("@ngraveio/bc-ur/dist/bytewords"), import("@ngraveio/bc-ur/dist/cbor"),
    import("@ngraveio/bc-ur/dist/fountainUtils"), import("@ngraveio/bc-ur/dist/utils"), import("buffer"),
  ]);
  // The CommonJS default export, under the bundler's interop or without it
  // (the dev server leaves it a layer deeper).
  type Bytewords = typeof bytewords.default;
  const bw = (bytewords.default.STYLES ? bytewords.default : (bytewords.default as unknown as { default: Bytewords }).default);
  return {
    /** A frame's body to the bytes it carries. */
    bytes: (body: string) => Buffer.from(bw.decode(body, bw.STYLES.MINIMAL), "hex"),
    cborDecode: (b: Uint8Array) => cbor.cborDecode(Buffer.from(b)) as unknown,
    chooseFragments: fountain.chooseFragments,
    crc: (b: Uint8Array) => utils.getCRC(Buffer.from(b)),
  };
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
  // In slices: the API gives at most 64 KB at a time.
  for (let at = 0; at < random.length; at += 65536) crypto.getRandomValues(random.subarray(at, at + 65536));
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
  /** 0–1: the parts pinned down against the parts the chapter is cut in. */
  progress(): number;
  /** Parts pinned down, and the parts the chapter is cut in (0 before the
   *  first). */
  parts(): { read: number; of: number };
  done(): boolean;
  /** What was read: a chapter, or a test of the transfer — or an error
   *  saying what is wrong. */
  payload(): Promise<{ kind: "chapter"; chapter: LpdoChapter } | { kind: "test"; test: QrTest }>;
}

/** Frames a reading takes, typically, per part the chapter is cut in: the
 *  parts themselves and a few that happened to mix nothing new. */
export const PARTS_NEEDED = 1.05;

export async function receiver(): Promise<Receiver> {
  const { bytes, cborDecode, chooseFragments, crc } = await loadParts();
  // The chapter's shape, from the first frame; frames of another are ignored.
  let of = 0, messageLength = 0, checksum = 0, fragmentLength = 0, words = 0;
  // The system so far, in reduced form: one row per pivot (the lowest part
  // mixed into it), each a set of parts (a bit each) and the XOR of their
  // bytes. A frame is reduced by the rows whose pivots it contains; what is
  // left, if anything, is a new row — or nothing new (a repeat, or a mix of
  // what is known), and it is dropped. The chapter is solved when there is a
  // row for every part.
  const rows = new Map<number, { bits: Uint32Array; frag: Uint8Array }>();
  let message: Uint8Array | null = null;
  const xor = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]; return out; };

  const add = (indexes: number[], fragment: Uint8Array) => {
    const bits = new Uint32Array(words);
    for (const i of indexes) bits[i >> 5] |= 1 << (i & 31);
    let frag = fragment;
    for (let w = 0; w < words; w++) {
      while (bits[w]) {
        const pivot = w * 32 + 31 - Math.clz32(bits[w] & -bits[w]);
        const row = rows.get(pivot);
        if (!row) { rows.set(pivot, { bits, frag }); return; }
        for (let k = w; k < words; k++) bits[k] ^= row.bits[k];
        frag = xor(frag, row.frag);
      }
    }
  };
  // Back-substitution, from the last part: a row's other parts are all
  // later ones, solved already.
  const solve = () => {
    const parts: Uint8Array[] = new Array(of);
    for (let p = of - 1; p >= 0; p--) {
      const row = rows.get(p)!;
      let frag = row.frag;
      for (let q = p + 1; q < of; q++) if (row.bits[q >> 5] & (1 << (q & 31))) frag = xor(frag, parts[q]);
      parts[p] = frag;
    }
    const all = new Uint8Array(of * fragmentLength);
    parts.forEach((f, i) => all.set(f, i * fragmentLength));
    return all.subarray(0, messageLength);
  };

  return {
    receive(text) {
      if (message) return;
      const m = /^UR:([a-z0-9-]+)\/(?:(\d+)-(\d+)\/)?([a-z]+)$/i.exec(text);
      if (!m || m[1].toLowerCase() !== "bytes") return;
      try {
        const b = bytes(m[4].toLowerCase());
        // A chapter in one code: the body is the message itself.
        if (!m[2]) { if (!of) { of = 1; message = b; rows.set(0, { bits: new Uint32Array(1), frag: b }); } return; }
        const body = cborDecode(b);
        if (!Array.isArray(body) || body.length !== 5) return;
        const [seqNum, seqLength, msgLen, sum, fragment] = body as [number, number, number, number, Uint8Array];
        if (seqNum !== +m[2] || seqLength !== +m[3] || !(fragment instanceof Uint8Array) || !fragment.length) return;
        if (!of) { of = seqLength; messageLength = msgLen; checksum = sum; fragmentLength = fragment.length; words = Math.ceil(of / 32); }
        else if (seqLength !== of || msgLen !== messageLength || sum !== checksum || fragment.length !== fragmentLength) return;
        add(chooseFragments(seqNum, seqLength, checksum), new Uint8Array(fragment));
        if (rows.size === of) message = solve();
      } catch { /* not a frame of ours */ }
    },
    progress: () => (of ? rows.size / of : 0),
    parts: () => ({ read: rows.size, of }),
    done: () => message !== null,
    async payload() {
      if (!message) throw new Error("The code is not read through yet");
      if (of > 1 && crc(message) !== checksum) throw new Error("The code could not be read: the parts do not add up");
      const compressed = new Uint8Array(cborDecode(message) as Uint8Array);
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
