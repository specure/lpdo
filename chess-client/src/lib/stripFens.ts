// Removing FEN strings from a chapter's comments (#327): courses exported
// from other tools often leave a position's FEN in the text ("…the King's
// Indian Defense rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
// 1.d4 Nf6…"). The board shows the position; the FEN is noise.

import type { AnnotatedGame, MoveNode } from "./parsePgnTree";

/** A FEN: eight ranks, then — each optional, in order — side to move,
 *  castling, en passant square, halfmove clock and move number. */
const FEN = /(?:[pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8}(?:\s+[wb](?:\s+(?:[KQkq]{1,4}|-)(?:\s+(?:[a-h][36]|-)(?:\s+\d+(?:\s+\d+)?)?)?)?)?/g;

/** `text` without its FENs, and how many. Only the spaces around each FEN
 *  are tidied — one space left where it stood (none at either end); the
 *  rest of the text is kept exactly as written. */
export function stripFenText(text: string): { text: string; removed: number } {
  let removed = 0;
  const around = new RegExp(`[ \\t]*${FEN.source}[ \\t]*`, "g");
  const out = text.replace(around, (_m, offset: number, whole: string) => {
    removed++;
    const atStart = offset === 0;
    const atEnd = offset + _m.length === whole.length;
    return atStart || atEnd ? "" : " ";
  });
  return { text: removed ? out : text, removed };
}

/** Remove the FENs from every comment of `game` — after a move, before it
 *  (a variation's intro), and the chapter's own intro. Changes `game`;
 *  gives how many were removed. */
export function stripFens(game: AnnotatedGame): number {
  let n = 0;
  const fix = (s: string | undefined) => {
    if (!s) return s;
    const r = stripFenText(s);
    n += r.removed;
    return r.text || undefined;
  };
  game.startComment = fix(game.startComment);
  const walk = (line: MoveNode[]) => {
    for (const node of line) {
      node.annotations.comment = fix(node.annotations.comment);
      node.preComment = fix(node.preComment);
      for (const v of node.variations) walk(v);
    }
  };
  walk(game.mainLine);
  return n;
}
