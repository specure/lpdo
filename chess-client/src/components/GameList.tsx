import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { GameSummary, MoveStats, PlayerInfo } from "../types";
import PlayerProfileModal from "./PlayerProfileModal";

type Color = "any" | "white" | "black";

// Expand a partial date filter into a full ISO date so the SQL date
// comparison covers the intended interval. Year-only and year-month inputs
// are widened to the start / end of that period; YYYY-MM-DD passes through.
//   "2024"     → "2024-01-01" / "2024-12-31"
//   "2024-06"  → "2024-06-01" / "2024-06-30"
function expandDateFrom(s: string): string {
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  return s;
}
function expandDateTo(s: string): string {
  if (/^\d{4}$/.test(s)) return `${s}-12-31`;
  const ym = s.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    const year = parseInt(ym[1], 10);
    const month = parseInt(ym[2], 10);
    // new Date(y, m, 0) returns the last day of month m-1 (1-indexed input
    // becomes the month *after*, day 0 = last day of the target month).
    const lastDay = new Date(year, month, 0).getDate();
    return `${s}-${String(lastDay).padStart(2, "0")}`;
  }
  return s;
}

interface Props {
  player: PlayerInfo;
  selectedId: number | null;
  onSelect: (game: GameSummary) => void;
  moveSequence: string[];
  onMoveAppend: (mv: string) => void;
  onMoveBack: () => void;
  onMoveReset: () => void;
  onPositionModeChange: (active: boolean) => void;
  arrowKeysActive: boolean;
  /** Suspend list arrow-key navigation (e.g. while the moves editor is active). */
  editing?: boolean;
  onTopGameChange?: (game: GameSummary | null) => void;
  onMoveStatsChange?: (stats: MoveStats[]) => void;
  onSelectedMoveChange?: (san: string | null) => void;
  scopePublicOnly?: boolean;
  setScopePublicOnly?: (v: boolean) => void;
  scopeCollectionId?: number | null;
  setScopeCollectionId?: (v: number | null) => void;
  scopeIncludeDeleted?: boolean;
  setScopeIncludeDeleted?: (v: boolean) => void;
  scopeCollections?: { id: number; name: string; game_count: number }[];
  /** Bumped externally to force a re-fetch (e.g. after a game is mutated). */
  reloadKey?: number;
}

function formatElo(elo: number | null) {
  return elo ? `(${elo})` : "";
}

function formatPerf(perf: number | null, perfSe: number | null): string {
  if (perf === null) return "—";
  const sign = perf >= 0 ? "+" : "";
  const base = `${sign}${Math.round(perf)}`;
  return perfSe !== null ? `${base} ±${Math.round(perfSe)}` : base;
}

export default function GameList({
  player,
  selectedId,
  onSelect,
  moveSequence,
  onMoveAppend,
  onMoveBack,
  onMoveReset,
  onPositionModeChange,
  arrowKeysActive,
  editing = false,
  onTopGameChange,
  onMoveStatsChange,
  onSelectedMoveChange,
  scopePublicOnly = false,
  setScopePublicOnly,
  scopeCollectionId = null,
  setScopeCollectionId,
  scopeIncludeDeleted = false,
  setScopeIncludeDeleted,
  scopeCollections = [],
  reloadKey = 0,
}: Props) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [colorPickPromptOpen, setColorPickPromptOpen] = useState(false);
  const [color, setColor] = useState<Color>("any");
  const [opponentInput, setOpponentInput] = useState("");
  const [eventInput, setEventInput] = useState("");
  const [dateFromInput, setDateFromInput] = useState("");
  const [dateToInput, setDateToInput] = useState("");
  const [opponent, setOpponent] = useState("");
  const [event, setEvent] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [games, setGames] = useState<GameSummary[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [movesOpen, setMovesOpen] = useState(false);
  const [moveStats, setMoveStats] = useState<MoveStats[]>([]);
  const [movesLoading, setMovesLoading] = useState(false);

  const [selectedMoveIndex, setSelectedMoveIndex] = useState(0);
  const pendingRestoreMoveRef = useRef<string | null>(null);
  const selectedRowRef = useRef<HTMLButtonElement>(null);

  const abortRef = useRef<AbortController | null>(null);
  const movesAbortRef = useRef<AbortController | null>(null);
  const movesCacheRef = useRef<Map<string, MoveStats[]>>(new Map());
  const selectedGameRowRef = useRef<HTMLButtonElement>(null);
  const pendingGameFocusRef = useRef(false);

  // JS-tracked hover state. We can't use CSS `:hover` because the Tauri
  // webview (Linux Chromium) sometimes leaves :hover applied after the cursor
  // leaves the element if the layout shifts during scroll — the row stays
  // visually "stuck" darker. React onMouseEnter/onMouseLeave + a container-
  // level safety reset gives us deterministic hover painting in both light
  // and dark themes.
  const [hoveredGameId, setHoveredGameId] = useState<number | null>(null);

  const movesEnabled = color !== "any";
  const firstMovesStr = moveSequence.join(" ");

  // Debounce text inputs
  useEffect(() => {
    const t = setTimeout(() => setOpponent(opponentInput), 500);
    return () => clearTimeout(t);
  }, [opponentInput]);

  useEffect(() => {
    const t = setTimeout(() => setEvent(eventInput), 500);
    return () => clearTimeout(t);
  }, [eventInput]);

  useEffect(() => {
    const t = setTimeout(() => setDateFrom(dateFromInput), 500);
    return () => clearTimeout(t);
  }, [dateFromInput]);

  useEffect(() => {
    const t = setTimeout(() => setDateTo(dateToInput), 500);
    return () => clearTimeout(t);
  }, [dateToInput]);

  // Scroll selected move row into view
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedMoveIndex]);

  // Notify parent of the top game whenever the list changes
  useEffect(() => {
    onTopGameChange?.(games[0] ?? null);
  }, [games, onTopGameChange]);

  // Propagate move stats to parent (for board arrows)
  useEffect(() => {
    onMoveStatsChange?.(moveStats);
  }, [moveStats, onMoveStatsChange]);

  // Propagate selected move SAN to parent (for board arrows)
  useEffect(() => {
    onSelectedMoveChange?.(moveStats[selectedMoveIndex]?.mv ?? null);
  }, [selectedMoveIndex, moveStats, onSelectedMoveChange]);

  // Reset when color becomes "any"
  useEffect(() => {
    if (color === "any") {
      onMoveReset();
      setMovesOpen(false);
      setMoveStats([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color]);

  // Reset sequence and close moves when player changes
  useEffect(() => {
    onMoveReset();
    setMoveStats([]);
    setMovesOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.id]);

  // Notify parent of position mode
  useEffect(() => {
    onPositionModeChange(movesOpen && movesEnabled);
  }, [movesOpen, movesEnabled, onPositionModeChange]);

  // Fetch games
  useEffect(() => {
    if (player.id === 0) {
      setGames([]);
      setTotalCount(0);
      setLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setError(null);
    setGames([]);
    setTotalCount(null);

    const params = new URLSearchParams({ player_id: String(player.id), color, limit: "100" });
    if (opponent) params.set("opponent", opponent);
    if (event)    params.set("event",    event);
    if (dateFrom) params.set("from",     expandDateFrom(dateFrom));
    if (dateTo)   params.set("to",       expandDateTo(dateTo));
    if (scopePublicOnly) params.set("visibility", "public");
    if (scopeCollectionId !== null) params.set("collection_id", String(scopeCollectionId));
    if (scopeIncludeDeleted) params.set("include_deleted", "true");
    if (firstMovesStr) {
      const chess = new Chess();
      for (const mv of moveSequence) {
        try { chess.move(mv); } catch { break; }
      }
      params.set("fen", chess.fen());
    }

    const countParams = new URLSearchParams(params);
    countParams.set("count", "true");

    const sig = abortRef.current.signal;
    Promise.all([
      fetch(`/api/games?${params}`, { signal: sig }).then((r) => {
        if (!r.ok) throw new Error(`Server error ${r.status}`);
        return r.json() as Promise<GameSummary[]>;
      }),
      fetch(`/api/games?${countParams}`, { signal: sig }).then((r) => {
        if (!r.ok) throw new Error(`Server error ${r.status}`);
        return r.json() as Promise<{ count: number }>;
      }),
    ])
      .then(([data, { count }]) => {
        setGames(data);
        setTotalCount(count);
        setLoading(false);
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load games");
        setLoading(false);
      });
  }, [player.id, color, opponent, event, dateFrom, dateTo, firstMovesStr, scopePublicOnly, scopeCollectionId, scopeIncludeDeleted, reloadKey]);

  // Fetch position move stats
  useEffect(() => {
    if (!movesOpen || !movesEnabled) return;

    const params = new URLSearchParams({ player_id: String(player.id), color });
    if (firstMovesStr)   params.set("first_moves", firstMovesStr);
    if (dateFrom)        params.set("from",        expandDateFrom(dateFrom));
    if (dateTo)          params.set("to",          expandDateTo(dateTo));
    if (opponent)        params.set(color === "white" ? "black" : "white", opponent);
    if (scopePublicOnly) params.set("visibility",  "public");
    const cacheKey = params.toString();

    const cached = movesCacheRef.current.get(cacheKey);
    if (cached) {
      setMoveStats(cached);
      setMovesLoading(false);
      if (pendingRestoreMoveRef.current !== null) {
        const idx = cached.findIndex((s) => s.mv === pendingRestoreMoveRef.current);
        setSelectedMoveIndex(idx >= 0 ? idx : 0);
        pendingRestoreMoveRef.current = null;
      } else {
        setSelectedMoveIndex(0);
      }
      return;
    }

    movesAbortRef.current?.abort();
    movesAbortRef.current = new AbortController();
    setMovesLoading(true);

    fetch(`/api/position/moves?${params}`, { signal: movesAbortRef.current.signal })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json() as Promise<MoveStats[]>;
      })
      .then((data) => {
        movesCacheRef.current.set(cacheKey, data);
        setMoveStats(data);
        setMovesLoading(false);
        if (pendingRestoreMoveRef.current !== null) {
          const idx = data.findIndex((s) => s.mv === pendingRestoreMoveRef.current);
          setSelectedMoveIndex(idx >= 0 ? idx : 0);
          pendingRestoreMoveRef.current = null;
        } else {
          setSelectedMoveIndex(0);
        }
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setMoveStats([]);
        setMovesLoading(false);
        setSelectedMoveIndex(0);
      });
  }, [movesOpen, movesEnabled, player.id, color, opponent, firstMovesStr, dateFrom, dateTo, scopePublicOnly]);

  // Arrow key navigation between games when a game is selected
  useEffect(() => {
    if (selectedId === null || arrowKeysActive || editing) return;

    function handleKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      // Plain arrows only — let modified arrows (e.g. Ctrl+Shift+Up/Down for the
      // moves editor's promote/demote) fall through to other handlers.
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Enter") return;
      e.preventDefault();
      if (e.key === "Enter") return; // no-op for now; later: open in new window
      const idx = games.findIndex((g) => g.id === selectedId);
      if (idx === -1) return;
      const next = e.key === "ArrowUp" ? idx - 1 : idx + 1;
      if (next >= 0 && next < games.length) {
        pendingGameFocusRef.current = true;
        onSelect(games[next]);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedId, arrowKeysActive, editing, games, onSelect]);

  // Scroll and focus selected game row after keyboard navigation
  useEffect(() => {
    selectedGameRowRef.current?.scrollIntoView({ block: "nearest" });
    if (pendingGameFocusRef.current) {
      selectedGameRowRef.current?.focus();
      pendingGameFocusRef.current = false;
    }
  }, [selectedId]);

  // Arrow key navigation in position mode
  useEffect(() => {
    if (!arrowKeysActive || movesLoading || moveStats.length === 0) return;

    function handleKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      // Plain arrows only — don't hijack modified arrows (e.g. Ctrl+Shift+Up/Down).
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedMoveIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedMoveIndex((i) => Math.min(moveStats.length - 1, i + 1));
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        const stat = moveStats[selectedMoveIndex];
        if (stat) onMoveAppend(stat.mv);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (moveSequence.length > 0) {
          pendingRestoreMoveRef.current = moveSequence[moveSequence.length - 1];
          onMoveBack();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [arrowKeysActive, movesLoading, moveStats, selectedMoveIndex, moveSequence, onMoveAppend, onMoveBack]);

  function toggleMoves() {
    if (!movesEnabled) {
      setColorPickPromptOpen(true);
      return;
    }
    setMovesOpen((o) => !o);
  }

  const activeFilterCount =
    (color !== "any" ? 1 : 0) +
    (opponent ? 1 : 0) +
    (event ? 1 : 0) +
    (dateFrom ? 1 : 0) +
    (dateTo ? 1 : 0) +
    (scopePublicOnly ? 1 : 0) +
    (scopeCollectionId !== null ? 1 : 0) +
    (scopeIncludeDeleted ? 1 : 0);

  const activeMoveCount = moveSequence.length;

  // M3 filter chip — three states:
  //   active (panel open)        → secondary-container fill
  //   inactive but has filters   → tertiary-container hint that something's set
  //   empty                      → outlined chip
  function chipClass(active: boolean, hasValue: boolean) {
    const base = "inline-flex items-center h-7 px-3 rounded-full text-label-md transition-colors duration-short3 ease-standard";
    if (active) return `${base} bg-secondary-container text-on-secondary-container`;
    if (hasValue) return `${base} bg-tertiary-container text-on-tertiary-container hover:brightness-110`;
    return `${base} border border-outline text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12`;
  }

  return (
    <div className="flex flex-col h-full bg-surface-container-low">

      {profileOpen && (
        <PlayerProfileModal player={player} onClose={() => setProfileOpen(false)} />
      )}

      {colorPickPromptOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40"
          onClick={(e) => { if (e.target === e.currentTarget) setColorPickPromptOpen(false); }}
        >
          {/* M3 dialog — Expressive uses xl (28px) corners */}
          <div className="bg-surface-container-high rounded-xl shadow-2xl p-6 flex flex-col items-center gap-5 w-72">
            <p className="text-title-md text-on-surface">Show moves played as…</p>
            <div className="flex gap-3">
              {/* Filled button */}
              <button
                onClick={() => { setColor("white"); setMovesOpen(true); setColorPickPromptOpen(false); }}
                className="h-10 px-5 rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
              >White</button>
              {/* Outlined button */}
              <button
                onClick={() => { setColor("black"); setMovesOpen(true); setColorPickPromptOpen(false); }}
                className="h-10 px-5 rounded-full border border-outline text-on-surface text-label-lg hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
              >Black</button>
            </div>
            {/* Text button */}
            <button
              onClick={() => setColorPickPromptOpen(false)}
              className="h-8 px-3 rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard"
            >Cancel</button>
          </div>
        </div>
      )}

      {/* Player header */}
      <div className="px-3 pt-3 pb-3 shrink-0 space-y-2">
        <div className="text-title-md text-on-surface truncate">{player.name}</div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <button
            onClick={() => setProfileOpen(true)}
            className={chipClass(false, false)}
          >
            Profile
          </button>
          <div className="flex gap-1.5">
            <button
              onClick={() => setFiltersOpen((o) => !o)}
              className={chipClass(filtersOpen, activeFilterCount > 0)}
            >
              {activeFilterCount > 0 ? `Filters · ${activeFilterCount}` : "Filters"}
            </button>
            <button
              onClick={toggleMoves}
              className={chipClass(movesOpen, activeMoveCount > 0)}
            >
              {activeMoveCount > 0 ? `Moves · ${activeMoveCount}` : "Moves"}
            </button>
          </div>
        </div>
      </div>

      {/* Filters section — tonal step up to signal grouping */}
      {filtersOpen && (
        <div className="p-4 bg-surface-container shrink-0 space-y-4">
          <div>
            <div className="text-label-md text-on-surface-variant mb-1.5">Color</div>
            {/* Segmented button — single-select pill */}
            <div className="inline-flex items-center w-full h-9 rounded-full border border-outline overflow-hidden">
              {(["any", "white", "black"] as Color[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`flex-1 h-full text-label-md capitalize transition-colors duration-short3 ease-standard ${
                    color === c
                      ? "bg-secondary-container text-on-secondary-container"
                      : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
                  }`}
                >
                  {c === "any" ? "Both" : c}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-label-md text-on-surface-variant mb-1.5">Opponent</div>
            {/* M3 outlined text field */}
            <input
              type="text"
              value={opponentInput}
              onChange={(e) => setOpponentInput(e.target.value)}
              placeholder="Name…"
              className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-md border border-outline focus:outline-none focus:border-primary focus:border-2 focus:px-[11px] transition-colors duration-short3 ease-standard"
            />
          </div>

          <div>
            <div className="text-label-md text-on-surface-variant mb-1.5">Event</div>
            <input
              type="text"
              value={eventInput}
              onChange={(e) => setEventInput(e.target.value)}
              placeholder="e.g. Wijk aan Zee"
              className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-md border border-outline focus:outline-none focus:border-primary focus:border-2 focus:px-[11px] transition-colors duration-short3 ease-standard"
            />
          </div>

          <div>
            <div className="text-label-md text-on-surface-variant mb-1.5">Date range</div>
            <div className="flex gap-2">
              <input
                type="text"
                value={dateFromInput}
                onChange={(e) => setDateFromInput(e.target.value)}
                placeholder="From (YYYY)"
                className="flex-1 min-w-0 h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-md border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
              />
              <input
                type="text"
                value={dateToInput}
                onChange={(e) => setDateToInput(e.target.value)}
                placeholder="To (YYYY)"
                className="flex-1 min-w-0 h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-md border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
              />
            </div>
          </div>

          {setScopeCollectionId && (
            <div>
              <div className="text-label-md text-on-surface-variant mb-1.5">Collection</div>
              <CollectionSelect
                value={scopeCollectionId}
                onChange={setScopeCollectionId}
                collections={scopeCollections}
              />
            </div>
          )}

          {(setScopePublicOnly || setScopeIncludeDeleted) && (
            <div className="space-y-2 pt-1">
              {setScopePublicOnly && (
                <label className="flex items-center gap-2 text-body-md text-on-surface cursor-pointer">
                  <input
                    type="checkbox"
                    checked={scopePublicOnly}
                    onChange={(e) => setScopePublicOnly(e.target.checked)}
                    className="cursor-pointer accent-primary w-4 h-4"
                  />
                  <span>Public games only</span>
                </label>
              )}
              {setScopeIncludeDeleted && (
                <label className="flex items-center gap-2 text-body-md text-on-surface cursor-pointer">
                  <input
                    type="checkbox"
                    checked={scopeIncludeDeleted}
                    onChange={(e) => setScopeIncludeDeleted(e.target.checked)}
                    className="cursor-pointer accent-primary w-4 h-4"
                  />
                  <span>Show soft-deleted games</span>
                </label>
              )}
            </div>
          )}
        </div>
      )}

      {/* Moves section — same tonal step as filters */}
      {movesOpen && movesEnabled && (
        <div className="bg-surface-container shrink-0">
          {movesLoading ? (
            <div className="p-3 text-center text-on-surface-variant text-body-sm">Loading…</div>
          ) : moveStats.length === 0 ? (
            <div className="p-3 text-center text-on-surface-variant text-body-sm">
              No games reach this position with current filters
            </div>
          ) : (
            <div className="p-3">
              {/* Column headers */}
              <div className="flex items-center text-label-sm text-on-surface-variant px-2 mb-1 select-none">
                <span className="w-10">Move</span>
                <span className="w-12 text-right">Games</span>
                <span className="w-7 text-right">W%</span>
                <span className="w-7 text-right">L%</span>
                <span className="w-10 text-right">Last</span>
                <span className="flex-1 text-right">Perf</span>
              </div>
              {/* Move rows.
                  Backend returns W/D/L and Perf from the perspective of the
                  side-to-move at this position (the player of `next_move`).
                  If the user has picked a color and is browsing a position
                  where the opposite side is to move, flip W↔L and negate
                  Perf so everything reads from the *selected player's* POV. */}
              <div className="max-h-52 overflow-y-auto">
                {(() => {
                  const sideToMove = moveSequence.length % 2 === 0 ? "white" : "black";
                  // `color` is already narrowed to "white" | "black" inside
                  // this branch because the panel only renders when movesEnabled.
                  const invertStats = color !== sideToMove;
                  return moveStats.map((stat, index) => {
                    const wPct = invertStats ? stat.l_pct : stat.w_pct;
                    const lPct = invertStats ? stat.w_pct : stat.l_pct;
                    const perfVal = invertStats && stat.perf !== null ? -stat.perf : stat.perf;
                    const isSelected = index === selectedMoveIndex;
                    const perfColor =
                      perfVal === null ? "text-on-surface-variant"
                      : perfVal > 0    ? "text-success"
                      : perfVal < 0    ? "text-error"
                      : "text-on-surface";

                    return (
                      <button
                        key={stat.mv}
                        ref={isSelected ? selectedRowRef : null}
                        onClick={() => onMoveAppend(stat.mv)}
                        className={`w-full flex items-center text-body-sm px-2 py-1 rounded-sm transition-colors duration-short3 ease-standard ${
                          isSelected
                            ? "bg-secondary-container text-on-secondary-container"
                            : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
                        }`}
                      >
                        <span className="w-10 font-mono">{stat.mv}</span>
                        <span className="w-12 text-right">{stat.games.toLocaleString()}</span>
                        <span className={`w-7 text-right ${isSelected ? "" : "text-success"}`}>{Math.round(wPct)}</span>
                        <span className={`w-7 text-right ${isSelected ? "" : "text-error"}`}>{Math.round(lPct)}</span>
                        <span className={`w-10 text-right ${isSelected ? "text-on-secondary-container/70" : "text-on-surface-variant"}`}>
                          {stat.last_played?.slice(0, 4) ?? "—"}
                        </span>
                        <span className={`flex-1 text-right font-mono ${isSelected ? "" : perfColor}`}>
                          {formatPerf(perfVal, stat.perf_se)}
                        </span>
                      </button>
                    );
                  });
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Game list */}
      <div
        className="flex-1 overflow-y-auto"
        onMouseLeave={() => setHoveredGameId(null)}
      >
        {loading && (
          <div className="p-4 text-center text-on-surface-variant text-body-md">Loading…</div>
        )}
        {error && (
          <div className="p-4 text-center text-error text-body-md">{error}</div>
        )}
        {!loading && !error && games.length === 0 && (
          <div className="p-4 text-center text-on-surface-variant text-body-md">
            No games found
          </div>
        )}
        {games.map((game) => {
          const isDeleted = game.deleted_at != null;
          const selected = selectedId === game.id;
          return (
            <button
              key={game.id}
              ref={selected ? selectedGameRowRef : null}
              onClick={(e) => {
                onSelect(game);
                // Blur after click — without this Chromium retains :focus on the
                // button after selection, which interacts with the hover state
                // and can leave previously-hovered rows visually "stuck" darker.
                e.currentTarget.blur();
              }}
              onMouseEnter={() => setHoveredGameId(game.id)}
              onMouseLeave={() => setHoveredGameId((id) => id === game.id ? null : id)}
              className={`relative w-full text-left px-4 py-3 font-normal focus:outline-none ${
                selected
                  ? "bg-secondary-container text-on-secondary-container"
                  : "text-on-surface"
              } ${isDeleted ? "opacity-60" : ""}`}
            >
              {/* M3 state-layer overlay — driven by React state instead of CSS
                  :hover so the Tauri/Linux webview can't leave it "stuck" when
                  the cursor leaves during a fast scroll. */}
              {!selected && hoveredGameId === game.id && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-on-surface opacity-[0.08]"
                />
              )}
              <div className="relative">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`text-body-md truncate ${isDeleted ? "line-through" : ""}`}>
                    {game.white} {formatElo(game.white_elo)}
                  </span>
                  <span className={`text-body-sm font-mono shrink-0 ${selected ? "text-on-secondary-container/80" : "text-on-surface-variant"}`}>
                    {game.result === "1/2-1/2" ? "½-½" : (game.result ?? "?")}
                  </span>
                </div>
                <div className={`text-body-md truncate ${selected ? "text-on-secondary-container" : "text-on-surface"} ${isDeleted ? "line-through" : ""}`}>
                  {game.black} {formatElo(game.black_elo)}
                </div>
                <div className={`flex items-center gap-2 mt-1 text-body-sm ${selected ? "text-on-secondary-container/70" : "text-on-surface-variant"}`}>
                  {game.date && <span className="whitespace-nowrap">{game.date}</span>}
                  {game.move_count && <span className="whitespace-nowrap">{Math.ceil(game.move_count / 2)} moves</span>}
                  {isDeleted && (
                    <span className="inline-flex items-center h-5 px-2 rounded-full bg-error-container text-on-error-container text-label-sm whitespace-nowrap">
                      deleted {game.deleted_at?.slice(0, 10)}
                    </span>
                  )}
                </div>
                {game.event && (
                  <div className={`text-body-sm truncate mt-0.5 ${selected ? "text-on-secondary-container/60" : "text-on-surface-variant"}`}>{game.event}</div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {games.length > 0 && (
        <div className="px-4 py-2 text-label-md text-on-surface-variant shrink-0">
          {totalCount != null ? totalCount : games.length} game{(totalCount ?? games.length) !== 1 ? "s" : ""}
          {totalCount != null && totalCount > games.length ? ` (showing first ${games.length})` : ""}
        </div>
      )}
    </div>
  );
}

// Custom dropdown for the Collection filter. The native <select> on Linux
// renders its option list with the OS chrome (white background) regardless of
// `color-scheme`, which clashes with the dark M3 theme. This replacement uses
// the same surface tokens as CollectionPicker so it blends in.
function CollectionSelect({ value, onChange, collections }: {
  value: number | null;
  onChange: (id: number | null) => void;
  collections: { id: number; name: string; game_count: number }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const selected = value === null ? null : collections.find((c) => c.id === value);
  const label = selected ? `${selected.name} (${selected.game_count})` : "All collections";

  function pick(id: number | null) {
    onChange(id);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-md border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard flex items-center justify-between gap-2"
      >
        <span className="truncate">{label}</span>
        <span className="text-on-surface-variant text-label-sm shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute z-10 left-0 right-0 mt-1 bg-surface-container-high rounded-md shadow-xl py-1 max-h-64 overflow-y-auto">
          <CollectionOption active={value === null} onClick={() => pick(null)}>
            All collections
          </CollectionOption>
          {collections.map((c) => (
            <CollectionOption key={c.id} active={value === c.id} onClick={() => pick(c.id)}>
              <span className="truncate">{c.name}</span>
              <span className="text-label-sm text-on-surface-variant ml-2 shrink-0">{c.game_count.toLocaleString()}</span>
            </CollectionOption>
          ))}
        </div>
      )}
    </div>
  );
}

function CollectionOption({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-body-sm flex items-center justify-between transition-colors duration-short3 ease-standard ${
        active ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8"
      }`}
    >
      {children}
    </button>
  );
}
