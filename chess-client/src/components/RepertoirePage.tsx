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
  saveChapterMoves, updateBook, updateChapter, documentOf, analyseChapters, type BookColor, type BookWithChapters, type ChapterSummary,
} from "../lib/repertoire";
import { saveTextFile } from "../lib/exportPgn";
import { useJobProgress } from "../hooks/useJobProgress";
import { buildPlayback } from "../lib/useGamePgn";
import { apiUrl } from "../api";
import AnalysisPage, { type AnalysisTab } from "./AnalysisPage";
import MergeChaptersDialog from "./repertoire/MergeChaptersDialog";
import RenameChaptersDialog from "./repertoire/RenameChaptersDialog";
import { mergeChapters, resolveMerge, type MergeChoices } from "../lib/mergeChapters";
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
  // Chapters being merged: the lines already merged, the conflicts to choose.
  const [merging, setMerging] = useState<{
    target: ChapterSummary; others: ChapterSummary[]; labels: string[]; result: ReturnType<typeof mergeChapters>;
  } | null>(null);

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
    if (c.name !== tab.document.chapterName || owner.name !== tab.document.bookName || owner.color !== tab.document.color || c.analysed_at !== (tab.document.analysedAt ?? null)) {
      setTab({ ...tab, game: { ...tab.game, white: c.name, black: owner.name, event: owner.name }, document: { ...tab.document, chapterName: c.name, bookName: owner.name, color: owner.color, analysedAt: c.analysed_at } });
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

  const addEmpty = (bookId: number, name: string) =>
    run(async () => { const [c] = await addChapters(bookId, { name }); if (c) setChapterId(c.id); });
  const importPgn = (bookId: number, items: { pgn: string; file?: string }[]) => run(async () => {
    // One file at a time, in the order picked: each adds its chapters at the
    // end. A file that fails stops the rest.
    let first: number | null = null;
    for (const it of items) {
      const cs = await addChapters(bookId, it).catch((e) => { throw new Error(it.file ? `${it.file}: ${String(e)}` : String(e)); });
      first ??= cs[0]?.id ?? null;
    }
    if (first != null && chapterId == null) setChapterId(first);
  });

  // Analysing chapters for practice (#327): a background job on the server,
  // started only from here; the list is read again when it ends (a cancelled
  // run keeps the chapters it finished).
  const analysis = useJobProgress("repertoire-analyse");
  const analysing = analysis.running || analysis.queued;
  const startAnalysis = (ids: number[]) => {
    if (!ids.length || analysing) return;
    analysis.runJob(() => analyseChapters(ids));
  };
  const wasAnalysing = useRef(false);
  useEffect(() => {
    if (wasAnalysing.current && !analysing) void load();
    wasAnalysing.current = analysing;
  }, [analysing, load]);

  // Merge the chapters into the topmost of them: its tree gains the others'
  // lines and comments, then they are deleted.
  const startMerge = (ids: number[]) => run(async () => {
    const cs = (book?.chapters ?? []).filter((c) => ids.includes(c.id)).sort((a, b) => a.ord - b.ord);
    if (cs.length < 2) return;
    const [first, ...rest] = await Promise.all(cs.map((c) => getChapter(c.id)));
    // Names as the list shows them; a repeated one numbered "(2)", "(3)" in
    // list order, so the merge window tells them apart.
    const seen = new Map<string, number>();
    const labels = cs.map((c) => {
      const n = (seen.get(c.name) ?? 0) + 1;
      seen.set(c.name, n);
      return n > 1 ? `${c.name} (${n})` : c.name;
    });
    const result = mergeChapters({ name: labels[0], pgn: first.pgn }, rest.map((c, i) => ({ name: labels[i + 1], pgn: c.pgn })));
    setMerging({ target: cs[0], others: cs.slice(1), labels, result });
  });
  const finishMerge = (choices: MergeChoices) => merging && run(async () => {
    const { target, others, result } = merging;
    await saveChapterMoves(target.id, resolveMerge(result, choices));
    for (const o of others) await deleteChapter(o.id);
    setMerging(null);
    // The merged chapter on the board, read again.
    if (chapterId === target.id) setTab(await loadTab(target.id));
    else setChapterId(target.id);
  });

  const booksPanel = booksFolded ? <Strip label="Books" onOpen={() => setBooksFolded(false)} /> : (
    <div className={box}>
      <BooksPanel
        books={books} selected={selectedBook} busy={busy} error={error}
        onSelect={setSelectedBook} onFold={() => setBooksFolded(true)}
        onCreate={(b) => run(async () => { const nb = await createBook(b); setSelectedBook(nb.id); })}
        onUpdate={(id, patch) => run(() => updateBook(id, patch))}
        onAddEmpty={addEmpty} onImport={importPgn}
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
      {(analysing || analysis.error || analysis.done) && (
        <div className="px-3 py-2 shrink-0 border-b border-outline/40 flex flex-col gap-1">
          <div className="flex items-center gap-2 text-label-sm text-on-surface-variant">
            <span className="flex-1 min-w-0 truncate">
              {analysis.error ? <span className="text-error">{analysis.error}</span>
                : analysing ? (analysis.queued ? "Analysis waiting for its turn…" : analysis.message || "Analysing…")
                : analysis.doneMessage || "Analysed."}
            </span>
            {analysing
              ? <button onClick={analysis.cancel} className={plain}>Cancel</button>
              : <button onClick={analysis.reset} className={plain} title="Dismiss">×</button>}
          </div>
          {analysing && (
            <div className="h-1 rounded-full bg-on-surface/10 overflow-hidden">
              <div className="h-full bg-primary transition-all duration-medium2" style={{ width: `${analysis.percent}%` }} />
            </div>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {book ? (
          <ChaptersList
            book={book} busy={busy} current={chapterId}
            onPick={setChapterId}
            onMerge={startMerge}
            onAnalyse={startAnalysis} analysing={analysing}
            onRenameMany={(changes) => run(async () => { for (const c of changes) await updateChapter(c.id, { name: c.name }); })}
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
  return (<>
    {merging && (
      <MergeChaptersDialog
        target={merging.labels[0]}
        others={merging.labels.slice(1)}
        added={merging.result.added} takenOver={merging.result.takenOver} conflicts={merging.result.conflicts}
        busy={busy} onMerge={finishMerge} onCancel={() => setMerging(null)}
      />
    )}
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
        : "Choose a chapter on the left to study it here — or add one with the book's ⋯: empty, from pasted PGN, or from PGN files."}
    />
  </>);
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

type ImportItem = { pgn: string; file?: string };

function BooksPanel({ books, selected, busy, error, onSelect, onFold, onCreate, onUpdate, onAddEmpty, onImport, onDelete }: {
  books: BookWithChapters[] | null; selected: number | null; busy: boolean; error: string | null;
  onSelect: (id: number) => void; onFold: () => void;
  onCreate: (b: { name: string; author: string | null; color: BookColor }) => void;
  onUpdate: (id: number, patch: BookPatch) => void;
  onAddEmpty: (bookId: number, name: string) => void;
  onImport: (bookId: number, items: ImportItem[]) => void;
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
            onUpdate={(patch) => onUpdate(book.id, patch)} onDelete={() => onDelete(book)}
            onAddEmpty={(name) => onAddEmpty(book.id, name)} onImport={(items) => onImport(book.id, items)} />
        )}
      </div>
    </>
  );
}

/** The selected book: what it is, and its settings. */
function BookDetails({ book, busy, first, last, onUpdate, onDelete, onAddEmpty, onImport }: {
  book: BookWithChapters; busy: boolean; first: boolean; last: boolean;
  onUpdate: (patch: BookPatch) => void; onDelete: () => void;
  onAddEmpty: (name: string) => void; onImport: (items: ImportItem[]) => void;
}) {
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  async function pickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    onImport(await Promise.all(files.map(async (f) => ({ pgn: await f.text(), file: f.name.replace(/\.[^.]+$/, "") }))));
  }
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
        <Menu up title="The book: add chapters, edit, reorder, export, delete" entries={[
          { label: "New empty chapter", onClick: () => onAddEmpty(`Chapter ${book.chapters.length + 1}`), disabled: busy },
          { label: "Paste PGN…", onClick: () => setPasting(true) },
          { label: "Import PGN files…", onClick: () => fileRef.current?.click(), disabled: busy },
          { label: editing ? "Done editing" : "Edit…", onClick: () => setEditing((e) => !e), separated: true },
          { label: "Move up", onClick: () => onUpdate({ ord: book.ord - 1 }), disabled: busy || first },
          { label: "Move down", onClick: () => onUpdate({ ord: book.ord + 1 }), disabled: busy || last },
          { label: "Export PGN…", onClick: () => void exportPgn(bookPgnPath(book.id), book.name).then(setNote), disabled: busy || book.chapters.length === 0 },
          { label: "Delete…", onClick: () => setConfirmDelete(true), disabled: busy, separated: true },
        ]} />
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
      <input ref={fileRef} type="file" multiple accept=".pgn,text/plain" className="hidden" onChange={(e) => void pickFiles(e)} />
      {pasting && (
        <div className="flex flex-col gap-1.5">
          <textarea autoFocus value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} placeholder={"[Event \"Najdorf: 6.Bg5\"]\n\n1. e4 c5 2. Nf3 d6 ..."} className="w-full font-mono text-body-sm p-2 rounded-sm bg-surface-container border border-outline/40 text-on-surface" />
          <span className="text-label-sm text-on-surface-variant">Several games become several chapters, named from their headers.</span>
          <div className="flex items-center gap-1 justify-end">
            <button onClick={() => { setPasting(false); setPasted(""); }} className={plain}>Cancel</button>
            <button onClick={() => { onImport([{ pgn: pasted }]); setPasted(""); setPasting(false); }} disabled={busy || !pasted.trim()} className={tonal}>Add as chapters</button>
          </div>
        </div>
      )}
      {confirmDelete && (
        <div className="flex items-center gap-1 flex-wrap">
          <button onClick={() => { setConfirmDelete(false); onDelete(); }} disabled={busy} className="h-7 px-2 rounded-full text-label-md text-error hover:bg-error/8">Delete it and its {plural(book.chapters.length, "chapter")}</button>
          <button onClick={() => setConfirmDelete(false)} className={plain}>Cancel</button>
        </div>
      )}
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
          <button onClick={() => setEditing(false)} className={`${tonal} self-end`} title="Each field is saved as you leave it">Done</button>
        </div>
      )}
      {note && <div className="text-label-sm text-on-surface-variant">{note}</div>}
    </div>
  );
}

/** Commands behind one ⋯. `up`: opens upwards (at the foot of a panel). */
function Menu({ entries, title, up = false }: {
  entries: { label: string; onClick: () => void; disabled?: boolean; separated?: boolean }[]; title: string; up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen((o) => !o)} className={`${nav} text-body-sm`} title={title} aria-haspopup="menu" aria-expanded={open}>⋯</button>
      {open && (
        <div role="menu" className={`absolute right-0 ${up ? "bottom-full mb-1" : "top-full mt-1"} z-20 min-w-44 py-1 rounded-md bg-surface-container-high border border-outline/40 shadow-lg flex flex-col`}>
          {entries.map((e) => (
            <button key={e.label} role="menuitem" disabled={e.disabled}
              onClick={() => { setOpen(false); e.onClick(); }}
              className={`text-left px-3 py-1.5 text-body-sm text-on-surface hover:bg-on-surface/8 disabled:opacity-40 disabled:hover:bg-transparent ${e.separated ? "border-t border-outline/40 mt-1 pt-2" : ""}`}>
              {e.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The book's chapters, with one menu for the chapter on the board and a
 *  mode for putting them in order. */
function ChaptersList({ book, busy, current, onPick, onMerge, onAnalyse, analysing, onRenameMany, onChapter, onDeleteChapter }: {
  book: BookWithChapters; busy: boolean; current: number | null;
  onPick: (id: number) => void;
  onMerge: (ids: number[]) => void;
  /** Analyse chapters for practice; `analysing`: a run is going on. */
  onAnalyse: (ids: number[]) => void;
  analysing: boolean;
  onRenameMany: (changes: { id: number; name: string }[]) => Promise<void>;
  onChapter: (id: number, patch: { name?: string; ord?: number; active?: boolean }) => void;
  onDeleteChapter: (id: number) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  // Merge mode: the chapters ticked for merging.
  const [selecting, setSelecting] = useState<number[] | null>(null);
  const [renamingAll, setRenamingAll] = useState(false);
  useEffect(() => setSelecting(null), [book.id]);
  const chapter = book.chapters.find((c) => c.id === current) ?? null;
  useEffect(() => setConfirmDelete(false), [current]);
  const none = !chapter || busy;

  return (
    <div className="flex flex-col">
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        <ColorDot color={book.color} />
        <span className="flex-1 min-w-0 truncate text-title-sm text-on-surface" title={book.name}>{book.name}</span>
        {arranging ? (
          <button onClick={() => setArranging(false)} className={tonal}>Done</button>
        ) : selecting ? (
          <>
            <button onClick={() => setSelecting(null)} className={plain}>Cancel</button>
            <button onClick={() => { onMerge(selecting); setSelecting(null); }} disabled={busy || selecting.length < 2} className={tonal}>
              Merge{selecting.length >= 2 ? ` ${selecting.length}` : ""}
            </button>
          </>
        ) : (
          <Menu title={chapter ? `The chapter on the board — ${chapter.name}` : "Rearrange the chapters; choose one for the rest"} entries={[
            { label: "Rename chapter…", onClick: () => chapter && setRenaming(chapter.id), disabled: none },
            { label: "Export chapter PGN…", onClick: () => chapter && void exportPgn(chapterPgnPath(chapter.id), `${book.name}-${chapter.name}`).then(setNote), disabled: none },
            { label: "Delete chapter…", onClick: () => setConfirmDelete(true), disabled: none },
            { label: "Rename chapters…", onClick: () => { setRenamingAll(true); setRenaming(null); }, disabled: busy || book.chapters.length === 0, separated: true },
            { label: "Rearrange chapters", onClick: () => { setArranging(true); setRenaming(null); }, disabled: busy || book.chapters.length < 2 },
            { label: "Merge chapters…", onClick: () => { setSelecting(current != null && chapter ? [current] : []); setRenaming(null); }, disabled: busy || book.chapters.length < 2 },
            { label: "Analyse chapter", onClick: () => chapter && onAnalyse([chapter.id]), disabled: none || analysing, separated: true },
            { label: "Analyse all chapters", onClick: () => onAnalyse(book.chapters.map((c) => c.id)), disabled: busy || analysing || book.chapters.length === 0 },
          ]} />
        )}
      </div>
      {renamingAll && (
        <RenameChaptersDialog bookName={book.name} chapters={book.chapters} busy={busy}
          onRename={(changes) => void onRenameMany(changes).then(() => setRenamingAll(false))}
          onCancel={() => setRenamingAll(false)} />
      )}
      {arranging && <div className="px-3 pb-1 text-label-sm text-on-surface-variant">Drag a chapter to its place, or move it with ▲ ▼.</div>}
      {selecting && <div className="px-3 pb-1 text-label-sm text-on-surface-variant">Tick the chapters to merge. The topmost keeps its name, place and main line; the others' lines and comments go into it, and they are deleted.</div>}
      {confirmDelete && chapter && (
        <div className="px-3 pb-1 flex items-center gap-1 flex-wrap">
          <button onClick={() => { setConfirmDelete(false); onDeleteChapter(chapter.id); }} disabled={busy} className="h-7 px-2 rounded-full text-label-md text-error hover:bg-error/8 truncate max-w-full">Delete “{chapter.name}”</button>
          <button onClick={() => setConfirmDelete(false)} className={plain}>Cancel</button>
        </div>
      )}
      {!book.active && <div className="px-3 pb-1 text-label-sm text-on-surface-variant">The book is off: these chapters are out of the repertoire whatever their switches say.</div>}
      <div className={`flex flex-col py-1 ${book.active ? "" : "opacity-70"}`}>
        {book.chapters.map((c, i) => (
          <ChapterRow key={c.id} chapter={c} busy={busy} current={c.id === current}
            renaming={renaming === c.id} arranging={arranging} first={i === 0} last={i === book.chapters.length - 1}
            dropTarget={arranging && over === c.id && dragged !== c.id}
            selected={selecting ? selecting.includes(c.id) : undefined}
            onSelect={(on) => setSelecting((s) => s && (on ? [...s, c.id] : s.filter((x) => x !== c.id)))}
            onPick={() => onPick(c.id)}
            onActive={(active) => onChapter(c.id, { active })}
            onRename={(n) => { setRenaming(null); if (n && n !== c.name) onChapter(c.id, { name: n }); }}
            onMove={(delta) => onChapter(c.id, { ord: c.ord + delta })}
            drag={{
              onDragStart: () => setDragged(c.id),
              onDragOver: (e) => { if (dragged != null) { e.preventDefault(); setOver(c.id); } },
              onDragLeave: () => setOver((o) => (o === c.id ? null : o)),
              onDrop: (e) => {
                e.preventDefault();
                if (dragged != null && dragged !== c.id) onChapter(dragged, { ord: c.ord });
                setDragged(null); setOver(null);
              },
              onDragEnd: () => { setDragged(null); setOver(null); },
            }} />
        ))}
        {book.chapters.length === 0 && <div className="px-3 py-1 text-label-sm text-on-surface-variant">No chapters yet — the book's ⋯ adds one: empty, pasted PGN, or PGN files.</div>}
      </div>
      {note && <div className="px-3 pb-2 text-label-sm text-on-surface-variant">{note}</div>}
    </div>
  );
}

function ChapterRow({ chapter: c, busy, current, renaming, arranging, first, last, dropTarget, selected, onSelect, onPick, onActive, onRename, onMove, drag }: {
  chapter: ChapterSummary; busy: boolean; current: boolean; renaming: boolean; arranging: boolean;
  first: boolean; last: boolean; dropTarget: boolean;
  /** In merge mode: ticked for merging (undefined outside it). */
  selected?: boolean; onSelect: (on: boolean) => void;
  onPick: () => void; onActive: (a: boolean) => void; onRename: (n: string) => void; onMove: (delta: -1 | 1) => void;
  drag: Pick<React.HTMLAttributes<HTMLDivElement>, "onDragStart" | "onDragOver" | "onDragLeave" | "onDrop" | "onDragEnd">;
}) {
  const [name, setName] = useState(c.name);
  useEffect(() => setName(c.name), [c.name, renaming]);
  const counts = `${c.lines} ${c.lines === 1 ? "line" : "lines"}${c.lines_off ? `, ${c.lines_off} off` : ""}`;
  // Analysed for practice: as the chapter is now, or changed since.
  const analysedOn = c.analysed_at ? new Date(c.analysed_at.replace(" ", "T")).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null;
  const stale = !!c.analysed_at && c.analysed_version !== c.updated_at;
  return (
    <div
      draggable={arranging && !busy}
      {...(arranging ? drag : {})}
      className={`flex items-center gap-1.5 px-3 py-1 ${current ? "bg-primary-container/40" : ""} ${c.active ? "" : "opacity-70"} ${arranging ? "cursor-grab" : ""} ${dropTarget ? "border-t-2 border-primary" : "border-t-2 border-transparent"}`}
    >
      {arranging
        ? <span className="shrink-0 text-on-surface-variant text-body-sm select-none" aria-hidden>⠿</span>
        : selected !== undefined
        ? <input type="checkbox" checked={selected} disabled={busy} onChange={(e) => onSelect(e.target.checked)} className="accent-tertiary shrink-0" title="Merge this chapter" />
        : <input type="checkbox" checked={c.active} disabled={busy} onChange={(e) => onActive(e.target.checked)} className="accent-primary shrink-0" title="Active: part of the repertoire you are playing now" />}
      {renaming ? (
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onBlur={() => onRename(name.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setName(c.name); onRename(c.name); } }}
          className={`${field} flex-1 min-w-0 h-7`} />
      ) : (
        <button onClick={onPick} className={`flex-1 min-w-0 text-left text-body-sm truncate ${current ? "text-on-surface font-medium" : "text-on-surface hover:text-primary"}`} title={`${c.name} — ${counts}`}>
          {c.name}
        </button>
      )}
      {arranging ? (
        <>
          <button onClick={() => onMove(-1)} disabled={busy || first} className={nav} title="Move up">▲</button>
          <button onClick={() => onMove(1)} disabled={busy || last} className={nav} title="Move down">▼</button>
        </>
      ) : (
        <>
          <span className="text-label-sm text-on-surface-variant tabular-nums shrink-0" title={counts}>{c.lines}{c.lines_off ? `−${c.lines_off}` : ""}</span>
          {/* Analysed for practice: a dot in a column of its own at the end,
              an empty slot when not, so neither the counts nor the dots move. */}
          <span className="shrink-0 w-2 flex justify-center"
            title={analysedOn ? (stale ? `Changed since the analysis of ${analysedOn} — analyse again for the new moves` : `Analysed ${analysedOn}`) : "Not analysed"}>
            {analysedOn && (
              <span aria-label={stale ? "changed since analysed" : "analysed"}
                className={`w-1.5 h-1.5 rounded-full ${stale ? "bg-tertiary" : "bg-primary"}`} />
            )}
          </span>
        </>
      )}
    </div>
  );
}
