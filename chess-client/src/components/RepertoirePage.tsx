// The Repertoire page (#327): books on the left, the selected book's
// chapters on the right — active toggles, line counts, rename, reorder,
// delete; a chapter is added empty, from pasted PGN or from a PGN file
// (one chapter per game); a book or a chapter exports to PGN. A chapter
// opens in the Analysis page to study and edit.

import { useEffect, useRef, useState } from "react";
import {
  addChapters, bookPgnPath, chapterPgnPath, createBook, deleteBook, deleteChapter, listRepertoire,
  updateBook, updateChapter, type BookColor, type BookWithChapters, type ChapterSummary,
} from "../lib/repertoire";
import { saveTextFile } from "../lib/exportPgn";
import { apiUrl } from "../api";

interface Props {
  onOpenChapter: (chapterId: number) => void;
}

const field = "h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface";
const tonal = "h-8 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 disabled:opacity-50 transition-all duration-short3 ease-standard";
const plain = "h-7 px-2 inline-flex items-center rounded-full text-label-md text-on-surface-variant hover:bg-on-surface/8 disabled:opacity-40 transition-colors duration-short3 ease-standard";

export default function RepertoirePage({ onOpenChapter }: Props) {
  const [books, setBooks] = useState<BookWithChapters[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(() => {
    const v = Number(localStorage.getItem("repertoireBook"));
    return Number.isFinite(v) && v > 0 ? v : null;
  });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const b = await listRepertoire();
      setBooks(b);
      setError(null);
      if (b.length && !b.some((x) => x.id === selected)) setSelected(b[0].id);
    } catch (e) { setError(String(e)); }
  };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (selected != null) localStorage.setItem("repertoireBook", String(selected)); }, [selected]);

  /** Run a change, then read everything again. */
  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await f(); await load(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  const book = books?.find((b) => b.id === selected) ?? null;

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden p-4 gap-4">
      <BooksColumn books={books} selected={selected} onSelect={setSelected} busy={busy} onCreate={(b) => run(async () => { const nb = await createBook(b); setSelected(nb.id); })} />
      <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto">
        {error && <div className="text-body-sm text-error">{error}</div>}
        {books && books.length === 0 && (
          <div className="text-body-md text-on-surface-variant max-w-xl">
            No books yet. A book is one opening course or one topic — "Najdorf for Black" — with the colour you play
            it from; its chapters hold the lines, one move tree each, to study in the Analysis page beside the
            reference database and the engines, and to adjust with the editor. Add a book on the left.
          </div>
        )}
        {book && (
          <BookView
            book={book}
            busy={busy}
            onOpenChapter={onOpenChapter}
            onRename={(name) => run(() => updateBook(book.id, { name }))}
            onColor={(color) => run(() => updateBook(book.id, { color }))}
            onUrl={(url) => run(() => updateBook(book.id, { url: url || null }))}
            onDelete={() => run(async () => { await deleteBook(book.id); setSelected(null); })}
            onAddEmpty={(name) => run(() => addChapters(book.id, { name }))}
            onImport={(pgn, name) => run(() => addChapters(book.id, { pgn, name }))}
            onChapter={(id, patch) => run(() => updateChapter(id, patch))}
            onDeleteChapter={(id) => run(() => deleteChapter(id))}
          />
        )}
      </div>
    </div>
  );
}

function BooksColumn({ books, selected, onSelect, busy, onCreate }: {
  books: BookWithChapters[] | null; selected: number | null; onSelect: (id: number) => void; busy: boolean;
  onCreate: (b: { name: string; color: BookColor; url?: string | null }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<BookColor>("white");
  const [url, setUrl] = useState("");
  return (
    <div className="w-72 shrink-0 flex flex-col gap-2 min-h-0">
      <div className="flex items-center justify-between">
        <h2 className="text-title-md text-on-surface">Books</h2>
        <button onClick={() => setAdding((a) => !a)} className={tonal}>{adding ? "Cancel" : "New book"}</button>
      </div>
      {adding && (
        <form
          className="rounded-md bg-surface-container-low border border-outline/40 p-3 flex flex-col gap-2"
          onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; onCreate({ name: name.trim(), color, url: url.trim() || null }); setName(""); setUrl(""); setAdding(false); }}
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name — Najdorf for Black" className={field} />
          <ColorPick value={color} onChange={setColor} />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link to the course (optional)" className={field} />
          <button type="submit" disabled={busy || !name.trim()} className={tonal}>Add</button>
        </form>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
        {books?.map((b) => {
          const active = b.chapters.filter((c) => c.active).length;
          return (
            <button
              key={b.id}
              onClick={() => onSelect(b.id)}
              className={`text-left rounded-md px-3 py-2 border transition-colors duration-short3 ease-standard ${
                b.id === selected ? "border-primary bg-surface-container" : "border-outline/40 bg-surface-container-low hover:bg-on-surface/8"
              }`}
            >
              <div className="flex items-center gap-2">
                <ColorDot color={b.color} />
                <span className="text-body-md text-on-surface truncate">{b.name}</span>
              </div>
              <div className="text-label-sm text-on-surface-variant mt-0.5">
                {b.chapters.length} {b.chapters.length === 1 ? "chapter" : "chapters"}{b.chapters.length ? ` · ${active} active` : ""}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ColorDot({ color }: { color: BookColor }) {
  return <span className={`inline-block w-3 h-3 rounded-full border border-outline shrink-0 ${color === "white" ? "bg-white" : "bg-black"}`} title={`Played as ${color}`} />;
}

function ColorPick({ value, onChange }: { value: BookColor; onChange: (c: BookColor) => void }) {
  const pill = (on: boolean) => `h-7 px-3 text-label-md ${on ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface-variant hover:bg-on-surface/8"}`;
  return (
    <span className="inline-flex items-center gap-2 text-body-sm text-on-surface">
      <span>Played as</span>
      <span className="inline-flex rounded-full overflow-hidden border border-outline/40">
        <button type="button" className={pill(value === "white")} onClick={() => onChange("white")}>White</button>
        <button type="button" className={pill(value === "black")} onClick={() => onChange("black")}>Black</button>
      </span>
    </span>
  );
}

function BookView({ book, busy, onOpenChapter, onRename, onColor, onUrl, onDelete, onAddEmpty, onImport, onChapter, onDeleteChapter }: {
  book: BookWithChapters; busy: boolean;
  onOpenChapter: (id: number) => void;
  onRename: (name: string) => void; onColor: (c: BookColor) => void; onUrl: (u: string) => void; onDelete: () => void;
  onAddEmpty: (name: string) => void; onImport: (pgn: string, name?: string) => void;
  onChapter: (id: number, patch: { name?: string; ord?: number; active?: boolean }) => void;
  onDeleteChapter: (id: number) => void;
}) {
  const [name, setName] = useState(book.name);
  const [url, setUrl] = useState(book.url ?? "");
  useEffect(() => { setName(book.name); setUrl(book.url ?? ""); }, [book.id, book.name, book.url]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [newName, setNewName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  async function exportBook() {
    try {
      const r = await fetch(apiUrl(bookPgnPath(book.id)));
      if (!r.ok) throw new Error(`${r.status}`);
      const ok = await saveTextFile(`${book.name.replace(/[^\w.-]+/g, "_")}.pgn`, await r.text());
      setNote(ok ? "Book saved as PGN" : null);
    } catch (e) { setNote(`Could not export: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async function exportChapter(c: ChapterSummary) {
    try {
      const r = await fetch(apiUrl(chapterPgnPath(c.id)));
      if (!r.ok) throw new Error(`${r.status}`);
      const ok = await saveTextFile(`${book.name}-${c.name}`.replace(/[^\w.-]+/g, "_") + ".pgn", await r.text());
      setNote(ok ? "Chapter saved as PGN" : null);
    } catch (e) { setNote(`Could not export: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    onImport(await f.text());
  }

  const total = book.chapters.reduce((n, c) => n + c.lines, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md bg-surface-container-low border border-outline/40 p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name.trim() !== book.name) onRename(name.trim()); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} className={`${field} text-title-md min-w-64 flex-1`} title="The book's name — click to rename" />
          <ColorPick value={book.color} onChange={onColor} />
          <button onClick={() => void exportBook()} disabled={busy || book.chapters.length === 0} className={plain} title="Save the book's chapters as one PGN file">Export PGN…</button>
          {confirmDelete ? (
            <span className="inline-flex items-center gap-1">
              <button onClick={() => { setConfirmDelete(false); onDelete(); }} disabled={busy} className="h-7 px-3 rounded-full text-label-md text-error hover:bg-error/8">Delete the book and its {book.chapters.length} chapters</button>
              <button onClick={() => setConfirmDelete(false)} className={plain}>Cancel</button>
            </span>
          ) : (
            <button onClick={() => setConfirmDelete(true)} disabled={busy} className={plain} title="Delete the book and its chapters">Delete…</button>
          )}
        </div>
        <div className="flex items-center gap-2 text-body-sm text-on-surface-variant flex-wrap">
          <input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => { if (url.trim() !== (book.url ?? "")) onUrl(url.trim()); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} placeholder="Link to the course (optional)" className={`${field} flex-1 min-w-64`} />
          <span>{book.chapters.length} {book.chapters.length === 1 ? "chapter" : "chapters"} · {total} {total === 1 ? "line" : "lines"}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-title-sm text-on-surface mr-auto">Chapters</h3>
        <form className="inline-flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); onAddEmpty(newName.trim() || `Chapter ${book.chapters.length + 1}`); setNewName(""); }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New chapter's name" className={`${field} w-48`} />
          <button type="submit" disabled={busy} className={tonal} title="An empty chapter: open it and play the lines in">Add empty</button>
        </form>
        <button onClick={() => setPasting((p) => !p)} className={tonal}>{pasting ? "Cancel" : "Paste PGN…"}</button>
        <button onClick={() => fileRef.current?.click()} disabled={busy} className={tonal} title="A PGN file: one chapter per game, named from its headers (a Lichess study exports this way)">Import PGN file…</button>
        <input ref={fileRef} type="file" accept=".pgn,text/plain" className="hidden" onChange={(e) => void pickFile(e)} />
      </div>
      {pasting && (
        <div className="rounded-md bg-surface-container-low border border-outline/40 p-3 flex flex-col gap-2">
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={8} placeholder={"[Event \"Najdorf: 6.Bg5\"]\n\n1. e4 c5 2. Nf3 d6 ..."} className="w-full font-mono text-body-sm p-2 rounded-sm bg-surface-container border border-outline/40 text-on-surface" />
          <div className="flex items-center gap-2">
            <button onClick={() => { onImport(pasted); setPasted(""); setPasting(false); }} disabled={busy || !pasted.trim()} className={tonal}>Add as chapters</button>
            <span className="text-label-sm text-on-surface-variant">Several games become several chapters, named from their headers.</span>
          </div>
        </div>
      )}
      {note && <div className="text-body-sm text-on-surface-variant">{note}</div>}

      <div className="flex flex-col gap-1">
        {book.chapters.map((c, i) => (
          <ChapterRow
            key={c.id} chapter={c} busy={busy} first={i === 0} last={i === book.chapters.length - 1}
            onOpen={() => onOpenChapter(c.id)}
            onActive={(active) => onChapter(c.id, { active })}
            onRename={(n) => onChapter(c.id, { name: n })}
            onMove={(delta) => onChapter(c.id, { ord: c.ord + delta })}
            onExport={() => void exportChapter(c)}
            onDelete={() => onDeleteChapter(c.id)}
          />
        ))}
        {book.chapters.length === 0 && <div className="text-body-sm text-on-surface-variant">No chapters yet — add an empty one, paste PGN, or import a file.</div>}
      </div>
    </div>
  );
}

function ChapterRow({ chapter: c, busy, first, last, onOpen, onActive, onRename, onMove, onExport, onDelete }: {
  chapter: ChapterSummary; busy: boolean; first: boolean; last: boolean;
  onOpen: () => void; onActive: (a: boolean) => void; onRename: (n: string) => void; onMove: (delta: -1 | 1) => void; onExport: () => void; onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(c.name);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setName(c.name), [c.name]);
  const nav = "w-6 h-6 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 disabled:opacity-30 text-[10px]";
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-md border border-outline/40 bg-surface-container-low ${c.active ? "" : "opacity-70"}`}>
      <input type="checkbox" checked={c.active} disabled={busy} onChange={(e) => onActive(e.target.checked)} className="accent-primary" title="Active: part of the repertoire you are playing now" />
      <span className="text-label-sm text-on-surface-variant tabular-nums w-6">{c.ord}.</span>
      {renaming ? (
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onBlur={() => { setRenaming(false); if (name.trim() && name.trim() !== c.name) onRename(name.trim()); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setName(c.name); setRenaming(false); } }}
          className={`${field} flex-1 min-w-0`} />
      ) : (
        <button onClick={onOpen} className="flex-1 min-w-0 text-left text-body-md text-on-surface hover:text-primary truncate" title="Open in the Analysis page">{c.name}</button>
      )}
      <span className="text-label-sm text-on-surface-variant tabular-nums whitespace-nowrap">
        {c.lines} {c.lines === 1 ? "line" : "lines"}{c.lines_off ? `, ${c.lines_off} off` : ""}
      </span>
      <button onClick={() => setRenaming(true)} className={plain} disabled={busy}>Rename</button>
      <button onClick={() => onMove(-1)} disabled={busy || first} className={nav} title="Move up">▲</button>
      <button onClick={() => onMove(1)} disabled={busy || last} className={nav} title="Move down">▼</button>
      <button onClick={onExport} className={plain} title="Save the chapter as a PGN file">PGN…</button>
      {confirm ? (
        <>
          <button onClick={() => { setConfirm(false); onDelete(); }} disabled={busy} className="h-7 px-2 rounded-full text-label-md text-error hover:bg-error/8">Delete</button>
          <button onClick={() => setConfirm(false)} className={plain}>Cancel</button>
        </>
      ) : (
        <button onClick={() => setConfirm(true)} disabled={busy} className={plain} title="Delete the chapter">✕</button>
      )}
    </div>
  );
}
