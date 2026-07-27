import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { GameSummary, MoveStats, PlayerInfo } from "../types";
import PlayerPicker from "./PlayerPicker";

// DB-wide game browser + opening explorer (the Games page): like the Players
// view, but without picking a player first. Two columns: filters + explorer on
// the left, the game list on the right. Player 1 / Player 2 are
// autocomplete-to-player (indexed). Position/explorer is always on — click moves
// to walk the tree (server move-stats over ALL matching games) while the list
// filters to games reaching that position (#—).

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
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryToken = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Opening explorer (always on).
  const [moveStats, setMoveStats] = useState<MoveStats[]>([]);
  const [movesLoading, setMovesLoading] = useState(false);
  const movesAbortRef = useRef<AbortController | null>(null);

  const firstMovesStr = moveSequence.join(" ");

  function setP1C(c: ColorFilter) { setP1Color(c); setP2Color(OPPOSITE[c]); }
  function setP2C(c: ColorFilter) { setP2Color(c); setP1Color(OPPOSITE[c]); }

  useEffect(() => { const t = setTimeout(() => setEvent(eventInput), 400); return () => clearTimeout(t); }, [eventInput]);
  useEffect(() => { const t = setTimeout(() => setDateFrom(dateFromInput), 400); return () => clearTimeout(t); }, [dateFromInput]);
  useEffect(() => { const t = setTimeout(() => setDateTo(dateToInput), 400); return () => clearTimeout(t); }, [dateToInput]);

  // The board always shows the position explorer here (when no game is selected).
  useEffect(() => { onPositionModeChange(true); return () => onPositionModeChange(false); }, [onPositionModeChange]);
  useEffect(() => { onMoveStatsChange(moveStats); }, [moveStats, onMoveStatsChange]);
  useEffect(() => { onSelectedMoveChange(moveStats[0]?.mv ?? null); }, [moveStats, onSelectedMoveChange]);
  useEffect(() => { onTopGameChange(games[0] ?? null); }, [games, onTopGameChange]);

  // Build the games query at a given offset (shared by the first page + load-more).
  function buildParams(off: number): URLSearchParams {
    const primary = p1 ?? p2;
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(off) });
    if (primary) {
      params.set("player_id", String(primary.id));
      params.set("color", p1 ? p1Color : p2Color);
      if (p1 && p2) params.set("opponent_id", String(p2.id));
    }
    if (event) params.set("event", event);
    if (dateFrom) params.set("from", fromISO(dateFrom));
    if (dateTo) params.set("to", toISO(dateTo));
    // Only filter by position once a move is played — the root (start position)
    // is "all games", which is far cheaper as a plain query than a positions join.
    if (moveSequence.length > 0) params.set("fen", fenFromMoves(moveSequence));
    if (scopePublicOnly) params.set("visibility", "public");
    if (scopeCollectionId !== null) params.set("collection_id", String(scopeCollectionId));
    if (scopeIncludeDeleted) params.set("include_deleted", "true");
    return params;
  }

  // First page (reset) whenever a filter changes; further pages append on scroll.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const sig = abortRef.current.signal;
    const token = ++queryToken.current;
    setLoading(true);
    setError(null);
    setGames([]);
    setTotal(null);

    const params = buildParams(0);
    const countParams = new URLSearchParams(params);
    countParams.set("count", "true");

    Promise.all([
      fetch(`/api/games?${params}`, { signal: sig }).then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json() as Promise<GameSummary[]>; }),
      fetch(`/api/games?${countParams}`, { signal: sig }).then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json() as Promise<{ count: number }>; }),
    ])
      .then(([data, { count }]) => {
        if (token !== queryToken.current) return;
        setGames(data);
        setTotal(count);
        setLoading(false);
        scrollRef.current?.scrollTo({ top: 0 });
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (token === queryToken.current) { setError(e instanceof Error ? e.message : "Failed to load games"); setLoading(false); }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p1?.id, p1Color, p2?.id, p2Color, event, dateFrom, dateTo, firstMovesStr, scopePublicOnly, scopeCollectionId, scopeIncludeDeleted]);

  function loadMore() {
    if (loading || loadingMore || total === null || games.length >= total) return;
    const token = queryToken.current;
    setLoadingMore(true);
    fetch(`/api/games?${buildParams(games.length)}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<GameSummary[]>; })
      .then((data) => { if (token !== queryToken.current) return; setGames((prev) => [...prev, ...data]); })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore();
  }

  // Opening-explorer move stats (all games; side-to-move is intrinsic).
  useEffect(() => {
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
  }, [firstMovesStr, dateFrom, dateTo, scopePublicOnly]);

  // Move-number prefix for the explorer list, from the current ply: White to
  // move → "N. ", Black to move → "N... " (e.g. "1. e4", "1... Nf6").
  const moveNo = Math.floor(moveSequence.length / 2) + 1;
  const movePrefix = moveSequence.length % 2 === 0 ? `${moveNo}. ` : `${moveNo}... `;

  const colorBtn = (active: boolean) =>
    `text-label-md h-7 px-2.5 inline-flex items-center rounded-full transition-colors duration-short3 ease-standard ${
      active ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
    }`;
  const textInput = "h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard";

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
    <div className="flex h-full shrink-0">
      {/* Column 1: filters + opening explorer */}
      <div className="w-72 shrink-0 flex flex-col overflow-y-auto bg-surface-container-low border-r border-outline/40">
        <div className="p-3 space-y-3">
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
          <input type="text" value={eventInput} onChange={(e) => setEventInput(e.target.value)} placeholder="Event…" className={`w-full ${textInput}`} />
          <div className="flex gap-2">
            <input type="text" value={dateFromInput} onChange={(e) => setDateFromInput(e.target.value)} placeholder="From (YYYY)" className={`flex-1 min-w-0 ${textInput}`} />
            <input type="text" value={dateToInput} onChange={(e) => setDateToInput(e.target.value)} placeholder="To (YYYY)" className={`flex-1 min-w-0 ${textInput}`} />
          </div>
        </div>

        {/* Opening explorer — moves from the current position across all matching games */}
        <div className="border-t border-outline/40 flex-1 min-h-0 flex flex-col">
          <div className="px-3 pt-2 text-label-sm text-on-surface-variant uppercase tracking-wider">Moves</div>
          {movesLoading ? (
            <div className="p-3 text-center text-on-surface-variant text-body-sm">Loading…</div>
          ) : moveStats.length === 0 ? (
            <div className="p-3 text-center text-on-surface-variant text-body-sm">No moves from this position</div>
          ) : (
            <div className="p-2">
              <div className="flex items-center text-label-sm text-on-surface-variant px-2 mb-1 select-none">
                <span className="w-20">Move</span>
                <span className="w-14 text-right">Games</span>
                <span className="w-7 text-right">W%</span>
                <span className="w-7 text-right">L%</span>
                <span className="flex-1 text-right">Last</span>
              </div>
              <div className="overflow-y-auto">
                {moveStats.map((stat) => (
                  <button
                    key={stat.mv}
                    onClick={() => onMoveAppend(stat.mv)}
                    className="w-full flex items-center text-body-sm px-2 py-1 rounded-sm text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
                  >
                    <span className="w-20 font-mono truncate text-left">{movePrefix}{stat.mv}</span>
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
      </div>

      {/* Column 2: the game list */}
      <div className="w-72 shrink-0 flex flex-col overflow-hidden bg-surface-container-low border-r border-outline/40">
        <div className="px-3 py-2 shrink-0 text-label-md text-on-surface-variant border-b border-outline/40">
          {loading ? "Loading…" : total !== null ? `${total.toLocaleString()} game${total !== 1 ? "s" : ""}` : ""}
        </div>

        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
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
          {loadingMore && <div className="p-3 text-center text-on-surface-variant text-body-sm">Loading…</div>}
        </div>
      </div>
    </div>
  );
}
