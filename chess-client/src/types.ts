export interface GameSummary {
  id: number;
  white: string;
  black: string;
  white_elo: number | null;
  black_elo: number | null;
  event: string | null;
  date: string | null;
  result: string | null;
  eco: string | null;
  move_count: number | null;
  opening_line: string | null;
  visibility?: string | null;
  /** Soft-delete timestamp (ISO). Null = alive. Only populated when include_deleted=true. */
  deleted_at?: string | null;
  move_number?: number | null;
}

export interface PlayerInfo {
  id: number;
  name: string;
  fide_id: number | null;
  game_count: number;
}

export interface OpeningLine {
  line: string;
  games: number;
  w_pct: number;
  d_pct: number;
  l_pct: number;
  last_played: string | null;
}

export interface PlayerStats {
  total: number;
  as_white: number;
  as_black: number;
  white_w_pct: number;
  white_d_pct: number;
  white_l_pct: number;
  black_w_pct: number;
  black_d_pct: number;
  black_l_pct: number;
  top_openings_white: OpeningLine[];
  top_openings_black: OpeningLine[];
}

export interface MoveStats {
  mv: string;
  games: number;
  w_pct: number;
  d_pct: number;
  l_pct: number;
  elo_p25: number | null;
  elo_p50: number | null;
  elo_p75: number | null;
  perf: number | null;
  perf_se: number | null;
  elite: string | null;
  last_played: string | null;
}

export interface FidePlayer {
  fide_id: number | null;
  name: string | null;
  title: string | null;
  federation: string | null;
  rating: number | null;
  rapid_rating: number | null;
  blitz_rating: number | null;
  birthyear: number | null;
}

/** A single point in a player's FIDE standard-rating history, as published
 *  in the monthly rating list. `period` is "YYYY-MM". */
export interface RatingPoint {
  period: string;
  rating: number;
}

export interface FideActivity {
  classical: number;
  rapid: number;
  blitz: number;
}

export interface FideRecentGame {
  period: string;
  event: string | null;
  opponent: string;
  opponent_rating: number | null;
  opponent_rating_capped: boolean;
  color: string;
  result: string;
  rating_type: string;
}

// ── Tournament prep types ─────────────────────────────────────────────────────

export type ShortlistEntry =
  | { kind: "Individual"; id: string; name: string; url: string; my_snr: number; my_name: string; my_fide_id: number | null }
  | { kind: "Team"; id: string; name: string; url: string; my_team_name: string; home_black_board1: boolean };

export interface ParticipantDto {
  snr: number;
  name: string;
  rating: number | null;
}

export interface TeamDto {
  name: string;
  rtg_avg: number | null;
}

export interface TournamentMeta {
  id: string;
  name: string;
  kind: "individual" | "team";
}

export interface IndividualPrepResult {
  round: number;
  datetime: string | null;
  opponent_name: string | null;
  opponent_rating: number | null;
  opponent_fide_id: number | null;
  opponent_snr: number | null;
  my_color: string | null;
}

export interface TeamScheduleRound {
  round: number;
  date: string | null;
  time: string | null;
  is_played: boolean;
}

export interface LikelyOpponent {
  snr: number;
  name: string;
  rating: number | null;
  probability: number;
  fide_id: number | null;
  tournament_points: string | null;
  performance: number | null;
}

export interface TeamPrepResult {
  round: number;
  datetime: string | null;
  my_team: string;
  opponent_team: string;
  my_team_rank: number | null;
  opp_team_rank: number | null;
  my_elo_avg: number | null;
  opp_elo_avg: number | null;
  color: string | null;
  opponents: LikelyOpponent[];
}

export interface PrepContext {
  tournamentName: string;
  round: number;
  datetime: string | null;
  color: string | null;
  board: number | null;
  opponentTeam: string | null;
  opponents: LikelyOpponent[];
}

// ── Local PGN browser types ──────────────────────────────────────────────────

export interface DirEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

export interface LocalGame extends GameSummary {
  pgn: string;
  deleted_at: string | null;
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface StatusInfo {
  /** Server build version, for the update-available check. Absent on old servers. */
  version?: string;
  /** API contract version; absent on old servers. */
  api_version?: number;
  /** Absolute path of the DB file the connected server has open (its real path,
   *  not a client guess) — e.g. /var/lib/lpdo/.chess-db/chess.db. Newer servers only. */
  db_path?: string;
  /** Directory containing the database (and the `twic/` cache). Newer servers only. */
  data_dir?: string;
  games: number;
  players: number;
  /** TWIC issues actually imported (excludes local PGN imports and undownloaded ids). */
  issues: number;
  /** Local PGN files imported (Megabase, Bundesliga, …); absent on old servers. */
  local_imports?: number;
  positions: number;
  /** Soft-deleted games (newer servers only). */
  deleted_games?: number;
  /** Number of the most recently imported TWIC issue (e.g. 1649). */
  last_twic_issue?: number | null;
  /** TWIC's own publication date of `last_twic_issue` (e.g. "2026-06-15"). */
  last_twic_published?: string | null;
  /** ISO timestamp at which `last_twic_issue` was imported. */
  last_twic_imported?: string | null;
  /** First-run setup readiness (#40 C4): "empty" (fresh, no games), "preparing"
   *  (the import/maintenance pipeline is running), "failed" (interrupted/errored —
   *  offer Reset), or "ready". Absent on older servers. */
  setup_status?: "empty" | "preparing" | "failed" | "ready";
}

// ── Sources (multi-source import catalog, #40) ────────────────────────────────

/** One curated import source's catalog metadata + this database's state for it.
 *  Mirrors the server's `/sources` payload. */
export interface SourceStatus {
  key: string;
  name: string;
  kind: "feed" | "bulk";
  description: string;
  homepage: string;
  /** Attribution line shown in the acknowledgment gate. */
  credit: string;
  /** Collection games from this source are grouped into (1:1). */
  collection: string;
  enabled: boolean;
  /** Whether the attribution/license was acknowledged (gates enabling). */
  credit_acked: boolean;
  /** Inclusive game-date window (ISO YYYY-MM-DD); null = unbounded. */
  from_date: string | null;
  to_date: string | null;
  exclude_undated: boolean;
  /** ISO timestamp of the last sync, and its outcome ("ok" / error text). */
  last_run: string | null;
  last_status: string | null;
  /** Items (issues/files) imported for this source. */
  items: number;
}

// ── Background jobs (the daemon's job pipeline, #40 C3) ────────────────────────

/** One job tracked by the daemon's JobManager. Mirrors `GET /jobs`. */
export interface Job {
  id: string;
  /** Job kind, e.g. "sources_sync" | "update" | "index_positions" | "backup". */
  type: string;
  status: "queued" | "running" | "done" | "error";
  value: number;
  total: number;
  message: string;
  /** False for appender (fast) writes that must not be interrupted. */
  interruptible: boolean;
  path?: string;
  error?: string;
  /** Submission params, used to label a job by what it operates on. */
  params?: Record<string, unknown>;
}
