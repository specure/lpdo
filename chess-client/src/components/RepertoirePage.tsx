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
  saveChapterMoves, updateBook, updateChapter, documentOf, analyseChapters, getBookGames, scorePct, importBooks, deleteChapters, orderChapters,
  type BookGames, type Score, type BookColor, type BookWithChapters, type ChapterSummary, type GameResult, GAME_RESULTS,
} from "../lib/repertoire";
import { saveTextFile } from "../lib/exportPgn";
import { useJobProgress } from "../hooks/useJobProgress";
import { currentMyPlayer } from "./MyStatsWidget";
import { buildPlayback } from "../lib/useGamePgn";
import { apiUrl } from "../api";
import AnalysisPage, { type AnalysisTab } from "./AnalysisPage";
import MergeChaptersDialog from "./repertoire/MergeChaptersDialog";
import RenameChaptersDialog from "./repertoire/RenameChaptersDialog";
import { mergeChapters, resolveMerge, type MergeChoices } from "../lib/mergeChapters";
import { parsePgnTree } from "../lib/parsePgnTree";
import { serializeMovetext } from "../lib/serializeMovetext";
import { stripFens } from "../lib/stripFens";
import type { CursorPath } from "../lib/moveTreeNav";

interface Props {
  /** Open games (a related game from the Games tab) in the Analysis page. */
  onOpenGame: (games: GameSummary[]) => Promise<number>;
}

const field = "h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface";
const tonal = "h-7 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 disabled:opacity-50 transition-all duration-short3 ease-standard whitespace-nowrap";
const plain = "h-7 px-2 inline-flex items-center rounded-full text-label-md text-on-surface-variant hover:bg-on-surface/8 disabled:opacity-40 transition-colors duration-short3 ease-standard whitespace-nowrap";
const nav = "w-6 h-6 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 disabled:opacity-30 text-[10px]";
// ▲ ▼ in a row being arranged: as tall as the row's line of text, so the
// rows keep their spacing while they are moved; the buttons overhang it.
const moveNav = `${nav} -my-1`;
const box = "h-full overflow-hidden flex flex-col bg-surface-container-low border border-outline/40 rounded-md";
const CHAPTER_KEY = "repertoireChapter";
const BOOKS_FOLDED_KEY = "repertoireBooksCollapsed";
const CHAPTERS_FOLDED_KEY = "repertoireChaptersCollapsed";

/** Where the board was in each chapter — the position, the cursor in the
 *  moves, which way up — so leaving the page (or the chapter) and coming
 *  back finds it there. The 50 chapters looked at last. */
const VIEWS_KEY = "repertoireChapterViews";
type ChapterView = { fen: string | null; cursor: CursorPath | null; flipped: boolean };

function readViews(): Record<string, ChapterView> {
  try {
    const v = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}

function saveView(chapterId: number, view: ChapterView) {
  try {
    const all = readViews();
    delete all[chapterId];
    all[chapterId] = view;
    const ids = Object.keys(all);
    for (const id of ids.slice(0, Math.max(0, ids.length - 50))) delete all[id];
    localStorage.setItem(VIEWS_KEY, JSON.stringify(all));
  } catch { /* storage full or off: the view is simply not kept */ }
}

/** A cursor read back from storage, if it is one — the moves may have been
 *  edited since; the board copes with a path that no longer fits. */
function validCursor(raw: unknown): CursorPath | null {
  if (!raw || typeof raw !== "object") return null;
  const { steps, index } = raw as Partial<CursorPath>;
  if (!Array.isArray(steps) || typeof index !== "number" || !Number.isFinite(index)) return null;
  if (!steps.every((s) => s && typeof s.node === "number" && typeof s.varIdx === "number")) return null;
  return { steps, index };
}

/** An Analysis tab for a chapter, fetched afresh — the board where it was
 *  left in this chapter. */
async function loadTab(chapterId: number): Promise<AnalysisTab> {
  const c = await getChapter(chapterId);
  const view = readViews()[chapterId];
  const game: GameSummary = {
    id: -c.id, white: c.name, black: c.book.name, white_elo: null, black_elo: null,
    // A model game's result — a chapter has none.
    event: c.book.name, date: null, result: c.model ? c.result : null, eco: null, move_count: null, opening_line: null,
  };
  return {
    key: `c${c.id}`, game,
    loaded: { id: -c.id, white: c.name, black: c.book.name, result: c.model ? c.result : null, date: null, event: c.book.name, pgn: c.pgn, gameUrl: null, ...buildPlayback(c.pgn) },
    fen: typeof view?.fen === "string" ? view.fen : null,
    cursor: validCursor(view?.cursor),
    flipped: typeof view?.flipped === "boolean" ? view.flipped : c.book.color === "black",
    document: documentOf(c),
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
  // "Your games": the book's line picked instead of a chapter — My games then
  // lists the whole book's games (the chapter stays on the board).
  const [bookPicked, setBookPicked] = useState(false);
  // Bumped when the chapter on the board was changed here, outside the
  // editor (FENs removed, chapters merged into it): the board reads it again.
  const [docReload, setDocReload] = useState(0);
  useEffect(() => setBookPicked(false), [selectedBook]);
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

  // The book shown follows the chapter on the board — when another chapter
  // is chosen (or the books first come), not on every reading of the books:
  // a save while another book is shown (its details being edited) must not
  // switch back to the chapter's.
  const followed = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!books) return;
    const owner = chapterId != null ? books.find((b) => b.chapters.some((c) => c.id === chapterId)) : undefined;
    if (owner && followed.current !== chapterId) { followed.current = chapterId; setSelectedBook(owner.id); }
    else if (selectedBook == null || !books.some((b) => b.id === selectedBook)) setSelectedBook(owner?.id ?? books[0]?.id ?? null);
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
  // Keep where the board is in the chapter, for coming back to it.
  useEffect(() => {
    if (tab?.document) saveView(tab.document.id, { fen: tab.fen, cursor: tab.cursor, flipped: tab.flipped });
  }, [tab?.document?.id, tab?.fen, tab?.cursor, tab?.flipped]);
  function dropChapter() { setChapterId(null); localStorage.removeItem(CHAPTER_KEY); }

  const book = books?.find((b) => b.id === selectedBook) ?? null;

  const addEmpty = (bookId: number, name: string) =>
    run(async () => { const [c] = await addChapters(bookId, { name }); if (c) setChapterId(c.id); });
  // Books from LPDO's own export (a book, or a backup): made again, each a
  // new book — never added to the one selected.
  const importBookFiles = (items: { pgn: string; file?: string }[]) => run(async () => {
    let first: number | null = null;
    try {
      for (const [i, it] of items.entries()) {
        setImporting({ i: i + 1, n: items.length, file: it.file ?? null });
        const made = await importBooks(it.pgn, it.file).catch((e) => { throw new Error(it.file ? `${it.file}: ${String(e)}` : String(e)); });
        first ??= made[0]?.id ?? null;
      }
    } finally {
      setImporting(null);
    }
    if (first != null) setSelectedBook(first);
  });

  // An import going on: which file of how many — shown above the chapters,
  // so a long one is not taken for nothing happening.
  const [importing, setImporting] = useState<{ i: number; n: number; file: string | null } | null>(null);
  /** Chapters made model games, or model games chapters again. */
  const convert = (ids: number[], model: boolean) => run(async () => {
    for (const id of ids) {
      const c = await updateChapter(id, { model });
      if (c.model !== model) throw new Error("The server does not know model games yet. Update the server (lpdo-server 0.21.42 or later).");
    }
  });
  /** `model`: the games are model games of the book. */
  const importPgn = (bookId: number, items: { pgn: string; file?: string }[], model = false) => run(async () => {
    // One file at a time, in the order picked: each adds its chapters at the
    // end. A file that fails stops the rest.
    let first: number | null = null;
    try {
      for (const [i, it] of items.entries()) {
        setImporting({ i: i + 1, n: items.length, file: it.file ?? null });
        const cs = await addChapters(bookId, { ...it, model }).catch((e) => { throw new Error(it.file ? `${it.file}: ${String(e)}` : String(e)); });
        // A server from before model games takes them for chapters, silently.
        if (model && cs.some((c) => c.model !== true)) {
          throw new Error("The server does not know model games yet — they were added as chapters. Update the server (lpdo-server 0.21.42 or later), then select them and use “Make N model games”.");
        }
        first ??= cs[0]?.id ?? null;
      }
    } finally {
      setImporting(null);
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
  // Reading and merging many chapters can take a while before the window
  // opens: until then the page waits under a "Please wait" cover, so nothing
  // else is clicked and the merge isn't started twice.
  const [preparingMerge, setPreparingMerge] = useState(false);
  const startMerge = (ids: number[]) => !preparingMerge && run(async () => {
    const cs = (book?.chapters ?? []).filter((c) => ids.includes(c.id)).sort((a, b) => a.ord - b.ord);
    if (cs.length < 2) return;
    setPreparingMerge(true);
    try { await prepareMerge(cs); } finally { setPreparingMerge(false); }
  });
  const prepareMerge = async (cs: ChapterSummary[]) => {
    const [first, ...rest] = await Promise.all(cs.map((c) => getChapter(c.id)));
    // Names as the list shows them; a repeated one numbered "(2)", "(3)" in
    // list order, so the merge window tells them apart.
    const seen = new Map<string, number>();
    const labels = cs.map((c) => {
      const n = (seen.get(c.name) ?? 0) + 1;
      seen.set(c.name, n);
      return n > 1 ? `${c.name} (${n})` : c.name;
    });
    // The merge itself holds the page: let the cover paint first.
    await new Promise((r) => setTimeout(r, 30));
    const result = mergeChapters({ name: labels[0], pgn: first.pgn }, rest.map((c, i) => ({ name: labels[i + 1], pgn: c.pgn })));
    setMerging({ target: cs[0], others: cs.slice(1), labels, result });
  };
  // How many FENs each chapter's comments hold — nothing changed.
  const countFens = async (ids: number[]): Promise<{ id: number; name: string; n: number }[]> => {
    const out: { id: number; name: string; n: number }[] = [];
    for (const id of ids) {
      const c = await getChapter(id);
      out.push({ id, name: c.name, n: stripFens(parsePgnTree(c.pgn)) });
    }
    return out;
  };

  // FEN strings left in the comments (exports from other tools): removed,
  // the chapters saved; how many were removed — null when it failed (the
  // error shows instead).
  const removeFens = async (ids: number[]): Promise<number | null> => {
    let total = 0;
    let done = false;
    await run(async () => {
      for (const id of ids) {
        const c = await getChapter(id);
        const tree = parsePgnTree(c.pgn);
        const n = stripFens(tree);
        if (n === 0) continue;
        await saveChapterMoves(id, serializeMovetext(tree));
        total += n;
      }
      if (total && chapterId != null && ids.includes(chapterId)) {
        setTab(await loadTab(chapterId));
        setDocReload((v) => v + 1);
      }
      done = true;
    });
    return done ? total : null;
  };

  const finishMerge = (choices: MergeChoices, noteChapters: boolean) => merging && run(async () => {
    const { target, others, result } = merging;
    await saveChapterMoves(target.id, resolveMerge(result, choices, noteChapters));
    // All at once, in one transaction: one request a chapter, each renumbering
    // the rest, made merging 50 chapters take minutes.
    await deleteChapters(others.map((o) => o.id));
    setMerging(null);
    // The merged chapter on the board, read again.
    if (chapterId === target.id) { setTab(await loadTab(target.id)); setDocReload((v) => v + 1); }
    else setChapterId(target.id);
  });

  // The keys go where one is working, as in a file manager: the panel
  // clicked last. ↑ ↓ step through its books or chapters (elsewhere, the
  // board's lines); F2 edits the book, else renames the chapter(s).
  const keysFor = useRef<"books" | "chapters" | "models" | "reference" | "board">("board");
  useEffect(() => {
    // Ahead of the panels' own (capturing) handlers, which then claim it.
    const away = () => { keysFor.current = "board"; };
    window.addEventListener("mousedown", away, true);
    return () => window.removeEventListener("mousedown", away, true);
  }, []);
  const f2Books = useCallback(() => keysFor.current === "books", []);
  const f2Chapters = useCallback(() => keysFor.current === "chapters" || keysFor.current === "board", []);
  const arrowsChapters = useCallback(() => keysFor.current === "chapters", []);
  const f2Models = useCallback(() => keysFor.current === "models" || keysFor.current === "board", []);
  const arrowsModels = useCallback(() => keysFor.current === "models", []);
  const f2Reference = useCallback(() => keysFor.current === "reference" || keysFor.current === "board", []);
  const arrowsReference = useCallback(() => keysFor.current === "reference", []);
  const booksPanel = booksFolded ? <Strip label="Books" onOpen={() => setBooksFolded(false)} /> : (
    <div className={box} onMouseDownCapture={() => { keysFor.current = "books"; }}>
      <BooksPanel
        books={books} selected={selectedBook} busy={busy} error={error} f2Here={f2Books}
        onSelect={setSelectedBook} onFold={() => setBooksFolded(true)}
        onCreate={(b) => run(async () => { const nb = await createBook(b); setSelectedBook(nb.id); })}
        onUpdate={(id, patch) => run(() => updateBook(id, patch))}
        onImportBooks={importBookFiles}
        onDelete={(b) => run(async () => {
          await deleteBook(b.id);
          if (b.chapters.some((c) => c.id === chapterId)) dropChapter();
          setSelectedBook(null);
        })}
      />
    </div>
  );
  const chaptersPanel = chaptersFolded ? <Strip label={book ? book.name : "Chapters"} onOpen={() => setChaptersFolded(false)} /> : (
    <div className={box} onMouseDownCapture={() => { keysFor.current = "chapters"; }}>
      <div className="px-3 py-2 flex items-center gap-2 border-b border-outline/40 shrink-0">
        <span className="flex-1 min-w-0 truncate text-label-md text-on-surface-variant uppercase tracking-wider" title={book?.name}>Chapters</span>
        <button onClick={() => setChaptersFolded(true)} className="h-7 px-2 inline-flex items-center rounded-full text-on-surface-variant hover:bg-on-surface/8 text-body-md" title="Hide the chapters">«</button>
      </div>
      {importing && (
        <div className="px-3 py-2 shrink-0 border-b border-outline/40 flex flex-col gap-1">
          <span className="text-label-sm text-on-surface-variant truncate">
            Importing{importing.file ? ` “${importing.file}”` : " the PGN"}{importing.n > 1 ? ` (${importing.i} of ${importing.n})` : ""}…
          </span>
          <div className="h-1 rounded-full bg-on-surface/10 overflow-hidden">
            <div className="h-full bg-primary transition-all duration-medium2" style={{ width: `${Math.round(((importing.i - 0.5) / importing.n) * 100)}%` }} />
          </div>
        </div>
      )}
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
        {book ? (<>
          <ChaptersList f2Here={f2Chapters} arrowsHere={arrowsChapters}
            book={{ ...book, chapters: chaptersOf(book) }} busy={busy} current={chapterId}
            onConvert={(ids) => convert(ids, true)}
            onImportModels={(items) => importPgn(book.id, items, true)}
            onPick={(id) => { setChapterId(id); setBookPicked(false); }}
            bookPicked={bookPicked} onPickBook={setBookPicked}
            onMerge={startMerge}
            onAnalyse={startAnalysis} analysing={analysing}
            onRemoveFens={removeFens} onCountFens={countFens}
            onRenameMany={(changes) => run(async () => { for (const c of changes) await updateChapter(c.id, { name: c.name }); })}
            onChapter={(id, patch) => run(() => updateChapter(id, patch))}
            onDeleteChapter={(id) => run(async () => { await deleteChapter(id); if (id === chapterId) dropChapter(); })}
            onAddEmpty={(name) => addEmpty(book.id, name)} onImport={(items) => importPgn(book.id, items)}
            onDeleteChapters={(ids) => run(async () => { await deleteChapters(ids); if (chapterId != null && ids.includes(chapterId)) dropChapter(); })}
          />
          {/* The book's games, apart from the repertoire: model games —
              annotated, showing its ideas — and reference games, without
              comments; the same list, twice. */}
          {([["models", modelsOf(book), f2Models, arrowsModels], ["reference", referencesOf(book), f2Reference, arrowsReference]] as const).map(([kind, games, f2, arrows]) => games.length > 0 && (
            <div key={kind} onMouseDownCapture={() => { keysFor.current = kind; }}>
              <ChaptersList kind={kind} f2Here={f2} arrowsHere={arrows}
                book={{ ...book, chapters: [...games] }} busy={busy} current={chapterId}
                onPick={(id) => { setChapterId(id); setBookPicked(false); }}
                bookPicked={false} onPickBook={() => {}}
                onMerge={() => {}} onAnalyse={() => {}} analysing={false}
                onRemoveFens={removeFens} onCountFens={countFens}
                onRenameMany={(changes) => run(async () => { for (const c of changes) await updateChapter(c.id, { name: c.name }); })}
                onChapter={(id, patch) => run(() => updateChapter(id, patch))}
                onDeleteChapter={(id) => run(async () => { await deleteChapter(id); if (id === chapterId) dropChapter(); })}
                onAddEmpty={() => {}} onImport={() => {}}
                onImportModels={(items) => importPgn(book.id, items, true)}
                onConvert={(ids) => convert(ids, false)}
                onOrder={(ids) => run(() => orderChapters(ids))}
                onDeleteChapters={(ids) => run(async () => { await deleteChapters(ids); if (chapterId != null && ids.includes(chapterId)) dropChapter(); })}
              />
            </div>
          ))}
        </>) : (
          <div className="px-3 py-2 text-label-sm text-on-surface-variant">{books && books.length === 0 ? "Add a book first." : "Choose a book."}</div>
        )}
      </div>
    </div>
  );

  // Each fold has a layout of its own: the group reads its sizes once.
  const layoutId = `repertoire-${booksFolded ? "b" : "B"}${chaptersFolded ? "c" : "C"}`;
  return (<>
    {preparingMerge && <PleaseWait text="Merging the chapters…" />}
    {merging && (
      <MergeChaptersDialog
        target={merging.labels[0]}
        others={merging.labels.slice(1)}
        added={merging.result.added} carried={merging.result.carried} takenOver={merging.result.takenOver} conflicts={merging.result.conflicts}
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
      myGamesBook={bookPicked && book ? { id: book.id, chapters: chaptersOf(book).map((c) => ({ id: c.id, name: c.name })) } : null}
      onPickChapter={(id) => { setChapterId(id); setBookPicked(false); }}
      documentReload={docReload}
      leadingPanels={[
        booksFolded ? { id: "books", node: booksPanel, size: "3", strip: true } : { id: "books", node: booksPanel, size: "14", min: "9", max: "30" },
        chaptersFolded ? { id: "chapters", node: chaptersPanel, size: "3", strip: true } : { id: "chapters", node: chaptersPanel, size: "16", min: "10", max: "34" },
      ]}
      layoutId={layoutId}
      emptyState={books && books.length === 0
        ? "No books yet. A book is one opening course or one topic — \"Najdorf for Black\" — with the colour you play it from; its chapters hold the lines. Add a book on the left."
        : "Choose a chapter on the left to study it here — or add one with the ⋯ above the chapters: empty, from pasted PGN, or from PGN files."}
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

/** A book's chapters — its repertoire — and its model games, apart. */
const chaptersOf = (b: BookWithChapters) => b.chapters.filter((c) => !c.model);
/** The games kept apart: all of them, those with comments (model games),
 *  and those without (reference games). */
const gamesOf = (b: BookWithChapters) => b.chapters.filter((c) => c.model);
// (A server from before the split says nothing: model games, then.)
const modelsOf = (b: BookWithChapters) => b.chapters.filter((c) => c.model && c.annotated !== false);
const referencesOf = (b: BookWithChapters) => b.chapters.filter((c) => c.model && c.annotated === false);

function BooksPanel({ books, selected, busy, error, f2Here, onSelect, onFold, onCreate, onUpdate, onImportBooks, onDelete }: {
  books: BookWithChapters[] | null; selected: number | null; busy: boolean; error: string | null;
  /** Whether F2 is the books' (they were clicked last): Edit… the selected one. */
  f2Here: () => boolean;
  onSelect: (id: number) => void; onFold: () => void;
  onCreate: (b: { name: string; author: string | null; color: BookColor }) => void;
  onUpdate: (id: number, patch: BookPatch) => void;
  /** Books from LPDO's own PGN (a book exported, or a backup). */
  onImportBooks: (items: ImportItem[]) => void;
  onDelete: (b: BookWithChapters) => void;
}) {
  const [adding, setAdding] = useState(false);
  // Putting the books in order: dragged with the mouse (HTML drag and drop
  // does not reach the page in the app's window), ▲ ▼, or ↑ ↓ for the one
  // selected — as the chapters are.
  const [arranging, setArranging] = useState(false);
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  useEffect(() => {
    if (dragged == null) return;
    const drop = () => {
      const to = books?.find((b) => b.id === over);
      if (to && over !== dragged) onUpdate(dragged, { ord: to.ord });
      setDragged(null); setOver(null);
    };
    window.addEventListener("mouseup", drop);
    return () => window.removeEventListener("mouseup", drop);
  }, [dragged, over, books, onUpdate]);
  // ↑ ↓ — the books clicked last — select the book before or after;
  // rearranging, they move the selected one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!arranging && !f2Here()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // M starts rearranging (the books clicked last); Enter, Esc or M again ends it.
      if (arranging && (e.key === "Escape" || e.key === "Enter" || (e.key === "m" || e.key === "M") && !e.altKey && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); setArranging(false); return; }
      if (!arranging && (e.key === "m" || e.key === "M") && !e.altKey && !e.ctrlKey && !e.metaKey && books && books.length > 1) { e.preventDefault(); setArranging(true); return; }
      if (!books || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.altKey || e.ctrlKey || e.metaKey) return;
      // Not also a step along the board's lines.
      e.preventDefault(); e.stopPropagation();
      const i = books.findIndex((b) => b.id === selected);
      const j = i + (e.key === "ArrowUp" ? -1 : 1);
      if (i < 0 || j < 0 || j >= books.length) return;
      if (arranging) { if (!busy) onUpdate(books[i].id, { ord: books[i].ord + (j - i) }); return; }
      onSelect(books[j].id);
      document.querySelector(`[data-book-id="${books[j].id}"]`)?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [arranging, busy, books, selected, onUpdate, onSelect, f2Here]);
  const booksFileRef = useRef<HTMLInputElement>(null);
  async function pickBookFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    onImportBooks(await Promise.all(files.map(async (f) => ({ pgn: await f.text(), file: f.name.replace(/\.[^.]+$/, "") }))));
  }
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [color, setColor] = useState<BookColor>("white");
  const book = books?.find((b) => b.id === selected) ?? null;
  /** The drop line: above the book when the dragged one goes up, below when down. */
  const dropAt = (id: number, i: number) => {
    if (!arranging || dragged == null || over !== id || over === dragged || !books) return "border-transparent";
    return books.findIndex((x) => x.id === dragged) > i ? "border-t-primary border-b-transparent" : "border-b-primary border-t-transparent";
  };
  return (
    <>
      <div className="px-3 py-2 flex items-center gap-1 border-b border-outline/40 shrink-0">
        <span className="flex-1 text-label-md text-on-surface-variant uppercase tracking-wider">Books</span>
        <button onClick={() => booksFileRef.current?.click()} disabled={busy} className={plain}
          title="Books exported from LPDO — one, or a backup of them all — made again as they were: name, colour, author, link, notes and chapters. Each becomes a new book.">Import…</button>
        <input ref={booksFileRef} type="file" multiple accept=".pgn,text/plain" className="hidden" onChange={(e) => void pickBookFiles(e)} />
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
          {arranging && (
            <div className="px-3 pb-1 flex items-start gap-2 text-label-sm text-on-surface-variant">
              <span className="flex-1 min-w-0">Drag a book to its place, or move it with ▲ ▼ — or ↑ ↓ for the one selected; Enter when done.</span>
              <button onClick={() => setArranging(false)} className={tonal}>Done</button>
            </div>
          )}
          {books?.map((b, i) => {
            const on = chaptersOf(b).filter((c) => c.active).length;
            const sel = b.id === selected;
            return (
              <div key={b.id} data-book-id={b.id}
                {...(arranging ? {
                  // Not from ▲ ▼; no text selected while dragging.
                  onMouseDown: (e: React.MouseEvent) => {
                    if (e.button !== 0 || busy || (e.target as HTMLElement).closest("[data-nodrag]")) return;
                    e.preventDefault();
                    setDragged(b.id); setOver(b.id);
                  },
                  onMouseEnter: () => { if (dragged != null) setOver(b.id); },
                } : {})}
                className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors duration-short3 ease-standard ${sel ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8"} ${b.active ? "" : "opacity-60"} ${arranging ? (dragged === b.id ? "cursor-grabbing opacity-50" : "cursor-grab") : ""} border-y-2 ${dropAt(b.id, i)}`}>
                {arranging
                  ? <span className="shrink-0 text-on-surface-variant text-body-sm select-none" aria-hidden>⠿</span>
                  : <input type="checkbox" checked={b.active} disabled={busy} onChange={(e) => onUpdate(b.id, { active: e.target.checked })}
                      className="accent-primary shrink-0" title="In the repertoire: off takes the whole book out, whatever its chapters say" />}
                <button onClick={() => onSelect(b.id)} className="flex-1 min-w-0 text-left flex items-center gap-2">
                  <ColorDot color={b.color} />
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className="truncate text-body-sm" title={b.name}>{b.name}</span>
                    {b.author && <span className="truncate text-label-sm opacity-70" title={b.author}>{b.author}</span>}
                  </span>
                  {!arranging && <span className="text-label-sm opacity-70 tabular-nums shrink-0" title={`${on} of ${chaptersOf(b).length} chapters active`}>{on}/{chaptersOf(b).length}</span>}
                </button>
                {arranging && (
                  <>
                    <button data-nodrag onClick={() => onUpdate(b.id, { ord: b.ord - 1 })} disabled={busy || i === 0} className={moveNav} title="Move up (↑)">▲</button>
                    <button data-nodrag onClick={() => onUpdate(b.id, { ord: b.ord + 1 })} disabled={busy || i === books.length - 1} className={moveNav} title="Move down (↓)">▼</button>
                  </>
                )}
              </div>
            );
          })}
          {books && books.length === 0 && !adding && <div className="px-3 py-1 text-label-sm text-on-surface-variant">None yet — + New adds one.</div>}
        </div>
        {book && books && (
          <BookDetails key={book.id} book={book} busy={busy} canArrange={books.length > 1} onArrange={() => setArranging(true)} f2Here={f2Here}
            onUpdate={(patch) => onUpdate(book.id, patch)} onDelete={() => onDelete(book)}
          />
        )}
      </div>
    </>
  );
}

/** The selected book: what it is, and its settings. */
function BookDetails({ book, busy, canArrange, onArrange, f2Here, onUpdate, onDelete }: {
  book: BookWithChapters; busy: boolean; f2Here: () => boolean;
  /** Rearranging the books: the list's mode for it. */
  canArrange: boolean; onArrange: () => void;
  onUpdate: (patch: BookPatch) => void; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  // F2 — the books clicked last — opens Edit…, the name ready to change.
  const nameRef = useRef<HTMLInputElement>(null);
  const [focusName, setFocusName] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F2" || !f2Here()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      setEditing(true); setFocusName(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [f2Here]);
  useEffect(() => {
    if (editing && focusName) { nameRef.current?.focus(); nameRef.current?.select(); setFocusName(false); }
  }, [editing, focusName]);
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
  const chapters = chaptersOf(book);
  const models = modelsOf(book).length;
  const references = referencesOf(book).length;
  const games = gamesOf(book).length;
  const active = chapters.filter((c) => c.active);
  const lines = chapters.reduce((n, c) => n + c.lines, 0);
  const off = chapters.reduce((n, c) => n + c.lines_off, 0);
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
        <Menu up title="The book: edit, export, delete; rearrange the books" entries={[
          { label: editing ? "Done editing" : "Edit… (F2)", onClick: () => setEditing((e) => !e) },
          { label: "Rearrange books (M)", onClick: onArrange, disabled: busy || !canArrange },
          { label: "Export PGN…", onClick: () => void exportPgn(bookPgnPath(book.id), book.name).then(setNote), disabled: busy || book.chapters.length === 0 },
          { label: "Delete…", onClick: () => setConfirmDelete(true), disabled: busy, separated: true },
        ]} />
      </div>
      <div className="text-label-sm text-on-surface-variant">
        Played as {book.color} · {plural(chapters.length, "chapter")}{active.length !== chapters.length ? `, ${active.length} active` : ""} · {plural(lines, "line")}{off ? `, ${off} off` : ""}{models ? ` · ${plural(models, "model game")}` : ""}{references ? ` · ${plural(references, "reference game")}` : ""}
      </div>
      {!book.active && <div className="text-label-sm text-on-surface-variant">Off: the whole book is out of the repertoire.</div>}
      {book.url && (
        <button onClick={() => openLink(book.url!)} className="text-left text-label-md text-primary hover:underline truncate" title={book.url}>
          ↗ {book.url.replace(/^https?:\/\//, "")}
        </button>
      )}
      {book.description && <div className="text-body-sm text-on-surface-variant whitespace-pre-wrap break-words">{book.description}</div>}
      {confirmDelete && (
        <div className="flex items-center gap-1 flex-wrap">
          <button onClick={() => { setConfirmDelete(false); onDelete(); }} disabled={busy} className="h-7 px-2 rounded-full text-label-md text-error hover:bg-error/8">Delete it and its {plural(chapters.length, "chapter")}{games ? ` and ${plural(games, "game")}` : ""}</button>
          <button onClick={() => setConfirmDelete(false)} className={plain}>Cancel</button>
        </div>
      )}
      {editing && (
        <div className="flex flex-col gap-1.5">
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name.trim() !== book.name) onUpdate({ name: name.trim() }); }}
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
function ChaptersList({ book, busy, current, onPick, bookPicked, onPickBook, onMerge, onAnalyse, analysing, onRemoveFens, onCountFens, onRenameMany, onChapter, onDeleteChapter, onDeleteChapters, onAddEmpty, onImport, f2Here, arrowsHere, kind = "chapters", onImportModels, onConvert, onOrder }: {
  /** Which list: the chapters, or — with their own heading and commands —
   *  the model games (`book.chapters` holds the one or the other). */
  kind?: "chapters" | "models" | "reference";
  book: BookWithChapters; busy: boolean; current: number | null;
  onPick: (id: number) => void;
  onMerge: (ids: number[]) => void;
  /** Analyse chapters for practice; `analysing`: a run is going on. */
  onAnalyse: (ids: number[]) => void;
  /** Remove the FENs left in chapters' comments; resolves to how many
   *  (null: it failed, the error shows). */
  onRemoveFens: (ids: number[]) => Promise<number | null>;
  /** How many FENs each of these chapters holds, nothing changed. */
  onCountFens: (ids: number[]) => Promise<{ id: number; name: string; n: number }[]>;
  /** "Your games": the book's line picked, and picking it (or not). */
  bookPicked: boolean;
  onPickBook: (on: boolean) => void;
  analysing: boolean;
  onRenameMany: (changes: { id: number; name: string }[]) => Promise<void>;
  onChapter: (id: number, patch: { name?: string; ord?: number; active?: boolean; result?: GameResult }) => void;
  onDeleteChapter: (id: number) => void;
  onDeleteChapters: (ids: number[]) => void;
  /** Model games from PGN (pasted, or files). */
  onImportModels: (items: ImportItem[]) => void;
  /** Chapters made model games — or, in the model games' list, chapters again. */
  onConvert: (ids: number[]) => void;
  /** The list put in this order (the model games reversed). */
  onOrder?: (ids: number[]) => void;
  /** Adding chapters: an empty one, or from PGN (pasted, or files). */
  onAddEmpty: (name: string) => void;
  onImport: (items: ImportItem[]) => void;
  /** Whether F2 is the chapters' (the books were not clicked last). */
  f2Here: () => boolean;
  /** Whether ↑ ↓ are the chapters' (they were clicked last): the chapter
   *  before or after, on the board. */
  arrowsHere: () => boolean;
}) {
  // The games kept apart — model games and reference games — share the
  // games' commands; only their names differ.
  const models = kind !== "chapters";
  // What a chapter is called here, one and several.
  const one = kind === "models" ? "model game" : kind === "reference" ? "reference game" : "chapter";
  const many = `${one}s`;
  const [note, setNote] = useState<string | null>(null);
  // Pasting PGN: as chapters, or as model games.
  const [pasting, setPasting] = useState<false | "chapters" | "models">(false);
  const [pasted, setPasted] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const filesAsModels = useRef(false);
  async function pickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    const items = await Promise.all(files.map(async (f) => ({ pgn: await f.text(), file: f.name.replace(/\.[^.]+$/, "") })));
    (filesAsModels.current ? onImportModels : onImport)(items);
  }
  const pickFilesAs = (asModels: boolean) => { filesAsModels.current = asModels; fileRef.current?.click(); };
  // The model games' list folds away.
  const foldKey = kind === "reference" ? "repertoireReferenceFolded" : "repertoireModelsFolded";
  const [folded, setFolded] = useState(() => { try { return models && localStorage.getItem(foldKey) === "1"; } catch { return false; } });
  const fold = (f: boolean) => { setFolded(f); try { localStorage.setItem(foldKey, f ? "1" : "0"); } catch { /* not kept */ } };
  /** Moved one place within this list — to its neighbour's place: the
   *  chapters and the model games are numbered together. */
  const moveBy = (id: number, delta: number) => {
    const i = book.chapters.findIndex((c) => c.id === id);
    const to = book.chapters[i + delta];
    if (i >= 0 && to) onChapter(id, { ord: to.ord });
  };
  const [renaming, setRenaming] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Deleting the chapters selected: asked in the selection's bar.
  const [confirmDeleteMany, setConfirmDeleteMany] = useState(false);
  const [arranging, setArranging] = useState(false);
  // Rearranging by dragging — with the mouse, not HTML drag and drop, which
  // the app's window does not pass on to the page.
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  useEffect(() => {
    if (dragged == null) return;
    const drop = () => {
      const to = book.chapters.find((c) => c.id === over);
      if (to && over !== dragged) onChapter(dragged, { ord: to.ord });
      setDragged(null); setOver(null);
    };
    window.addEventListener("mouseup", drop);
    return () => window.removeEventListener("mouseup", drop);
  }, [dragged, over, book.chapters, onChapter]);
  // Merge mode: the chapters ticked for merging.
  const [selecting, setSelecting] = useState<number[] | null>(null);
  // The chapter clicked last in merge mode: where a Shift-click's range starts.
  const anchor = useRef<number | null>(null);
  // What the column on the right shows: the chapters' lines, or one's own
  // games in them (looked up live for the whole book).
  const [games, setGames] = useState<BookGames | null>(null);
  const [gamesNote, setGamesNote] = useState<string | null>(null);
  // Read again when the book's chapters change (an edit, a merge, a move).
  const chaptersKey = book.chapters.map((c) => `${c.id}:${c.updated_at}`).join(",");
  useEffect(() => {
    if (models) return;
    let gone = false;
    setGamesNote(null);
    void (async () => {
      const me = await currentMyPlayer();
      if (gone) return;
      if (!me) { setGames(null); setGamesNote("Set your player on the Home page to see your games per chapter."); return; }
      try {
        const g = await getBookGames(book.id, me.id);
        if (!gone) setGames(g);
      } catch (e) { if (!gone) { setGames(null); setGamesNote(String(e)); } }
    })();
    return () => { gone = true; };
  }, [book.id, chaptersKey]);
  // Which games count — for the tooltips: "Your games as Black, the last 12
  // months (set on the Maintenance page, Repertoire tab)".
  const gamesScope = games
    ? `Your games as ${games.color === "white" ? "White" : "Black"}, ${games.months ? `the last ${games.months} months` : "all of them"} (the period is set on the Maintenance page, Repertoire tab)`
    : null;
  const gamesFor = (id: number): Score | null => (games ? games.chapters.find((c) => c.id === id) ?? null : null);
  // Renaming chapters at once: which (all of them, or those selected).
  const [renamingAll, setRenamingAll] = useState<number[] | null>(null);
  // Chapters selected as in a file manager — a click one (and the board on
  // it), Shift-click a range from the one clicked last, Ctrl-click one more
  // or less — for Merge and Rename (F2) on several.
  const [picked, setPicked] = useState<number[]>([]);
  useEffect(() => setPicked([]), [book.id]);
  useEffect(() => { if (current != null && !picked.includes(current)) setPicked([current]); }, [current]); // eslint-disable-line react-hooks/exhaustive-deps
  const multi = picked.filter((id) => book.chapters.some((c) => c.id === id));
  const several = multi.length >= 2;
  useEffect(() => { if (!several) setConfirmDeleteMany(false); }, [several]);
  function clickChapter(id: number, i: number, e: React.MouseEvent) {
    if (e.shiftKey && anchor.current != null) {
      const from = book.chapters.findIndex((c) => c.id === anchor.current);
      if (from >= 0) { setPicked(book.chapters.slice(Math.min(from, i), Math.max(from, i) + 1).map((c) => c.id)); return; }
    }
    if (e.ctrlKey || e.metaKey) {
      anchor.current = id;
      setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
      return;
    }
    anchor.current = id;
    setPicked([id]);
    onPick(id);
  }
  // Removing FENs: which chapters, said how — the dialog counts first.
  const [fens, setFens] = useState<{ ids: number[]; what: string } | null>(null);
  useEffect(() => setSelecting(null), [book.id]);
  const chapter = book.chapters.find((c) => c.id === current) ?? null;
  useEffect(() => setConfirmDelete(false), [current]);
  const none = !chapter || busy;
  // F2 renames, as in a file manager: the chapter on the board in place, or
  // — several selected — those in the Rename dialog. Esc drops a selection
  // of several. Not while typing somewhere, ordering or ticking chapters.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || selecting) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // M — the chapters clicked last — starts rearranging; Enter, Esc or M
      // again ends it.
      if (arranging && (e.key === "Escape" || e.key === "Enter" || (e.key === "m" || e.key === "M") && !e.altKey && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); setArranging(false); return; }
      if (!arranging && (e.key === "m" || e.key === "M") && !e.altKey && !e.ctrlKey && !e.metaKey && arrowsHere() && book.chapters.length > 1) { e.preventDefault(); setArranging(true); setRenaming(null); return; }
      // Rearranging: ↑ ↓ move the chapter on the board.
      if (arranging) {
        if (!chapter || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        // Not also a step along the board's lines.
        e.preventDefault(); e.stopPropagation();
        moveBy(chapter.id, e.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && arrowsHere() && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        // Not also a step along the board's lines.
        e.preventDefault(); e.stopPropagation();
        const i = book.chapters.findIndex((c) => c.id === current);
        const j = i < 0 ? 0 : i + (e.key === "ArrowUp" ? -1 : 1);
        const next = book.chapters[j];
        if (!next) return;
        anchor.current = next.id;
        setPicked([next.id]);
        onPick(next.id);
        document.querySelector(`[data-chapter-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (e.key === "Escape" && several) { setConfirmDeleteMany(false); setPicked(current != null ? [current] : []); return; }
      if (e.key !== "F2" || !f2Here()) return;
      if (several && arrowsHere()) { e.preventDefault(); setRenamingAll(multi); return; }
      if (!chapter) return;
      e.preventDefault();
      setRenaming(chapter.id);
    };
    // Capturing: ahead of the board's own keys.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [chapter, busy, arranging, selecting, several, multi.join(","), current, book.chapters]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col">
      {/* The book's row — its name, the ⋯, and Merge / Cancel or Done in
          those modes — stays at the top while the chapters scroll under it. */}
      <div className={models ? "mt-2 border-t border-outline/40" : "sticky top-0 z-10 bg-surface-container-low"}>
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        {models ? (
          <button onClick={() => fold(!folded)} className="flex-1 min-w-0 flex items-center gap-1.5 text-left text-label-md text-on-surface-variant uppercase tracking-wider"
            title={kind === "reference"
              ? (folded ? "Show the reference games — the book's games without comments" : "Fold the reference games away")
              : (folded ? "Show the model games — the book's annotated games" : "Fold the model games away")} aria-expanded={!folded}>
            <span className="text-[10px] w-3">{folded ? "▸" : "▾"}</span>
            {kind === "reference" ? "Reference games" : "Model games"} ({book.chapters.length})
          </button>
        ) : (<>
          <ColorDot color={book.color} />
          <span className="flex-1 min-w-0 truncate text-title-sm text-on-surface" title={book.name}>{book.name}</span>
        </>)}
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
          <Menu title={models
            ? (chapter ? `${kind === "reference" ? "Reference" : "Model"} games; the one on the board — ${chapter.name}` : `${kind === "reference" ? "Reference" : "Model"} games: rearrange them; choose one for the rest`)
            : (chapter ? `Add chapters; the chapter on the board — ${chapter.name}` : "Add chapters, rearrange them; choose one for the rest")} entries={[
            ...(models ? [] : [
              { label: "New empty chapter", onClick: () => onAddEmpty(`Chapter ${book.chapters.length + 1}`), disabled: busy },
              { label: "Paste PGN…", onClick: () => setPasting("chapters"), disabled: busy },
              { label: "Import PGN files…", onClick: () => pickFilesAs(false), disabled: busy },
            ]),
            { label: "Paste model games…", onClick: () => setPasting("models"), disabled: busy, separated: !models },
            { label: "Import model games…", onClick: () => pickFilesAs(true), disabled: busy },
            { label: `Rename ${one}… (F2)`, separated: true, onClick: () => chapter && setRenaming(chapter.id), disabled: none },
            { label: `Export ${one} PGN…`, onClick: () => chapter && void exportPgn(chapterPgnPath(chapter.id), `${book.name}-${chapter.name}`).then(setNote), disabled: none },
            several
              ? { label: `Delete ${multi.length} ${many}…`, onClick: () => setConfirmDeleteMany(true), disabled: busy }
              : { label: `Delete ${one}…`, onClick: () => setConfirmDelete(true), disabled: none },
            several
              ? { label: models ? `Make ${multi.length} chapters` : `Make ${multi.length} model games`, onClick: () => { onConvert(multi); setPicked([]); }, disabled: busy }
              : { label: models ? "Make it a chapter" : "Make it a model game", onClick: () => chapter && onConvert([chapter.id]), disabled: none },
            several
              ? { label: `Rename ${multi.length} ${many}… (F2)`, onClick: () => { setRenamingAll(multi); setRenaming(null); }, disabled: busy, separated: true }
              : { label: `Rename ${many}…`, onClick: () => { setRenamingAll(book.chapters.map((c) => c.id)); setRenaming(null); }, disabled: busy || book.chapters.length === 0, separated: true },
            { label: `Rearrange ${many} (M)`, onClick: () => { setArranging(true); setRenaming(null); }, disabled: busy || book.chapters.length < 2 },
            ...(models && onOrder ? [{ label: "Reverse the order", onClick: () => onOrder(book.chapters.map((c) => c.id).reverse()), disabled: busy || book.chapters.length < 2 }] : []),
            ...(models ? [] : [
            several
              ? { label: `Merge ${multi.length} chapters…`, onClick: () => { onMerge(multi); setPicked([]); setRenaming(null); }, disabled: busy }
              : { label: "Merge chapters…", onClick: () => { setSelecting(current != null && chapter ? [current] : []); anchor.current = chapter ? current : null; setRenaming(null); }, disabled: busy || book.chapters.length < 2 },
            { label: "Analyse chapter", onClick: () => chapter && onAnalyse([chapter.id]), disabled: none || analysing, separated: true },
            { label: "Analyse all chapters", onClick: () => onAnalyse(book.chapters.map((c) => c.id)), disabled: busy || analysing || book.chapters.length === 0 },
            { label: "Remove FENs from comments…", separated: true, disabled: none,
              onClick: () => chapter && setFens({ ids: [chapter.id], what: `“${chapter.name}”` }) },
            { label: "Remove FENs in all chapters…", disabled: busy || book.chapters.length === 0,
              onClick: () => setFens({ ids: book.chapters.map((c) => c.id), what: "the book's chapters" }) },
            ]),
          ]} />
        )}
      </div>
      {/* Several chapters selected: what can be done with them, at hand
          while the list scrolls. */}
      {several && !arranging && !selecting && (
        <div className="px-3 pb-1.5 flex items-center gap-1 flex-wrap">
          {confirmDeleteMany ? (
            <>
              <button onClick={() => { setConfirmDeleteMany(false); onDeleteChapters(multi); setPicked([]); }} disabled={busy}
                className="h-7 px-2 rounded-full text-label-md text-error hover:bg-error/8">Delete {multi.length} {many}</button>
              <button onClick={() => setConfirmDeleteMany(false)} className={plain}>Cancel</button>
            </>
          ) : (
            <>
              <span className="flex-1 min-w-0 truncate text-label-sm text-on-surface-variant" title="Shift-click: a range · Ctrl-click: one more or less · Esc: none">
                {multi.length} selected
              </span>
              {!models && <button onClick={() => { onMerge(multi); setPicked([]); setRenaming(null); }} disabled={busy} className={tonal}>Merge…</button>}
              <button onClick={() => { setRenamingAll(multi); setRenaming(null); }} disabled={busy} className={plain} title="F2">Rename…</button>
              <button onClick={() => setConfirmDeleteMany(true)} disabled={busy} className={plain}>Delete…</button>
              <button onClick={() => setPicked(current != null ? [current] : [])} className={plain} title="Select none (Esc)" aria-label="Select none">×</button>
            </>
          )}
        </div>
      )}
      </div>
      {/* What the last command did ("Removed 5 FEN codes…"), at the top where
          it is seen — not under the last chapter. */}
      {note && (
        <div className="mx-3 mb-1 px-2 py-1 flex items-start gap-2 rounded-sm bg-secondary-container text-on-secondary-container text-label-sm">
          <span className="flex-1 min-w-0">{note}</span>
          <button onClick={() => setNote(null)} className="shrink-0 leading-none px-1 hover:opacity-70" title="Dismiss" aria-label="Dismiss">×</button>
        </div>
      )}
      <input ref={fileRef} type="file" multiple accept=".pgn,text/plain" className="hidden" onChange={(e) => void pickFiles(e)} />
      {pasting && (
        <div className="px-3 pb-2 flex flex-col gap-1.5">
          <textarea autoFocus value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} placeholder={"[Event \"Najdorf: 6.Bg5\"]\n\n1. e4 c5 2. Nf3 d6 ..."} className="w-full font-mono text-body-sm p-2 rounded-sm bg-surface-container border border-outline/40 text-on-surface" />
          <span className="text-label-sm text-on-surface-variant">{pasting === "models"
            ? "Each game is kept with the book, with its headers, comments and result: with comments under Model games, without under Reference games."
            : "Several games become several chapters, named from their headers."}</span>
          <div className="flex items-center gap-1 justify-end">
            <button onClick={() => { setPasting(false); setPasted(""); }} className={plain}>Cancel</button>
            <button onClick={() => { (pasting === "models" ? onImportModels : onImport)([{ pgn: pasted }]); setPasted(""); setPasting(false); }} disabled={busy || !pasted.trim()} className={tonal}>
              {pasting === "models" ? "Add as model games" : "Add as chapters"}
            </button>
          </div>
        </div>
      )}
      {fens && (
        <RemoveFensDialog what={fens.what} busy={busy} count={() => onCountFens(fens.ids)}
          onRemove={() => onRemoveFens(fens.ids)} onClose={() => setFens(null)} />
      )}
      {renamingAll && (
        <RenameChaptersDialog bookName={book.name} chapters={book.chapters.filter((c) => renamingAll.includes(c.id))} busy={busy}
          onRename={(changes) => void onRenameMany(changes).then(() => setRenamingAll(null))}
          onCancel={() => setRenamingAll(null)} />
      )}
      {/* One's own games in the book and each chapter (the line counts are
          in the chapters' tooltips, and the Lines tab): the columns' names,
          then the whole book's row. */}
      {!models && !arranging && !selecting && games && (
        <div className="px-3 flex items-center gap-1.5 text-label-sm text-on-surface-variant whitespace-nowrap">
          <span className="flex-1" />
          <span className="flex items-center gap-1 shrink-0" title={gamesScope ?? undefined}>
            <span className="w-9 text-right">games</span>
            <span className="w-10 text-right">score</span>
            <span className="w-10 text-right" title="Your performance rating, with three rated opponents or more">perf</span>
          </span>
          <span className="shrink-0 w-2" />
        </div>
      )}
      {!models && !arranging && !selecting && (
        <BookGamesSummary games={games} note={gamesNote} picked={bookPicked} onPick={() => onPickBook(true)} />
      )}
      {arranging && <div className="px-3 pb-1 text-label-sm text-on-surface-variant">Drag a {one} to its place, or move it with ▲ ▼ — or ↑ ↓ for the one on the board; Enter when done.</div>}
      {selecting && <div className="px-3 pb-1 text-label-sm text-on-surface-variant">Tick the chapters to merge — Shift-click ticks all from the one clicked last. The topmost keeps its name, place and main line; the others' lines and comments go into it, and they are deleted.</div>}
      {confirmDelete && chapter && (
        <div className="px-3 pb-1 flex items-center gap-1 flex-wrap">
          <button onClick={() => { setConfirmDelete(false); onDeleteChapter(chapter.id); }} disabled={busy} className="h-7 px-2 rounded-full text-label-md text-error hover:bg-error/8 truncate max-w-full">Delete “{chapter.name}”</button>
          <button onClick={() => setConfirmDelete(false)} className={plain}>Cancel</button>
        </div>
      )}
      {!models && !book.active && <div className="px-3 pb-1 text-label-sm text-on-surface-variant">The book is off: these chapters are out of the repertoire whatever their switches say.</div>}
      {!(models && folded) && <div className={`flex flex-col py-1 ${book.active || models ? "" : "opacity-70"}`}>
        {book.chapters.map((c, i) => (
          <ChapterRow key={c.id} chapter={c} busy={busy} current={c.id === current && !bookPicked}
            renaming={renaming === c.id} arranging={arranging} first={i === 0} last={i === book.chapters.length - 1}
            dropTarget={!arranging || dragged == null || over !== c.id || over === dragged ? null
              : book.chapters.findIndex((x) => x.id === dragged) > i ? "above" : "below"}
            dragging={dragged === c.id}
            selected={selecting ? selecting.includes(c.id) : undefined}
            mine={games && !arranging && !selecting ? (gamesFor(c.id) ?? { games: 0, w: 0, d: 0, l: 0, perf: null }) : undefined}
            onSelect={(on, range) => {
              // Shift-click: every chapter from the one clicked last to this
              // one, ticked (or unticked) alike.
              const from = range && anchor.current != null ? book.chapters.findIndex((x) => x.id === anchor.current) : -1;
              const ids = from >= 0
                ? book.chapters.slice(Math.min(from, i), Math.max(from, i) + 1).map((x) => x.id)
                : [c.id];
              anchor.current = c.id;
              setSelecting((s) => s && (on ? [...s, ...ids.filter((x) => !s.includes(x))] : s.filter((x) => !ids.includes(x))));
            }}
            onPick={(e) => clickChapter(c.id, i, e)}
            picked={several && multi.includes(c.id)}
            onActive={(active) => onChapter(c.id, { active })}
            onRename={(n) => { setRenaming(null); if (n && n !== c.name) onChapter(c.id, { name: n }); }}
            onMove={(delta) => moveBy(c.id, delta)}
            onResult={(result) => onChapter(c.id, { result })}
            drag={{
              // Not from ▲ ▼; no text selected while dragging.
              onMouseDown: (e) => {
                if (e.button !== 0 || busy || (e.target as HTMLElement).closest("[data-nodrag]")) return;
                e.preventDefault();
                setDragged(c.id); setOver(c.id);
              },
              onMouseEnter: () => { if (dragged != null) setOver(c.id); },
            }} />
        ))}
        {book.chapters.length === 0 && <div className="px-3 py-1 text-label-sm text-on-surface-variant">No chapters yet — the ⋯ above adds one: empty, pasted PGN, or PGN files.</div>}
      </div>}

    </div>
  );
}

/** Removing the FENs from chapters' comments: counted first, nothing
 *  changed — "25 FEN codes will be removed", per chapter — then removed on
 *  the user's word; "No FEN codes found" with an OK when there are none. */
function RemoveFensDialog({ what, busy, count, onRemove, onClose }: {
  what: string; busy: boolean;
  count: () => Promise<{ id: number; name: string; n: number }[]>;
  onRemove: () => Promise<number | null>;
  onClose: () => void;
}) {
  const [found, setFound] = useState<{ id: number; name: string; n: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    let gone = false;
    count().then((f) => { if (!gone) setFound(f); }).catch((e) => { if (!gone) setError(String(e)); });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const total = found?.reduce((n, c) => n + c.n, 0) ?? 0;
  const withFens = found?.filter((c) => c.n > 0) ?? [];
  const codes = (n: number) => `${n} FEN ${n === 1 ? "code" : "codes"}`;
  async function remove() {
    setRemoving(true);
    const n = await onRemove();
    setRemoving(false);
    if (n == null) setError("Removing them failed — see the message above the chapters.");
    else onClose();
  }
  const btn = "h-9 px-4 inline-flex items-center rounded-full text-label-lg transition-all duration-short3 ease-standard disabled:opacity-50";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40" onClick={removing ? undefined : onClose}>
      <div className="bg-surface-container-high rounded-xl shadow-2xl w-[30rem] max-w-[92vw] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 pt-4 pb-2 shrink-0">
          <h2 className="text-title-md text-on-surface">Remove FENs from comments</h2>
        </div>
        <div className="px-6 py-2 flex-1 min-h-0 overflow-y-auto text-body-md text-on-surface">
          {error ? <p className="text-error">{error}</p>
            : !found ? <p className="text-on-surface-variant">Looking through {what}…</p>
            : total === 0 ? <p>No FEN codes found in {what}.</p>
            : (
              <>
                <p>{codes(total)} will be removed from {what}{withFens.length > 1 ? `, in ${withFens.length} chapters` : ""}. The rest of each comment stays as it is.</p>
                {withFens.length > 1 && (
                  <ul className="mt-2 text-body-sm text-on-surface-variant">
                    {withFens.map((c) => (
                      <li key={c.id} className="flex gap-2"><span className="flex-1 min-w-0 truncate">{c.name}</span><span className="tabular-nums">{c.n}</span></li>
                    ))}
                  </ul>
                )}
              </>
            )}
        </div>
        <div className="px-6 py-4 shrink-0 flex items-center justify-end gap-2">
          {found && total > 0 && !error ? (
            <>
              <button onClick={onClose} disabled={removing} className={`${btn} text-primary hover:bg-primary/8`}>Cancel</button>
              <button onClick={() => void remove()} disabled={removing || busy} className={`${btn} bg-primary text-on-primary hover:brightness-110`}>
                {removing ? "Removing…" : `Remove ${total}`}
              </button>
            </>
          ) : (
            <button onClick={onClose} disabled={removing} className={`${btn} bg-primary text-on-primary hover:brightness-110`}>{found || error ? "OK" : "Cancel"}</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The book's line in "Your games": which games count, and — a row like a
 *  chapter's, with the same columns — those in the book's opening. Picked,
 *  My games lists them all. */
function BookGamesSummary({ games, note, picked, onPick }: { games: BookGames | null; note: string | null; picked: boolean; onPick: () => void }) {
  if (note) return <div className="px-3 pb-1 text-label-sm text-on-surface-variant">{note}</div>;
  if (!games) return <div className="px-3 pb-1 text-label-sm text-on-surface-variant">Looking up your games…</div>;
  const colour = games.color === "white" ? "White" : "Black";
  const period = games.months ? `the last ${games.months} months` : "all your games";
  const b = games.in_book;
  return (
    <>
      <button onClick={onPick}
        className={`flex items-center gap-1.5 px-3 py-1 text-left border-t-2 border-transparent ${picked ? "bg-primary-container/40" : "hover:bg-on-surface/4"}`}
        title={`Your games as ${colour}, ${period}, in this book's opening. Click: list them under My games.`}>
        <span className="flex-1 min-w-0 flex flex-col">
          <span className={`truncate text-body-sm ${picked ? "text-on-surface font-medium" : "text-on-surface"}`}>The whole book</span>
          {b.games > 0 && <span className="text-label-sm text-on-surface-variant tabular-nums">+{b.w} ={b.d} −{b.l}</span>}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          <span className="w-9 text-right text-label-sm text-on-surface-variant tabular-nums">{b.games || "–"}</span>
          <ScoreCell s={b} />
          <span className="w-10 text-right text-label-sm text-on-surface-variant tabular-nums">{b.perf ?? ""}</span>
        </span>
        <span className="shrink-0 w-2" />
      </button>
    </>
  );
}

/** One's score, coloured: better than even, worse, or about even. */
function ScoreCell({ s }: { s: Score }) {
  const pct = s.games ? (s.w + s.d / 2) / s.games : null;
  const tone = pct == null ? "text-on-surface-variant" : pct >= 0.55 ? "text-success" : pct <= 0.45 ? "text-error" : "text-on-surface";
  return <span className={`w-10 text-right text-label-sm tabular-nums shrink-0 ${tone}`}>{scorePct(s)}</span>;
}

function ChapterRow({ chapter: c, busy, current, renaming, arranging, first, last, dropTarget, dragging = false, selected, onSelect, mine, picked = false, onPick, onActive, onRename, onMove, onResult, drag }: {
  chapter: ChapterSummary; busy: boolean; current: boolean; renaming: boolean; arranging: boolean;
  first: boolean; last: boolean;
  /** Rearranging: the dragged chapter goes in above or below this one. */
  dropTarget: "above" | "below" | null; dragging?: boolean;
  /** In merge mode: ticked for merging (undefined outside it). */
  selected?: boolean; onSelect: (on: boolean, range: boolean) => void;
  /** "Your games": one's games in the chapter, shown instead of the lines. */
  mine?: Score;
  onPick: (e: React.MouseEvent) => void; onActive: (a: boolean) => void; onRename: (n: string) => void; onMove: (delta: -1 | 1) => void;
  /** One of several chapters selected (for Merge, Rename). */
  picked?: boolean;
  /** A model game's result, set. */
  onResult: (r: GameResult) => void;
  drag: Pick<React.HTMLAttributes<HTMLDivElement>, "onMouseDown" | "onMouseEnter">;
}) {
  const [name, setName] = useState(c.name);
  useEffect(() => setName(c.name), [c.name, renaming]);
  const counts = `${c.lines} ${c.lines === 1 ? "line" : "lines"}${c.lines_off ? `, ${c.lines_off} off` : ""}`;
  // Analysed for practice: as the chapter is now, or changed since.
  const analysedOn = c.analysed_at ? new Date(c.analysed_at.replace(" ", "T")).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null;
  const stale = !!c.analysed_at && c.analysis_stale === true;
  return (
    <div data-chapter-id={c.id}
      // In merge mode the whole row ticks the chapter (Shift: a range), not
      // only the checkbox; no text selected by a Shift-click.
      onClick={selected !== undefined ? (e) => { if ((e.target as HTMLElement).tagName !== "INPUT") onSelect(!selected, e.shiftKey); } : undefined}
      onMouseDown={selected !== undefined ? (e) => { if (e.shiftKey) e.preventDefault(); } : undefined}
      {...(arranging ? drag : {})}
      className={`flex items-center gap-1.5 px-3 py-1 ${current ? "bg-primary-container/40" : picked ? "bg-primary-container/20" : ""} ${c.active || c.model ? "" : "opacity-70"} ${arranging ? (dragging ? "cursor-grabbing opacity-50" : "cursor-grab") : ""} ${selected !== undefined ? "cursor-pointer select-none hover:bg-on-surface/4" : ""} border-y-2 ${dropTarget === "above" ? "border-t-primary border-b-transparent" : dropTarget === "below" ? "border-b-primary border-t-transparent" : "border-transparent"}`}
    >
      {arranging
        ? <span className="shrink-0 text-on-surface-variant text-body-sm select-none" aria-hidden>⠿</span>
        : selected !== undefined
        ? <input type="checkbox" checked={selected} disabled={busy} readOnly
            onClick={(e) => onSelect(!selected, e.shiftKey)}
            className="accent-tertiary shrink-0" title="Merge this chapter — Shift-click: all from the one clicked last" />
        : c.model
        // A model game is not part of the repertoire: no switch.
        ? null
        : <input type="checkbox" checked={c.active} disabled={busy} onChange={(e) => onActive(e.target.checked)} className="accent-primary shrink-0" title="Active: part of the repertoire you are playing now" />}
      {renaming ? (
        // The name all selected, as in a file manager: typing replaces it.
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => onRename(name.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setName(c.name); onRename(c.name); } }}
          className={`${field} flex-1 min-w-0 h-7`} />
      ) : (
        <button onClick={selected !== undefined ? undefined : onPick}
          onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
          className={`flex-1 min-w-0 text-left text-body-sm truncate ${current ? "text-on-surface font-medium" : "text-on-surface hover:text-primary"}`} title={c.model ? c.name : `${c.name} — ${counts}`}>
          {c.name}
        </button>
      )}
      {arranging ? (
        <>
          <button data-nodrag onClick={() => onMove(-1)} disabled={busy || first} className={moveNav} title="Move up (↑)">▲</button>
          <button data-nodrag onClick={() => onMove(1)} disabled={busy || last} className={moveNav} title="Move down (↓)">▼</button>
        </>
      ) : (
        <>
          {c.model ? (
            // The game's result, set here: Chessable's exports leave it out.
            <select data-nodrag value={c.result} disabled={busy} onChange={(e) => onResult(e.target.value as GameResult)}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 h-6 w-10 px-1 appearance-none text-right rounded-sm bg-transparent text-label-sm text-on-surface-variant tabular-nums hover:bg-on-surface/8 cursor-pointer"
              title="The game's result">
              {GAME_RESULTS.map((r) => <option key={r} value={r}>{r === "1/2-1/2" ? "½–½" : r}</option>)}
            </select>
          ) : mine ? (
            <span className="flex items-center gap-1 shrink-0"
              title={mine.games ? `Your games in this chapter: ${mine.games} · +${mine.w} =${mine.d} −${mine.l}${mine.perf ? ` · performance ${mine.perf}` : ""}` : "None of your games went into this chapter"}>
              <span className="w-9 text-right text-label-sm text-on-surface-variant tabular-nums">{mine.games || "–"}</span>
              <ScoreCell s={mine} />
              <span className="w-10 text-right text-label-sm text-on-surface-variant tabular-nums">{mine.perf ?? ""}</span>
            </span>
          ) : (
            <span className="text-label-sm text-on-surface-variant tabular-nums shrink-0" title={counts}>{c.lines}{c.lines_off ? `−${c.lines_off}` : ""}</span>
          )}
          {/* Analysed for practice: a dot in a column of its own at the end,
              an empty slot when not, so neither the counts nor the dots move. */}
          {!c.model && <span className="shrink-0 w-2 flex justify-center"
            title={analysedOn ? (stale ? `Changed since the analysis of ${analysedOn} — analyse again for the new moves` : `Analysed ${analysedOn}`) : "Not analysed"}>
            {analysedOn && (
              <span aria-label={stale ? "changed since analysed" : "analysed"}
                className={`w-1.5 h-1.5 rounded-full ${stale ? "bg-tertiary" : "bg-primary"}`} />
            )}
          </span>}
        </>
      )}
    </div>
  );
}

/** A cover over the whole page while something runs: no clicks or keys get
 *  through to what is underneath. */
function PleaseWait({ text }: { text: string }) {
  useEffect(() => {
    const swallow = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation(); };
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40 cursor-wait">
      <div className="bg-surface-container-high rounded-xl shadow-2xl px-6 py-4 flex items-center gap-3 text-body-md text-on-surface">
        <span className="inline-block w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        {text} Please wait.
      </div>
    </div>
  );
}
