import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FidePlayer,
  GameSummary,
  IndividualPrepResult,
  LikelyOpponent,
  PlayerInfo,
  PrepContext,
  ShortlistEntry,
  TeamPrepResult,
  TeamScheduleRound,
} from "../../types";
import RoundPicker from "./RoundPicker";
import RoundInfoCard from "./RoundInfoCard";
import BoardInput from "./BoardInput";
import AddGameDialog from "../AddGameDialog";
import { Tag, defaultNewGameTags } from "../../lib/pgnEditor";
import { loadMyPlayer } from "../MyStatsWidget";

// "2026-06-26 18:15" or ISO → "2026.06.26". Returns null if unparseable.
function pgnDateFromDatetime(dt: string | null | undefined): string | null {
  const datePart = dt?.split(/[ T]/)[0];
  return datePart && /^\d{4}-\d{2}-\d{2}$/.test(datePart)
    ? datePart.replace(/-/g, ".")
    : null;
}

function buildTeamPrepTags(
  tournamentName: string,
  myTeamName: string,
  result: TeamPrepResult,
): Tag[] {
  const me = loadMyPlayer();
  const playerIsWhite = result.color === "White";
  // Opponent name unknown until the user picks from the list — leave blank.
  const white = playerIsWhite ? (me?.name ?? "") : "";
  const black = playerIsWhite ? "" : (me?.name ?? "");
  const whiteTeam = playerIsWhite ? myTeamName : result.opponent_team;
  const blackTeam = playerIsWhite ? result.opponent_team : myTeamName;
  const whiteFideId = playerIsWhite ? (me?.fide_id ?? null) : null;
  const blackFideId = playerIsWhite ? null : (me?.fide_id ?? null);

  const overrides: Record<string, string> = {
    Event: tournamentName,
    Round: String(result.round),
    White: white,
    Black: black,
    Result: "*",
  };
  const pgnDate = pgnDateFromDatetime(result.datetime);
  if (pgnDate) overrides.Date = pgnDate;
  const tags: Tag[] = defaultNewGameTags().map(t =>
    overrides[t.name] !== undefined ? { ...t, value: overrides[t.name] } : t,
  );
  tags.push({ name: "WhiteTeam", value: whiteTeam });
  tags.push({ name: "BlackTeam", value: blackTeam });
  if (whiteFideId != null) tags.push({ name: "WhiteFideId", value: String(whiteFideId) });
  if (blackFideId != null) tags.push({ name: "BlackFideId", value: String(blackFideId) });
  return tags;
}

function buildIndividualPrepTags(
  tournamentName: string,
  myName: string,
  myFideId: number | null,
  result: IndividualPrepResult,
): Tag[] {
  const playerIsWhite = result.my_color === "White";
  const white = playerIsWhite ? myName : (result.opponent_name ?? "");
  const black = playerIsWhite ? (result.opponent_name ?? "") : myName;
  const whiteFideId = playerIsWhite ? myFideId : result.opponent_fide_id;
  const blackFideId = playerIsWhite ? result.opponent_fide_id : myFideId;
  const overrides: Record<string, string> = {
    Event: tournamentName,
    Round: String(result.round),
    White: white,
    Black: black,
    Result: "*",
  };
  const pgnDate = pgnDateFromDatetime(result.datetime);
  if (pgnDate) overrides.Date = pgnDate;
  const tags: Tag[] = defaultNewGameTags().map(t =>
    overrides[t.name] !== undefined ? { ...t, value: overrides[t.name] } : t,
  );
  if (whiteFideId != null) tags.push({ name: "WhiteFideId", value: String(whiteFideId) });
  if (blackFideId != null) tags.push({ name: "BlackFideId", value: String(blackFideId) });
  return tags;
}

const teamPrepCache = new Map<string, TeamPrepResult>();

interface Props {
  entry: ShortlistEntry;
  onOpponentsReady: (ctx: PrepContext) => void;
  onShowGame: (player: PlayerInfo, game: GameSummary) => void;
}

// ── Individual tournament panel ───────────────────────────────────────────────

function IndividualPanel({ entry, onOpponentsReady, onShowGame }: { entry: Extract<ShortlistEntry, { kind: "Individual" }>; onOpponentsReady: (ctx: PrepContext) => void; onShowGame: (player: PlayerInfo, game: GameSummary) => void }) {
  const [result, setResult] = useState<IndividualPrepResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState<number | null>(null);
  const [addGamePrefill, setAddGamePrefill] = useState<Tag[] | null>(null);
  // null = unknown / still checking / no match. Set means the round's game
  // already exists in the local DB and the user can jump to it.
  const [dbMatch, setDbMatch] = useState<{ me: PlayerInfo; game: GameSummary } | null>(null);
  const [inDbReloadKey, setInDbReloadKey] = useState(0);
  // FIDE-canonical opponent name resolved via fide_player. Chess-results often
  // spells names with extra qualifiers ("Schwab, Rene Mag.(Fh)") that won't
  // match our FIDE-normalised DB rows or display nicely. Falls back to the
  // chess-results spelling if the lookup yields nothing.
  const [fideOppName, setFideOppName] = useState<string | null>(null);
  const [fideOppLoading, setFideOppLoading] = useState(false);

  useEffect(() => {
    const fideId = result?.opponent_fide_id;
    if (!fideId) { setFideOppName(null); setFideOppLoading(false); return; }
    let cancelled = false;
    setFideOppLoading(true);
    invoke<FidePlayer | null>("fide_player", { fideId })
      .then((p) => { if (!cancelled) { setFideOppName(p?.name ?? null); setFideOppLoading(false); } })
      .catch(() => { if (!cancelled) { setFideOppName(null); setFideOppLoading(false); } });
    return () => { cancelled = true; };
  }, [result?.opponent_fide_id]);

  const displayedOpponentName = fideOppName ?? result?.opponent_name ?? null;
  // Result with the FIDE-canonical opponent name slotted in for display and
  // downstream lookups. Anything that consumes `result.opponent_name` should
  // use this projection instead.
  const displayedResult: IndividualPrepResult | null = result && displayedOpponentName !== result.opponent_name
    ? { ...result, opponent_name: displayedOpponentName }
    : result;

  // Check whether this round's game already exists locally.
  useEffect(() => {
    if (!result?.opponent_name) { setDbMatch(null); return; }
    // Wait for the FIDE canonical-name lookup to settle before querying so we
    // don't first miss the match on the chess-results spelling and then flip.
    if (fideOppLoading) return;
    const opponent = displayedOpponentName ?? result.opponent_name;
    const myFide = entry.my_fide_id ?? loadMyPlayer()?.fide_id ?? null;
    const myName = entry.my_name;

    let cancelled = false;
    (async () => {
      try {
        // Resolve my player id: prefer FIDE id (exact), fall back to name prefix.
        const playerLookup = myFide != null
          ? `/api/players?fide_id=${myFide}`
          : `/api/players?name=${encodeURIComponent(myName)}`;
        const playerResp = await fetch(playerLookup);
        if (!playerResp.ok) throw new Error(`players ${playerResp.status}`);
        const players = (await playerResp.json()) as PlayerInfo[];
        const me = myFide != null ? players[0] : players.find(p => p.name === myName);
        if (!me) { if (!cancelled) setDbMatch(null); return; }

        const q = new URLSearchParams({
          player_id: String(me.id),
          opponent,
          event: entry.name,
          limit: "1",
        });
        const gamesResp = await fetch(`/api/games?${q}`);
        if (!gamesResp.ok) throw new Error(`games ${gamesResp.status}`);
        const games = (await gamesResp.json()) as GameSummary[];
        if (!cancelled) setDbMatch(games.length > 0 ? { me, game: games[0] } : null);
      } catch {
        if (!cancelled) setDbMatch(null); // unknown — show the add button by default
      }
    })();
    return () => { cancelled = true; };
  }, [result?.opponent_name, displayedOpponentName, fideOppLoading, entry.id, entry.my_fide_id, entry.my_name, entry.name, inDbReloadKey]);

  useEffect(() => {
    load(undefined);
  }, [entry.id]);

  async function load(r: number | undefined) {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<IndividualPrepResult>("get_individual_prep", {
        tournamentId: entry.id,
        round: r ?? null,
      });
      setResult(res);
      setRound(res.round);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleRoundChange(r: number) {
    setRound(r);
    load(r);
  }

  function handlePrepare() {
    if (!displayedResult?.opponent_name) return;
    const opponent: LikelyOpponent = {
      snr: displayedResult.opponent_snr ?? 0,
      name: displayedResult.opponent_name,
      rating: displayedResult.opponent_rating,
      probability: 100,
      fide_id: displayedResult.opponent_fide_id,
      tournament_points: null,
      performance: null,
    };
    onOpponentsReady({
      tournamentName: entry.name,
      round: displayedResult.round,
      datetime: displayedResult.datetime,
      color: displayedResult.my_color,
      board: null,
      opponentTeam: null,
      opponents: [opponent],
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-3 shrink-0 space-y-3">
        <div className="flex items-center gap-4">
          {round !== null && (
            <RoundPicker kind="individual" currentRound={round} onChange={handleRoundChange} />
          )}
          {loading && <span className="text-body-sm text-on-surface-variant">Loading…</span>}
        </div>
        {error && <div className="text-body-sm text-error">{error}</div>}
        {displayedResult && <RoundInfoCard kind="individual" result={displayedResult} />}
      </div>

      {displayedResult?.opponent_name && (
        <div className="px-4 py-3 flex items-center gap-2">
          <button
            onClick={handlePrepare}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
          >
            Search opponent →
          </button>
          {dbMatch ? (
            <>
              <span className="text-body-sm text-on-surface-variant">Game already in the database</span>
              <button
                onClick={() => onShowGame(dbMatch.me, dbMatch.game)}
                className="h-9 px-4 inline-flex items-center rounded-full border border-outline text-on-surface text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
              >
                Show the game →
              </button>
            </>
          ) : (
            <button
              onClick={() => setAddGamePrefill(buildIndividualPrepTags(entry.name, entry.my_name, entry.my_fide_id ?? loadMyPlayer()?.fide_id ?? null, displayedResult))}
              title="Add this game to the database with prefilled headers"
              className="h-9 px-4 inline-flex items-center rounded-full border border-outline text-on-surface text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
            >
              + Add game
            </button>
          )}
        </div>
      )}

      {addGamePrefill && (
        <AddGameDialog
          initialMode="scratch"
          initialTags={addGamePrefill}
          onClose={() => setAddGamePrefill(null)}
          onImported={() => setInDbReloadKey(k => k + 1)}
        />
      )}
    </div>
  );
}

// ── Team tournament panel ─────────────────────────────────────────────────────

function TeamPanel({ entry, onOpponentsReady }: { entry: Extract<ShortlistEntry, { kind: "Team" }>; onOpponentsReady: (ctx: PrepContext) => void }) {
  const [schedule, setSchedule] = useState<TeamScheduleRound[]>([]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [prepLoading, setPrepLoading] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  // Last successfully loaded team-prep result for the current selection. Used
  // to enable the "+ Add game" button once we know the matchup + my color.
  const [lastPrep, setLastPrep] = useState<TeamPrepResult | null>(null);
  const [addGamePrefill, setAddGamePrefill] = useState<Tag[] | null>(null);

  useEffect(() => {
    loadSchedule();
  }, [entry.id]);

  async function loadSchedule() {
    setScheduleError(null);
    try {
      const rounds = await invoke<TeamScheduleRound[]>("get_team_schedule", {
        tournamentId: entry.id,
      });
      setSchedule(rounds);
      const upcoming = rounds.find((r) => !r.is_played) ?? rounds[rounds.length - 1];
      if (upcoming) setSelectedRound(upcoming.round);
    } catch (e) {
      setScheduleError(String(e));
    }
  }

  async function handleLoadOpponents(board: number) {
    if (!selectedRound) return;
    const cacheKey = `${entry.id}:${selectedRound}:${board}`;
    const cached = teamPrepCache.get(cacheKey);
    if (cached) {
      setLastPrep(cached);
      onOpponentsReady({
        tournamentName: entry.name,
        round: cached.round,
        datetime: cached.datetime,
        color: cached.color,
        board,
        opponentTeam: cached.opponent_team,
        opponents: cached.opponents,
      });
      return;
    }
    setPrepLoading(true);
    setPrepError(null);
    try {
      const res = await invoke<TeamPrepResult>("get_team_prep", {
        tournamentId: entry.id,
        round: selectedRound,
        myBoard: board,
      });
      teamPrepCache.set(cacheKey, res);
      setLastPrep(res);
      onOpponentsReady({
        tournamentName: entry.name,
        round: res.round,
        datetime: res.datetime,
        color: res.color,
        board,
        opponentTeam: res.opponent_team,
        opponents: res.opponents,
      });
    } catch (e) {
      setPrepError(String(e));
    } finally {
      setPrepLoading(false);
    }
  }

  function handleRoundChange(r: number) {
    setSelectedRound(r);
    setPrepError(null);
    setLastPrep(null);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Single toolbar row: Round + Board + Load */}
      <div className="px-4 py-3 shrink-0 flex items-center gap-4 flex-wrap">
        {scheduleError && <div className="text-body-sm text-error">{scheduleError}</div>}
        {schedule.length === 0 && !scheduleError && (
          <span className="text-body-sm text-on-surface-variant">Loading schedule…</span>
        )}
        {schedule.length > 0 && selectedRound !== null && (
          <RoundPicker
            kind="team"
            schedule={schedule}
            value={selectedRound}
            onChange={handleRoundChange}
          />
        )}
        <BoardInput onSubmit={handleLoadOpponents} loading={prepLoading} />
        {lastPrep?.color && (
          <button
            onClick={() => setAddGamePrefill(buildTeamPrepTags(entry.name, entry.my_team_name, lastPrep))}
            title="Add this game to the database with prefilled headers (opponent name left blank)"
            className="h-9 px-4 inline-flex items-center rounded-full border border-outline text-on-surface text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
          >
            + Add game
          </button>
        )}
      </div>

      {prepError && (
        <div className="px-4 py-2 text-body-sm text-error shrink-0">{prepError}</div>
      )}

      {addGamePrefill && (
        <AddGameDialog
          initialMode="scratch"
          initialTags={addGamePrefill}
          onClose={() => setAddGamePrefill(null)}
        />
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function TournamentPrepPanel({ entry, onOpponentsReady, onShowGame }: Props) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-3 bg-surface-container shrink-0">
        <div className="text-title-md text-on-surface truncate">{entry.name}</div>
        <div className="text-body-sm text-on-surface-variant mt-0.5">
          {entry.kind === "Team" ? `Team: ${entry.my_team_name}` : `SNR: ${entry.my_snr} · ${entry.my_name}`}
        </div>
      </div>

      {entry.kind === "Individual" ? (
        <IndividualPanel entry={entry} onOpponentsReady={onOpponentsReady} onShowGame={onShowGame} />
      ) : (
        <TeamPanel entry={entry} onOpponentsReady={onOpponentsReady} />
      )}
    </div>
  );
}
