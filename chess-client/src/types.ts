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
  games: number;
  players: number;
  issues: number;
  downloaded: number;
  imported: number;
  positions: number;
  /** Soft-deleted games (newer servers only). */
  deleted_games?: number;
  /** ISO timestamp of the most recently imported TWIC issue. */
  last_twic_imported?: string | null;
}
