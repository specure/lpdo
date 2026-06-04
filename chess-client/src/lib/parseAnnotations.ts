export interface CalArrow {
  from: string;
  to: string;
  color: string;
}

export interface CslCircle {
  square: string;
  color: string;
}

export interface ParsedComment {
  text: string;
  arrows: CalArrow[];
  circles: CslCircle[];
}

const COLOR_MAP: Record<string, string> = {
  G: "rgba(0, 220, 0, 0.7)",
  R: "rgba(255, 50, 50, 0.7)",
  B: "rgba(70, 130, 255, 0.7)",
  Y: "rgba(255, 230, 0, 0.7)",
};

const CAL_RE = /\[%cal\s+([^\]]+)\]/g;
const CSL_RE = /\[%csl\s+([^\]]+)\]/g;
const ARROW_ENTRY_RE = /([GRBY])([a-h][1-8])([a-h][1-8])/g;
const CIRCLE_ENTRY_RE = /([GRBY])([a-h][1-8])/g;

export function parseComment(raw: string): ParsedComment {
  const arrows: CalArrow[] = [];
  const circles: CslCircle[] = [];

  // Extract arrows
  let m: RegExpExecArray | null;
  CAL_RE.lastIndex = 0;
  while ((m = CAL_RE.exec(raw)) !== null) {
    const content = m[1];
    ARROW_ENTRY_RE.lastIndex = 0;
    let ae: RegExpExecArray | null;
    while ((ae = ARROW_ENTRY_RE.exec(content)) !== null) {
      arrows.push({
        from: ae[2],
        to: ae[3],
        color: COLOR_MAP[ae[1]] ?? COLOR_MAP.G,
      });
    }
  }

  // Extract circles
  CSL_RE.lastIndex = 0;
  while ((m = CSL_RE.exec(raw)) !== null) {
    const content = m[1];
    CIRCLE_ENTRY_RE.lastIndex = 0;
    let ce: RegExpExecArray | null;
    while ((ce = CIRCLE_ENTRY_RE.exec(content)) !== null) {
      circles.push({
        square: ce[2],
        color: COLOR_MAP[ce[1]] ?? COLOR_MAP.G,
      });
    }
  }

  // Strip all [%...] tags from text (cal, csl, evp, clk, etc.)
  const text = raw
    .replace(/\[%[^\]]*\]/g, "")
    .trim();

  return { text, arrows, circles };
}

export const NAG_MAP: Record<number, string> = {
  1: "!",
  2: "?",
  3: "!!",
  4: "??",
  5: "!?",
  6: "?!",
  10: "=",
  13: "∞",   // ∞ (unclear)
  14: "+=",
  15: "=+",
  16: "\u00b1",   // ±
  17: "\u2213",   // ∓
  18: "+-",
  19: "-+",
  22: "\u2a00",   // ⨀
  36: "\u2192",   // →
  40: "\u2191",   // ↑
};

export function nagToSymbol(nag: number): string {
  return NAG_MAP[nag] ?? `$${nag}`;
}

/** Render a move's NAG codes as a display string (e.g. [1, 16] → "!±"). */
export function nagsToString(nags?: number[]): string {
  return (nags ?? []).map(nagToSymbol).join("");
}

// ── Inverses (for serialising a move tree back to PGN movetext) ───────────────

const SYMBOL_TO_NAG: Record<string, number> = Object.fromEntries(
  Object.entries(NAG_MAP).map(([n, sym]) => [sym, Number(n)]),
);

/** Inverse of `nagToSymbol`: map a NAG symbol back to its numeric code, or null
 *  if it isn't a recognised NAG. Also handles the `$N` passthrough that
 *  `nagToSymbol` emits for codes outside `NAG_MAP`. */
export function symbolToNag(symbol: string): number | null {
  if (symbol in SYMBOL_TO_NAG) return SYMBOL_TO_NAG[symbol];
  const m = symbol.match(/^\$(\d+)$/);
  if (m) return Number(m[1]);
  return null;
}

// rgba string → single-letter code (reverse of COLOR_MAP). Exact-string match;
// arrows/circles created in-app and those parsed from PGN both use the same
// COLOR_MAP constants, so the rgba values match exactly.
const RGBA_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(COLOR_MAP).map(([code, rgba]) => [rgba, code]),
);

function colorCode(rgba: string): string {
  return RGBA_TO_CODE[rgba] ?? "G";
}

/** Encode arrows as a `[%cal ...]` tag, or "" when there are none. */
export function encodeCal(arrows: CalArrow[]): string {
  if (!arrows.length) return "";
  const entries = arrows.map((a) => `${colorCode(a.color)}${a.from}${a.to}`).join(",");
  return `[%cal ${entries}]`;
}

/** Encode circles as a `[%csl ...]` tag, or "" when there are none. */
export function encodeCsl(circles: CslCircle[]): string {
  if (!circles.length) return "";
  const entries = circles.map((c) => `${colorCode(c.color)}${c.square}`).join(",");
  return `[%csl ${entries}]`;
}
