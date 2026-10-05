// The opening repertoire (#327): books of chapters on the server, each
// chapter a PGN game studied in the Analysis page. See
// docs/design/opening-repertoire.md.

import { apiDelete, apiGet, apiUrl, postJson, putJson, submitJob } from "../api";
import type { PositionStat } from "../trainer/buildPackage";
import type { Mine } from "../trainer/format";

export type BookColor = "white" | "black";

export interface Book {
  id: number;
  name: string;
  color: BookColor;
  author: string | null;
  description: string | null;
  url: string | null;
  ord: number;
  /** Off: the whole book is out of the active repertoire. */
  active: boolean;
}

export interface ChapterSummary {
  id: number;
  book_id: number;
  ord: number;
  name: string;
  active: boolean;
  lines: number;
  lines_off: number;
  updated_at: string | null;
  /** When the chapter was last analysed for practice, and whether its
   *  positions changed since (moves added or removed — not a comment). */
  analysed_at: string | null;
  analysis_stale: boolean | null;
  /** A model game: a complete annotated game kept with the book to show its
   *  ideas — not part of the repertoire; its own headers kept. */
  model: boolean;
  /** The game's result ("*" for a chapter). */
  result: GameResult;
  /** A model game with comments of its own (text, arrows, marks — not clock
   *  times); without, a reference game, listed apart. Set by hand, it stays so. */
  annotated: boolean;
  /** Whether `annotated` was set by hand rather than told by the comments
   *  (absent from servers before it could be). */
  annotated_set?: boolean;
}

export type GameResult = "*" | "1-0" | "0-1" | "1/2-1/2";
export const GAME_RESULTS: GameResult[] = ["*", "1-0", "0-1", "1/2-1/2"];

export interface BookWithChapters extends Book {
  chapters: ChapterSummary[];
}

export interface ChapterDetail extends ChapterSummary {
  pgn: string;
  book: Book;
}

/** What an Analysis tab holds of a chapter (serialisable: it is persisted
 *  with the tab; the PGN is fetched again on restore). */
export interface ChapterDocument {
  kind: "chapter";
  id: number;
  bookName: string;
  chapterName: string;
  color: BookColor;
  /** When the chapter was last analysed — read again when it changes. */
  analysedAt?: string | null;
  /** A model game: no lines to list, no games of one's own to look up. */
  model?: boolean;
}

export const listRepertoire = () => apiGet<BookWithChapters[]>("/repertoire");
export const createBook = (b: { name: string; color: BookColor; author?: string | null; description?: string | null; url?: string | null }) =>
  postJson<Book>("/repertoire/books", b);
export const updateBook = (id: number, patch: { name?: string; color?: BookColor; author?: string | null; description?: string | null; url?: string | null; ord?: number; active?: boolean }) =>
  putJson<Book>(`/repertoire/books/${id}`, patch);
export const deleteBook = (id: number) => apiDelete(`/repertoire/books/${id}`);
/** `file`: the PGN's file name, without the extension — names the chapters
 *  its headers do not. */
/** `model`: model games, one per game of the PGN. */
export const addChapters = (bookId: number, body: { name?: string; pgn?: string; file?: string; model?: boolean }) =>
  postJson<ChapterSummary[]>(`/repertoire/books/${bookId}/chapters`, body);
export const getChapter = (id: number) => apiGet<ChapterDetail>(`/repertoire/chapters/${id}`);
export const updateChapter = (id: number, patch: { name?: string; ord?: number; active?: boolean; book_id?: number; model?: boolean; result?: GameResult; annotated?: boolean | null }) =>
  putJson<ChapterSummary>(`/repertoire/chapters/${id}`, patch);
export const saveChapterMoves = (id: number, moves: string) =>
  putJson<ChapterSummary>(`/repertoire/chapters/${id}/moves`, { moves });
export const deleteChapter = (id: number) => apiDelete(`/repertoire/chapters/${id}`);
/** Delete chapters at once — those merged into another — in one transaction. */
export const deleteChapters = (ids: number[]) => postJson<{ deleted: number }>("/repertoire/chapters/delete", { ids });
/** Chapters of one book put in this order, in the places they hold now. */
export const orderChapters = (ids: number[]) => postJson<{ ordered: number }>("/repertoire/chapters/order", { ids });
/** A chapter's analysis for practice: the database's figures for every
 *  position, as stored, or worked out on the spot when
 *  there is none (3–6 s; `analysed_at` null). */
export interface ChapterAnalysis {
  analysed_at: string | null;
  chapter_updated: string | null;
  positions: PositionStat[];
}
export const getChapterStats = (id: number) => apiGet<ChapterAnalysis>(`/repertoire/chapters/${id}/stats`);
/** Only what is stored — no positions when the chapter has not been analysed. */
export const getStoredAnalysis = (id: number) => apiGet<ChapterAnalysis>(`/repertoire/chapters/${id}/stats?stored=true`);
/** Analyse chapters for practice, in the background (job `repertoire_analyse`):
 *  the database's figures. */
export const analyseChapters = (chapters: number[]) =>
  submitJob({ type: "repertoire_analyse", params: { chapters } });

/** One's own games through a chapter's positions, looked up live (~0.1 s):
 *  those with the book's colour, from the last `months` (0: all) — `since`
 *  the first day counted. */
export interface OwnGames {
  color: BookColor;
  months: number;
  since: string | null;
  games: number;
  ms: number;
  positions: { key: string; mine: Mine }[];
}
export const getOwnGames = (chapterId: number, playerId: number) =>
  apiGet<OwnGames>(`/repertoire/chapters/${chapterId}/mine?player_id=${playerId}`);

/** A score over some of one's games; `perf` with three rated opponents or more. */
export interface Score { games: number; w: number; d: number; l: number; perf: number | null }
/** One's own games across a book (live, ~0.1 s): per chapter, the games that
 *  reached one of its own positions by a move of one's own; the games in the
 *  book's opening, and those that left it, by the move that left. With the
 *  book's colour, from the period set on the Maintenance page. */
export interface BookGames {
  color: BookColor;
  months: number;
  since: string | null;
  games: number;
  in_book: Score;
  left: Score;
  left_by: [string, number][];
  chapters: ({ id: number } & Score)[];
  ms: number;
}
export const getBookGames = (bookId: number, playerId: number) =>
  apiGet<BookGames>(`/repertoire/books/${bookId}/mine?player_id=${playerId}`);
/** One of one's games in a chapter, with how far it followed it: "left" (a
 *  move the chapter does not have — `left_by` you or the opponent, `move`
 *  "8...b6"), "end" (to the end of a line), "index" (as far as the positions
 *  index goes, each game's first ~40 plies), "ended" (the game ended in it).
 *  `at_key`: the deepest chapter position it reached. */
export interface ChapterGame {
  id: number;
  white: string;
  black: string;
  white_elo: number | null;
  black_elo: number | null;
  event: string | null;
  date: string | null;
  result: string | null;
  followed: "left" | "end" | "index" | "ended";
  left_by: "you" | "opponent" | null;
  move: string | null;
  at_key: string;
  at_ply: number;
}
export interface ChapterGameList {
  color: BookColor;
  months: number;
  since: string | null;
  games: ChapterGame[];
  ms: number;
}
/** One's games in a chapter (as "Your games" counts them), newest first. */
export const getChapterGames = (chapterId: number, playerId: number) =>
  apiGet<ChapterGameList>(`/repertoire/chapters/${chapterId}/games?player_id=${playerId}`);

/** One of one's games in a book's opening: the chapters it counts for, or
 *  (none) the move that left the book. */
export interface BookGame {
  id: number;
  white: string;
  black: string;
  white_elo: number | null;
  black_elo: number | null;
  event: string | null;
  date: string | null;
  result: string | null;
  chapters: number[];
  /** How far it followed its (first) chapter — as that chapter's list says. */
  follow: Pick<ChapterGame, "followed" | "left_by" | "move" | "at_key" | "at_ply"> | null;
  left: string | null;
}
export interface BookGameList { color: BookColor; months: number; since: string | null; games: BookGame[]; ms: number }
export const getBookGameList = (bookId: number, playerId: number) =>
  apiGet<BookGameList>(`/repertoire/books/${bookId}/games?player_id=${playerId}`);

/** One's score as a percentage, "46%"; "–" without games. */
export const scorePct = (s: Score) => (s.games ? `${Math.round(((s.w + s.d / 2) / s.games) * 100)}%` : "–");

/** The repertoire's settings, on the Maintenance page. */
export interface RepertoireSettings {
  /** One's own games count from this many months back; 0 = all. */
  own_games_months: number;
}
export const getRepertoireSettings = () => apiGet<RepertoireSettings>("/repertoire/settings");
export const putRepertoireSettings = (s: RepertoireSettings) => putJson<RepertoireSettings>("/repertoire/settings", s);
/** Books from a PGN exported by LPDO (a book, or a backup of them all), made
 *  again one to one; a PGN without LPDO's tags makes one book after `file`. */
export const importBooks = (pgn: string, file?: string) => postJson<Book[]>("/repertoire/import", { pgn, file });
/** Every book replaced by a backup's — a `.pgn.zip` from Maintenance → Backup,
 *  or a plain PGN backup. One transaction: a file that cannot be read leaves
 *  the books as they were. */
export async function restoreBooks(file: Blob): Promise<Book[]> {
  const r = await fetch(apiUrl("/repertoire/restore"), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
  if (r.status === 404 || r.status === 405) throw new Error("The server cannot restore the repertoire yet. Update the server.");
  if (!r.ok) throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
  return r.json() as Promise<Book[]>;
}
/** Books from a zip of PGNs — a backup, or PGNs zipped by hand: each `.pgn`
 *  in it imported as if picked on its own. */
export async function importBooksZip(zip: Blob): Promise<Book[]> {
  const r = await fetch(apiUrl("/repertoire/import/zip"), { method: "POST", headers: { "content-type": "application/zip" }, body: zip });
  if (r.status === 404 || r.status === 405) throw new Error("The server cannot import zipped books yet. Update the server.");
  if (!r.ok) throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
  return r.json() as Promise<Book[]>;
}
/** Where a book's or a chapter's PGN is served (for exporting). */
export const bookPgnPath = (id: number) => `/repertoire/books/${id}/pgn`;
export const chapterPgnPath = (id: number) => `/repertoire/chapters/${id}/pgn`;

export function documentOf(c: ChapterDetail): ChapterDocument {
  return { kind: "chapter", id: c.id, bookName: c.book.name, chapterName: c.name, color: c.book.color, analysedAt: c.analysed_at, model: c.model };
}
