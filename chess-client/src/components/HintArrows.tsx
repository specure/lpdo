// Hint arrows on a board: the database's most played moves (orange) and the
// engines' strong moves (violet) — every move any engine with a result for
// the position marks "!", stronger the more engines agree — the same on the
// Games and Analysis boards, and a ring on the destination of a forcing move:
// one that leaves the opponent only one or two strong replies (the Engine
// panel's Strong column, by any engine). Colours chosen apart from the PGN annotation arrows
// (green, red, yellow, blue). Each can be switched off with its checkbox
// (per page, per computer).

import { useId, useState } from "react";
import { Chess } from "chess.js";

export interface HintArrow {
  from: string;
  to: string;
  kind: "db" | "engine";
  /** 0–1: a database move's share of the games (the top one 1); for an
   *  engine move 1 when strong ("!"), less when neutral. */
  weight: number;
  /** Emphasised (the move selected in a list). */
  selected?: boolean;
}

/** One engine's move for the board: "!" (strong) or unmarked (neutral) —
 *  moves marked "?" are left out. */
export interface EngineMove {
  from: string;
  to: string;
  strong: boolean;
  /** The opponent has only one or two strong replies (a count, not "5+"). */
  forcing: boolean;
}

/** The engines' moves together: each move once, with how many engines mark
 *  it strong of those that have a result, and whether any finds it forcing. */
export interface CombinedMove extends EngineMove {
  /** 0–1: the share of the engines with a result that mark it "!". */
  agree: number;
}

/** Combine the engines' moves (per engine; an engine without a result for
 *  the position is left out). */
export function combineEngineMoves(perEngine: EngineMove[][]): CombinedMove[] {
  const withResult = perEngine.filter((m) => m.length > 0);
  const byMove = new Map<string, { m: EngineMove; strong: number; forcing: boolean }>();
  for (const moves of withResult) {
    for (const m of moves) {
      const k = m.from + m.to;
      const e = byMove.get(k) ?? { m, strong: 0, forcing: false };
      if (m.strong) e.strong += 1;
      if (m.forcing) e.forcing = true;
      byMove.set(k, e);
    }
  }
  return [...byMove.values()].map(({ m, strong, forcing }) => ({
    from: m.from, to: m.to, strong: strong > 0, forcing, agree: withResult.length ? strong / withResult.length : 0,
  }));
}

/** A forcing move has at most this many strong replies. */
export const FORCING_REPLIES = 2;

export const HINT_ARROWS = 3;

/** The database's top moves (SAN with game counts) in `fen` as arrows. */
export function dbArrows(fen: string, moves: { mv: string; games: number }[], selectedSan?: string | null): HintArrow[] {
  const top = [...moves].sort((a, b) => b.games - a.games).slice(0, HINT_ARROWS);
  const most = top[0]?.games ?? 0;
  if (!most) return [];
  let verbose: { san: string; from: string; to: string }[] = [];
  try { verbose = new Chess(fen).moves({ verbose: true }); } catch { return []; }
  const out: HintArrow[] = [];
  for (const m of top) {
    const v = verbose.find((x) => x.san === m.mv);
    if (v) out.push({ from: v.from, to: v.to, kind: "db", weight: m.games / most, selected: m.mv === selectedSan });
  }
  return out;
}

/** The squares of the forcing moves (any engine's, strong or neutral). */
export function forcingRings(moves: CombinedMove[]): { from: string; to: string }[] {
  return moves.filter((m) => m.forcing).map((m) => ({ from: m.from, to: m.to }));
}

/** Every strong move as an arrow — stronger the more engines agree. */
export function engineArrows(moves: CombinedMove[]): HintArrow[] {
  return moves.filter((m) => m.strong).map((m) => ({ from: m.from, to: m.to, kind: "engine", weight: m.agree }));
}

const COLOR = { db: "245, 158, 11", engine: "124, 58, 237", forcing: "219, 39, 119" };

/** The arrows over a board of `size` pixels. `faint`: the game has arrows of
 *  its own, which keep the stage. */
export function HintArrowsOverlay({ arrows, rings = [], flipped, size, faint }: {
  arrows: HintArrow[];
  /** Forcing moves: a ring on the destination, a dot on the source. */
  rings?: { from: string; to: string }[];
  flipped: boolean;
  size: number;
  faint?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  if (arrows.length === 0 && rings.length === 0) return null;
  const sq = size / 8;
  const center = (s: string) => {
    const col = s.charCodeAt(0) - 97;
    const row = parseInt(s[1], 10) - 1;
    return { x: (flipped ? 7 - col : col) * sq + sq / 2, y: (flipped ? row : 7 - row) * sq + sq / 2 };
  };
  const anySelected = arrows.some((a) => a.selected);
  // The database's arrows first; the engine's over them — where both have the
  // same move, the engine's thinner arrow shows as a violet core in the orange.
  const both = new Set(arrows.filter((a) => a.kind === "db").map((a) => a.from + a.to));
  const ordered = [...arrows].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "db" ? -1 : 1));
  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 15 }}>
      {ordered.map((a, i) => {
        const from = center(a.from);
        const to = center(a.to);
        const dx = to.x - from.x, dy = to.y - from.y;
        const dist = Math.hypot(dx, dy) || 1;
        const core = a.kind === "engine" && both.has(a.from + a.to);
        const w = sq * (a.kind === "db" ? 0.1 + 0.08 * a.weight : 0.1 + 0.04 * a.weight) * (core ? 0.5 : 1);
        const head = Math.max(w * 2.6, sq * 0.22);
        let opacity = a.kind === "db" ? 0.35 + 0.35 * a.weight : 0.45 + 0.4 * a.weight;
        if (anySelected) opacity = a.selected ? 0.95 : opacity * 0.5;
        if (faint) opacity *= 0.5;
        // Start a little off the source's centre; end where the head's tip
        // reaches the destination's centre.
        const sx = from.x + (dx / dist) * sq * 0.2, sy = from.y + (dy / dist) * sq * 0.2;
        const ex = to.x - (dx / dist) * head * 0.8, ey = to.y - (dy / dist) * head * 0.8;
        const color = `rgb(${COLOR[a.kind]})`;
        const id = `hint-${uid}-${i}`;
        return (
          <g key={`${a.kind}-${a.from}${a.to}`} opacity={opacity}>
            <defs>
              <marker id={id} markerWidth={head} markerHeight={head} refX={head * 0.2} refY={head / 2} orient="auto" markerUnits="userSpaceOnUse">
                <polygon points={`0,0 ${head},${head / 2} 0,${head}`} fill={color} />
              </marker>
            </defs>
            <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={color} strokeWidth={w} strokeLinecap="round" markerEnd={`url(#${id})`} />
          </g>
        );
      })}
      {rings.map((r) => {
        const to = center(r.to);
        const from = center(r.from);
        return (
          <g key={`ring-${r.from}${r.to}`} opacity={faint ? 0.45 : 0.9}>
            <circle cx={to.x} cy={to.y} r={sq * 0.42} fill="none" stroke={`rgb(${COLOR.forcing})`} strokeWidth={sq * 0.07} strokeDasharray={`${sq * 0.16} ${sq * 0.09}`} />
            <circle cx={from.x} cy={from.y} r={sq * 0.09} fill={`rgb(${COLOR.forcing})`} />
          </g>
        );
      })}
    </svg>
  );
}

/** Which arrows a page shows, remembered per computer. */
export function useArrowToggles(page: "games" | "analysis") {
  const key = `boardArrows:${page}`;
  const fallback = page === "games" ? { db: true, engine: true, forcing: true } : { db: false, engine: true, forcing: true };
  const [on, setOn] = useState<{ db: boolean; engine: boolean; forcing: boolean }>(() => {
    try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? "{}") }; } catch { return fallback; }
  });
  const set = (k: "db" | "engine" | "forcing", v: boolean) => {
    setOn((o) => {
      const next = { ...o, [k]: v };
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* per-computer convenience only */ }
      return next;
    });
  };
  return { on, set };
}

/** The two checkboxes: the database's arrows, the engine's. */
export function ArrowToggles({ on, set }: ReturnType<typeof useArrowToggles>) {
  const box = (k: "db" | "engine" | "forcing", label: string, color: string, title: string) => (
    <label className="inline-flex items-center gap-1 cursor-pointer select-none" title={title}>
      <input type="checkbox" checked={on[k]} onChange={(e) => set(k, e.target.checked)} className="accent-primary" />
      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: `rgb(${color})` }} />
      {label}
    </label>
  );
  return (
    <span className="inline-flex items-center gap-3 text-label-sm text-on-surface-variant">
      {box("db", "Database", COLOR.db, "Arrows for the three moves played most often from here")}
      {box("engine", "Engine", COLOR.engine, "Arrows for the strong moves (marked !) of every engine with a result for the position — stronger the more engines agree")}
      {box("forcing", "Forcing", COLOR.forcing, "A ring on the square of an engine move that leaves the opponent only one or two strong replies (the Strong column), a dot on the piece that moves")}
    </span>
  );
}
