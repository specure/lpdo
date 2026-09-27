// Engine lines that lead to a repetition (#314). An engine can rate a move
// better than a draw while its line, played out, comes back to a position
// already on the board — the moves just shuffle, and at the repetition the
// better side has to find another, more principled way. Stockfish's such
// lines are shown apart from the principal ones, where the side to move is
// better (see repetitionSettings).

import { Chess } from "chess.js";
import type { EngineHistory } from "../api";

/** A position's identity for repetition: placement, side to move, castling
 *  and en passant — the FEN without its move counters. */
function positionKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/** The positions of the game up to `fen` (from `history` when it leads
 *  there), for a line to repeat; just `fen` without one. */
export function gamePositions(fen: string, history?: EngineHistory): string[] {
  const keys: string[] = [];
  if (history && history.sans.length > 0) {
    try {
      const c = new Chess(history.startFen);
      keys.push(positionKey(c.fen()));
      for (const san of history.sans) {
        c.move(san);
        keys.push(positionKey(c.fen()));
      }
      if (keys[keys.length - 1] === positionKey(fen)) return keys;
    } catch { /* not this game's moves: the position alone */ }
  }
  return [positionKey(fen)];
}

/** Where a line (UCI moves from `fen`) first comes back to a position it has
 *  been in, or the game had before it: the number of the move (1-based ply
 *  in the line) whose position repeats, or null when it never does. */
export function repetitionAt(fen: string, pvUci: string[], before: string[]): number | null {
  const seen = new Set(before);
  try {
    const c = new Chess(fen);
    for (let i = 0; i < pvUci.length; i++) {
      const u = pvUci[i];
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || undefined });
      const k = positionKey(c.fen());
      if (seen.has(k)) return i + 1;
      seen.add(k);
    }
  } catch { /* an illegal move ends the check */ }
  return null;
}

/** Whether Stockfish's lines that repeat are shown apart, and above how many
 *  centipawns in the best line the side to move counts as better (0: any
 *  plus). Set per computer (Maintenance → Engines → Stockfish). */
export const REPETITION_APART_KEY = "stockfishRepetitionApart";
export const REPETITION_ABOVE_KEY = "stockfishRepetitionAboveCp";

export function repetitionSettings(): { apart: boolean; aboveCp: number } {
  try {
    const cp = Number(localStorage.getItem(REPETITION_ABOVE_KEY));
    return {
      apart: localStorage.getItem(REPETITION_APART_KEY) !== "false",
      aboveCp: Number.isFinite(cp) && cp >= 0 ? cp : 0,
    };
  } catch {
    return { apart: true, aboveCp: 0 };
  }
}
