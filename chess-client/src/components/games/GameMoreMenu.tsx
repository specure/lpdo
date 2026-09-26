import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { pvString } from "../CloudEngine";

// Everything else this game can do: open it on Lichess for a second opinion,
// or put it on the clipboard. One menu rather than four more buttons in the
// actions bar, which is already carrying edit, export and delete.
//
// Lichess reads both forms straight from the address:
//   https://lichess.org/analysis/<fen, spaces as underscores>
//   https://lichess.org/analysis/pgn/<movetext>#<ply>
// The trailing ply is what stops Lichess landing on the final position: it is
// counted in half-moves from the start of the movetext.

interface Props {
  /** The game's PGN, for copying. null while it is still loading. */
  pgn: string | null;
  /** Position on the board right now. */
  fen: string;
  /** Moves of the line being viewed, from the start of the game. */
  lineSans: string[];
  /** Half-moves from the start to the position on screen — where Lichess
   *  should open the line. 0 puts it at the starting position. */
  ply: number;
  /** Position the line starts from — the game's start, which is not the
   *  standard one in a game set up from a diagram. */
  startFen: string;
  /** The game's own address, when its PGN names one. */
  gameUrl: string | null;
}

export function lichessPositionUrl(fen: string): string {
  return `https://lichess.org/analysis/${fen.replace(/ /g, "_")}`;
}

export function lichessGameUrl(startFen: string, sans: string[], ply = 0): string {
  const at = Math.max(0, Math.min(ply, sans.length));
  return `https://lichess.org/analysis/pgn/${encodeURIComponent(pvString(startFen, sans))}#${at}`;
}

export default function GameMoreMenu({ pgn, fen, lineSans, ply, startFen, gameUrl }: Props) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 1500);
    return () => window.clearTimeout(t);
  }, [note]);

  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => setNote(`${what} copied`))
      .catch(() => setNote(`Could not copy the ${what.toLowerCase()}`));
    setOpen(false);
  };
  const go = (url: string) => { void openUrl(url); setOpen(false); };

  const item = "w-full text-left px-3 py-1.5 text-label-md text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-40 disabled:hover:bg-transparent transition-colors duration-short3 ease-standard whitespace-nowrap";

  return (
    <div className="relative inline-flex items-center" ref={boxRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`h-7 px-3 inline-flex items-center rounded-full text-label-md transition-colors duration-short3 ease-standard ${
          open ? "bg-on-surface/12 text-on-surface" : "text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12"
        }`}
        title="Open this game or position elsewhere, or copy it"
      >
        More ▾
      </button>
      {note && <span className="ml-2 text-label-sm text-on-surface-variant">{note}</span>}
      {open && (
        <div className="absolute left-0 top-8 z-30 py-1 rounded-md bg-surface-container-high shadow-xl min-w-56">
          {gameUrl && (
            <button className={item} onClick={() => go(gameUrl)}>
              Open where it was played ↗
            </button>
          )}
          <button className={item} onClick={() => go(lichessGameUrl(startFen, lineSans, ply))} disabled={lineSans.length === 0}>
            Analyse this line on Lichess ↗
          </button>
          <button className={item} onClick={() => go(lichessPositionUrl(fen))}>
            Analyse this position on Lichess ↗
          </button>
          <div className="my-1 h-px bg-outline-variant" />
          <button className={item} onClick={() => copy(pgn ?? "", "PGN")} disabled={!pgn}>
            Copy the game's PGN
          </button>
          <button className={item} onClick={() => copy(fen, "FEN")}>
            Copy this position's FEN
          </button>
        </div>
      )}
    </div>
  );
}
