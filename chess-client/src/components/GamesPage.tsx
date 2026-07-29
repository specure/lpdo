import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Chess } from "chess.js";
import { GameSummary, MoveStats, PlayerInfo } from "../types";
import PlayerPicker from "./PlayerPicker";
import PositionBoard from "./PositionBoard";
import PositionMoves from "./PositionMoves";
import MiniBoard from "./games/MiniBoard";
import MoveList from "./games/MoveList";
import { useGamePgn } from "../lib/useGamePgn";

// The Games page: a DB-wide analysis layout with every panel visible at once
// (#219). Six areas — A main position board, B opening-explorer moves, C engine
// (placeholder), D game list, E mini board of the selected game, F its compact
// move list — plus a collapsible filter rail. Read-only: editing lives on the
// future Analysis page (#220). The explorer (A+B) and the selected game (E+F)
// are independent contexts.

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
  scopePublicOnly: boolean;
  scopeCollectionId: number | null;
  scopeIncludeDeleted: boolean;
}

export default function GamesPage({ scopePublicOnly, scopeCollectionId, scopeIncludeDeleted }: Props) {
  // ── Filters ───────────────────────────────────────────────────────────────
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
  const [filtersCollapsed, setFiltersCollapsed] = useState(true);

  // ── Game list (infinite scroll) ─────────────────────────────────────────────
  const [games, setGames] = useState<GameSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryToken = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Opening explorer (A + B), always on ─────────────────────────────────────
  // Cursor model: `line` is the full explored line, `ply` the current depth. The
  // active sequence (board position, filters, move-stats) is line[0..ply]. Back/
  // forward just move the cursor; clicking a new move from B branches from here.
  const [line, setLine] = useState<string[]>([]);
  const [ply, setPly] = useState(0);
  const moveSequence = line.slice(0, ply);
  function appendMove(mv: string) {
    setLine((prev) => (prev[ply] === mv ? prev : [...prev.slice(0, ply), mv]));
    setPly((p) => p + 1);
  }
  const [moveStats, setMoveStats] = useState<MoveStats[]>([]);
  const [movesLoading, setMovesLoading] = useState(false);
  const movesAbortRef = useRef<AbortController | null>(null);

  // ── Selected game (E + F), independent of the explorer ──────────────────────
  const [selectedGame, setSelectedGame] = useState<GameSummary | null>(null);
  const [selectedPly, setSelectedPly] = useState(0);
  const { game: loadedGame, loading: gameLoading } = useGamePgn(selectedGame?.id ?? null);
  useEffect(() => { setSelectedPly(0); }, [selectedGame?.id]);

  const firstMovesStr = moveSequence.join(" ");

  function setP1C(c: ColorFilter) { setP1Color(c); setP2Color(OPPOSITE[c]); }
  function setP2C(c: ColorFilter) { setP2Color(c); setP1Color(OPPOSITE[c]); }

  useEffect(() => { const t = setTimeout(() => setEvent(eventInput), 400); return () => clearTimeout(t); }, [eventInput]);
  useEffect(() => { const t = setTimeout(() => setDateFrom(dateFromInput), 400); return () => clearTimeout(t); }, [dateFromInput]);
  useEffect(() => { const t = setTimeout(() => setDateTo(dateToInput), 400); return () => clearTimeout(t); }, [dateToInput]);

  // Build the games query at a given offset (shared by first page + load-more).
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
    // Only join positions once a move is played — the root is "all games".
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

  // Explorer move-number prefix: White to move → "N.", Black to move → "N...".
  const moveNo = Math.floor(moveSequence.length / 2) + 1;
  const movePrefix = moveSequence.length % 2 === 0 ? `${moveNo}.` : `${moveNo}...`;

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

  const panel = "bg-surface-container-low border border-outline/40 rounded-md overflow-hidden flex flex-col min-h-0 min-w-0 h-full w-full";
  const anyFilter = p1 || p2 || event || dateFrom || dateTo;
  // Resizable-panel dividers: thin, transparent, highlight on hover/drag.
  const vHandle = "w-1.5 bg-transparent hover:bg-primary/30 data-[resize-handle-state=drag]:bg-primary/50 transition-colors";
  const hHandle = "h-1.5 bg-transparent hover:bg-primary/30 data-[resize-handle-state=drag]:bg-primary/50 transition-colors";

  // Resizable game-list columns. White/Black/Result/Year have user-draggable
  // widths (persisted); Event fills the remainder so no space is wasted.
  type ColKey = "white" | "black" | "result" | "year";
  const [colW, setColW] = useState<Record<ColKey, number>>(() => {
    try { const s = localStorage.getItem("gamesColWidths"); if (s) return JSON.parse(s); } catch { /* ignore */ }
    return { white: 170, black: 170, result: 48, year: 52 };
  });
  useEffect(() => { try { localStorage.setItem("gamesColWidths", JSON.stringify(colW)); } catch { /* ignore */ } }, [colW]);
  const gridCols = `${colW.white}px ${colW.black}px ${colW.result}px ${colW.year}px minmax(0,1fr)`;
  function startResize(key: ColKey, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colW[key];
    const onMove = (ev: MouseEvent) => setColW((w) => ({ ...w, [key]: Math.max(36, startW + (ev.clientX - startX)) }));
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Collapsible filter rail ─────────────────────────────────────────── */}
      {filtersCollapsed ? (
        <button
          onClick={() => setFiltersCollapsed(false)}
          className="w-8 shrink-0 flex flex-col items-center gap-2 pt-3 bg-surface-container-low border-r border-outline/40 text-on-surface-variant hover:text-on-surface hover:bg-on-surface/4 transition-colors duration-short3 ease-standard"
          title="Show filters"
        >
          <span className="text-body-md">»</span>
          <span className="text-label-sm uppercase tracking-wider" style={{ writingMode: "vertical-rl" }}>Filters</span>
          {anyFilter && <span className="w-1.5 h-1.5 rounded-full bg-primary" title="Filters active" />}
        </button>
      ) : (
        <div className="w-72 shrink-0 flex flex-col overflow-y-auto bg-surface-container-low border-r border-outline/40">
          <div className="px-3 py-2 flex items-center justify-between border-b border-outline/40">
            <span className="text-label-md text-on-surface-variant uppercase tracking-wider">Filters</span>
            <button onClick={() => setFiltersCollapsed(true)} className="h-7 px-2 inline-flex items-center rounded-full text-on-surface-variant hover:bg-on-surface/8 text-body-md" title="Hide filters">«</button>
          </div>
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
        </div>
      )}

      {/* ── 6-area mosaic (resizable, nested panel groups) ────────────────────── */}
      <div className="flex-1 min-w-0 min-h-0 p-1.5">
        <PanelGroup direction="horizontal" autoSaveId="games-cols" className="h-full w-full">
          {/* Left column: A (board) over C (engine) */}
          <Panel defaultSize={30} minSize={16}>
            <PanelGroup direction="vertical" autoSaveId="games-leftcol" className="h-full w-full">
              {/* A — position board (board only) */}
              <Panel defaultSize={60} minSize={20}>
                <div className={panel}>
                  <PositionBoard
                    moveSequence={moveSequence}
                    onBack={() => setPly((p) => Math.max(0, p - 1))}
                    onReset={() => setPly(0)}
                    moveStats={moveStats}
                    selectedMoveSan={moveStats[0]?.mv ?? null}
                    showRelatedGame={false}
                    showMoves={false}
                  />
                </div>
              </Panel>
              <PanelResizeHandle className={hHandle} />
              {/* C — engine evaluation (placeholder, #221) */}
              <Panel defaultSize={40} minSize={12}>
                <div className={panel}>
                  <div className="px-3 py-2 shrink-0 text-label-md text-on-surface-variant uppercase tracking-wider border-b border-outline/40">Engine</div>
                  <div className="flex-1 flex items-center justify-center text-center text-on-surface-variant text-body-sm px-3">
                    Engine evaluation — coming soon
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </Panel>

          <PanelResizeHandle className={vHandle} />

          {/* Right area: B (B1|B2) over bottom (D | E/F) */}
          <Panel defaultSize={70} minSize={30}>
            <PanelGroup direction="vertical" autoSaveId="games-right" className="h-full w-full">
              {/* B — position moves (B1) + explorer stats (B2) */}
              <Panel defaultSize={34} minSize={15}>
                <PanelGroup direction="horizontal" autoSaveId="games-b" className="h-full w-full">
                  {/* B1 — position-related moves (the played line + nav) */}
                  <Panel defaultSize={33} minSize={15}>
                    <div className={panel}>
                      <div className="p-2 h-full min-h-0">
                        <PositionMoves
                          moveSequence={moveSequence}
                          fullLine={line}
                          onBack={() => setPly((p) => Math.max(0, p - 1))}
                          onReset={() => setPly(0)}
                          onForward={() => setPly((p) => Math.min(line.length, p + 1))}
                          onEnd={() => setPly(line.length)}
                          onJumpTo={(n) => setPly(Math.max(0, Math.min(line.length, n)))}
                        />
                      </div>
                    </div>
                  </Panel>
                  <PanelResizeHandle className={vHandle} />
                  {/* B2 — opening-explorer moves (stats over all matching games) */}
                  <Panel defaultSize={67} minSize={20}>
                    <div className={panel}>
                      {movesLoading ? (
                        <div className="p-3 text-center text-on-surface-variant text-body-sm">Loading…</div>
                      ) : moveStats.length === 0 ? (
                        <div className="p-3 text-center text-on-surface-variant text-body-sm">No moves from this position</div>
                      ) : (
                        <div className="flex-1 overflow-y-auto p-2">
                          <div className="flex items-center text-label-sm text-on-surface-variant px-2 mb-1 select-none">
                            <span className="w-24">Move</span>
                            <span className="w-20 text-right">Games</span>
                            <span className="w-10 text-right">W%</span>
                            <span className="w-10 text-right">D%</span>
                            <span className="w-10 text-right">L%</span>
                            <span className="w-16 text-right">Last</span>
                          </div>
                          {moveStats.map((stat) => (
                            <button
                              key={stat.mv}
                              onClick={() => appendMove(stat.mv)}
                              className="w-full flex items-center text-body-sm px-2 py-1 rounded-sm text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
                            >
                              <span className="w-24 font-mono truncate text-left">{movePrefix}{stat.mv}</span>
                              <span className="w-20 text-right">{stat.games.toLocaleString()}</span>
                              <span className="w-10 text-right text-success">{Math.round(stat.w_pct)}</span>
                              <span className="w-10 text-right text-on-surface-variant">{Math.round(stat.d_pct)}</span>
                              <span className="w-10 text-right text-error">{Math.round(stat.l_pct)}</span>
                              <span className="w-16 text-right text-on-surface-variant">{stat.last_played?.slice(0, 4) ?? "—"}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </Panel>
                </PanelGroup>
              </Panel>

              <PanelResizeHandle className={hHandle} />

              {/* Bottom: D (game list) | E-F (mini board over move list) */}
              <Panel defaultSize={66} minSize={25}>
                <PanelGroup direction="horizontal" autoSaveId="games-bottom" className="h-full w-full">
                  {/* D — game list (resizable columns) */}
                  <Panel defaultSize={62} minSize={25}>
                    <div className={panel}>
                      <div className="px-3 py-2 shrink-0 text-label-md text-on-surface-variant border-b border-outline/40">
                        {loading ? "Loading…" : total !== null ? `${total.toLocaleString()} game${total !== 1 ? "s" : ""}` : ""}
                      </div>
                      {/* Column header with drag-to-resize handles */}
                      <div className="shrink-0 grid items-center text-label-sm text-on-surface-variant border-b border-outline/40 select-none" style={{ gridTemplateColumns: gridCols }}>
                        {(["white", "black", "result", "year"] as ColKey[]).map((k) => (
                          <div key={k} className="relative px-3 py-1 truncate">
                            {k === "white" ? "White" : k === "black" ? "Black" : k === "result" ? "Result" : "Year"}
                            <span
                              onMouseDown={(e) => startResize(k, e)}
                              className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                            />
                          </div>
                        ))}
                        <div className="px-3 py-1 truncate">Event</div>
                      </div>
                      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
                        {error && <div className="p-4 text-center text-error text-body-md">{error}</div>}
                        {!error && !loading && games.length === 0 && (
                          <div className="p-4 text-center text-on-surface-variant text-body-md">No games found</div>
                        )}
                        {games.map((game) => {
                          const selected = selectedGame?.id === game.id;
                          const subText = selected ? "text-on-secondary-container/80" : "text-on-surface-variant";
                          return (
                            <button
                              key={game.id}
                              onClick={() => setSelectedGame(game)}
                              style={{ display: "grid", gridTemplateColumns: gridCols }}
                              className={`w-full items-baseline text-body-sm text-left transition-colors duration-short3 ease-standard ${
                                selected ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
                              }`}
                            >
                              <span className="px-3 py-1.5 truncate">{game.white}{game.white_elo ? <span className={subText}> {game.white_elo}</span> : null}</span>
                              <span className="px-3 py-1.5 truncate">{game.black}{game.black_elo ? <span className={subText}> {game.black_elo}</span> : null}</span>
                              <span className="px-3 py-1.5 truncate tabular-nums">{game.result ? (game.result === "1/2-1/2" ? "½-½" : game.result) : ""}</span>
                              <span className={`px-3 py-1.5 truncate ${subText}`}>{game.date?.slice(0, 4) ?? ""}</span>
                              <span className={`px-3 py-1.5 truncate ${subText}`}>{game.event ?? ""}</span>
                            </button>
                          );
                        })}
                        {loadingMore && <div className="p-3 text-center text-on-surface-variant text-body-sm">Loading…</div>}
                      </div>
                    </div>
                  </Panel>
                  <PanelResizeHandle className={vHandle} />
                  {/* E over F */}
                  <Panel defaultSize={38} minSize={18}>
                    <PanelGroup direction="vertical" autoSaveId="games-ef" className="h-full w-full">
                      {/* E — mini board of the selected game */}
                      <Panel defaultSize={55} minSize={20}>
                        <div className={panel}>
                          {loadedGame ? (
                            <MiniBoard game={loadedGame} ply={selectedPly} setPly={setSelectedPly} />
                          ) : (
                            <div className="flex-1 flex items-center justify-center text-center text-on-surface-variant text-body-sm px-3">
                              {gameLoading ? "Loading…" : "Select a game"}
                            </div>
                          )}
                        </div>
                      </Panel>
                      <PanelResizeHandle className={hHandle} />
                      {/* F — compact move list of the selected game */}
                      <Panel defaultSize={45} minSize={12}>
                        <div className={panel}>
                          {loadedGame ? (
                            <MoveList game={loadedGame} ply={selectedPly} setPly={setSelectedPly} />
                          ) : (
                            <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-sm px-3">—</div>
                          )}
                        </div>
                      </Panel>
                    </PanelGroup>
                  </Panel>
                </PanelGroup>
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
