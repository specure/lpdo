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

/** The moves leading to a cursor, as SAN, from the start of the game. */
export function sansToCursor(breadcrumbs: { line: MoveNode[]; index: number }[], line: MoveNode[], index: number): string[] {
  const sans: string[] = [];
  for (const bc of breadcrumbs) sans.push(...bc.line.slice(0, bc.index).map((n) => n.san));
  sans.push(...line.slice(0, index).map((n) => n.san));
  return sans;
}

/** Put `sans` back on top of `game`, following the game's own moves as far as
 *  they agree and playing the rest as a scratch line.
 *
 *  This is what a discarded edit leaves behind: the position stays the one the
 *  user was looking at, and whatever of it the game doesn't hold is marked as
 *  a scratch line rather than silently becoming part of the game. Returns null
 *  when every move was already in the game — there is nothing to scratch, only
 *  a cursor to move. */
export function replayAsScratch(
  game: AnnotatedGame,
  sans: string[],
): { game: AnnotatedGame; cursor: CursorPath; anchor: CursorPath; scratched: boolean } | null {
  let tree = game;
  let cursor: CursorPath = { steps: [], index: 0 };
  let anchor: CursorPath | null = null;

  for (const san of sans) {
    if (!anchor) {
      // Still walking the game's own moves: take the line that continues with
      // this move — the line itself first, then any variation on it.
      const at = resolvePathSafe(tree.mainLine, cursor.steps);
      if (!at) return null;
      const next = at.line[cursor.index];
      if (next && next.san === san) { cursor = { ...cursor, index: cursor.index + 1 }; continue; }
      const varIdx = next?.variations.findIndex((v) => v[0]?.san === san) ?? -1;
      if (next && varIdx >= 0) {
        cursor = { steps: [...cursor.steps, { node: cursor.index, varIdx }], index: 1 };
        continue;
      }
      anchor = cursor;   // from here on the moves are the user's own
    }
    const played = appendScratchMove(tree, cursor, { san });
    if (!played) break;  // shouldn't happen — the moves were legal when played
    tree = played.game;
    cursor = played.cursor;
  }

  if (!anchor) return { game, cursor, anchor: cursor, scratched: false };
  return { game: tree, cursor, anchor, scratched: true };
}
