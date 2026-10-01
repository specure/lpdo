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
}

function moveLabel(node: MoveNode): string {
  const n = getMoveNum(node);
  return node.color === "w" ? `${n}.${node.san}` : `${n}…${node.san}`;
}

/** The lines of a chapter, in the order they are read: a line, then the
 *  variations that branch off it, each with its own variations. */
export function chapterLines(game: AnnotatedGame): ChapterLine[] {
  const out: ChapterLine[] = [];
  function walk(line: MoveNode[], steps: PathStep[], inheritedOff: boolean, depth: number, name: string) {
    const real = line.filter((n) => n.san);
    if (real.length === 0) return;
    // The line itself, first; its off state is that of its last move.
    let off = inheritedOff;
    for (const n of line) if (n.annotations.off) off = true;
    // The main line is read from the start; a variation from its first move.
    out.push({ steps, line, name, branchIndex: depth === 0 ? 0 : 1, length: real.length, off, depth });
    // Then its variations, in move order, each inheriting the off state as it
    // was before the move they replace.
    let offBefore = inheritedOff;
    line.forEach((node, i) => {
      node.variations.forEach((v, varIdx) => {
        const first = v.find((n) => n.san);
        if (!first) return;
        walk(v, [...steps, { node: i, varIdx }], offBefore, depth + 1, moveLabel(first));
      });
      if (node.annotations.off) offBefore = true;
    });
  }
  walk(game.mainLine, [], false, 0, "Main line");
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
