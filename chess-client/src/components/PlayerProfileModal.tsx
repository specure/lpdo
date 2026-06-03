import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PlayerInfo, PlayerStats, OpeningLine, FidePlayer, FideActivity, FideRecentGame, GameSummary } from "../types";
import { Tag, defaultNewGameTags } from "../lib/pgnEditor";
import AddGameDialog from "./AddGameDialog";

// FIDE publishes a game in a later rating period than when it was played
// (typically the next month, but late submissions can land up to ~2 months
// later — a 31-Mar game has been seen under the May period). Returns
// "YYYY-MM" shifted `n` months earlier.
function shiftMonth(period: string, n: number): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Months to look back from a FIDE period when searching for a DB game.
// 0 = same month, 1 = previous, 2 = two months prior (≈ 8 weeks of slack).
const LOOKBACK_MONTHS = [0, 1, 2];

// Build a PGN-style result string ("1-0", "0-1", "1/2-1/2", or "*") from a
// FIDE recent-games row, where `g.result` is from the player's perspective.
function pgnResult(g: FideRecentGame): string {
  const isWhite = g.color === "W";
  if (g.result === "1") return isWhite ? "1-0" : "0-1";
  if (g.result === "0") return isWhite ? "0-1" : "1-0";
  if (g.result === "½" || g.result === "1/2") return "1/2-1/2";
  return "*";
}

function buildPrefillTags(
  g: FideRecentGame,
  player: PlayerInfo,
  fidePlayer: FidePlayer | null,
  opponentFideId: number | null,
): Tag[] {
  const playerIsWhite = g.color === "W";
  const white = playerIsWhite ? player.name : g.opponent;
  const black = playerIsWhite ? g.opponent : player.name;
  const playerRating =
    g.rating_type === "STD" ? fidePlayer?.rating
    : g.rating_type === "RPD" ? fidePlayer?.rapid_rating
    : g.rating_type === "BLZ" ? fidePlayer?.blitz_rating
    : null;
  const whiteElo = playerIsWhite ? playerRating : g.opponent_rating;
  const blackElo = playerIsWhite ? g.opponent_rating : playerRating;
  const whiteFideId = playerIsWhite ? player.fide_id : opponentFideId;
  const blackFideId = playerIsWhite ? opponentFideId : player.fide_id;
  // FIDE publishes a game in the month after it was played, so default the
  // play month to the previous one. Day is unknown ⇒ "??" per PGN convention.
  const date = `${shiftMonth(g.period, 1).replace("-", ".")}.??`;

  const base = defaultNewGameTags();
  const overrides: Record<string, string> = {
    Event: g.event ?? "",
    Date: date,
    White: white,
    Black: black,
    Result: pgnResult(g),
  };
  const tags: Tag[] = base.map(t =>
    overrides[t.name] !== undefined ? { ...t, value: overrides[t.name] } : t,
  );
  if (whiteElo != null) tags.push({ name: "WhiteElo", value: String(whiteElo) });
  if (blackElo != null) tags.push({ name: "BlackElo", value: String(blackElo) });
  if (whiteFideId != null) tags.push({ name: "WhiteFideId", value: String(whiteFideId) });
  if (blackFideId != null) tags.push({ name: "BlackFideId", value: String(blackFideId) });
  return tags;
}

interface Props {
  player: PlayerInfo;
  onClose: () => void;
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

function OpeningsTable({ openings }: { openings: OpeningLine[] }) {
  if (openings.length === 0) return <p className="text-on-surface-variant text-body-sm">No data</p>;
  return (
    <table className="w-full text-body-sm border-separate border-spacing-0">
      <thead>
        <tr className="text-on-surface-variant uppercase tracking-wide">
          <th className="text-left pb-1 pr-2 font-normal w-4">#</th>
          <th className="text-left pb-1 pr-2 font-normal">Opening</th>
          <th className="text-right pb-1 pr-2 font-normal w-10">Games</th>
          <th className="text-right pb-1 pr-2 font-normal w-8 text-success">W%</th>
          <th className="text-right pb-1 pr-2 font-normal w-8">D%</th>
          <th className="text-right pb-1 pr-2 font-normal w-8 text-error">L%</th>
          <th className="text-right pb-1 font-normal w-14">Last</th>
        </tr>
      </thead>
      <tbody>
        {openings.map((o, i) => (
          <tr key={i} className="align-top">
            <td className="text-on-surface-variant pr-2 pt-0.5">{i + 1}.</td>
            <td className="font-mono text-on-surface pr-2 py-0.5 max-w-0 w-full">
              <div className="truncate">{o.line}</div>
            </td>
            <td className="text-right text-on-surface pr-2 pt-0.5 whitespace-nowrap">{o.games}</td>
            <td className="text-right text-success pr-2 pt-0.5 whitespace-nowrap">{Math.round(o.w_pct)}%</td>
            <td className="text-right text-on-surface pr-2 pt-0.5 whitespace-nowrap">{Math.round(o.d_pct)}%</td>
            <td className="text-right text-error pr-2 pt-0.5 whitespace-nowrap">{Math.round(o.l_pct)}%</td>
            <td className="text-right text-on-surface-variant pt-0.5 whitespace-nowrap">
              {o.last_played ? o.last_played : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fidePerformance(games: FideRecentGame[], ratingType: string): number | null {
  let sum = 0, count = 0;
  for (const g of games.filter(g => g.rating_type === ratingType)) {
    if (g.opponent_rating !== null) {
      const score = g.result === "1" ? 1 : g.result === "0" ? -1 : 0;
      sum += g.opponent_rating + 400 * score;
      count++;
    }
  }
  return count > 0 ? Math.round(sum / count) : null;
}

function resultColor(result: string) {
  if (result === "1") return "text-success";
  if (result === "0") return "text-error";
  return "text-on-surface-variant";
}

export default function PlayerProfileModal({ player, onClose }: Props) {
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [fidePlayer, setFidePlayer] = useState<FidePlayer | null>(null);
  const [fideActivity, setFideActivity] = useState<FideActivity | null>(null);
  const [fideGames, setFideGames] = useState<FideRecentGame[] | null>(null);
  const [fideLoading, setFideLoading] = useState(false);
  const [fideError, setFideError] = useState<string | null>(null);

  // For each FIDE recent-games index, the matching local DB game (if any).
  const [dbMatches, setDbMatches] = useState<Record<number, GameSummary>>({});
  // Looked-up opponent FIDE IDs from the local players table, keyed by name.
  // `null` = looked up, not found. Missing key = not yet looked up.
  const [opponentFideIds, setOpponentFideIds] = useState<Record<string, number | null>>({});
  // Reload-trigger so the DB cross-reference re-runs after an Add Game import.
  const [matchesReloadKey, setMatchesReloadKey] = useState(0);
  // Prefilled tag set for the nested Add Game dialog (null = closed).
  const [addGamePrefill, setAddGamePrefill] = useState<Tag[] | null>(null);

  useEffect(() => {
    if (player.id === 0) {
      setStatsLoading(false);
      return;
    }
    fetch(`/api/players/${player.id}/stats`)
      .then((r) => {
        if (!r.ok) throw new Error(`Server error ${r.status}`);
        return r.json() as Promise<PlayerStats>;
      })
      .then((data) => { setStats(data); setStatsLoading(false); })
      .catch((e) => { setStatsError(e.message); setStatsLoading(false); });
  }, [player.id]);

  function handlePrint() {
    const r = (v: number) => Math.round(v);

    const recentGamesHtml = fideGames && fideGames.length > 0 ? `
      <h3>Recent games (last 3 months)</h3>
      <table>
        <thead><tr>
          <th>Period</th><th>Type</th><th>C</th><th>R</th>
          <th>Opponent</th><th style="text-align:right">Rating</th><th>Event</th>
        </tr></thead>
        <tbody>
          ${fideGames.map(g => `<tr>
            <td>${g.period}</td>
            <td>${g.rating_type}</td>
            <td>${g.color}</td>
            <td class="${g.result === "1" ? "win" : g.result === "0" ? "loss" : ""}">${g.result}</td>
            <td>${g.opponent}</td>
            <td style="text-align:right">${g.opponent_rating ?? "—"}${g.opponent_rating_capped ? "*" : ""}</td>
            <td class="muted">${g.event ?? ""}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      ${(() => {
        const std = fidePerformance(fideGames, "STD");
        const rpd = fidePerformance(fideGames, "RPD");
        const blz = fidePerformance(fideGames, "BLZ");
        if (std === null && rpd === null && blz === null) return "";
        return `<p class="muted" style="font-size:11px;margin:4px 0 0">Performance:${std !== null ? `  Classical: ${std}` : ""}${rpd !== null ? `  Rapid: ${rpd}` : ""}${blz !== null ? `  Blitz: ${blz}` : ""}</p>`;
      })()}` : "";

    const openingsHtml = (title: string, openings: OpeningLine[]) => `
      <h3>${title}</h3>
      ${openings.length === 0 ? "<p class='muted'>No data</p>" : `
      <table>
        <thead><tr><th>#</th><th>Opening</th><th style="text-align:right">Games</th>
          <th style="text-align:right">W%</th><th style="text-align:right">D%</th>
          <th style="text-align:right">L%</th><th style="text-align:right">Last</th></tr></thead>
        <tbody>
          ${openings.map((o, i) => `<tr>
            <td class="muted">${i + 1}.</td>
            <td class="mono">${o.line}</td>
            <td style="text-align:right">${o.games}</td>
            <td style="text-align:right" class="win">${r(o.w_pct)}%</td>
            <td style="text-align:right">${r(o.d_pct)}%</td>
            <td style="text-align:right" class="loss">${r(o.l_pct)}%</td>
            <td style="text-align:right" class="muted">${o.last_played ?? ""}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}`;

    const printHtml = `
      <h1>${player.name}</h1>
      <div class="sub">${player.fide_id ? `FIDE ${player.fide_id}` : ""}</div>
      ${fidePlayer || fideActivity ? `<h2>FIDE</h2>` : ""}
      ${fidePlayer ? `
        <div class="cards">
          <div class="card">
            <div class="card-label">Profile</div>
            <div class="card-value">
              Title <b>${fidePlayer.title ?? "—"}</b> &nbsp;│&nbsp;
              Fed <b>${fidePlayer.federation ?? "—"}</b> &nbsp;│&nbsp;
              Born <b>${fidePlayer.birthyear ?? "—"}</b>
            </div>
          </div>
          <div class="card">
            <div class="card-label">Ratings</div>
            <div class="card-value">
              Std <b>${fidePlayer.rating ?? "—"}</b> &nbsp;
              Rpd <b>${fidePlayer.rapid_rating ?? "—"}</b> &nbsp;
              Blz <b>${fidePlayer.blitz_rating ?? "—"}</b>
            </div>
          </div>
        </div>` : ""}
      ${fideActivity ? `
        <div class="card" style="margin-bottom:8px">
          <div class="card-label">Activity (last 12 months)</div>
          <div class="card-value">
            Classical <b>${fideActivity.classical}</b> &nbsp;
            Rapid <b>${fideActivity.rapid}</b> &nbsp;
            Blitz <b>${fideActivity.blitz}</b> &nbsp;
            Total <b>${fideActivity.classical + fideActivity.rapid + fideActivity.blitz}</b>
          </div>
        </div>` : ""}
      ${recentGamesHtml}
      ${stats ? `
        <h2>Games in database</h2>
        <div class="cards">
          <div class="card" style="text-align:center">
            <div class="card-label">Total</div><div class="card-value">${stats.total}</div>
          </div>
          <div class="card" style="text-align:center">
            <div class="card-label">As White</div><div class="card-value">${stats.as_white}</div>
            <div class="muted">${r(stats.white_w_pct)}% / ${r(stats.white_d_pct)}% / ${r(stats.white_l_pct)}%</div>
          </div>
          <div class="card" style="text-align:center">
            <div class="card-label">As Black</div><div class="card-value">${stats.as_black}</div>
            <div class="muted">${r(stats.black_w_pct)}% / ${r(stats.black_d_pct)}% / ${r(stats.black_l_pct)}%</div>
          </div>
        </div>
        ${openingsHtml("Top openings as White", stats.top_openings_white)}
        ${openingsHtml("Top openings as Black", stats.top_openings_black)}
      ` : ""}`;

    const style = document.createElement("style");
    style.id = "chess-print-style";
    style.textContent = `
      @media print {
        body > *:not(#chess-print-root) { display: none !important; }
        #chess-print-root {
          display: block !important;
          font-family: sans-serif; font-size: 12px; color: #111; margin: 0;
        }
        #chess-print-root h1 { font-size: 18px; margin: 0 0 2px; }
        #chess-print-root h2 { font-size: 13px; font-weight: 600; text-transform: uppercase;
          letter-spacing: .05em; color: #555; border-bottom: 1px solid #ddd;
          margin: 16px 0 6px; padding-bottom: 3px; }
        #chess-print-root h3 { font-size: 11px; font-weight: 600; text-transform: uppercase;
          letter-spacing: .05em; color: #888; margin: 12px 0 4px; }
        #chess-print-root .sub { color: #888; font-size: 11px; margin: 0 0 12px; }
        #chess-print-root .cards { display: flex; gap: 12px; margin-bottom: 8px; }
        #chess-print-root .card { border: 1px solid #ddd; border-radius: 4px;
          padding: 6px 10px; flex: 1; }
        #chess-print-root .card-label { font-size: 10px; color: #888;
          text-transform: uppercase; margin-bottom: 2px; }
        #chess-print-root .card-value { font-size: 13px; }
        #chess-print-root table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
        #chess-print-root th { text-align: left; font-size: 10px; text-transform: uppercase;
          color: #888; border-bottom: 1px solid #ddd; padding: 2px 6px 2px 0; }
        #chess-print-root td { padding: 2px 6px 2px 0; border-bottom: 1px solid #f0f0f0;
          vertical-align: top; }
        #chess-print-root .mono { font-family: monospace; font-size: 11px; }
        #chess-print-root .muted { color: #aaa; }
        #chess-print-root .win { color: #2a7a2a; }
        #chess-print-root .loss { color: #c00; }
      }`;

    const div = document.createElement("div");
    div.id = "chess-print-root";
    div.style.display = "none";
    div.innerHTML = printHtml;

    document.head.appendChild(style);
    document.body.appendChild(div);

    const cleanup = () => {
      document.getElementById("chess-print-style")?.remove();
      document.getElementById("chess-print-root")?.remove();
    };
    window.addEventListener("afterprint", cleanup, { once: true });
    document.title = `${player.name.replace(/,\s*/g, "-").replace(/\s+/g, "-")}-Profile`;
    window.print();
  }

  // Cross-reference FIDE recent games against the local DB by player + period + opponent.
  useEffect(() => {
    if (!fideGames || fideGames.length === 0 || player.id === 0) {
      setDbMatches({});
      return;
    }
    // FIDE periods lag the play month — fetch from the earliest lookback
    // month so we don't miss games right at the window edge.
    const periods = fideGames.map(g => g.period).filter(Boolean).sort();
    const maxLookback = Math.max(...LOOKBACK_MONTHS);
    const fromDate = `${shiftMonth(periods[0], maxLookback)}-01`;
    const url = `/api/games?player_id=${player.id}&from=${fromDate}&limit=1000`;
    let cancelled = false;
    fetch(url)
      .then(r => r.ok ? r.json() as Promise<GameSummary[]> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((games) => {
        if (cancelled) return;
        // DB names are FIDE-normalised, so exact-match on the opponent name.
        // Bucket DB games by "YYYY-MM|opponent"; FIDE's period is one month
        // after the game month, so look up both the same and the previous month.
        const bucket = new Map<string, GameSummary>();
        for (const g of games) {
          if (!g.date) continue;
          const ym = g.date.slice(0, 7);
          const opp = g.white === player.name ? g.black
                    : g.black === player.name ? g.white
                    : null;
          if (!opp) continue;
          const key = `${ym}|${opp}`;
          if (!bucket.has(key)) bucket.set(key, g);
        }
        const next: Record<number, GameSummary> = {};
        fideGames.forEach((fg, i) => {
          for (const n of LOOKBACK_MONTHS) {
            const hit = bucket.get(`${shiftMonth(fg.period, n)}|${fg.opponent}`);
            if (hit) { next[i] = hit; break; }
          }
        });
        setDbMatches(next);
      })
      .catch(() => { if (!cancelled) setDbMatches({}); });
    return () => { cancelled = true; };
  }, [fideGames, player.id, player.name, matchesReloadKey]);

  // Look up each opponent's FIDE id in the local DB so the Add Game prefill
  // can populate WhiteFideId / BlackFideId. DB names are FIDE-normalised so we
  // exact-match by name on the prefix-search endpoint.
  useEffect(() => {
    if (!fideGames || fideGames.length === 0) {
      setOpponentFideIds({});
      return;
    }
    const unique = Array.from(new Set(fideGames.map(g => g.opponent).filter(Boolean)));
    let cancelled = false;
    Promise.all(unique.map(async (name) => {
      try {
        const r = await fetch(`/api/players?name=${encodeURIComponent(name)}`);
        if (!r.ok) return [name, null] as const;
        const list = (await r.json()) as PlayerInfo[];
        const exact = list.find(p => p.name === name);
        return [name, exact?.fide_id ?? null] as const;
      } catch {
        return [name, null] as const;
      }
    })).then((pairs) => {
      if (!cancelled) setOpponentFideIds(Object.fromEntries(pairs));
    });
    return () => { cancelled = true; };
  }, [fideGames]);

  useEffect(() => {
    if (!player.fide_id) return;
    const id = player.fide_id;
    setFideLoading(true);
    Promise.all([
      invoke<FidePlayer | null>("fide_player", { fideId: id }),
      invoke<FideActivity>("fide_activity", { fideId: id }),
      invoke<FideRecentGame[]>("fide_recent_games", { fideId: id }),
    ])
      .then(([p, a, g]) => {
        setFidePlayer(p);
        setFideActivity(a);
        setFideGames(g);
        setFideLoading(false);
      })
      .catch((e) => { setFideError(String(e)); setFideLoading(false); });
  }, [player.fide_id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface-container-high rounded-xl shadow-2xl w-[960px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 shrink-0">
          <div>
            <div className="text-title-md text-on-surface">{player.name}</div>
            {player.fide_id && (
              <div className="text-body-sm text-on-surface-variant">FIDE {player.fide_id}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Filled tonal */}
            <button
              onClick={handlePrint}
              className="h-8 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
            >Print / PDF</button>
            <button
              onClick={onClose}
              className="w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard text-base leading-none"
            >✕</button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-5 space-y-5">

          {/* ── FIDE info ── */}
          {player.fide_id && (
            <section>
              <h3 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-2">FIDE</h3>
              {fideLoading && <p className="text-on-surface-variant text-body-sm">Loading…</p>}
              {fideError && <p className="text-error text-body-sm">{fideError}</p>}
              {!fideLoading && !fideError && (
                <div className="space-y-3">
                  {/* Player bio + ratings */}
                  {fidePlayer && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-surface-container-highest rounded-md p-3 space-y-1">
                        <div className="text-label-md text-on-surface-variant">Profile</div>
                        <div className="text-body-sm text-on-surface">
                          <span className="text-on-surface-variant">Title </span>{fidePlayer.title ?? "—"}
                          <span className="mx-2 text-outline">│</span>
                          <span className="text-on-surface-variant">Fed </span>{fidePlayer.federation ?? "—"}
                          <span className="mx-2 text-outline">│</span>
                          <span className="text-on-surface-variant">Born </span>{fidePlayer.birthyear ?? "—"}
                        </div>
                      </div>
                      <div className="bg-surface-container-highest rounded-md p-3 space-y-1">
                        <div className="text-label-md text-on-surface-variant">Ratings</div>
                        <div className="text-body-sm text-on-surface flex gap-3">
                          <span><span className="text-on-surface-variant">Std </span>{fidePlayer.rating ?? "—"}</span>
                          <span><span className="text-on-surface-variant">Rpd </span>{fidePlayer.rapid_rating ?? "—"}</span>
                          <span><span className="text-on-surface-variant">Blz </span>{fidePlayer.blitz_rating ?? "—"}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Activity */}
                  {fideActivity && (
                    <div className="bg-surface-container-highest rounded-md p-3">
                      <div className="text-label-md text-on-surface-variant mb-1">Activity (last 12 months)</div>
                      <div className="text-body-sm text-on-surface flex gap-4">
                        <span><span className="text-on-surface-variant">Classical </span>{fideActivity.classical}</span>
                        <span><span className="text-on-surface-variant">Rapid </span>{fideActivity.rapid}</span>
                        <span><span className="text-on-surface-variant">Blitz </span>{fideActivity.blitz}</span>
                        <span><span className="text-on-surface-variant">Total </span>{fideActivity.classical + fideActivity.rapid + fideActivity.blitz}</span>
                      </div>
                    </div>
                  )}

                  {/* Recent games */}
                  {fideGames && fideGames.length > 0 && (
                    <div>
                      <div className="text-label-md text-on-surface-variant mb-1">Recent games (last 3 months)</div>
                      <table className="w-full text-body-sm border-separate border-spacing-0">
                        <thead>
                          <tr className="text-on-surface-variant uppercase tracking-wide">
                            <th className="pb-1 pr-1 font-normal w-3" title="In local database" aria-label="In local database"></th>
                            <th className="text-left pb-1 pr-2 font-normal w-16">Period</th>
                            <th className="text-left pb-1 pr-2 font-normal w-10">Type</th>
                            <th className="text-left pb-1 pr-2 font-normal w-6">C</th>
                            <th className="text-left pb-1 pr-2 font-normal w-6">R</th>
                            <th className="text-left pb-1 pr-2 font-normal">Opponent</th>
                            <th className="text-right pb-1 pr-2 font-normal w-12">Rating</th>
                            <th className="text-left pb-1 font-normal">Event</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fideGames.map((g, i) => {
                            const match = dbMatches[i];
                            return (
                            <tr key={i} className="align-top">
                              <td className="pr-1 pt-0.5 text-center">
                                {match ? (
                                  <span className="text-primary" title={`In database (game #${match.id})`}>●</span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setAddGamePrefill(buildPrefillTags(g, player, fidePlayer, opponentFideIds[g.opponent] ?? null))}
                                    title="Add this game to the database"
                                    aria-label="Add this game to the database"
                                    className="w-5 h-5 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 hover:text-on-surface active:bg-on-surface/12 transition-colors duration-short3 ease-standard leading-none"
                                  >+</button>
                                )}
                              </td>
                              <td className="text-on-surface-variant pr-2 pt-0.5 whitespace-nowrap">{g.period}</td>
                              <td className="text-on-surface-variant pr-2 pt-0.5">{g.rating_type}</td>
                              <td className="text-on-surface pr-2 pt-0.5">{g.color}</td>
                              <td className={`pr-2 pt-0.5 font-medium ${resultColor(g.result)}`}>{g.result}</td>
                              <td className="text-on-surface pr-2 pt-0.5 whitespace-nowrap">{g.opponent}</td>
                              <td className={`text-right pr-2 pt-0.5 whitespace-nowrap ${g.opponent_rating_capped ? "text-on-surface-variant" : "text-on-surface"}`}>
                                {g.opponent_rating ?? "—"}{g.opponent_rating_capped ? "*" : ""}
                              </td>
                              <td className="text-on-surface-variant pt-0.5 truncate max-w-0 w-full">
                                <div className="truncate" title={g.event ?? ""}>{g.event ?? ""}</div>
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {(() => {
                        const std = fidePerformance(fideGames, "STD");
                        const rpd = fidePerformance(fideGames, "RPD");
                        const blz = fidePerformance(fideGames, "BLZ");
                        if (std === null && rpd === null && blz === null) return null;
                        return (
                          <div className="text-body-sm text-on-surface pt-1 mt-1 flex gap-4">
                            <span className="text-on-surface-variant">Performance</span>
                            {std !== null && <span><span className="text-on-surface-variant">Classical </span>{std}</span>}
                            {rpd !== null && <span><span className="text-on-surface-variant">Rapid </span>{rpd}</span>}
                            {blz !== null && <span><span className="text-on-surface-variant">Blitz </span>{blz}</span>}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                  {fideGames && fideGames.length === 0 && (
                    <p className="text-on-surface-variant text-body-sm">No recent games found</p>
                  )}
                </div>
              )}
            </section>
          )}

          {/* ── DB stats ── */}
          <section>
            <h3 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-2">Games in database</h3>
            {statsLoading && <p className="text-on-surface-variant text-body-md text-center py-4">Loading…</p>}
            {!statsLoading && player.id === 0 && <p className="text-on-surface-variant text-body-md text-center py-4">No games found</p>}
            {statsError && <p className="text-error text-body-md text-center py-4">{statsError}</p>}
            {stats && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-surface-container-highest rounded-md p-3 text-center">
                    <div className="text-headline-sm font-mono text-on-surface">{stats.total}</div>
                    <div className="text-label-md text-on-surface-variant">Total</div>
                  </div>
                  <div className="bg-surface-container-highest rounded-md p-3 text-center">
                    <div className="text-headline-sm font-mono text-on-surface">{stats.as_white}</div>
                    <div className="text-label-md text-on-surface-variant mb-1">As White</div>
                    <div className="text-body-sm">
                      <WDL w={stats.white_w_pct} d={stats.white_d_pct} l={stats.white_l_pct} />
                    </div>
                  </div>
                  <div className="bg-surface-container-highest rounded-md p-3 text-center">
                    <div className="text-headline-sm font-mono text-on-surface">{stats.as_black}</div>
                    <div className="text-label-md text-on-surface-variant mb-1">As Black</div>
                    <div className="text-body-sm">
                      <WDL w={stats.black_w_pct} d={stats.black_d_pct} l={stats.black_l_pct} />
                    </div>
                  </div>
                </div>

                <section>
                  <h3 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-2">Top openings as White</h3>
                  <OpeningsTable openings={stats.top_openings_white} />
                </section>

                <section>
                  <h3 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-2">Top openings as Black</h3>
                  <OpeningsTable openings={stats.top_openings_black} />
                </section>
              </div>
            )}
          </section>

        </div>
      </div>

      {addGamePrefill && (
        <AddGameDialog
          initialMode="scratch"
          initialTags={addGamePrefill}
          onClose={() => setAddGamePrefill(null)}
          onImported={() => setMatchesReloadKey(k => k + 1)}
        />
      )}
    </div>
  );
}
