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
import { addCloudWatch } from "../api";
import { CLOUD_WATCH_LANDED } from "./ActivityIndicator";

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

// Cloud engine (chessdb.cn) — one candidate move + its score (#221).
interface CloudMove { san: string; uci: string; scoreCp: number; mate: number | null; winrate: number | null; rank: number; note: string; }

/** chessdb note "! (20-04)" → { mark:"!", opp:"20", oppStrong:"04" }; null for mate/odd notes. */
function parseNote(note: string): { mark: string; opp: string; oppStrong: string } | null {
  const m = note.match(/^\s*(\S*)\s*\((\d+)-(\d+)\)/);
  return m ? { mark: m[1], opp: m[2], oppStrong: m[3] } : null;
}

type EngineSource = "chessdb" | "lichess";

// Lichess (Stockfish) cloud eval — a few deep PV lines, White-relative eval + depth.
interface LichessLine { evalCp: number | null; mate: number | null; pvUci: string[]; }
interface LichessEval { status: EngineStatus; depth: number; knodes: number; lines: LichessLine[]; }

/** Convert a UCI principal variation to SAN by replaying it from `fen`. */
function pvToSan(fen: string, pvUci: string[]): string[] {
  const chess = new Chess(fen);
  const sans: string[] = [];
  for (const uci of pvUci) {
    try {
      const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: (uci.slice(4, 5) || undefined) as ("q" | "r" | "b" | "n" | undefined) });
      if (!mv) break;
      sans.push(mv.san);
    } catch { break; }
  }
  return sans;
}

/** Render a SAN line with move numbers starting from `fen`'s move/side. */
function pvString(fen: string, sans: string[]): string {
  const parts = fen.split(" ");
  let n = parseInt(parts[5] || "1", 10);
  let white = parts[1] !== "b";
  const toks: string[] = [];
  sans.forEach((s, i) => {
    if (white) toks.push(`${n}.${s}`);
    else { toks.push(i === 0 ? `${n}...${s}` : s); n += 1; }
    white = !white;
  });
  return toks.join(" ");
}

/** Lichess eval (White-relative): "+0.14", "-2.36", "M1" / "-M1". */
function fmtLichess(l: LichessLine): string {
  if (l.mate !== null) return l.mate > 0 ? `M${l.mate}` : `-M${-l.mate}`;
  const p = (l.evalCp ?? 0) / 100;
  return (p > 0 ? "+" : "") + p.toFixed(2);
}
type EngineStatus = "loading" | "ok" | "unknown" | "offline";

/** Score from the side-to-move's perspective, e.g. "+0.30", "-1.15", "M3". */
function fmtEval(m: CloudMove): string {
  if (m.mate !== null) return m.mate > 0 ? `M${m.mate}` : `-M${-m.mate}`;
  const p = m.scoreCp / 100;
  return (p > 0 ? "+" : "") + p.toFixed(2);
}
function evalColor(m: CloudMove): string {
  const v = m.mate !== null ? m.mate : m.scoreCp;
  return v > 0 ? "text-success" : v < 0 ? "text-error" : "text-on-surface-variant";
}

interface Props {
  scopePublicOnly: boolean;
  scopeCollectionId: number | null;
  scopeIncludeDeleted: boolean;
  /** Players mode: locks Player 1 to this player (chosen via the external player
   *  list) and scopes the games + explorer to them. Undefined on the Games page. */
  player?: PlayerInfo | null;
  /** Open the selected game in the editable Analysis board (#220). */
  onOpenInAnalysis?: (game: GameSummary) => void;
}

export default function GamesPage({ scopePublicOnly, scopeCollectionId, scopeIncludeDeleted, player, onOpenInAnalysis }: Props) {
  const playerScoped = player !== undefined;
  // ── Filters ───────────────────────────────────────────────────────────────
  const [p1, setP1] = useState<PlayerInfo | null>(player ?? null);
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

  // ── Cloud engine (C): chessdb.cn or Lichess (Stockfish), via the daemon (#221) ─
  const [engineSource, setEngineSource] = useState<EngineSource>(() => (localStorage.getItem("engineSource") === "lichess" ? "lichess" : "chessdb"));
  useEffect(() => { localStorage.setItem("engineSource", engineSource); }, [engineSource]);
  const [engineMoves, setEngineMoves] = useState<CloudMove[]>([]);          // chessdb
  const [chessdbDepth, setChessdbDepth] = useState<number | null>(null);
  const [lichessEval, setLichessEval] = useState<LichessEval | null>(null); // lichess
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("ok");
  const [engineQueuing, setEngineQueuing] = useState(false);
  const [watchStarted, setWatchStarted] = useState(false);
  // Bumped when a deepen watch lands on the current position, to force a refetch.
  const [engineRefetch, setEngineRefetch] = useState(0);
  const engineAbort = useRef<AbortController | null>(null);

  // ── Selected game (E + F), independent of the explorer ──────────────────────
  const [selectedGame, setSelectedGame] = useState<GameSummary | null>(null);
  const [selectedPly, setSelectedPly] = useState(0);
  const { game: loadedGame, loading: gameLoading } = useGamePgn(selectedGame?.id ?? null);
  useEffect(() => { setSelectedPly(0); }, [selectedGame?.id]);

  // Players mode: when the externally-selected player changes, lock Player 1 to
  // them and reset the explorer + selection to a clean slate for the new player.
  useEffect(() => {
    if (!playerScoped) return;
    setP1(player ?? null);
    setLine([]); setPly(0);
    setSelectedGame(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player?.id]);

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
    // Scope the explorer to the selected player (their repertoire), matching the
    // game list — DB-wide only when no player is chosen.
    const primary = p1 ?? p2;
    if (primary) { params.set("player_id", String(primary.id)); params.set("color", p1 ? p1Color : p2Color); }

    fetch(`/api/position/moves?${params}`, { signal: movesAbortRef.current.signal })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<MoveStats[]>; })
      .then((data) => { setMoveStats(data); setMovesLoading(false); })
      .catch((e) => { if (e instanceof DOMException && e.name === "AbortError") return; setMoveStats([]); setMovesLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstMovesStr, dateFrom, dateTo, scopePublicOnly, p1?.id, p1Color, p2?.id, p2Color]);

  // Cloud engine evaluation for the current position (debounced — hits the free
  // chessdb.cn / Lichess services through the daemon, which caches by position).
  useEffect(() => {
    engineAbort.current?.abort();
    const ctrl = new AbortController();
    engineAbort.current = ctrl;
    setEngineStatus("loading");
    const fen = fenFromMoves(moveSequence);
    const t = setTimeout(() => {
      if (engineSource === "chessdb") {
        fetch(`/api/cloud-eval?fen=${encodeURIComponent(fen)}`, { signal: ctrl.signal })
          .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<{ status: EngineStatus; moves: CloudMove[]; depth: number | null }>; })
          .then((d) => { setEngineMoves(d.moves ?? []); setChessdbDepth(d.depth ?? null); setEngineStatus(d.moves?.length ? "ok" : (d.status ?? "unknown")); })
          .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) { setEngineMoves([]); setEngineStatus("offline"); } });
      } else {
        fetch(`/api/lichess-eval?fen=${encodeURIComponent(fen)}`, { signal: ctrl.signal })
          .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<LichessEval>; })
          .then((d) => { setLichessEval(d); setEngineStatus(d.lines?.length ? "ok" : (d.status ?? "unknown")); })
          .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) { setLichessEval(null); setEngineStatus("offline"); } });
      }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstMovesStr, engineSource, engineRefetch]);

  // A watch landed somewhere: if it's the position on screen, refetch so the
  // deeper result appears live (the daemon has already busted its cache for it).
  useEffect(() => {
    function onLanded(e: Event) {
      const fen = (e as CustomEvent<{ fen: string }>).detail?.fen;
      if (fen && fen === fenFromMoves(moveSequence)) setEngineRefetch((n) => n + 1);
    }
    window.addEventListener(CLOUD_WATCH_LANDED, onLanded);
    return () => window.removeEventListener(CLOUD_WATCH_LANDED, onLanded);
  }, [moveSequence]);

  function requestAnalysis() {
    const fen = fenFromMoves(moveSequence);
    setEngineQueuing(true);
    fetch(`/api/cloud-eval/queue?fen=${encodeURIComponent(fen)}`, { method: "POST" })
      .then(() => new Promise((res) => setTimeout(res, 2500)))
      .then(() => fetch(`/api/cloud-eval?fen=${encodeURIComponent(fen)}`))
      .then((r) => r.json() as Promise<{ status: EngineStatus; moves: CloudMove[]; depth: number | null }>)
      .then((d) => { setEngineMoves(d.moves ?? []); setChessdbDepth(d.depth ?? null); setEngineStatus(d.moves?.length ? "ok" : (d.status ?? "unknown")); })
      .catch(() => {})
      .finally(() => setEngineQueuing(false));
  }

  // Watch this position for deeper chessdb analysis; the activity panel notifies
  // when the depth grows (and this panel refetches if it's still on screen).
  function startWatch() {
    const label = moveSequence.length ? pvString(new Chess().fen(), moveSequence) : "Starting position";
    setWatchStarted(true);
    addCloudWatch(fenFromMoves(moveSequence), label)
      .catch(() => {})
      .finally(() => setTimeout(() => setWatchStarted(false), 1500));
  }

  // Explorer move-number prefix: White to move → "N.", Black to move → "N...".
  const moveNo = Math.floor(moveSequence.length / 2) + 1;
  const movePrefix = moveSequence.length % 2 === 0 ? `${moveNo}.` : `${moveNo}...`;
  const currentFen = fenFromMoves(moveSequence);

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
                <span>{playerScoped ? "Player" : "Player 1"}</span> {colorRow(p1Color, setP1C)}
              </div>
              {playerScoped ? (
                <div className="px-3 py-2 rounded-sm bg-surface-container text-body-md text-on-surface truncate">{p1?.name ?? "—"}</div>
              ) : (
                <PlayerPicker label="" value={p1} onPick={setP1} excludeId={p2?.id} />
              )}
            </div>
            <div>
              <div className="text-label-md text-on-surface-variant mb-1.5 flex items-center justify-between">
                <span>{playerScoped ? "Opponent" : "Player 2"}</span> {colorRow(p2Color, setP2C)}
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
              {/* C — cloud engine evaluation (chessdb.cn, #221) */}
              <Panel defaultSize={40} minSize={12}>
                <div className={panel}>
                  <div className="px-3 py-2 shrink-0 flex items-center justify-between border-b border-outline/40">
                    <div className="flex gap-0.5">
                      {(["chessdb", "lichess"] as EngineSource[]).map((src) => (
                        <button
                          key={src}
                          onClick={() => setEngineSource(src)}
                          className={`h-6 px-2 rounded-full text-label-sm transition-colors duration-short3 ease-standard ${engineSource === src ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-on-surface/8"}`}
                        >
                          {src === "chessdb" ? "chessdb" : "Lichess"}
                        </button>
                      ))}
                    </div>
                    <span
                      className="text-label-sm text-on-surface-variant/70 cursor-help"
                      title={engineSource === "chessdb" ? "Free cloud analysis from the community database chessdb.cn" : "Cloud Stockfish evaluations from lichess.org — only popular positions are cached"}
                    >
                      via {engineSource === "chessdb" ? "chessdb.cn" : "lichess.org"}
                    </span>
                  </div>
                  {engineStatus === "loading" ? (
                    <div className="p-3 text-center text-on-surface-variant text-body-sm">Analysing…</div>
                  ) : engineStatus === "offline" ? (
                    <div className="flex-1 flex items-center justify-center text-center text-on-surface-variant text-body-sm px-3">Engine unavailable (offline)</div>
                  ) : engineSource === "chessdb" ? (
                    engineStatus === "unknown" || engineMoves.length === 0 ? (
                      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-3 text-center">
                        <span className="text-on-surface-variant text-body-sm">Not in the cloud database yet.</span>
                        <button onClick={requestAnalysis} disabled={engineQueuing} className="h-8 px-3 rounded-full text-label-md text-primary hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard">
                          {engineQueuing ? "Requested — analysing…" : "Request analysis"}
                        </button>
                      </div>
                    ) : (
                      <div className="flex-1 flex flex-col min-h-0">
                        <div className="px-3 py-1 shrink-0 flex items-center justify-between text-label-sm text-on-surface-variant border-b border-outline/40">
                          <span>chessdb{chessdbDepth !== null ? ` · depth ${chessdbDepth}` : ""}</span>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={requestAnalysis}
                              disabled={engineQueuing}
                              className="h-6 px-2 rounded-full text-primary hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard"
                              title="Ask chessdb.cn to analyse this position more deeply — asynchronous; re-query later to see it grow"
                            >
                              {engineQueuing ? "Requested…" : "Deepen"}
                            </button>
                            <button
                              onClick={startWatch}
                              disabled={watchStarted}
                              className="h-6 px-2 rounded-full text-primary hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard"
                              title="Watch this position — the activity panel notifies you when chessdb's depth grows"
                            >
                              {watchStarted ? "Watching ✓" : "Watch"}
                            </button>
                          </div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-2">
                        <div className="flex items-center text-label-sm text-on-surface-variant px-2 mb-1 select-none">
                          <span className="flex-1 min-w-0">Move</span>
                          <span className="w-14 text-right">Eval</span>
                          <span className="w-14 text-right cursor-help underline decoration-dotted underline-offset-2" title="Opponent's total legal moves after this move.">Replies</span>
                          <span className="w-14 text-right cursor-help underline decoration-dotted underline-offset-2" title="Opponent's strong ('power') replies after this move — a low number means a forcing line.">Strong</span>
                        </div>
                        {engineMoves.map((m) => {
                          const nn = parseNote(m.note);
                          return (
                            <button key={m.uci || m.san} onClick={() => appendMove(m.san.replace(/[+#]+$/, ""))} className="w-full flex items-center text-body-sm px-2 py-1 rounded-sm text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard">
                              <span className="flex-1 min-w-0 font-mono truncate text-left">{movePrefix}{m.san}{nn && nn.mark && nn.mark !== "*" && <span className="text-primary">{nn.mark}</span>}</span>
                              <span className={`w-14 text-right tabular-nums ${evalColor(m)}`}>{fmtEval(m)}</span>
                              <span className="w-14 text-right tabular-nums text-on-surface-variant">{nn ? Number(nn.opp) : "—"}</span>
                              <span className="w-14 text-right tabular-nums text-on-surface">{nn ? Number(nn.oppStrong) : "—"}</span>
                            </button>
                          );
                        })}
                        </div>
                      </div>
                    )
                  ) : (
                    engineStatus === "unknown" || !lichessEval?.lines.length ? (
                      <div className="flex-1 flex items-center justify-center text-center text-on-surface-variant text-body-sm px-3">Not in Lichess's cloud (only popular positions are cached).</div>
                    ) : (
                      <div className="flex-1 flex flex-col min-h-0">
                        <div className="px-3 py-1 shrink-0 text-label-sm text-on-surface-variant border-b border-outline/40">Stockfish · depth {lichessEval.depth}</div>
                        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                          {lichessEval.lines.map((l, i) => {
                            const sans = pvToSan(currentFen, l.pvUci);
                            return (
                              <button key={i} onClick={() => { if (sans[0]) appendMove(sans[0].replace(/[+#]+$/, "")); }} className="w-full flex items-baseline gap-2 px-2 py-1 rounded-sm text-left hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard">
                                <span className="w-14 shrink-0 text-right tabular-nums font-mono text-on-surface">{fmtLichess(l)}</span>
                                <span className="flex-1 min-w-0 truncate font-mono text-body-sm text-on-surface-variant">{pvString(currentFen, sans)}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )
                  )}
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
                      <div className="px-3 py-2 shrink-0 text-label-md border-b border-outline/40 truncate" title={p1?.name}>
                        {loading ? (
                          <span className="text-on-surface-variant">Loading…</span>
                        ) : p1 ? (
                          <>
                            <span className="text-on-surface">{p1.name}{p1Color === "white" ? " (White)" : p1Color === "black" ? " (Black)" : ""}</span>
                            {total !== null && <span className="text-on-surface-variant"> · {total.toLocaleString()} game{total !== 1 ? "s" : ""}</span>}
                          </>
                        ) : (
                          <span className="text-on-surface-variant">{total !== null ? `${total.toLocaleString()} game${total !== 1 ? "s" : ""}` : ""}</span>
                        )}
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
                            <>
                              {onOpenInAnalysis && selectedGame && (
                                <div className="shrink-0 px-2 py-1 border-b border-outline/40 flex justify-end">
                                  <button
                                    onClick={() => onOpenInAnalysis(selectedGame)}
                                    className="text-label-md text-primary hover:bg-primary/8 active:bg-primary/12 px-2.5 h-7 rounded-full transition-colors duration-short3 ease-standard"
                                    title="Open this game in the editable Analysis board"
                                  >
                                    Open in Analysis ↗
                                  </button>
                                </div>
                              )}
                              <MiniBoard game={loadedGame} ply={selectedPly} setPly={setSelectedPly} />
                            </>
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
