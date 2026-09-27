// The Repertoire page (#327): the books and chapters in a collapsible panel
// on the left — as the Players page keeps its players — and the chapter
// being studied on the right, with the Analysis page's own layout (board,
// moves, Reference / Games / Lines, engines) but no rail of open games.
// Switching chapters, or books, stays on this page.

import { useCallback, useEffect, useRef, useState } from "react";
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
const CHAPTER_KEY = "repertoireChapter";
const COLLAPSED_KEY = "repertoirePanelCollapsed";

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

export default function RepertoirePage({ onOpenGame }: Props) {
  const [books, setBooks] = useState<BookWithChapters[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  useEffect(() => { localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); }, [collapsed]);
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

  // The book shown in the panel follows the chapter on the board.
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
  const tabsRef = useRef<AnalysisTab[]>([]);
  tabsRef.current = tab ? [tab] : [];

  const book = books?.find((b) => b.id === selectedBook) ?? null;
  const panel = collapsed ? (
    <button
      onClick={() => setCollapsed(false)}
      className="h-full w-full flex flex-col items-center gap-2 pt-3 bg-surface-container-low border border-outline/40 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-on-surface/4 transition-colors duration-short3 ease-standard"
      title="Show the books and chapters"
    >
      <span className="text-body-md">»</span>
      <span className="text-label-sm uppercase tracking-wider" style={{ writingMode: "vertical-rl" }}>Repertoire</span>
    </button>
  ) : (
    <div className="h-full overflow-hidden flex flex-col bg-surface-container-low border border-outline/40 rounded-md">
      <div className="px-3 py-2 flex items-center justify-between border-b border-outline/40 shrink-0">
        <span className="text-label-md text-on-surface-variant uppercase tracking-wider">Repertoire</span>
        <button onClick={() => setCollapsed(true)} className="h-7 px-2 inline-flex items-center rounded-full text-on-surface-variant hover:bg-on-surface/8 text-body-md" title="Hide the books and chapters">«</button>
      </div>
      {error && <div className="px-3 py-1 text-body-sm text-error">{error}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        <BooksList books={books} selected={selectedBook} onSelect={setSelectedBook} busy={busy}
          onCreate={(b) => run(async () => { const nb = await createBook(b); setSelectedBook(nb.id); })} />
        {book && (
          <ChaptersList
            book={book} busy={busy} current={chapterId}
            onPick={setChapterId}
            onRename={(name) => run(() => updateBook(book.id, { name }))}
            onColor={(color) => run(() => updateBook(book.id, { color }))}
            onUrl={(url) => run(() => updateBook(book.id, { url: url || null }))}
            onDelete={() => run(async () => {
              await deleteBook(book.id);
              if (book.chapters.some((c) => c.id === chapterId)) { setChapterId(null); localStorage.removeItem(CHAPTER_KEY); }
              setSelectedBook(null);
            })}
            onAddEmpty={(name) => run(async () => { const [c] = await addChapters(book.id, { name }); if (c) setChapterId(c.id); })}
            onImport={(pgn) => run(async () => { const cs = await addChapters(book.id, { pgn }); if (cs[0] && chapterId == null) setChapterId(cs[0].id); })}
            onChapter={(id, patch) => run(() => updateChapter(id, patch))}
            onDeleteChapter={(id) => run(async () => { await deleteChapter(id); if (id === chapterId) { setChapterId(null); localStorage.removeItem(CHAPTER_KEY); } })}
          />
        )}
      </div>
    </div>
  );

  return (
    <AnalysisPage
      key={collapsed ? "collapsed" : "open"}
      tabs={tab ? [tab] : []}
      activeKey={tab?.key ?? null}
      onActivate={() => {}}
      onClose={() => { setChapterId(null); localStorage.removeItem(CHAPTER_KEY); }}
      onCloseMany={() => {}}
      onMove={() => {}}
      capacity={1}
      onOpenGame={onOpenGame}
      onTabState={onTabState}
      onGameMutated={() => void load()}
      leadingPanel={panel}
      leadingPanelSize={collapsed ? "3" : "18"}
      leadingPanelMax={collapsed ? "3" : "40"}
      layoutId={collapsed ? "repertoire-collapsed" : "repertoire-main"}
      emptyState={books && books.length === 0
        ? "No books yet. A book is one opening course or one topic — \"Najdorf for Black\" — with the colour you play it from; its chapters hold the lines. Add a book on the left."
        : "Choose a chapter on the left to study it here — or add one: empty, from pasted PGN, or from a PGN file."}
    />
  );
}

// ── The panel ────────────────────────────────────────────────────────────────

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

function BooksList({ books, selected, onSelect, busy, onCreate }: {
  books: BookWithChapters[] | null; selected: number | null; onSelect: (id: number) => void; busy: boolean;
  onCreate: (b: { name: string; color: BookColor }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<BookColor>("white");
  return (
    <div className="shrink-0 border-b border-outline/40">
      <div className="px-3 pt-2 pb-1 flex items-center justify-between">
        <span className="text-title-sm text-on-surface">Books</span>
        <button onClick={() => setAdding((a) => !a)} className={plain}>{adding ? "Cancel" : "+ New"}</button>
      </div>
      {adding && (
        <form className="px-3 pb-2 flex flex-col gap-1.5"
          onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; onCreate({ name: name.trim(), color }); setName(""); setAdding(false); }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name — Najdorf for Black" className={field} />
          <div className="flex items-center gap-2 text-label-sm text-on-surface-variant">Played as <ColorPick value={color} onChange={setColor} /><button type="submit" disabled={busy || !name.trim()} className={`${tonal} ml-auto`}>Add</button></div>
        </form>
      )}
      <div className="flex flex-col pb-1">
        {books?.map((b) => {
          const active = b.chapters.filter((c) => c.active).length;
          return (
            <button key={b.id} onClick={() => onSelect(b.id)}
              className={`text-left px-3 py-1.5 flex items-center gap-2 transition-colors duration-short3 ease-standard ${b.id === selected ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8"}`}>
              <ColorDot color={b.color} />
              <span className="flex-1 min-w-0 truncate text-body-sm">{b.name}</span>
              <span className="text-label-sm opacity-70 tabular-nums">{active}/{b.chapters.length}</span>
            </button>
          );
        })}
        {books && books.length === 0 && <div className="px-3 py-1 text-label-sm text-on-surface-variant">None yet.</div>}
      </div>
    </div>
  );
}

function ChaptersList({ book, busy, current, onPick, onRename, onColor, onUrl, onDelete, onAddEmpty, onImport, onChapter, onDeleteChapter }: {
  book: BookWithChapters; busy: boolean; current: number | null;
  onPick: (id: number) => void;
  onRename: (name: string) => void; onColor: (c: BookColor) => void; onUrl: (u: string) => void; onDelete: () => void;
  onAddEmpty: (name: string) => void; onImport: (pgn: string) => void;
  onChapter: (id: number, patch: { name?: string; ord?: number; active?: boolean }) => void;
  onDeleteChapter: (id: number) => void;
}) {
  const [settings, setSettings] = useState(false);
  const [name, setName] = useState(book.name);
  const [url, setUrl] = useState(book.url ?? "");
  useEffect(() => { setName(book.name); setUrl(book.url ?? ""); }, [book.id, book.name, book.url]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  async function exportPgn(path: string, filename: string) {
    try {
      const r = await fetch(apiUrl(path));
      if (!r.ok) throw new Error(`${r.status}`);
      const ok = await saveTextFile(filename.replace(/[^\w.-]+/g, "_") + ".pgn", await r.text());
      setNote(ok ? "Saved as PGN" : null);
    } catch (e) { setNote(`Could not export: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) onImport(await f.text());
  }

  return (
    <div className="flex flex-col">
      <div className="px-3 pt-2 pb-1 flex items-center gap-1">
        <ColorDot color={book.color} />
        <span className="flex-1 min-w-0 truncate text-title-sm text-on-surface" title={book.name}>{book.name}</span>
        <button onClick={() => setSettings((s) => !s)} className={plain} title="The book's name, colour, link, export and delete">{settings ? "Done" : "Book…"}</button>
      </div>
      {settings && (
        <div className="px-3 pb-2 flex flex-col gap-1.5 border-b border-outline/40">
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name.trim() !== book.name) onRename(name.trim()); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} className={field} title="Rename" />
          <div className="flex items-center gap-2 text-label-sm text-on-surface-variant">Played as <ColorPick value={book.color} onChange={onColor} /></div>
          <input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => { if (url.trim() !== (book.url ?? "")) onUrl(url.trim()); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} placeholder="Link to the course (optional)" className={field} />
          <div className="flex items-center gap-1 flex-wrap">
            <button onClick={() => void exportPgn(bookPgnPath(book.id), book.name)} disabled={busy || book.chapters.length === 0} className={plain} title="Save the book's chapters as one PGN file">Export PGN…</button>
            {confirmDelete ? (
              <>
                <button onClick={() => { setConfirmDelete(false); onDelete(); }} disabled={busy} className="h-7 px-2 rounded-full text-label-md text-error hover:bg-error/8">Delete the book and its {book.chapters.length} chapters</button>
                <button onClick={() => setConfirmDelete(false)} className={plain}>Cancel</button>
              </>
            ) : (
              <button onClick={() => setConfirmDelete(true)} disabled={busy} className={plain}>Delete…</button>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col py-1">
        {book.chapters.map((c, i) => (
          <ChapterRow key={c.id} chapter={c} busy={busy} current={c.id === current} first={i === 0} last={i === book.chapters.length - 1}
            onPick={() => onPick(c.id)}
            onActive={(active) => onChapter(c.id, { active })}
            onRename={(n) => onChapter(c.id, { name: n })}
            onMove={(delta) => onChapter(c.id, { ord: c.ord + delta })}
            onExport={() => void exportPgn(chapterPgnPath(c.id), `${book.name}-${c.name}`)}
            onDelete={() => onDeleteChapter(c.id)} />
        ))}
        {book.chapters.length === 0 && <div className="px-3 py-1 text-label-sm text-on-surface-variant">No chapters yet.</div>}
      </div>
      <div className="px-3 py-2 flex items-center gap-1 flex-wrap border-t border-outline/40">
        <button onClick={() => onAddEmpty(`Chapter ${book.chapters.length + 1}`)} disabled={busy} className={tonal} title="An empty chapter: play the lines in with Edit lines…">+ Empty</button>
        <button onClick={() => setPasting((p) => !p)} className={tonal}>{pasting ? "Cancel" : "Paste PGN…"}</button>
        <button onClick={() => fileRef.current?.click()} disabled={busy} className={tonal} title="A PGN file: one chapter per game, named from its headers (a Lichess study exports this way)">Import…</button>
        <input ref={fileRef} type="file" accept=".pgn,text/plain" className="hidden" onChange={(e) => void pickFile(e)} />
      </div>
      {pasting && (
        <div className="px-3 pb-2 flex flex-col gap-1.5">
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} placeholder={"[Event \"Najdorf: 6.Bg5\"]\n\n1. e4 c5 2. Nf3 d6 ..."} className="w-full font-mono text-body-sm p-2 rounded-sm bg-surface-container border border-outline/40 text-on-surface" />
          <button onClick={() => { onImport(pasted); setPasted(""); setPasting(false); }} disabled={busy || !pasted.trim()} className={tonal}>Add as chapters</button>
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
  const nav = "w-6 h-6 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 disabled:opacity-30 text-[10px]";
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
