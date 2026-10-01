// The opening repertoire (#327): books of chapters on the server, each
// chapter a PGN game studied in the Analysis page. See
// docs/design/opening-repertoire.md.

import { apiDelete, apiGet, postJson, putJson, submitJob } from "../api";
import type { PositionStat } from "../trainer/buildPackage";

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
  /** When the chapter was last analysed for practice, and its `updated_at`
   *  then — another one means changed since. */
  analysed_at: string | null;
  analysed_version: string | null;
}

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
}

export const listRepertoire = () => apiGet<BookWithChapters[]>("/repertoire");
export const createBook = (b: { name: string; color: BookColor; author?: string | null; description?: string | null; url?: string | null }) =>
  postJson<Book>("/repertoire/books", b);
export const updateBook = (id: number, patch: { name?: string; color?: BookColor; author?: string | null; description?: string | null; url?: string | null; ord?: number; active?: boolean }) =>
  putJson<Book>(`/repertoire/books/${id}`, patch);
export const deleteBook = (id: number) => apiDelete(`/repertoire/books/${id}`);
/** `file`: the PGN's file name, without the extension — names the chapters
 *  its headers do not. */
export const addChapters = (bookId: number, body: { name?: string; pgn?: string; file?: string }) =>
  postJson<ChapterSummary[]>(`/repertoire/books/${bookId}/chapters`, body);
export const getChapter = (id: number) => apiGet<ChapterDetail>(`/repertoire/chapters/${id}`);
export const updateChapter = (id: number, patch: { name?: string; ord?: number; active?: boolean; book_id?: number }) =>
  putJson<ChapterSummary>(`/repertoire/chapters/${id}`, patch);
export const saveChapterMoves = (id: number, moves: string) =>
  putJson<ChapterSummary>(`/repertoire/chapters/${id}/moves`, { moves });
export const deleteChapter = (id: number) => apiDelete(`/repertoire/chapters/${id}`);
/** A chapter's analysis for practice: the database's figures for every
 *  position (and one's own games), as stored, or worked out on the spot when
 *  there is none (3–6 s; `analysed_at` null). */
export interface ChapterAnalysis {
  analysed_at: string | null;
  chapter_updated: string | null;
  player_id: number | null;
  positions: PositionStat[];
}
export const getChapterStats = (id: number) => apiGet<ChapterAnalysis>(`/repertoire/chapters/${id}/stats`);
/** Only what is stored — no positions when the chapter has not been analysed. */
export const getStoredAnalysis = (id: number) => apiGet<ChapterAnalysis>(`/repertoire/chapters/${id}/stats?stored=true`);
/** Analyse chapters for practice, in the background (job `repertoire_analyse`):
 *  the database's figures, and `playerId`'s own games. */
export const analyseChapters = (chapters: number[], playerId: number | null) =>
  submitJob({ type: "repertoire_analyse", params: { chapters, player_id: playerId } });
/** Where a book's or a chapter's PGN is served (for exporting). */
export const bookPgnPath = (id: number) => `/repertoire/books/${id}/pgn`;
export const chapterPgnPath = (id: number) => `/repertoire/chapters/${id}/pgn`;

export function documentOf(c: ChapterDetail): ChapterDocument {
  return { kind: "chapter", id: c.id, bookName: c.book.name, chapterName: c.name, color: c.book.color, analysedAt: c.analysed_at };
}
