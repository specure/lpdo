// One's own online games (#90): accounts on Lichess and Chess.com linked to
// one's player, their sync into "My online games", and one's recent games —
// over the board and online — with how each stood to the repertoire.

import { apiDelete, apiGet, postJson } from "../api";
import type { LineMatch } from "./repertoire";

export type Platform = "lichess" | "chesscom";

export const PLATFORMS: { id: Platform; name: string; profile: (username: string) => string }[] = [
  { id: "chesscom", name: "Chess.com", profile: (u) => `https://www.chess.com/member/${u}` },
  { id: "lichess", name: "Lichess", profile: (u) => `https://lichess.org/@/${u}` },
];

export const platformName = (p: string | null | undefined) => PLATFORMS.find((x) => x.id === p)?.name ?? (p ?? "");

/** A linked account, as the server lists it. */
export interface Account {
  id: number;
  platform: Platform;
  username: string;
  /** The handle's own player row (a virtual player). */
  player_id: number;
  /** The local player it belongs to. */
  owner_id: number;
  owner_name: string;
  enabled: boolean;
  last_sync: string | null;
  last_status: string | null;
  /** The handle's games in the database. */
  games: number;
  /** Games from this day on are synced ("2025-10-13"); null: all of them. */
  from_date: string | null;
}

export const getAccounts = () => apiGet<Account[]>("/accounts");
export const addAccount = (platform: Platform, username: string, playerId: number, from: string | null) =>
  postJson<Account>("/accounts", { platform, username, player_id: playerId, from });
/** From which day the account's games are synced; null for all. */
export const setAccountFrom = (id: number, from: string | null) => postJson<unknown>(`/accounts/${id}/from`, { from });
export const removeAccount = (id: number) => apiDelete(`/accounts/${id}`);
export const setAccountEnabled = (id: number, enabled: boolean) => postJson<unknown>(`/accounts/${id}/enabled`, { enabled });
/** Sync now — a job, followed in Activity. */
export const syncAccount = (id: number) => postJson<{ job_id: string }>(`/accounts/${id}/sync`);
export const syncAccounts = () => postJson<{ job_id: string }>("/accounts/sync");

/** How one's games are counted: all, over the board only, online only (any
 *  of one's linked handles). */
export type Scope = "all" | "otb" | "online";
export const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "All" }, { id: "otb", label: "Over the board" }, { id: "online", label: "Online" },
];

export type TimeClass = "bullet" | "blitz" | "rapid" | "classical" | "correspondence";
export const TIME_CLASSES: TimeClass[] = ["bullet", "blitz", "rapid", "classical", "correspondence"];

/** One of one's games of the last days, with how it stood to the repertoire. */
export interface RecentGame {
  id: number;
  white: string;
  black: string;
  white_elo: number | null;
  black_elo: number | null;
  date: string | null;
  event: string | null;
  site: string | null;
  result: string | null;
  time_control: string | null;
  time_class: TimeClass | null;
  platform: Platform | null;
  /** One's side. */
  color: "white" | "black";
  /** One's result: 1, 0.5, 0; null without a result. */
  score: number | null;
  /** The game's moves (SAN), to put a chapter's board where it left. */
  moves: string[];
  /** The chapter it went into, when it went into one. */
  match: LineMatch | null;
}

export interface RecentGames {
  days: number;
  since: string;
  scope: Scope;
  games: RecentGame[];
  ms: number;
}

export const getRecentGames = (playerId: number, days: number, scope: Scope, limit = 300) =>
  apiGet<RecentGames>(`/players/${playerId}/recent?days=${days}&scope=${scope}&limit=${limit}`);
