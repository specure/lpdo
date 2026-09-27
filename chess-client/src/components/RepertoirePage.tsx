// The Repertoire page (#327): the books in a panel on the left, the selected
// book's chapters in a panel beside it — each folding away to a strip, as the
// Players page keeps its players — and the chapter being studied on the
// right, with the Analysis page's own layout (board, moves, Reference /
// Games / Lines, engines) but no rail of open games. Switching chapters, or
// books, stays on this page.

import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { GameSummary } from "../types";
import {
  addChapters, bookPgnPath, chapterPgnPath, createBook, deleteBook, deleteChapter, getChapter, listRepertoire,
  updateBook, updateChapter, documentOf, type BookColor, type BookWithChapters, type ChapterSummary,
} from "../lib/repertoire";
import { saveTextFile } from "../lib/exportPgn";
import { buildPlayback } from "../lib/useGamePgn";
import { apiUrl } from "../api";
import AnalysisPage, { type AnalysisTab } from "./AnalysisPage";
import type { CursorPath } from "../lib/moveTreeNav";

interface Props {
  /** Open games (a related game from the Games tab) in the Analysis page. */
  onOpenGame: (games: GameSummary[]) => Promise<number>;
}

const field = "h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface";
const tonal = "h-7 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 disabled:opacity-50 transition-all duration-short3 ease-standard whitespace-nowrap";
const plain = "h-7 px-2 inline-flex items-center rounded-full text-label-md text-on-surface-variant hover:bg-on-surface/8 disabled:opacity-40 transition-colors duration-short3 ease-standard whitespace-nowrap";
const nav = "w-6 h-6 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 disabled:opacity-30 text-[10px]";
const box = "h-full overflow-hidden flex flex-col bg-surface-container-low border border-outline/40 rounded-md";
const CHAPTER_KEY = "repertoireChapter";
const BOOKS_FOLDED_KEY = "repertoireBooksCollapsed";
const CHAPTERS_FOLDED_KEY = "repertoireChaptersCollapsed";

/** An Analysis tab for a chapter, fetched afresh. */
async function loadTab(chapterId: number): Promise<AnalysisTab> {
  const c = await getChapter(chapterId);
  const game: GameSummary = {
    id: -c.id, white: c.name, black: c.book.name, white_elo: null, black_elo: null,
    event: c.book.name, date: null, result: null, eco: null, move_count: null, opening_line: null,
  };
  return {
    key: `c${c.id}`, game,
    loaded: { id: -c.id, white: c.name, black: c.book.name, result: null, date: null, event: c.book.name, pgn: c.pgn, gameUrl: null, ...buildPlayback(c.pgn) },
    fen: null, cursor: null, flipped: c.book.color === "black", document: documentOf(c),
  };
}

function useFolded(key: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => localStorage.getItem(key) === "1");
  useEffect(() => { localStorage.setItem(key, v ? "1" : "0"); }, [key, v]);
  return [v, setV];
}

/** A course link, opened outside the app (a bare "chessable.com/…" too). */
function openLink(url: string) {
  const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  openUrl(full).catch(() => window.open(full, "_blank", "noopener"));
}

export default function RepertoirePage({ onOpenGame }: Props) {
  const [books, setBooks] = useState<BookWithChapters[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booksFolded, setBooksFolded] = useFolded(BOOKS_FOLDED_KEY);
  const [chaptersFolded, setChaptersFolded] = useFolded(CHAPTERS_FOLDED_KEY);
  // The chapter on the board, as an Analysis tab of one.
  const [tab, setTab] = useState<AnalysisTab | null>(null);
  const [chapterId, setChapterId] = useState<number | null>(() => {
    const v = Number(localStorage.getItem(CHAPTER_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  });
  const [selectedBook, setSelectedBook] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const b = await listRepertoire();
      setBooks(b);
      setError(null);
      return b;
    } catch (e) { setError(String(e)); return null; }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // The book shown follows the chapter on the board.
  useEffect(() => {
    if (!books) return;
    const owner = chapterId != null ? books.find((b) => b.chapters.some((c) => c.id === chapterId)) : undefined;
    if (owner) setSelectedBook(owner.id);
    else if (selectedBook == null || !books.some((b) => b.id === selectedBook)) setSelectedBook(books[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books, chapterId]);

  // The chapter on the board: loaded when chosen, kept while its names
  // change (the tab's document carries them), dropped when it is gone.
  useEffect(() => {
    if (chapterId == null) { setTab(null); return; }
    localStorage.setItem(CHAPTER_KEY, String(chapterId));
    let gone = false;
    loadTab(chapterId)
      .then((t) => { if (!gone) setTab((prev) => (prev?.key === t.key ? { ...t, fen: prev.fen, cursor: prev.cursor, flipped: prev.flipped } : t)); })
      .catch(() => { if (!gone) { setTab(null); setChapterId(null); localStorage.removeItem(CHAPTER_KEY); } });
    return () => { gone = true; };
  }, [chapterId]);
  // A rename, or a move to another book, reaches the tab's names.
  useEffect(() => {
    if (!tab || !books) return;
    const owner = books.find((b) => b.chapters.some((c) => c.id === tab.document?.id));
    const c = owner?.chapters.find((x) => x.id === tab.document?.id);
    if (!owner || !c || !tab.document) return;
    if (c.name !== tab.document.chapterName || owner.name !== tab.document.bookName || owner.color !== tab.document.color) {
      setTab({ ...tab, game: { ...tab.game, white: c.name, black: owner.name, event: owner.name }, document: { ...tab.document, chapterName: c.name, bookName: owner.name, color: owner.color } });
    }
  }, [books, tab]);

  /** Run a change, then read everything again. */
  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await f(); await load(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const onTabState = useCallback((key: string, patch: { fen?: string; cursor?: CursorPath; flipped?: boolean }) => {
    setTab((t) => (t && t.key === key ? { ...t, ...patch } : t));
  }, []);
  function dropChapter() { setChapterId(null); localStorage.removeItem(CHAPTER_KEY); }

  const book = books?.find((b) => b.id === selectedBook) ?? null;

  const booksPanel = booksFolded ? <Strip label="Books" onOpen={() => setBooksFolded(false)} /> : (
    <div className={box}>
      <BooksPanel
        books={books} selected={selectedBook} busy={busy} error={error}
        onSelect={setSelectedBook} onFold={() => setBooksFolded(true)}
        onCreate={(b) => run(async () => { const nb = await createBook(b); setSelectedBook(nb.id); })}
        onUpdate={(id, patch) => run(() => updateBook(id, patch))}
        onDelete={(b) => run(async () => {
          await deleteBook(b.id);
          if (b.chapters.some((c) => c.id === chapterId)) dropChapter();
          setSelectedBook(null);
        })}
      />
    </div>
  );
  const chaptersPanel = chaptersFolded ? <Strip label={book ? book.name : "Chapters"} onOpen={() => setChaptersFolded(false)} /> : (
    <div className={box}>
      <div className="px-3 py-2 flex items-center gap-2 border-b border-outline/40 shrink-0">
        <span className="flex-1 min-w-0 truncate text-label-md text-on-surface-variant uppercase tracking-wider" title={book?.name}>Chapters</span>
        <button onClick={() => setChaptersFolded(true)} className="h-7 px-2 inline-flex items-center rounded-full text-on-surface-variant hover:bg-on-surface/8 text-body-md" title="Hide the chapters">«</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {book ? (
          <ChaptersList
            book={book} busy={busy} current={chapterId}
            onPick={setChapterId}
            onAddEmpty={(name) => run(async () => { const [c] = await addChapters(book.id, { name }); if (c) setChapterId(c.id); })}
            onImport={(items) => run(async () => {
              // One file at a time, in the order picked: each adds its
              // chapters at the end. A file that fails stops the rest.
              let first: number | null = null;
              for (const it of items) {
                const cs = await addChapters(book.id, it).catch((e) => { throw new Error(it.file ? `${it.file}: ${String(e)}` : String(e)); });
                first ??= cs[0]?.id ?? null;
              }
              if (first != null && chapterId == null) setChapterId(first);
            })}
            onChapter={(id, patch) => run(() => updateChapter(id, patch))}
            onDeleteChapter={(id) => run(async () => { await deleteChapter(id); if (id === chapterId) dropChapter(); })}
          />
        ) : (
          <div className="px-3 py-2 text-label-sm text-on-surface-variant">{books && books.length === 0 ? "Add a book first." : "Choose a book."}</div>
        )}
      </div>
    </div>
  );

  // Each fold has a layout of its own: the group reads its sizes once.
  const layoutId = `repertoire-${booksFolded ? "b" : "B"}${chaptersFolded ? "c" : "C"}`;
  return (
    <AnalysisPage
      key={layoutId}
      tabs={tab ? [tab] : []}
      activeKey={tab?.key ?? null}
      onActivate={() => {}}
      onClose={dropChapter}
      onCloseMany={() => {}}
      onMove={() => {}}
      capacity={1}
      onOpenGame={onOpenGame}
      onTabState={onTabState}
      onGameMutated={() => void load()}
      leadingPanels={[
        booksFolded ? { id: "books", node: booksPanel, size: "3", strip: true } : { id: "books", node: booksPanel, size: "14", min: "9", max: "30" },
        chaptersFolded ? { id: "chapters", node: chaptersPanel, size: "3", strip: true } : { id: "chapters", node: chaptersPanel, size: "16", min: "10", max: "34" },
      ]}
      layoutId={layoutId}
      emptyState={books && books.length === 0
        ? "No books yet. A book is one opening course or one topic — \"Najdorf for Black\" — with the colour you play it from; its chapters hold the lines. Add a book on the left."
        : "Choose a chapter on the left to study it here — or add one: empty, from pasted PGN, or from a PGN file."}
    />
  );
}

// ── The panels ───────────────────────────────────────────────────────────────

/** A folded panel: its name down the strip; a click opens it. */
function Strip({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="h-full w-full flex flex-col items-center gap-2 pt-3 bg-surface-container-low border border-outline/40 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-on-surface/4 transition-colors duration-short3 ease-standard overflow-hidden"
      title={`Show ${label === "Books" ? "the books" : "the chapters"}`}
    >
      <span className="text-body-md">»</span>
      <span className="text-label-sm uppercase tracking-wider truncate max-h-full" style={{ writingMode: "vertical-rl" }}>{label}</span>
    </button>
  );
}

function ColorDot({ color }: { color: BookColor }) {
  return <span className={`inline-block w-3 h-3 rounded-full border border-outline shrink-0 ${color === "white" ? "bg-white" : "bg-black"}`} title={`Played as ${color}`} />;
}

function ColorPick({ value, onChange }: { value: BookColor; onChange: (c: BookColor) => void }) {
  const pill = (on: boolean) => `h-6 px-2 text-label-sm ${on ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface-variant hover:bg-on-surface/8"}`;
  return (
    <span className="inline-flex rounded-full overflow-hidden border border-outline/40">
      <button type="button" className={pill(value === "white")} onClick={() => onChange("white")}>White</button>
      <button type="button" className={pill(value === "black")} onClick={() => onChange("black")}>Black</button>
    </span>
  );
}

type BookPatch = Parameters<typeof updateBook>[1];

async function exportPgn(path: string, filename: string): Promise<string | null> {
  try {
    const r = await fetch(apiUrl(path));
    if (!r.ok) throw new Error(`${r.status}`);
    const ok = await saveTextFile(filename.replace(/[^\w.-]+/g, "_") + ".pgn", await r.text());
    return ok ? "Saved as PGN" : null;
  } catch (e) { return `Could not export: ${e instanceof Error ? e.message : String(e)}`; }
}

function BooksPanel({ books, selected, busy, error, onSelect, onFold, onCreate, onUpdate, onDelete }: {
  books: BookWithChapters[] | null; selected: number | null; busy: boolean; error: string | null;
  onSelect: (id: number) => void; onFold: () => void;
  onCreate: (b: { name: string; author: string | null; color: BookColor }) => void;
  onUpdate: (id: number, patch: BookPatch) => void;
  onDelete: (b: BookWithChapters) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [color, setColor] = useState<BookColor>("white");
  const book = books?.find((b) => b.id === selected) ?? null;
  return (
    <>
      <div className="px-3 py-2 flex items-center gap-1 border-b border-outline/40 shrink-0">
        <span className="flex-1 text-label-md text-on-surface-variant uppercase tracking-wider">Books</span>
        <button onClick={() => setAdding((a) => !a)} className={plain}>{adding ? "Cancel" : "+ New"}</button>
        <button onClick={onFold} className="h-7 px-2 inline-flex items-center rounded-full text-on-surface-variant hover:bg-on-surface/8 text-body-md" title="Hide the books">«</button>
      </div>
      {error && <div className="px-3 py-1 text-body-sm text-error">{error}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {adding && (
          <form className="px-3 py-2 flex flex-col gap-1.5 border-b border-outline/40"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              onCreate({ name: name.trim(), author: author.trim() || null, color });
              setName(""); setAuthor(""); setAdding(false);
            }}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name — Najdorf for Black" className={field} />
            <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Author (optional)" className={field} />
            <div className="flex items-center gap-2 text-label-sm text-on-surface-variant">Played as <ColorPick value={color} onChange={setColor} /><button type="submit" disabled={busy || !name.trim()} className={`${tonal} ml-auto`}>Add</button></div>
          </form>
        )}
        <div className="flex flex-col py-1">
          {books?.map((b) => {
            const on = b.chapters.filter((c) => c.active).length;
            const sel = b.id === selected;
            return (
              <div key={b.id}
                className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors duration-short3 ease-standard ${sel ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8"} ${b.active ? "" : "opacity-60"}`}>
                <input type="checkbox" checked={b.active} disabled={busy} onChange={(e) => onUpdate(b.id, { active: e.target.checked })}
                  className="accent-primary shrink-0" title="In the repertoire: off takes the whole book out, whatever its chapters say" />
                <button onClick={() => onSelect(b.id)} className="flex-1 min-w-0 text-left flex items-center gap-2">
                  <ColorDot color={b.color} />
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className="truncate text-body-sm" title={b.name}>{b.name}</span>
                    {b.author && <span className="truncate text-label-sm opacity-70" title={b.author}>{b.author}</span>}
                  </span>
                  <span className="text-label-sm opacity-70 tabular-nums shrink-0" title={`${on} of ${b.chapters.length} chapters active`}>{on}/{b.chapters.length}</span>
                </button>
              </div>
            );
          })}
          {books && books.length === 0 && !adding && <div className="px-3 py-1 text-label-sm text-on-surface-variant">None yet — + New adds one.</div>}
        </div>
        {book && books && (
          <BookDetails key={book.id} book={book} busy={busy} first={book.id === books[0]?.id} last={book.id === books[books.length - 1]?.id}
            onUpdate={(patch) => onUpdate(book.id, patch)} onDelete={() => onDelete(book)} />
        )}
      </div>
    </>
  );
}

/** The selected book: what it is, and its settings. */
function BookDetails({ book, busy, first, last, onUpdate, onDelete }: {
  book: BookWithChapters; busy: boolean; first: boolean; last: boolean;
  onUpdate: (patch: BookPatch) => void; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(book.name);
  const [author, setAuthor] = useState(book.author ?? "");
  const [url, setUrl] = useState(book.url ?? "");
  const [description, setDescription] = useState(book.description ?? "");
  // Each field follows its own saved value only: a save of one (which reads
  // the book again) must not reset another while it is being typed.
  useEffect(() => setName(book.name), [book.name]);
  useEffect(() => setAuthor(book.author ?? ""), [book.author]);
  useEffect(() => setUrl(book.url ?? ""), [book.url]);
  useEffect(() => setDescription(book.description ?? ""), [book.description]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const active = book.chapters.filter((c) => c.active);
  const lines = book.chapters.reduce((n, c) => n + c.lines, 0);
  const off = book.chapters.reduce((n, c) => n + c.lines_off, 0);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  /** Save a text field when it is left, if it changed. */
  const commit = (key: "author" | "url" | "description", v: string, was: string | null) => {
    if (v.trim() !== (was ?? "")) onUpdate({ [key]: v.trim() || null });
  };
  const enter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); };

  return (
    <div className="mt-auto border-t border-outline/40 px-3 py-2 flex flex-col gap-1.5 text-body-sm">
      <div className="flex items-start gap-2">
        <span className="pt-1"><ColorDot color={book.color} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-title-sm text-on-surface break-words">{book.name}</div>
          {book.author && <div className="text-label-md text-on-surface-variant break-words">by {book.author}</div>}
        </div>
      </div>
      <div className="text-label-sm text-on-surface-variant">
        Played as {book.color} · {plural(book.chapters.length, "chapter")}{active.length !== book.chapters.length ? `, ${active.length} active` : ""} · {plural(lines, "line")}{off ? `, ${off} off` : ""}
      </div>
      {!book.active && <div className="text-label-sm text-on-surface-variant">Off: the whole book is out of the repertoire.</div>}
      {book.url && (
        <button onClick={() => openLink(book.url!)} className="text-left text-label-md text-primary hover:underline truncate" title={book.url}>
          ↗ {book.url.replace(/^https?:\/\//, "")}
        </button>
      )}
      {book.description && <div className="text-body-sm text-on-surface-variant whitespace-pre-wrap break-words">{book.description}</div>}
      <div className="flex items-center gap-1 flex-wrap">
        <button onClick={() => setEditing((e) => !e)} className={plain} title="Name, author, colour, link, notes">{editing ? "Done" : "Edit…"}</button>
        <button onClick={() => onUpdate({ ord: book.ord - 1 })} disabled={busy || first} className={nav} title="Move the book up">▲</button>
        <button onClick={() => onUpdate({ ord: book.ord + 1 })} disabled={busy || last} className={nav} title="Move the book down">▼</button>
        <button onClick={() => void exportPgn(bookPgnPath(book.id), book.name).then(setNote)} disabled={busy || book.chapters.length === 0} className={plain} title="Save the book's chapters as one PGN file">PGN…</button>
        {confirmDelete ? (
          <>
            <button onClick={() => { setConfirmDelete(false); onDelete(); }} disabled={busy} className="h-7 px-2 rounded-full text-label-md text-error hover:bg-error/8">Delete it and its {plural(book.chapters.length, "chapter")}</button>
            <button onClick={() => setConfirmDelete(false)} className={plain}>Cancel</button>
          </>
        ) : (
          <button onClick={() => setConfirmDelete(true)} disabled={busy} className={plain}>Delete…</button>
        )}
      </div>
      {editing && (
        <div className="flex flex-col gap-1.5">
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name.trim() !== book.name) onUpdate({ name: name.trim() }); }}
            onKeyDown={enter} className={field} title="Name" placeholder="Name" />
          <input value={author} onChange={(e) => setAuthor(e.target.value)} onBlur={() => commit("author", author, book.author)}
            onKeyDown={enter} className={field} placeholder="Author (optional)" />
          <div className="flex items-center gap-2 text-label-sm text-on-surface-variant">Played as <ColorPick value={book.color} onChange={(c) => onUpdate({ color: c })} /></div>
          <input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => commit("url", url, book.url)}
            onKeyDown={enter} placeholder="Link to the course (optional)" className={field} />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => commit("description", description, book.description)}
            rows={3} placeholder="Notes (optional)" className="w-full text-body-sm p-2 rounded-sm bg-surface-container border border-outline/40 text-on-surface" />
        </div>
      )}
      {note && <div className="text-label-sm text-on-surface-variant">{note}</div>}
    </div>
  );
}

function ChaptersList({ book, busy, current, onPick, onAddEmpty, onImport, onChapter, onDeleteChapter }: {
  book: BookWithChapters; busy: boolean; current: number | null;
  onPick: (id: number) => void;
  onAddEmpty: (name: string) => void; onImport: (items: { pgn: string; file?: string }[]) => void;
  onChapter: (id: number, patch: { name?: string; ord?: number; active?: boolean }) => void;
  onDeleteChapter: (id: number) => void;
}) {
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  async function pickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    onImport(await Promise.all(files.map(async (f) => ({ pgn: await f.text(), file: f.name.replace(/\.[^.]+$/, "") }))));
  }

  return (
    <div className="flex flex-col">
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        <ColorDot color={book.color} />
        <span className="flex-1 min-w-0 truncate text-title-sm text-on-surface" title={book.name}>{book.name}</span>
      </div>
      {!book.active && <div className="px-3 pb-1 text-label-sm text-on-surface-variant">The book is off: these chapters are out of the repertoire whatever their switches say.</div>}
      <div className={`flex flex-col py-1 ${book.active ? "" : "opacity-70"}`}>
        {book.chapters.map((c, i) => (
          <ChapterRow key={c.id} chapter={c} busy={busy} current={c.id === current} first={i === 0} last={i === book.chapters.length - 1}
            onPick={() => onPick(c.id)}
            onActive={(active) => onChapter(c.id, { active })}
            onRename={(n) => onChapter(c.id, { name: n })}
            onMove={(delta) => onChapter(c.id, { ord: c.ord + delta })}
            onExport={() => void exportPgn(chapterPgnPath(c.id), `${book.name}-${c.name}`).then(setNote)}
            onDelete={() => onDeleteChapter(c.id)} />
        ))}
        {book.chapters.length === 0 && <div className="px-3 py-1 text-label-sm text-on-surface-variant">No chapters yet.</div>}
      </div>
      <div className="px-3 py-2 flex items-center gap-1 flex-wrap border-t border-outline/40">
        <button onClick={() => onAddEmpty(`Chapter ${book.chapters.length + 1}`)} disabled={busy} className={tonal} title="An empty chapter: play the lines in with Edit lines…">+ Empty</button>
        <button onClick={() => setPasting((p) => !p)} className={tonal}>{pasting ? "Cancel" : "Paste PGN…"}</button>
        <button onClick={() => fileRef.current?.click()} disabled={busy} className={tonal} title="PGN files, one or several: one chapter per game, named from its headers (a Lichess study exports this way) or else after its file">Import…</button>
        <input ref={fileRef} type="file" multiple accept=".pgn,text/plain" className="hidden" onChange={(e) => void pickFiles(e)} />
      </div>
      {pasting && (
        <div className="px-3 pb-2 flex flex-col gap-1.5">
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} placeholder={"[Event \"Najdorf: 6.Bg5\"]\n\n1. e4 c5 2. Nf3 d6 ..."} className="w-full font-mono text-body-sm p-2 rounded-sm bg-surface-container border border-outline/40 text-on-surface" />
          <button onClick={() => { onImport([{ pgn: pasted }]); setPasted(""); setPasting(false); }} disabled={busy || !pasted.trim()} className={tonal}>Add as chapters</button>
          <span className="text-label-sm text-on-surface-variant">Several games become several chapters, named from their headers.</span>
        </div>
      )}
      {note && <div className="px-3 pb-2 text-label-sm text-on-surface-variant">{note}</div>}
    </div>
  );
}

function ChapterRow({ chapter: c, busy, current, first, last, onPick, onActive, onRename, onMove, onExport, onDelete }: {
  chapter: ChapterSummary; busy: boolean; current: boolean; first: boolean; last: boolean;
  onPick: () => void; onActive: (a: boolean) => void; onRename: (n: string) => void; onMove: (delta: -1 | 1) => void; onExport: () => void; onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(c.name);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setName(c.name), [c.name]);
  return (
    <div className={`flex flex-col ${current ? "bg-primary-container/40" : ""} ${c.active ? "" : "opacity-70"}`}>
      <div className="flex items-center gap-1.5 px-3 py-1">
        <input type="checkbox" checked={c.active} disabled={busy} onChange={(e) => onActive(e.target.checked)} className="accent-primary shrink-0" title="Active: part of the repertoire you are playing now" />
        {renaming ? (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onBlur={() => { setRenaming(false); if (name.trim() && name.trim() !== c.name) onRename(name.trim()); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setName(c.name); setRenaming(false); } }}
            className={`${field} flex-1 min-w-0 h-7`} />
        ) : (
          <button onClick={onPick} className={`flex-1 min-w-0 text-left text-body-sm truncate ${current ? "text-on-surface font-medium" : "text-on-surface hover:text-primary"}`} title={`${c.name} — ${c.lines} ${c.lines === 1 ? "line" : "lines"}${c.lines_off ? `, ${c.lines_off} off` : ""}`}>
            {c.ord}. {c.name}
          </button>
        )}
        <span className="text-label-sm text-on-surface-variant tabular-nums shrink-0">{c.lines}{c.lines_off ? `−${c.lines_off}` : ""}</span>
        <button onClick={() => setMenu((m) => !m)} className={`${nav} text-body-sm`} title="Rename, reorder, export, delete">⋯</button>
      </div>
      {menu && (
        <div className="px-3 pb-1.5 pl-8 flex items-center gap-1 flex-wrap">
          <button onClick={() => { setMenu(false); setRenaming(true); }} className={plain} disabled={busy}>Rename</button>
          <button onClick={() => onMove(-1)} disabled={busy || first} className={nav} title="Move up">▲</button>
          <button onClick={() => onMove(1)} disabled={busy || last} className={nav} title="Move down">▼</button>
          <button onClick={() => { setMenu(false); onExport(); }} className={plain} title="Save the chapter as a PGN file">PGN…</button>
          {confirm ? (
            <>
              <button onClick={() => { setConfirm(false); setMenu(false); onDelete(); }} disabled={busy} className="h-7 px-2 rounded-full text-label-md text-error hover:bg-error/8">Delete</button>
              <button onClick={() => setConfirm(false)} className={plain}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirm(true)} disabled={busy} className={plain}>Delete…</button>
          )}
        </div>
      )}
    </div>
  );
}
