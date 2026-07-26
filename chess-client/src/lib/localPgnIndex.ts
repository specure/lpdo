// Thin wrappers over the in-process `chess-pgn` engine (Tauri commands) used to
// browse large local PGN files without a server (#104). See src-tauri/pgn_index.rs.
import { invoke } from "@tauri-apps/api/core";

export type ColorFilter = "any" | "white" | "black";

/** One row from a query — mirrors `chess_pgn::GameRow`. `id` is the game's index
 *  in file order and is what `pgnGame` takes. */
export interface IndexedRow {
  id: number;
  white: string;
  black: string;
  white_elo: number | null;
  black_elo: number | null;
  event: string | null;
  date: string | null;
  result: string | null;
}

/** Query params — field names are snake_case to match `chess_pgn::Query`
 *  (Tauri's camelCase→snake_case conversion applies only to the top-level
 *  command args, not this nested object). */
export interface PgnQuery {
  player1?: string | null;
  player1_color?: ColorFilter;
  player2?: string | null;
  player2_color?: ColorFilter;
  event?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  offset: number;
  limit: number;
}

export interface PgnQueryResult {
  /** Games indexed so far (grows until `complete`). */
  total: number;
  /** Matches among those indexed so far. */
  matched: number;
  rows: IndexedRow[];
  /** True once the whole file has been indexed. */
  complete: boolean;
}

/** Open a PGN file; indexing starts in the background. Poll `pgnQuery` (its
 *  `complete` flag + growing `total`) to watch it fill in. */
export const pgnOpen = (path: string) =>
  invoke<{ session: number }>("pgn_open", { path });

/** Filter + paginate an open index. */
export const pgnQuery = (session: number, query: PgnQuery) =>
  invoke<PgnQueryResult>("pgn_query", { session, query });

/** Read one game's raw PGN text back by id. */
export const pgnGame = (session: number, id: number) =>
  invoke<string>("pgn_game", { session, id });

/** Free the index (best-effort; ignore errors on close). */
export const pgnClose = (session: number) =>
  invoke("pgn_close", { session }).catch(() => {});
