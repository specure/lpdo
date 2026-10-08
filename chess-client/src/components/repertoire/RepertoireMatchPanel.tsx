// The Repertoire tab on a game in Analysis: the chapters of one's books the
// game went into — those of one colour, as a repertoire is White's or
// Black's. The colour is one's own in the game when one played it (the
// player set on the Home page), else the one picked last. A click opens the
// chapter on the Repertoire page, where the game left it.

import { useCallback, useEffect, useState } from "react";
import { matchLine, type BookColor, type LineMatch } from "../../lib/repertoire";
import { currentMyPlayer } from "../MyStatsWidget";

interface Props {
  /** The game's moves (its main line), SAN. */
  moves: string[];
  match: RepertoireMatch;
  onOpen: (m: LineMatch) => void;
}

export interface RepertoireMatch {
  color: BookColor;
  pick: (c: BookColor) => void;
  /** null: being looked up. */
  matches: LineMatch[] | null;
  error: string | null;
}

const COLOR_KEY = "analysisRepertoireColor";

/** "5...Nxd5": the move that brought the line to `ply` half-moves. */
const moveAt = (moves: string[], ply: number) =>
  `${Math.floor((ply - 1) / 2) + 1}${(ply - 1) % 2 ? "..." : "."}${moves[ply - 1] ?? ""}`;

/** The chapters a game went into, in the books of the colour picked — kept
 *  by the Analysis page, so the tab can say how many while it is not shown. */
export function useRepertoireMatch(moves: string[], white: string, black: string, on: boolean): RepertoireMatch {
  const [color, setColor] = useState<BookColor>(() => (localStorage.getItem(COLOR_KEY) === "black" ? "black" : "white"));
  const [matches, setMatches] = useState<LineMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One's own colour when one played the game.
  useEffect(() => {
    if (!on) return;
    let gone = false;
    void currentMyPlayer().then((me) => {
      if (gone || !me) return;
      if (me.name === white) setColor("white");
      else if (me.name === black) setColor("black");
    }).catch(() => {});
    return () => { gone = true; };
  }, [white, black, on]);

  const line = moves.join(" ");
  useEffect(() => {
    if (!on) return;
    let gone = false;
    setMatches(null);
    setError(null);
    matchLine(line ? line.split(" ") : [], color)
      .then((m) => { if (!gone) setMatches(m); })
      .catch((e) => { if (!gone) setError(String(e)); });
    return () => { gone = true; };
  }, [line, color, on]);

  const pick = useCallback((c: BookColor) => {
    setColor(c);
    try { localStorage.setItem(COLOR_KEY, c); } catch { /* not kept */ }
  }, []);
  return { color, pick, matches, error };
}

/** "1 book · 2 chapters" — what the tab's "1/2" says. */
export function matchCount(matches: LineMatch[]): { books: number; chapters: number } {
  return { books: new Set(matches.map((m) => m.book_id)).size, chapters: matches.length };
}

export default function RepertoireMatchPanel({ moves, match: { color, pick, matches, error }, onOpen }: Props) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-1 shrink-0 flex items-center gap-2 text-label-sm text-on-surface-variant border-b border-outline/40">
        <span>Repertoire as</span>
        <div className="inline-flex rounded-full border border-outline/40 overflow-hidden">
          {(["white", "black"] as BookColor[]).map((c) => (
            <button key={c} onClick={() => pick(c)}
              className={`h-6 px-3 text-label-md transition-colors duration-short3 ease-standard ${
                color === c ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-on-surface/8"
              }`}>
              {c === "white" ? "White" : "Black"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-outline">click: the chapter, where the game left it</span>
      </div>
      {error ? (
        <div className="p-3 text-center text-error text-body-sm">{error}</div>
      ) : !matches ? (
        <div className="p-3 text-center text-on-surface-variant text-body-sm">Looking in your books…</div>
      ) : matches.length === 0 ? (
        <div className="p-3 text-center text-on-surface-variant text-body-sm">
          None of your {color === "white" ? "White" : "Black"} books has this game's moves.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {matches.map((m) => (
            <button key={m.chapter_id} onClick={() => onOpen(m)}
              title={`Open “${m.chapter_name}” on the Repertoire page, where the game left it`}
              className="w-full flex flex-col px-3 py-1.5 text-left text-body-sm rounded-sm text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard">
              <span className={`truncate w-full ${m.overview ? "italic" : ""}`}>{m.chapter_name}</span>
              <span className="text-label-sm text-on-surface-variant truncate w-full">{m.book_name}</span>
              <span className="text-label-sm text-on-surface-variant truncate w-full">
                in the chapter to {moveAt(moves, m.ply)}
                {m.followed === "left" && m.move ? (
                  <> · <span className={m.left_by === "you" ? "text-error" : ""}>
                    {m.move.includes("...") ? "Black" : "White"} deviated at {m.move}
                  </span></>
                ) : m.followed === "end" ? " · the end of its line" : " · the game ended in it"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
