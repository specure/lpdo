// A scratch line: moves played on the board (or clicked in the Reference and
// Engine panels) that are NOT part of the game — like pushing pieces around on
// a physical board without writing anything down.
//
// It is kept as a normal variation in a *clone* of the game's move tree, with
// `scratch: true` on each node it adds. That way the move list, the navigation
// helpers and the serializer all work on it unchanged; the only rule is that
// the clone never reaches the server unless the user asks to keep the line.
// GameBoard holds the untouched tree aside and puts it back when the line is
// abandoned, which happens on any step back (see `discardScratch` there).

import { Chess } from "chess.js";
import type { AnnotatedGame, MoveNode } from "./parsePgnTree";
import { fenAt, resolvePathSafe, type CursorPath } from "./moveTreeNav";

/** A move to play, either as coordinates (a drag) or as SAN (a click in one of
 *  the panels). SAN may carry check/mate marks; chess.js accepts them. */
export type ScratchMove = { from: string; to: string; promotion?: string } | { san: string };

/** Play `move` at `cursor` in a copy of `game`, as a scratch node.
 *
 *  Mid-line the move becomes a new variation on the move it replaces — even
 *  when it repeats that move, so the scratch line stays visibly apart from the
 *  game. At the end of a line it extends that line. Returns null when the move
 *  is illegal or the cursor no longer resolves. */
export function appendScratchMove(
  game: AnnotatedGame,
  cursor: CursorPath,
  move: ScratchMove,
): { game: AnnotatedGame; cursor: CursorPath } | null {
  const clone = structuredClone(game);
  const resolved = resolvePathSafe(clone.mainLine, cursor.steps);
  if (!resolved) return null;
  const { line, breadcrumbs } = resolved;
  if (cursor.index > line.length) return null;

  const fen = fenAt(clone, breadcrumbs, line, cursor.index);
  const chess = new Chess(fen);
  let played;
  try {
    played = "san" in move ? chess.move(move.san) : chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  } catch {
    return null;   // chess.js throws on an illegal move
  }
  if (!played) return null;

  const node: MoveNode = {
    san: played.san,
    color: played.color,
    fen: chess.fen(),
    annotations: {},
    variations: [],
    scratch: true,
  };

  if (cursor.index < line.length) {
    const branching = line[cursor.index];
    branching.variations.push([node]);
    return {
      game: clone,
      cursor: { steps: [...cursor.steps, { node: cursor.index, varIdx: branching.variations.length - 1 }], index: 1 },
    };
  }
  line.push(node);
  return { game: clone, cursor: { steps: cursor.steps, index: cursor.index + 1 } };
}

/** True once any node in the tree is a scratch node. */
export function hasScratch(game: AnnotatedGame): boolean {
  const inLine = (line: MoveNode[]): boolean =>
    line.some((n) => n.scratch || n.variations.some(inLine));
  return inLine(game.mainLine);
}

/** Drop the `scratch` marks, keeping the moves. Used when the user keeps the
 *  line: from then on it is an ordinary variation of the game. */
export function clearScratchMarks(game: AnnotatedGame): AnnotatedGame {
  const walk = (line: MoveNode[]) => {
    for (const n of line) {
      delete n.scratch;
      n.variations.forEach(walk);
    }
  };
  const copy = structuredClone(game);
  walk(copy.mainLine);
  return copy;
}
