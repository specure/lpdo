// The opening repertoire (#327): books of chapters on the server, each
// chapter a PGN game studied in the Analysis page. See
// docs/design/opening-repertoire.md.

import { apiDelete, apiGet, postJson, putJson } from "../api";

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
/** Where a book's or a chapter's PGN is served (for exporting). */
export const bookPgnPath = (id: number) => `/repertoire/books/${id}/pgn`;
export const chapterPgnPath = (id: number) => `/repertoire/chapters/${id}/pgn`;

export function documentOf(c: ChapterDetail): ChapterDocument {
  return { kind: "chapter", id: c.id, bookName: c.book.name, chapterName: c.name, color: c.book.color };
}
