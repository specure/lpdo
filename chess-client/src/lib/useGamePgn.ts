import { useEffect, useState } from "react";
import { Chess } from "chess.js";

// Fetch + parse a single DB game (by id) into a flat, read-only playback model
// for the Games page's mini board + compact move list (#219). Linear mainline
// only — comments and variations are dropped ("compressed").

export interface GameMove {
  ply: number; // 1-based half-move
  san: string;
  color: "w" | "b";
}

export interface LoadedGame {
  id: number;
  white: string;
  black: string;
  result: string | null;
  date: string | null;
  event: string | null;
  /** fens[0] = start; fens[i] = position after i half-moves. */
  fens: string[];
  moves: GameMove[];
}

/** Fetch + parse one DB game by id into the flat playback model. Throws on error. */
export async function loadGamePgn(gameId: number): Promise<LoadedGame> {
  const r = await fetch(`/api/games/${gameId}`);
  if (!r.ok) throw new Error(`Server error ${r.status}`);
  const d: { white: string; black: string; result: string | null; date: string | null; event: string | null; pgn: string | null } = await r.json();
  const fens: string[] = [];
  const moves: GameMove[] = [];
  const replay = new Chess();
  fens.push(replay.fen());
  try {
    const chess = new Chess();
    chess.loadPgn(d.pgn ?? "");
    chess.history({ verbose: true }).forEach((m, i) => {
      replay.move(m.san);
      fens.push(replay.fen());
      moves.push({ ply: i + 1, san: m.san, color: m.color });
    });
  } catch {
    // Unparsable movetext → show just the starting position.
  }
  return { id: gameId, white: d.white, black: d.black, result: d.result, date: d.date, event: d.event, fens, moves };
}

export function useGamePgn(gameId: number | null) {
  const [game, setGame] = useState<LoadedGame | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (gameId === null) { setGame(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadGamePgn(gameId)
      .then((g) => { if (!cancelled) { setGame(g); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [gameId]);

  return { game, loading, error };
}
