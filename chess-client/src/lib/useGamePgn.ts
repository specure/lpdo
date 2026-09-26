import { useEffect, useState } from "react";
import { Chess } from "chess.js";
import { parsePgnTree } from "./parsePgnTree";
import { parseBlockTags } from "./pgnEditor";

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
  /** The PGN has movetext, but none of it could be read as moves — shown as
   *  such, not as a game without moves (#286). */
  unreadable?: boolean;
  /** The PGN as the server holds it — the previews offer it for copying.
   *  Not persisted anywhere: the Analysis tabs store only ids and cursors. */
  pgn: string | null;
  /** Where the game can be watched online, from the PGN's own tags — Lichess
   *  broadcasts write GameURL, and Site is a URL for online games. null when
   *  the game names no address (most OTB games from TWIC and Megabase). */
  gameUrl: string | null;
}

/** The game's own web address, from the first PGN tag that holds one. Tags
 *  are free text, so anything that isn't an http(s) address is ignored — Site
 *  is often a town ("Venice") or a service name ("chess.com INT"). */
export function gameUrlFromPgn(pgn: string | null): string | null {
  if (!pgn) return null;
  const { tags } = parseBlockTags(pgn);
  for (const name of ["GameURL", "GameUrl", "Link", "BroadcastURL", "Site"]) {
    const value = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())?.value?.trim();
    if (value && /^https?:\/\/\S+$/i.test(value)) return value;
  }
  return null;
}

/** Whether a PGN has any movetext beyond its headers, comments and result. */
function hasMovetext(pgn: string): boolean {
  const body = pgn
    .replace(/^\s*\[[^\]]*\]\s*$/gm, "") // header lines
    .replace(/\{[^}]*\}/g, "") // comments
    .replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/, ""); // result
  return /\S/.test(body);
}

/** Positions and main-line moves of a PGN, for the flat playback model.
 *
 *  Parsed with the same tolerant parser as Analysis (`GameBoard`), so a game can
 *  never show moves there but none in a preview. chess.js's strict `loadPgn`
 *  used to do this, and it rejects valid PGN — several comments in a row after
 *  one move, which Lichess writes on every move its engine flags as a blunder,
 *  mistake or inaccuracy — with the error swallowed into an empty game (#286). */
export function buildPlayback(pgn: string | null): Pick<LoadedGame, "fens" | "moves" | "unreadable"> {
  const text = pgn ?? "";
  try {
    const tree = parsePgnTree(text);
    const fens = [tree.startFen, ...tree.mainLine.map((n) => n.fen)];
    const moves = tree.mainLine.map((n, i): GameMove => ({ ply: i + 1, san: n.san, color: n.color }));
    return { fens, moves, unreadable: moves.length === 0 && hasMovetext(text) };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("Could not read this game's moves:", e);
    return { fens: [new Chess().fen()], moves: [], unreadable: hasMovetext(text) };
  }
}

/** Fetch + parse one DB game by id into the flat playback model. Throws on error. */
export async function loadGamePgn(gameId: number): Promise<LoadedGame> {
  const r = await fetch(`/api/games/${gameId}`);
  if (!r.ok) throw new Error(`Server error ${r.status}`);
  const d: { white: string; black: string; result: string | null; date: string | null; event: string | null; pgn: string | null } = await r.json();
  return {
    id: gameId, white: d.white, black: d.black, result: d.result, date: d.date, event: d.event,
    pgn: d.pgn,
    gameUrl: gameUrlFromPgn(d.pgn),
    ...buildPlayback(d.pgn),
  };
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
