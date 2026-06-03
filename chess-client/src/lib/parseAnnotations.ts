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
