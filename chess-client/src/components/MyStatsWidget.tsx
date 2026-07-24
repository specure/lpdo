// Personalised stats widget shown on the Home screen.
// Fully self-contained — owns its localStorage key and all async fetches.
//
// State machine:
//   myPlayer === null → SetupForm (name autocomplete + FIDE ID fallback)
//   myPlayer set     → StatsView (ratings / activity / games in DB)

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FideActivity, FidePlayer, FideRecentGame, PlayerInfo, PlayerStats, StatusInfo } from "../types";
import CountUp from "./CountUp";

const MY_PLAYER_KEY = "myPlayer";

export function loadMyPlayer(): PlayerInfo | null {
  try {
    const raw = localStorage.getItem(MY_PLAYER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Persist the user's chosen player identity (shared by the Home widget and the
 *  setup wizard so both write the same `myPlayer` key). */
export function saveMyPlayer(player: PlayerInfo): void {
  localStorage.setItem(MY_PLAYER_KEY, JSON.stringify(player));
}

// Linear performance estimate: avg(opponent_rating + 400 * score), score ∈ {-1, 0, +1}.
// Same formula as PlayerProfileModal — keep them consistent.
function fidePerformance(games: FideRecentGame[], ratingType: string): number | null {
  let sum = 0, count = 0;
  for (const g of games.filter((g) => g.rating_type === ratingType)) {
    if (g.opponent_rating !== null) {
      const score = g.result === "1" ? 1 : g.result === "0" ? -1 : 0;
      sum += g.opponent_rating + 400 * score;
      count++;
    }
  }
  return count > 0 ? Math.round(sum / count) : null;
}

function WDL({ w, d, l }: { w: number; d: number; l: number }) {
  return (
    <span>
      <span className="text-success">{Math.round(w)}%</span>
      <span className="text-on-surface-variant"> / </span>
      <span className="text-on-surface">{Math.round(d)}%</span>
      <span className="text-on-surface-variant"> / </span>
      <span className="text-error">{Math.round(l)}%</span>
    </span>
  );
}

// ── Setup form ────────────────────────────────────────────────────────────────

export function ProfileSetupForm({ onSave }: { onSave: (p: PlayerInfo) => void }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PlayerInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [fideInput, setFideInput] = useState("");
  const [fideLoading, setFideLoading] = useState(false);
  const [fideError, setFideError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Debounced name search — same pattern as PlayerList.tsx
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setSuggestions([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/players?name=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => r.ok ? r.json() : [])
        .then((data: PlayerInfo[]) => { setSuggestions(data.slice(0, 8)); setOpen(true); })
        .catch(() => {});
    }, 300);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  useEffect(() => { setHighlighted(0); }, [suggestions]);

  // Close dropdown on outside click
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function handleFideLookup() {
    const id = parseInt(fideInput.trim(), 10);
    if (!Number.isFinite(id) || id <= 0) return;
    setFideLoading(true);
    setFideError(null);
    try {
      // Try local DB first (gives us a real id so DB stats work too)
      const res = await fetch(`/api/players?fide_id=${id}`);
      if (res.ok) {
        const arr: PlayerInfo[] = await res.json();
        if (arr.length > 0) { onSave(arr[0]); return; }
      }
      // Fall back to ratings.fide.com for FIDE-only lookup
      const fp = await invoke<FidePlayer | null>("fide_player", { fideId: id });
      if (fp?.name) {
        onSave({ id: 0, name: fp.name, fide_id: id, game_count: 0 });
      } else {
        setFideError("No player found with this FIDE ID.");
      }
    } catch (e) {
      setFideError(String(e));
    } finally {
      setFideLoading(false);
    }
  }

  return (
    <div className="bg-surface-container-highest rounded-2xl p-6">
      <div className="flex items-start gap-4 mb-5">
        {/* Decorative chip — same primary tone as the populated header */}
        <div className="w-12 h-12 shrink-0 inline-flex items-center justify-center rounded-2xl bg-primary-container text-on-primary-container text-xl">
          ♟
        </div>
        <div>
          <h2 className="text-title-lg text-on-surface">My profile</h2>
          <p className="text-body-md text-on-surface-variant mt-1">
            Set yourself as a player to see your FIDE ratings, activity, and games in the database.
          </p>
        </div>
      </div>
      <div className="space-y-3">
        {/* Name autocomplete */}
        <div ref={ref} className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => query.trim().length >= 2 && setOpen(true)}
            onKeyDown={(e) => {
              if (!open || suggestions.length === 0) return;
              if (e.key === "ArrowDown") { setHighlighted((i) => Math.min(suggestions.length - 1, i + 1)); e.preventDefault(); }
              else if (e.key === "ArrowUp") { setHighlighted((i) => Math.max(0, i - 1)); e.preventDefault(); }
              else if (e.key === "Enter" && suggestions[highlighted]) { onSave(suggestions[highlighted]); e.preventDefault(); }
              else if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Search your name…"
            className="w-full h-10 px-4 rounded-full bg-surface-container-high text-on-surface placeholder:text-on-surface-variant text-body-md border border-transparent focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
          />
          {open && suggestions.length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-1 bg-surface-container-high rounded-md shadow-xl max-h-56 overflow-y-auto py-1">
              {suggestions.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSave(p)}
                  onMouseEnter={() => setHighlighted(i)}
                  className={`w-full text-left px-3 py-2 text-body-sm transition-colors duration-short3 ease-standard ${
                    i === highlighted ? "bg-on-surface/8" : ""
                  } hover:bg-on-surface/8`}
                >
                  <div className="text-on-surface">{p.name}</div>
                  {p.fide_id && (
                    <div className="text-label-sm text-on-surface-variant">
                      FIDE {p.fide_id} · {p.game_count.toLocaleString()} games
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* FIDE ID fallback */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-outline-variant" />
          <span className="text-label-sm text-on-surface-variant">or use FIDE ID</span>
          <div className="flex-1 h-px bg-outline-variant" />
        </div>
        <div className="flex gap-2">
          <input
            type="number"
            value={fideInput}
            onChange={(e) => { setFideInput(e.target.value); setFideError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleFideLookup(); }}
            placeholder="e.g. 1503014"
            className="flex-1 h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm font-mono border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant transition-colors duration-short3 ease-standard"
          />
          <button
            onClick={handleFideLookup}
            disabled={!fideInput.trim() || fideLoading}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard"
          >
            {fideLoading ? "Looking up…" : "Set"}
          </button>
        </div>
        {fideError && <p className="text-body-sm text-error">{fideError}</p>}
      </div>
    </div>
  );
}

// ── Stats view ────────────────────────────────────────────────────────────────

// Memoised so a status poll during a long import (the `status` object changes
// every tick) doesn't re-render — and thus re-animate — the FIDE stat tiles,
// whose values don't actually change. Only `dbStatsAvailable` (a stable boolean
// once the DB is non-empty) is passed instead of the whole status object.
const StatsView = memo(function StatsView({
  player, onClear, countStartDelayMs = 0, dbStatsAvailable,
}: {
  player: PlayerInfo;
  onClear: () => void;
  countStartDelayMs?: number;
  /** Whether DB stats are worth fetching (server up + DB non-empty). Gates the
   *  /api/players/:id/stats call, which 500s on an empty/offline DB. */
  dbStatsAvailable: boolean;
}) {
  const [fidePlayer, setFidePlayer] = useState<FidePlayer | null>(null);
  const [fideActivity, setFideActivity] = useState<FideActivity | null>(null);
  const [fideGames, setFideGames] = useState<FideRecentGame[] | null>(null);
  const [fideLoading, setFideLoading] = useState(false);
  const [fideError, setFideError] = useState<string | null>(null);

  const [dbStats, setDbStats] = useState<PlayerStats | null>(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  // FIDE data — only when a FIDE ID is available
  useEffect(() => {
    if (!player.fide_id) return;
    setFideLoading(true);
    setFideError(null);
    Promise.all([
      invoke<FidePlayer | null>("fide_player", { fideId: player.fide_id }),
      invoke<FideActivity>("fide_activity", { fideId: player.fide_id }),
      invoke<FideRecentGame[]>("fide_recent_games", { fideId: player.fide_id }),
    ])
      .then(([fp, fa, fg]) => { setFidePlayer(fp); setFideActivity(fa); setFideGames(fg); })
      .catch((e) => setFideError(String(e)))
      .finally(() => setFideLoading(false));
  }, [player.fide_id]);

  // DB stats — only for players that exist in the local database (id !== 0)
  // and only when there are actually games to look up (otherwise the endpoint
  // returns 500 / nothing useful and we'd just show a bare red error).
  useEffect(() => {
    if (player.id === 0 || !dbStatsAvailable) {
      setDbStats(null);
      setDbError(null);
      return;
    }
    setDbLoading(true);
    setDbError(null);
    fetch(`/api/players/${player.id}/stats`)
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json() as Promise<PlayerStats>; })
      .then((data) => setDbStats(data))
      .catch((e) => setDbError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDbLoading(false));
  }, [player.id, dbStatsAvailable]);

  // Featured FIDE tiles — same shape, bigger padding for breathing room. Each
  // tile gets a different hover wash via its conceptual M3 role colour, so the
  // user sees "different facets of you" at a glance:
  //   Ratings     → primary  (current strength)
  //   Performance → tertiary (recent form, same hue family as the Prep card)
  //   Activity    → secondary (engagement volume)
  const tileBase = "rounded-md px-4 py-3 bg-surface-container transition-colors duration-short3 ease-standard";
  const ratingsTile     = `${tileBase} hover:bg-primary-container/40`;
  const performanceTile = `${tileBase} hover:bg-tertiary-container/40`;
  const activityTile    = `${tileBase} hover:bg-secondary-container/40`;
  const tileLabel = "text-label-sm text-on-surface-variant uppercase tracking-wider";

  // Render an inline rating row like "Std 1915  Rpd 1951  Blz 1896" with
  // headline-scale numbers — featured presentation for current-state stats.
  // Uses mode="fade" because ratings are scores, not tallies: a count-up from
  // 0 → 1915 would imply an accumulation that's not actually happening.
  function FeaturedRatingRow({
    items,
  }: { items: { label: string; value: number | null }[] }) {
    const visible = items.filter((it) => it.value !== null) as { label: string; value: number }[];
    if (visible.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 items-baseline">
        {visible.map((it) => (
          <span key={it.label} className="text-headline-sm text-on-surface font-medium">
            <span className="text-on-surface-variant text-label-md font-normal mr-1.5">{it.label}</span>
            <CountUp value={it.value} plain mode="fade" startDelayMs={countStartDelayMs} />
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="bg-surface-container-highest rounded-2xl overflow-hidden">
      {/* Identity strip — primary-container hero so the player's profile feels owned */}
      <div className="bg-primary-container text-on-primary-container px-6 py-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 shrink-0 inline-flex items-center justify-center rounded-full bg-primary text-on-primary text-title-lg font-medium">
            {player.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-title-lg truncate">{player.name}</div>
            <div className="text-body-sm opacity-80">
              {player.fide_id ? `FIDE ${player.fide_id}` : "No FIDE ID"}
            </div>
          </div>
        </div>
        <button
          onClick={onClear}
          className="w-9 h-9 inline-flex items-center justify-center rounded-full text-on-primary-container hover:bg-on-primary-container/10 active:bg-on-primary-container/15 transition-colors duration-short3 ease-standard shrink-0 text-lg leading-none"
          title="Change player"
        >
          ×
        </button>
      </div>

      <div className="p-5 space-y-5">
        {/* FIDE row — order by relevance: Ratings → Performance → Activity */}
        {player.fide_id && (
          fideLoading ? (
            <p className="text-body-sm text-on-surface-variant">Loading FIDE data…</p>
          ) : fideError ? (
            <p className="text-body-sm text-error">{fideError}</p>
          ) : (() => {
            const std = fideGames ? fidePerformance(fideGames, "STD") : null;
            const rpd = fideGames ? fidePerformance(fideGames, "RPD") : null;
            const blz = fideGames ? fidePerformance(fideGames, "BLZ") : null;
            const hasPerf = std !== null || rpd !== null || blz !== null;
            return (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* 1. Ratings — current strength, top of the hierarchy */}
                {fidePlayer && (
                  <div className={ratingsTile}>
                    <div className={tileLabel}>Ratings</div>
                    <FeaturedRatingRow items={[
                      { label: "Std", value: fidePlayer.rating },
                      { label: "Rpd", value: fidePlayer.rapid_rating },
                      { label: "Blz", value: fidePlayer.blitz_rating },
                    ]} />
                  </div>
                )}
                {/* 2. Performance — recent form, same prominence as Ratings */}
                {fideGames && (
                  <div className={performanceTile}>
                    <div className={tileLabel}>Performance (last 3 months)</div>
                    {hasPerf ? (
                      <FeaturedRatingRow items={[
                        { label: "Std", value: std },
                        { label: "Rpd", value: rpd },
                        { label: "Blz", value: blz },
                      ]} />
                    ) : (
                      <div className="text-body-md text-on-surface-variant mt-2">No recent rated games</div>
                    )}
                  </div>
                )}
                {/* 3. Activity — engagement volume, slightly less prominent */}
                {fideActivity && (
                  <div className={activityTile}>
                    <div className={tileLabel}>Activity (last 12 months)</div>
                    <div className="text-body-lg text-on-surface flex flex-wrap gap-x-4 gap-y-1 mt-2">
                      <span><span className="text-on-surface-variant text-body-sm mr-1">Classical</span><CountUp value={fideActivity.classical} plain startDelayMs={countStartDelayMs} /></span>
                      <span><span className="text-on-surface-variant text-body-sm mr-1">Rapid</span><CountUp value={fideActivity.rapid} plain startDelayMs={countStartDelayMs} /></span>
                      <span><span className="text-on-surface-variant text-body-sm mr-1">Blitz</span><CountUp value={fideActivity.blitz} plain startDelayMs={countStartDelayMs} /></span>
                      <span><span className="text-on-surface-variant text-body-sm mr-1">Total</span><CountUp value={fideActivity.classical + fideActivity.rapid + fideActivity.blitz} plain startDelayMs={countStartDelayMs} /></span>
                    </div>
                  </div>
                )}
              </div>
            );
          })()
        )}

        {/* DB stats — deemphasized: single inline row, divider above, muted text */}
        {player.id !== 0 && dbStatsAvailable && (
          dbLoading ? (
            <p className="text-body-sm text-on-surface-variant">Loading database stats…</p>
          ) : dbError ? (
            <p className="text-body-sm text-error">{dbError}</p>
          ) : dbStats ? (
            <div className="border-t border-outline-variant pt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-body-md text-on-surface-variant">
              <span className={`${tileLabel} mr-2`}>Games in database</span>
              <span>
                <span className="text-on-surface font-medium"><CountUp value={dbStats.total} startDelayMs={countStartDelayMs} /></span> total
              </span>
              <span className="text-outline">·</span>
              <span>
                <span className="text-on-surface font-medium"><CountUp value={dbStats.as_white} startDelayMs={countStartDelayMs} /></span> as White{" "}
                <span className="text-body-sm">
                  (<WDL w={dbStats.white_w_pct} d={dbStats.white_d_pct} l={dbStats.white_l_pct} />)
                </span>
              </span>
              <span className="text-outline">·</span>
              <span>
                <span className="text-on-surface font-medium"><CountUp value={dbStats.as_black} startDelayMs={countStartDelayMs} /></span> as Black{" "}
                <span className="text-body-sm">
                  (<WDL w={dbStats.black_w_pct} d={dbStats.black_d_pct} l={dbStats.black_l_pct} />)
                </span>
              </span>
            </div>
          ) : null
        )}
      </div>
    </div>
  );
});

// ── Main export ───────────────────────────────────────────────────────────────

interface MyStatsWidgetProps {
  /** Delay number animations to align with the widget's CSS rise-in. */
  countStartDelayMs?: number;
  /** Server status — used to suppress the DB-stats fetch (and section) when
   *  there's nothing to query (server offline or empty database). */
  status?: StatusInfo | null;
}

export default function MyStatsWidget({ countStartDelayMs, status }: MyStatsWidgetProps = {}) {
  const [myPlayer, setMyPlayer] = useState<PlayerInfo | null>(loadMyPlayer);

  function save(player: PlayerInfo) {
    saveMyPlayer(player);
    setMyPlayer(player);
  }

  // Stable identity so the memoised StatsView isn't re-rendered by a new closure.
  const clear = useCallback(() => {
    localStorage.removeItem(MY_PLAYER_KEY);
    setMyPlayer(null);
  }, []);

  // Collapse the polling `status` object to the one stable boolean StatsView
  // needs, so a status change during an import doesn't churn the memoised tiles.
  const dbStatsAvailable = !!status && status.games > 0;

  return myPlayer
    ? <StatsView player={myPlayer} onClear={clear} countStartDelayMs={countStartDelayMs} dbStatsAvailable={dbStatsAvailable} />
    : <ProfileSetupForm onSave={save} />;
}
