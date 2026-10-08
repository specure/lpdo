// A chapter's lines (#327): every path from the start to a leaf of its move
// tree — the main line and each variation to its end — named, as Chessable
// names them, by the move where the line branches off. A line is off when
// a move on its path carries the off-switch (`[%rep off]`), which also
// covers everything below that move.

import { AnnotatedGame, MoveNode } from "./parsePgnTree";
import { PathStep, getMoveNum } from "./moveTreeNav";

export interface ChapterLine {
  /** The descent to the line's own array of moves. */
  steps: PathStep[];
  line: MoveNode[];
  /** "Main line", or the branching move: "6…Nbd7". */
  name: string;
  /** The move's own index in `line` where it branches (1-based; 1 for a
   *  variation's first move), for putting the cursor on it. */
  branchIndex: number;
  /** Number of the line's own moves, on top of the moves before its branch. */
  length: number;
  off: boolean;
  /** How deep the line is nested (0: the main line). */
  depth: number;
  /** The moves before the line's own: those it shares with the line it
   *  branches off (and that one's), from move 1 — the whole line is
   *  `before` then `line` — and where each of them is, for the cursor. */
  before: MoveNode[];
  beforeAt: { steps: PathStep[]; index: number }[];
}

function moveLabel(node: MoveNode): string {
  const n = getMoveNum(node);
  return node.color === "w" ? `${n}.${node.san}` : `${n}…${node.san}`;
}

/** The lines of a chapter, in the order they are read: a line, then the
 *  variations that branch off it, each with its own variations. */
export function chapterLines(game: AnnotatedGame): ChapterLine[] {
  const out: ChapterLine[] = [];
  function walk(line: MoveNode[], steps: PathStep[], inheritedOff: boolean, depth: number, name: string, before: MoveNode[], beforeAt: { steps: PathStep[]; index: number }[]) {
    const real = line.filter((n) => n.san);
    if (real.length === 0) return;
    // The line itself, first; its off state is that of its last move.
    let off = inheritedOff;
    for (const n of line) if (n.annotations.off) off = true;
    // The main line is read from the start; a variation from its first move.
    out.push({ steps, line, name, branchIndex: depth === 0 ? 0 : 1, length: real.length, off, depth, before, beforeAt });
    // Then its variations, in move order, each inheriting the off state as it
    // was before the move they replace.
    let offBefore = inheritedOff;
    line.forEach((node, i) => {
      node.variations.forEach((v, varIdx) => {
        const first = v.find((n) => n.san);
        if (!first) return;
        // A variation replaces the move at `i`: the moves before it are shared.
        const shared = line.slice(0, i).map((n, k) => ({ n, at: { steps, index: k + 1 } })).filter((x) => x.n.san);
        walk(v, [...steps, { node: i, varIdx }], offBefore, depth + 1, moveLabel(first),
          [...before, ...shared.map((x) => x.n)], [...beforeAt, ...shared.map((x) => x.at)]);
      });
      if (node.annotations.off) offBefore = true;
    });
  }
  walk(game.mainLine, [], false, 0, "Main line", [], []);
  return out;
}

/** Whether the move at `index` (1-based) of `line`, reached by `steps`, is
 *  off — itself or through a move above it. */
export function isOffAt(game: AnnotatedGame, steps: PathStep[], line: MoveNode[], index: number): boolean {
  // The moves before each branch, on the main line and the lines descended.
  let cur = game.mainLine;
  for (const s of steps) {
    for (let i = 0; i < s.node; i++) if (cur[i]?.annotations.off) return true;
    const child = cur[s.node]?.variations[s.varIdx];
    if (!child) return false;
    cur = child;
  }
  for (let i = 0; i < index && i < line.length; i++) if (line[i].annotations.off) return true;
  return false;
}

/** Where in the chapter's tree a position is — the cursor to put the board
 *  on it — found by its key (`keyOf` a node's FEN); the main line first, then
 *  the variations in reading order. The start position: index 0. */
export function cursorAtPosition(game: AnnotatedGame, key: string, keyOf: (fen: string) => string): { steps: PathStep[]; index: number } | null {
  if (keyOf(game.startFen) === key) return { steps: [], index: 0 };
  function find(line: MoveNode[], steps: PathStep[]): { steps: PathStep[]; index: number } | null {
    for (let i = 0; i < line.length; i++) if (line[i].san && keyOf(line[i].fen) === key) return { steps, index: i + 1 };
    for (let i = 0; i < line.length; i++) {
      for (let v = 0; v < line[i].variations.length; v++) {
        const hit = find(line[i].variations[v], [...steps, { node: i, varIdx: v }]);
        if (hit) return hit;
      }
    }
    return null;
  }
  return find(game.mainLine, []);
}

/** The cursor after the first `ply` moves of `sans` (SAN, from the start),
 *  followed through the game's main line and variations; null when the tree
 *  does not have them all. */
export function cursorAlong(game: AnnotatedGame, sans: string[], ply: number): { steps: PathStep[]; index: number } | null {
  const bare = (san: string) => san.replace(/[+#!?]+$/, "");
  let line = game.mainLine;
  let steps: PathStep[] = [];
  let index = 0;
  for (const san of sans.slice(0, ply)) {
    const next = line[index];
    if (!next) return null;
    if (bare(next.san) === bare(san)) { index += 1; continue; }
    const v = next.variations.findIndex((l) => l[0] && bare(l[0].san) === bare(san));
    if (v < 0) return null;
    steps = [...steps, { node: index, varIdx: v }];
    line = next.variations[v];
    index = 1;
  }
  return { steps, index };
}

/** Where a game left a chapter, in the variation the game took: its moves
 *  (SAN, from the start) followed through the chapter's lines and
 *  variations, to the deepest position with the key `key`. When the game
 *  got there by another move order, the position wherever the chapter goes
 *  on from it (the main line first) — else wherever it is. */
export function cursorForGame(game: AnnotatedGame, sans: string[], key: string, keyOf: (fen: string) => string): { steps: PathStep[]; index: number } | null {
  const bare = (san: string) => san.replace(/[+#!?]+$/, "");
  let line = game.mainLine;
  let steps: PathStep[] = [];
  let index = 0;
  let found: { steps: PathStep[]; index: number } | null = keyOf(game.startFen) === key ? { steps: [], index: 0 } : null;
  for (const san of sans) {
    const next = line[index];
    if (!next) break;
    if (bare(next.san) === bare(san)) {
      index += 1;
    } else {
      const v = next.variations.findIndex((l) => l[0] && bare(l[0].san) === bare(san));
      if (v < 0) break;
      steps = [...steps, { node: index, varIdx: v }];
      line = next.variations[v];
      index = 1;
    }
    if (keyOf(line[index - 1].fen) === key) found = { steps, index };
  }
  if (found) return found;

  // Another move order: every place the position is, one the chapter goes
  // on from first.
  const all: { steps: PathStep[]; index: number; on: boolean }[] = [];
  const walk = (l: MoveNode[], at: PathStep[]) => {
    for (let i = 0; i < l.length; i++) if (l[i].san && keyOf(l[i].fen) === key) all.push({ steps: at, index: i + 1, on: i + 1 < l.length });
    for (let i = 0; i < l.length; i++) l[i].variations.forEach((v, j) => walk(v, [...at, { node: i, varIdx: j }]));
  };
  walk(game.mainLine, []);
  const hit = all.find((c) => c.on) ?? all[0];
  return hit ? { steps: hit.steps, index: hit.index } : null;
}

/** Switch off one's own second choices: wherever a move of `color` has
 *  alternatives in the chapter (11.Nxf4, and 11.gxf4?! as a variation), the
 *  first stays and the others are switched off — with everything below
 *  them. The opponent's alternatives stay: they are what to know. Changes
 *  `game`; gives how many were switched off. */
export function switchOffSidelines(game: AnnotatedGame, color: "w" | "b"): number {
  let n = 0;
  const walk = (line: MoveNode[], off: boolean) => {
    for (const node of line) {
      if (node.annotations.off) off = true;
      for (const v of node.variations) {
        const first = v.find((m) => m.san);
        if (!first) continue;
        if (node.color === color && !off && !first.annotations.off) { first.annotations.off = true; n++; }
        walk(v, off || !!first.annotations.off);
      }
    }
  };
  walk(game.mainLine, false);
  return n;
}

/** Switch every move of the chapter back on. Changes `game`; gives how many
 *  were off. */
export function switchAllOn(game: AnnotatedGame): number {
  let n = 0;
  const walk = (line: MoveNode[]) => {
    for (const node of line) {
      if (node.annotations.off) { node.annotations.off = undefined; n++; }
      for (const v of node.variations) walk(v);
    }
  };
  walk(game.mainLine);
  return n;
}
