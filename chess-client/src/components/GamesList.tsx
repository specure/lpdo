import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { GameSummary, MoveStats, PlayerInfo } from "../types";
import PlayerPicker from "./PlayerPicker";

// DB-wide game browser (the Games page): like the Players game list, but without
// having to pick a player first. Player 1 / Player 2 are autocomplete-to-player
// (indexed, precise); with no filters it shows all games, paginated by date.
// A "Position" mode turns it into a DB-wide opening explorer: click moves to walk
// the tree (server move-stats over ALL games) while the list filters to games
// reaching that position (#—).

type ColorFilter = "any" | "white" | "black";
const PAGE = 100;
const OPPOSITE: Record<ColorFilter, ColorFilter> = { any: "any", white: "black", black: "white" };

const fromISO = (y: string) => (/^\d{4}$/.test(y) ? `${y}-01-01` : y);
const toISO = (y: string) => (/^\d{4}$/.test(y) ? `${y}-12-31` : y);

/** FEN after playing a SAN move sequence (empty = starting position). */
function fenFromMoves(moves: string[]): string {
  const chess = new Chess();
  for (const mv of moves) {
    try { chess.move(mv); } catch { break; }
  }
  return chess.fen();
}

interface Props {
  selectedId: number | null;
  onSelect: (game: GameSummary) => void;
  scopePublicOnly: boolean;
  scopeCollectionId: number | null;
  scopeIncludeDeleted: boolean;
  // Position/explorer wiring (shared with App's board, like GameList).
  moveSequence: string[];
  onMoveAppend: (mv: string) => void;
  onPositionModeChange: (active: boolean) => void;
  onMoveStatsChange: (stats: MoveStats[]) => void;
  onSelectedMoveChange: (san: string | null) => void;
  onTopGameChange: (game: GameSummary | null) => void;
}

export default function GamesList({
  selectedId,
  onSelect,
  scopePublicOnly,
  scopeCollectionId,
  scopeIncludeDeleted,
  moveSequence,
  onMoveAppend,
  onPositionModeChange,
  onMoveStatsChange,
  onSelectedMoveChange,
  onTopGameChange,
}: Props) {
  const [p1, setP1] = useState<PlayerInfo | null>(null);
  const [p1Color, setP1Color] = useState<ColorFilter>("any");
  const [p2, setP2] = useState<PlayerInfo | null>(null);
  const [p2Color, setP2Color] = useState<ColorFilter>("any");

  const [eventInput, setEventInput] = useState("");
  const [dateFromInput, setDateFromInput] = useState("");
  const [dateToInput, setDateToInput] = useState("");
  const [event, setEvent] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [games, setGames] = useState<GameSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Position (opening-explorer) mode.
  const [positionOpen, setPositionOpen] = useState(false);
  const [moveStats, setMoveStats] = useState<MoveStats[]>([]);
  const [movesLoading, setMovesLoading] = useState(false);
  const movesAbortRef = useRef<AbortController | null>(null);

  const firstMovesStr = moveSequence.join(" ");

  function setP1C(c: ColorFilter) { setP1Color(c); setP2Color(OPPOSITE[c]); }
  function setP2C(c: ColorFilter) { setP2Color(c); setP1Color(OPPOSITE[c]); }

  useEffect(() => { const t = setTimeout(() => setEvent(eventInput), 400); return () => clearTimeout(t); }, [eventInput]);
  useEffect(() => { const t = setTimeout(() => setDateFrom(dateFromInput), 400); return () => clearTimeout(t); }, [dateFromInput]);
  useEffect(() => { const t = setTimeout(() => setDateTo(dateToInput), 400); return () => clearTimeout(t); }, [dateToInput]);

  // Tell App whether the board should show the position explorer.
  useEffect(() => { onPositionModeChange(positionOpen); }, [positionOpen, onPositionModeChange]);
  // Feed the board the current stats + its top move (for the arrow).
  useEffect(() => { onMoveStatsChange(moveStats); }, [moveStats, onMoveStatsChange]);
  useEffect(() => { onSelectedMoveChange(moveStats[0]?.mv ?? null); }, [moveStats, onSelectedMoveChange]);
  // Report the top game so the board's "switch to game" has a target.
  useEffect(() => { onTopGameChange(games[0] ?? null); }, [games, onTopGameChange]);

  // Reset to page 1 on any filter change.
  useEffect(() => { setOffset(0); }, [p1?.id, p1Color, p2?.id, event, dateFrom, dateTo, positionOpen, firstMovesStr, scopePublicOnly, scopeCollectionId, scopeIncludeDeleted]);

  // Game list.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const sig = abortRef.current.signal;
    setLoading(true);
    setError(null);

    const primary = p1 ?? p2;
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (primary) {
      params.set("player_id", String(primary.id));
      params.set("color", p1 ? p1Color : p2Color);
      if (p1 && p2) params.set("opponent_id", String(p2.id));
    }
    if (event) params.set("event", event);
    if (dateFrom) params.set("from", fromISO(dateFrom));
    if (dateTo) params.set("to", toISO(dateTo));
    if (positionOpen) params.set("fen", fenFromMoves(moveSequence));
    if (scopePublicOnly) params.set("visibility", "public");
    if (scopeCollectionId !== null) params.set("collection_id", String(scopeCollectionId));
    if (scopeIncludeDeleted) params.set("include_deleted", "true");

    const countParams = new URLSearchParams(params);
    countParams.set("count", "true");

    Promise.all([
      fetch(`/api/games?${params}`, { signal: sig }).then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json() as Promise<GameSummary[]>; }),
      fetch(`/api/games?${countParams}`, { signal: sig }).then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json() as Promise<{ count: number }>; }),
    ])
      .then(([data, { count }]) => { setGames(data); setTotal(count); setLoading(false); })
      .catch((e) => { if (e instanceof DOMException && e.name === "AbortError") return; setError(e instanceof Error ? e.message : "Failed to load games"); setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p1?.id, p1Color, p2?.id, p2Color, event, dateFrom, dateTo, offset, positionOpen, firstMovesStr, scopePublicOnly, scopeCollectionId, scopeIncludeDeleted]);

  // Opening-explorer move stats (all games; side-to-move is intrinsic).
  useEffect(() => {
    if (!positionOpen) return;
    movesAbortRef.current?.abort();
    movesAbortRef.current = new AbortController();
    setMovesLoading(true);

    const params = new URLSearchParams();
    if (firstMovesStr) params.set("first_moves", firstMovesStr);
    if (dateFrom) params.set("from", fromISO(dateFrom));
    if (dateTo) params.set("to", toISO(dateTo));
    if (scopePublicOnly) params.set("visibility", "public");

    fetch(`/api/position/moves?${params}`, { signal: movesAbortRef.current.signal })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<MoveStats[]>; })
      .then((data) => { setMoveStats(data); setMovesLoading(false); })
      .catch((e) => { if (e instanceof DOMException && e.name === "AbortError") return; setMoveStats([]); setMovesLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionOpen, firstMovesStr, dateFrom, dateTo, scopePublicOnly]);

  const pageStart = total ? offset + 1 : 0;
  const pageEnd = offset + games.length;

  const colorBtn = (active: boolean) =>
    `text-label-md h-7 px-2.5 inline-flex items-center rounded-full transition-colors duration-short3 ease-standard ${
      active ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
    }`;
  const textInput = "h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard";
  const chipClass = (active: boolean) =>
    `inline-flex items-center h-7 px-3 rounded-full text-label-md transition-colors duration-short3 ease-standard ${
      active ? "bg-secondary-container text-on-secondary-container" : "border border-outline text-on-surface hover:bg-on-surface/8"
    }`;

  function colorRow(color: ColorFilter, set: (c: ColorFilter) => void) {
    return (
      <div className="flex gap-0.5">
        {(["any", "white", "black"] as ColorFilter[]).map((c) => (
          <button key={c} onClick={() => set(c)} className={colorBtn(color === c)}>
            {c === "any" ? "Any" : c === "white" ? "W" : "B"}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface-container-low">
      {/* Filters */}
      <div className="p-3 shrink-0 space-y-3 border-b border-outline/40">
        <div>
          <div className="text-label-md text-on-surface-variant mb-1.5 flex items-center justify-between">
            <span>Player 1</span> {colorRow(p1Color, setP1C)}
          </div>
          <PlayerPicker label="" value={p1} onPick={setP1} excludeId={p2?.id} />
        </div>
        <div>
          <div className="text-label-md text-on-surface-variant mb-1.5 flex items-center justify-between">
            <span>Player 2</span> {colorRow(p2Color, setP2C)}
          </div>
          <PlayerPicker label="" value={p2} onPick={setP2} excludeId={p1?.id} />
        </div>
        <div className="flex gap-2">
          <input type="text" value={eventInput} onChange={(e) => setEventInput(e.target.value)} placeholder="Event…" className={`flex-1 min-w-0 ${textInput}`} />
        </div>
        <div className="flex gap-2">
          <input type="text" value={dateFromInput} onChange={(e) => setDateFromInput(e.target.value)} placeholder="From (YYYY)" className={`flex-1 min-w-0 ${textInput}`} />
          <input type="text" value={dateToInput} onChange={(e) => setDateToInput(e.target.value)} placeholder="To (YYYY)" className={`flex-1 min-w-0 ${textInput}`} />
        </div>
        <button onClick={() => setPositionOpen((o) => !o)} className={chipClass(positionOpen)}>
          {positionOpen ? "Position ✓" : "Position…"}
        </button>
      </div>

      {/* Opening explorer (moves from the current position, over all matching games) */}
      {positionOpen && (
        <div className="bg-surface-container shrink-0 border-b border-outline/40">
          {movesLoading ? (
            <div className="p-3 text-center text-on-surface-variant text-body-sm">Loading…</div>
          ) : moveStats.length === 0 ? (
            <div className="p-3 text-center text-on-surface-variant text-body-sm">No moves from this position</div>
          ) : (
            <div className="p-3">
              <div className="flex items-center text-label-sm text-on-surface-variant px-2 mb-1 select-none">
                <span className="w-10">Move</span>
                <span className="w-14 text-right">Games</span>
                <span className="w-7 text-right">W%</span>
                <span className="w-7 text-right">L%</span>
                <span className="flex-1 text-right">Last</span>
              </div>
              <div className="max-h-52 overflow-y-auto">
                {moveStats.map((stat) => (
                  <button
                    key={stat.mv}
                    onClick={() => onMoveAppend(stat.mv)}
                    className="w-full flex items-center text-body-sm px-2 py-1 rounded-sm text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
                  >
                    <span className="w-10 font-mono">{stat.mv}</span>
                    <span className="w-14 text-right">{stat.games.toLocaleString()}</span>
                    <span className="w-7 text-right text-success">{Math.round(stat.w_pct)}</span>
                    <span className="w-7 text-right text-error">{Math.round(stat.l_pct)}</span>
                    <span className="flex-1 text-right text-on-surface-variant">{stat.last_played?.slice(0, 4) ?? "—"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Count + pagination */}
      <div className="px-3 py-2 shrink-0 flex items-center justify-between text-label-md text-on-surface-variant">
        <span>{loading ? "Loading…" : total !== null ? `${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${total.toLocaleString()}` : ""}</span>
        <div className="flex gap-1">
          <button onClick={() => setOffset((o) => Math.max(0, o - PAGE))} disabled={offset === 0 || loading} className="h-7 px-2 rounded-full border border-outline text-on-surface disabled:opacity-30 hover:bg-on-surface/8">‹ Prev</button>
          <button onClick={() => setOffset((o) => o + PAGE)} disabled={loading || total === null || pageEnd >= total} className="h-7 px-2 rounded-full border border-outline text-on-surface disabled:opacity-30 hover:bg-on-surface/8">Next ›</button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {error && <div className="p-4 text-center text-error text-body-md">{error}</div>}
        {!error && !loading && games.length === 0 && (
          <div className="p-4 text-center text-on-surface-variant text-body-md">No games found</div>
        )}
        {games.map((game) => {
          const selected = selectedId === game.id;
          const subText = selected ? "text-on-secondary-container/80" : "text-on-surface-variant";
          return (
            <button
              key={game.id}
              onClick={() => onSelect(game)}
              className={`w-full text-left px-4 py-3 transition-colors duration-short3 ease-standard ${
                selected ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
              }`}
            >
              <div className="text-body-md truncate flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full shrink-0 ${selected ? "bg-on-secondary-container" : "bg-on-surface"}`} />
                <span className="truncate">{game.white}</span>
                {game.white_elo && <span className={`text-body-sm shrink-0 ${subText}`}>({game.white_elo})</span>}
              </div>
              <div className="text-body-md truncate flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full bg-transparent shrink-0 border ${selected ? "border-on-secondary-container" : "border-on-surface-variant"}`} />
                <span className="truncate">{game.black}</span>
                {game.black_elo && <span className={`text-body-sm shrink-0 ${subText}`}>({game.black_elo})</span>}
              </div>
              <div className={`text-body-sm mt-0.5 flex gap-2 truncate ${subText}`}>
                {game.result && <span className={selected ? "" : "text-on-surface"}>{game.result === "1/2-1/2" ? "½-½" : game.result}</span>}
                {game.date && <span>{game.date.slice(0, 10)}</span>}
                {game.event && <span className="truncate">{game.event}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
