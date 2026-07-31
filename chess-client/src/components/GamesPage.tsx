import { useEffect, useRef, useState, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Chess } from "chess.js";
import { GameSummary, MoveStats, PlayerInfo } from "../types";
import PlayerPicker from "./PlayerPicker";
import PositionBoard from "./PositionBoard";
import PositionMoves from "./PositionMoves";
import MiniBoard from "./games/MiniBoard";
import MoveList from "./games/MoveList";
import { useGamePgn } from "../lib/useGamePgn";
import { addCloudWatch, getCloudWatches } from "../api";
import { CLOUD_WATCH_REMOVED, CLOUD_WATCH_UPDATED } from "./ActivityIndicator";

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

/** A numbered SAN line where each move is clickable — picking a move jumps to the
 *  position after it. Shared by the chessdb + Lichess engine views. Rendered on a
 *  single line by the parent (overflow-hidden), so the tail truncates to fit. */
function PvLine({ startFen, sans, onPick, mark }: { startFen: string; sans: string[]; onPick: (prefix: string[]) => void; mark?: string }) {
  const parts = startFen.split(" ");
  let n = parseInt(parts[5] || "1", 10);
  let white = parts[1] !== "b";
  const toks: ReactNode[] = [];
  sans.forEach((s, i) => {
    const label = white ? `${n}.` : i === 0 ? `${n}…` : "";
    toks.push(
      <span key={i} className="whitespace-nowrap">
        {label && <span className="text-outline select-none">{label}</span>}
        {/* The first move is the candidate — accent it, and hang its mark off it. */}
        <span className={`cursor-pointer hover:text-primary ${i === 0 ? "font-semibold text-on-surface" : ""}`} onClick={(e) => { e.stopPropagation(); onPick(sans.slice(0, i + 1)); }}>{s}</span>
        {i === 0 && mark && <span className={`font-semibold ${mark === "?" ? "text-error" : "text-primary"}`}>{mark}</span>}{" "}
      </span>,
    );
    if (!white) n += 1;
    white = !white;
  });
  return <>{toks}</>;
}

/** Lichess eval (White-relative): "+0.14", "-2.36", "M1" / "-M1". */
function fmtLichess(l: LichessLine): string {
  if (l.mate !== null) return l.mate > 0 ? `M${l.mate}` : `-M${-l.mate}`;
  const p = (l.evalCp ?? 0) / 100;
  return (p > 0 ? "+" : "") + p.toFixed(2);
}

// Bringing chessdb's "power move" lens to Stockfish (#221). Reverse-engineered
// from chessdb: a move within ~0.05 of the best is "strong" (chessdb marks the
// best "!" and treats anything >0.05 worse as "?"), AND — crucially — once the
// position itself is lost (best move worse than ~-0.7, i.e. win% under ~45%),
// chessdb marks *everything* "?": no point flagging the opponent's "good" replies
// when you're already lost. These constants match that behaviour.
const STRONG_CP = 5;    // within 0.05 of best → strong
const LOST_CP = -70;    // best move worse than -0.70 ⇒ position lost, all moves "?"
/** Eval from the side-to-move's perspective, in centipawns (mate ⇒ ±huge, nearer
 *  mates ranked higher). Lichess evals are White-relative, so flip for Black. */
function moverScore(evalCp: number | null, mate: number | null, whiteToMove: boolean): number {
  if (mate != null && mate !== 0) {
    const m = whiteToMove ? mate : -mate;
    return m > 0 ? 100000 - m : -100000 - m;
  }
  const cp = evalCp ?? 0;
  return whiteToMove ? cp : -cp;
}
/** "!" / "?" for a line, given the position's best score. Everything is "?" in a
 *  lost position; otherwise "!" within STRONG_CP of best, "?" beyond. */
function moveMark(best: number, score: number): string {
  if (best < LOST_CP) return "?";
  return best - score <= STRONG_CP ? "!" : "?";
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

// Games-page state that should survive leaving and returning to the page (and a
// restart) — the analysed line + applied filters. Persisted to localStorage; only
// for the Games page, not the player-scoped Players view (#—).
const GAMES_STATE_KEY = "gamesPageState";
interface PersistedGamesState {
  p1: PlayerInfo | null; p1Color: ColorFilter; p2: PlayerInfo | null; p2Color: ColorFilter;
  event: string; dateFrom: string; dateTo: string; filtersCollapsed: boolean;
  line: string[]; ply: number;
  selectedGame: GameSummary | null; selectedPly: number;
}
function loadGamesState(): Partial<PersistedGamesState> | null {
  try { const raw = localStorage.getItem(GAMES_STATE_KEY); return raw ? (JSON.parse(raw) as Partial<PersistedGamesState>) : null; } catch { return null; }
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
  // Restore the Games page's last analysed line + filters (once, on mount). Never
  // for the player-scoped view — that always locks to the externally-chosen player.
  const restored = useRef<Partial<PersistedGamesState> | null>(playerScoped ? null : loadGamesState()).current;
  // ── Filters ───────────────────────────────────────────────────────────────
  const [p1, setP1] = useState<PlayerInfo | null>(player ?? restored?.p1 ?? null);
  const [p1Color, setP1Color] = useState<ColorFilter>(restored?.p1Color ?? "any");
  const [p2, setP2] = useState<PlayerInfo | null>(restored?.p2 ?? null);
  const [p2Color, setP2Color] = useState<ColorFilter>(restored?.p2Color ?? "any");
  const [eventInput, setEventInput] = useState(restored?.event ?? "");
  const [dateFromInput, setDateFromInput] = useState(restored?.dateFrom ?? "");
  const [dateToInput, setDateToInput] = useState(restored?.dateTo ?? "");
  const [event, setEvent] = useState(restored?.event ?? "");
  const [dateFrom, setDateFrom] = useState(restored?.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(restored?.dateTo ?? "");
  const [filtersCollapsed, setFiltersCollapsed] = useState(restored?.filtersCollapsed ?? true);

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
  const [line, setLine] = useState<string[]>(restored?.line ?? []);
  const [ply, setPly] = useState(restored?.ply ?? 0);
  const moveSequence = line.slice(0, ply);
  function appendMove(mv: string) {
    setLine((prev) => (prev[ply] === mv ? prev : [...prev.slice(0, ply), mv]));
    setPly((p) => p + 1);
  }
  // Play a whole line prefix from the current position (clicking a move inside a
  // displayed engine line jumps to the position after that move).
  function appendLine(sans: string[]) {
    const clean = sans.map((s) => s.replace(/[+#]+$/, ""));
    setLine((prev) => [...prev.slice(0, ply), ...clean]);
    setPly((p) => p + clean.length);
  }
  const [moveStats, setMoveStats] = useState<MoveStats[]>([]);
  const [movesLoading, setMovesLoading] = useState(false);
  const movesAbortRef = useRef<AbortController | null>(null);

  // ── Cloud engine (C): chessdb.cn or Lichess (Stockfish), via the daemon (#221) ─
  // Default to Lichess (Stockfish) — deep, real evals for popular positions. A
  // versioned key so flipping the default from chessdb actually takes effect on
  // existing installs (the old key was auto-written on every load). An explicit
  // toggle to chessdb still persists.
  const [engineSource, setEngineSource] = useState<EngineSource>(() => (localStorage.getItem("engineSourceV2") === "chessdb" ? "chessdb" : "lichess"));
  useEffect(() => { localStorage.setItem("engineSourceV2", engineSource); }, [engineSource]);
  const [engineMoves, setEngineMoves] = useState<CloudMove[]>([]);          // chessdb
  const [engineLines, setEngineLines] = useState<Record<string, string[]>>({}); // uci → continuation SAN (lazy)
  const [lichessEval, setLichessEval] = useState<LichessEval | null>(null); // lichess
  const [lichessStats, setLichessStats] = useState<Record<string, { replies: number; strong: number }>>({}); // uci → power-move stats (lazy)
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("ok");
  const [engineQueuing, setEngineQueuing] = useState(false);
  // FENs with an active deepen watch — keep Deepen disabled for them so a second
  // click can't restart the watch (which would reset its baseline). Seeded from
  // the daemon on mount, then kept live via the landed/removed window events.
  const [watchedFens, setWatchedFens] = useState<Set<string>>(() => new Set());
  const engineAbort = useRef<AbortController | null>(null);

  // ── Selected game (E + F), independent of the explorer ──────────────────────
  const [selectedGame, setSelectedGame] = useState<GameSummary | null>(restored?.selectedGame ?? null);
  const [selectedPly, setSelectedPly] = useState(restored?.selectedPly ?? 0);
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

  // Persist the analysed line + filters so leaving and returning to the Games page
  // (or restarting) restores them. Not for the player-scoped view (#—).
  useEffect(() => {
    if (playerScoped) return;
    const snapshot: PersistedGamesState = {
      p1, p1Color, p2, p2Color, event, dateFrom, dateTo, filtersCollapsed, line, ply, selectedGame, selectedPly,
    };
    try { localStorage.setItem(GAMES_STATE_KEY, JSON.stringify(snapshot)); } catch { /* quota — ignore */ }
  }, [playerScoped, p1, p1Color, p2, p2Color, event, dateFrom, dateTo, filtersCollapsed, line, ply, selectedGame, selectedPly]);

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
        setEngineLines({}); // clear stale continuation lines
        fetch(`/api/cloud-eval?fen=${encodeURIComponent(fen)}`, { signal: ctrl.signal })
          .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<{ status: EngineStatus; moves: CloudMove[] }>; })
          .then((d) => {
            setEngineMoves(d.moves ?? []); setEngineStatus(d.moves?.length ? "ok" : (d.status ?? "unknown"));
            // Lazy second pass: fetch the continuation lines (several querypv calls)
            // once the move table is on screen.
            if (d.moves?.length) {
              fetch(`/api/cloud-eval/lines?fen=${encodeURIComponent(fen)}`, { signal: ctrl.signal })
                .then((r) => (r.ok ? r.json() as Promise<{ uci: string; pvSan: string[] }[]> : []))
                .then((ls) => { const map: Record<string, string[]> = {}; for (const l of ls) map[l.uci] = l.pvSan; setEngineLines(map); })
                .catch(() => {});
            }
          })
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
  }, [firstMovesStr, engineSource]);

  // Power-move stats for Lichess (async, after the lines are on screen): for each
  // top line, fetch the child position's cloud eval and count the opponent's
  // replies + how many are "strong" (within STRONG_CP of the best). Sparse — only
  // where Lichess has the child position cached.
  useEffect(() => {
    if (engineSource !== "lichess" || !lichessEval?.lines.length) { setLichessStats({}); return; }
    const fen = fenFromMoves(moveSequence);
    const oppWhite = fen.split(" ")[1] === "b"; // opponent (after our move) is White iff we're Black
    const ctrl = new AbortController();
    setLichessStats({});
    for (const l of lichessEval.lines.slice(0, 8)) {
      const uci = l.pvUci[0];
      if (!uci) continue;
      let childFen: string;
      try {
        const c = new Chess(fen);
        c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
        childFen = c.fen();
      } catch { continue; }
      fetch(`/api/lichess-eval?fen=${encodeURIComponent(childFen)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<LichessEval>) : null))
        .then((ce) => {
          if (!ce || ce.status !== "ok" || !ce.lines.length) return;
          const scores = ce.lines.map((x) => moverScore(x.evalCp, x.mate, oppWhite));
          const best = Math.max(...scores);
          // If the opponent is lost after this move, none of their replies are
          // "strong" — don't imply they have good options.
          const strong = best < LOST_CP ? 0 : scores.filter((s) => best - s <= STRONG_CP).length;
          setLichessStats((prev) => ({ ...prev, [uci]: { replies: ce.lines.length, strong } }));
        })
        .catch(() => {});
    }
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstMovesStr, engineSource, lichessEval]);

  // Seed the set of actively-watched positions on mount (a watch may still be
  // running from before this page was last left).
  useEffect(() => {
    let stop = false;
    getCloudWatches()
      .then((ws) => { if (!stop) setWatchedFens(new Set(ws.filter((w) => w.status === "watching").map((w) => w.fen))); })
      .catch(() => {});
    return () => { stop = true; };
  }, []);

  // When a watch fires (chessdb revised the evals) for the position on screen,
  // silently refresh the move table so it reflects the update; and re-enable Deepen
  // (dropping the position from the watched set) on either a fire or a cancel.
  useEffect(() => {
    const currentFenNow = fenFromMoves(moveSequence);
    const drop = (fen?: string) => {
      if (!fen) return;
      setWatchedFens((prev) => { if (!prev.has(fen)) return prev; const next = new Set(prev); next.delete(fen); return next; });
    };
    function onUpdated(e: Event) {
      const fen = (e as CustomEvent<{ fen: string }>).detail?.fen;
      drop(fen); // watch fired — allow deepening again
      if (!fen || fen !== currentFenNow || engineSource !== "chessdb") return;
      fetch(`/api/cloud-eval?fen=${encodeURIComponent(fen)}`)
        .then((r) => r.json() as Promise<{ status: EngineStatus; moves: CloudMove[] }>)
        .then((d) => {
          // Don't let a transient degraded response blank the panel; keep what's shown.
          if (d.status === "offline" || !d.moves?.length) return;
          setEngineMoves(d.moves); setEngineStatus("ok");
        })
        .catch(() => {});
    }
    function onRemoved(e: Event) {
      drop((e as CustomEvent<{ fen: string }>).detail?.fen); // cancelled — re-enable Deepen
    }
    window.addEventListener(CLOUD_WATCH_UPDATED, onUpdated);
    window.addEventListener(CLOUD_WATCH_REMOVED, onRemoved);
    return () => {
      window.removeEventListener(CLOUD_WATCH_UPDATED, onUpdated);
      window.removeEventListener(CLOUD_WATCH_REMOVED, onRemoved);
    };
  }, [moveSequence, engineSource]);

  // Deepen: queue the position for deeper chessdb analysis *and* start a watch,
  // so the activity panel notifies when its evaluation changes (and this panel refetches
  // if it's still on screen). A quick refetch also picks up any immediate gain.
  function requestAnalysis() {
    const fen = fenFromMoves(moveSequence);
    const label = moveSequence.length ? pvString(new Chess().fen(), moveSequence) : "Starting position";
    setEngineQueuing(true);
    setWatchedFens((prev) => new Set(prev).add(fen)); // keep Deepen disabled until it lands/cancels
    addCloudWatch(fen, label) // add_watch queues the position and captures the baseline
      .then(() => new Promise((res) => setTimeout(res, 2500)))
      .then(() => fetch(`/api/cloud-eval?fen=${encodeURIComponent(fen)}`))
      .then((r) => r.json() as Promise<{ status: EngineStatus; moves: CloudMove[] }>)
      .then((d) => { setEngineMoves(d.moves ?? []); setEngineStatus(d.moves?.length ? "ok" : (d.status ?? "unknown")); })
      .catch(() => {})
      .finally(() => setEngineQueuing(false));
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
                          <span>chessdb</span>
                          <button
                            onClick={requestAnalysis}
                            disabled={engineQueuing || watchedFens.has(currentFen)}
                            className="h-6 px-2 rounded-full text-primary hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard"
                            title="Ask chessdb.cn to analyse this position more deeply and watch for the result — the activity panel notifies you when its evaluation changes"
                          >
                            {engineQueuing ? "Requested…" : watchedFens.has(currentFen) ? "Watching…" : "Deepen"}
                          </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-2">
                        <div className="flex items-baseline gap-2 text-label-sm text-on-surface-variant px-2 mb-1 select-none">
                          <span className="flex-1 min-w-0"></span>
                          <span className="w-12 text-right cursor-help underline decoration-dotted underline-offset-2" title="Opponent's total legal moves after this move.">Replies</span>
                          <span className="w-12 text-right cursor-help underline decoration-dotted underline-offset-2" title="Opponent's strong ('power') replies after this move — a low number means a forcing line.">Strong</span>
                          <span className="w-14 text-right">Eval</span>
                        </div>
                        {engineMoves.map((m) => {
                          const nn = parseNote(m.note);
                          const sans = [m.san, ...(engineLines[m.uci] ?? [])]; // move + continuation (lazy)
                          return (
                            <div key={m.uci || m.san} className="w-full flex items-baseline gap-2 px-2 py-1 rounded-sm hover:bg-on-surface/8 transition-colors duration-short3 ease-standard">
                              <div className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-body-sm text-on-surface-variant">
                                <PvLine startFen={currentFen} sans={sans} onPick={appendLine} mark={nn && nn.mark && nn.mark !== "*" ? nn.mark : undefined} />
                              </div>
                              <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface-variant">{nn ? Number(nn.opp) : "—"}</span>
                              <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface">{nn ? Number(nn.oppStrong) : "—"}</span>
                              <span className={`shrink-0 w-14 text-right tabular-nums text-body-sm ${evalColor(m)}`}>{fmtEval(m)}</span>
                            </div>
                          );
                        })}
                        </div>
                      </div>
                    )
                  ) : (
                    engineStatus === "unknown" || !lichessEval?.lines.length ? (
                      <div className="flex-1 flex items-center justify-center text-center text-on-surface-variant text-body-sm px-3">Not in Lichess's cloud (only popular positions are cached).</div>
                    ) : (() => {
                      // Power-move marks (from the current position's own eval spread).
                      const lmWhite = currentFen.split(" ")[1] !== "b";
                      const lmScores = lichessEval.lines.map((l) => moverScore(l.evalCp, l.mate, lmWhite));
                      const lmBest = lmScores.length ? Math.max(...lmScores) : 0;
                      return (
                      <div className="flex-1 flex flex-col min-h-0">
                        <div className="px-3 py-1 shrink-0 text-label-sm text-on-surface-variant border-b border-outline/40">Stockfish · depth {lichessEval.depth}</div>
                        <div className="flex-1 overflow-y-auto p-2">
                        <div className="flex items-baseline gap-2 text-label-sm text-on-surface-variant px-2 mb-1 select-none">
                          <span className="flex-1 min-w-0"></span>
                          <span className="w-12 text-right cursor-help underline decoration-dotted underline-offset-2" title="Opponent's replies Lichess has cached after this move.">Replies</span>
                          <span className="w-12 text-right cursor-help underline decoration-dotted underline-offset-2" title="Opponent's strong replies — within 0.03 of their best. Low ⇒ forcing.">Strong</span>
                          <span className="w-14 text-right">Eval</span>
                        </div>
                          {lichessEval.lines.map((l, i) => {
                            const sans = pvToSan(currentFen, l.pvUci);
                            const st = lichessStats[l.pvUci[0]];
                            return (
                              <div key={i} className="w-full flex items-baseline gap-2 px-2 py-1 rounded-sm hover:bg-on-surface/8 transition-colors duration-short3 ease-standard">
                                <div className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-body-sm text-on-surface-variant">
                                  <PvLine startFen={currentFen} sans={sans} onPick={appendLine} mark={moveMark(lmBest, lmScores[i]) || undefined} />
                                </div>
                                <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface-variant">{st ? st.replies : "—"}</span>
                                <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface">{st ? st.strong : "—"}</span>
                                <span className="shrink-0 w-14 text-right tabular-nums font-mono text-body-sm text-on-surface">{fmtLichess(l)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      );
                    })()
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
