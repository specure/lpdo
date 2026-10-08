import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout, useGroupRef } from "react-resizable-panels";
import { GameSummary, MoveStats, PlayerInfo } from "../types";
import { LoadedGame } from "../lib/useGamePgn";
import { CursorPath } from "../lib/moveTreeNav";
import MiniBoard from "./games/MiniBoard";
import GamePreview from "./games/GamePreview";
import type { MenuEntry } from "./games/GameMoreMenu";
import GameBoard from "./GameBoard";
import CloudEngine from "./CloudEngine";
import { useGamePgn } from "../lib/useGamePgn";
import { useNeighbourResize } from "../lib/panelResize";
import { fetchPgns, savePgnFile } from "../lib/exportPgn";
import type { EngineHistory } from "../api";
import PrintDialog, { ExportableGame } from "./games/PrintDialog";
import { useShowEngineGames, engineParam as engineParamFor } from "../lib/engineGames";
import { ArrowToggles, dbArrows, engineArrows, useArrowToggles, type CombinedMove } from "./HintArrows";
import { saveChapterMoves, type ChapterDocument, type LineMatch } from "../lib/repertoire";
import LinesPanel from "./repertoire/LinesPanel";
import MyGamesPanel from "./repertoire/MyGamesPanel";
import RepertoireMatchPanel, { matchCount, useRepertoireMatch } from "./repertoire/RepertoireMatchPanel";
import type { ChapterLine } from "../lib/repertoireLines";

// The Analysis board (#220): the editable, multi-game workbench. Several games
// open at once as mini-board tabs (A). The active game is edited in a full
// GameBoard (board + Comments + Notation + edit-mode/Done, reused wholesale),
// and its current position drives the reference-DB moves (C) and related games
// (E) panels.

export interface AnalysisTab {
  key: string;          // stable per open game (dedupe by game id)
  game: GameSummary;
  loaded: LoadedGame;   // parsed moves + fens — the rail preview's fallback
  /** Position last analysed in this tab, as reported by the board. Drives the
   *  rail preview (so it shows the real position, variations included) and the
   *  reference/related panels. null until the board has reported one. */
  fen: string | null;
  /** Where the board's cursor stood, as a line descent + index. Restored into
   *  the board when the tab is activated again — the FEN alone could not say
   *  which variation (or which repetition of a position) the user was on. */
  cursor: CursorPath | null;
  /** Board orientation for this game — remembered per tab, so flipping to
   *  Black's view survives tab switches, leaving the page, and restarts. */
  flipped: boolean;
  /** A repertoire chapter (#327) rather than a game; `game` then carries
   *  its names (id: minus the chapter's) and `loaded` its PGN. */
  document?: ChapterDocument;
}

interface Props {
  tabs: AnalysisTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onCloseMany: (keys: string[]) => void;
  /** Move a tab one place up (-1) or down (+1) the rail. */
  onMove: (key: string, delta: -1 | 1) => void;
  /** How many games the rail holds at most. */
  capacity: number;
  /** Panels in the rail's place (#327): the Repertoire page puts its books
   *  and its chapters there and shows one chapter — no rail, no rail
   *  commands. */
  leadingPanels?: LeadingPanel[];
  /** Where the panel sizes are remembered; a host with a leading panel keeps
   *  a layout of its own. */
  layoutId?: string;
  /** What to show with nothing open. */
  emptyState?: ReactNode;
  /** The Repertoire page's whole book picked in "Your games": My games lists
   *  the book's games (with its chapters' names), and a game's chapter is
   *  put on the board with `onPickChapter`. */
  myGamesBook?: { id: number; chapters: { id: number; name: string }[] } | null;
  /** Bumped by the host when the document's moves changed outside the
   *  editor — the board, Lines and My games read them again. */
  documentReload?: number;
  onPickChapter?: (id: number) => void;
  /** Open a chapter a game went into on the Repertoire page (the Repertoire
   *  tab, on a game — not on a chapter). */
  onOpenRepertoire?: (m: LineMatch, moves: string[]) => void;
  /** Open a related game as a new tab. Resolves to 0, or to how many did not
   *  fit (the rail is full) — then it stayed closed. */
  onOpenGame: (games: GameSummary[]) => Promise<number>;
  /** Persist per-tab view state (position, cursor, orientation) in the owning store. */
  onTabState: (key: string, patch: { fen?: string; cursor?: CursorPath; flipped?: boolean }) => void;
  onGameMutated?: () => void;
  /** Open a player's profile from the game's header. */
  onOpenProfile?: (player: PlayerInfo) => void;
}

const panel = "bg-surface-container-low border border-outline/40 rounded-md overflow-hidden flex flex-col min-h-0 min-w-0 h-full w-full";
const vHandle = "w-1.5 bg-transparent hover:bg-primary/30 data-[resize-handle-state=drag]:bg-primary/50 transition-colors";
const hHandle = "h-1.5 bg-transparent hover:bg-primary/30 data-[resize-handle-state=drag]:bg-primary/50 transition-colors";
const STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

type RightTab = "reference" | "related" | "lines" | "mine" | "repertoire";
const TAB_KEY = "analysisRightTab";

/** A panel of the host's, left of the board, in the rail's place. */
export interface LeadingPanel {
  id: string;
  node: ReactNode;
  /** Sizes as the group takes them: percentages ("18"). */
  size: string;
  min?: string;
  max?: string;
  /** Folded to a narrow strip (fixed width with nothing open). */
  strip?: boolean;
}

export default function AnalysisPage({
  tabs, activeKey, onActivate, onClose, onCloseMany, onMove, capacity, onOpenGame, onTabState, onGameMutated, onOpenProfile,
  leadingPanels, layoutId = "analysis-main", emptyState, myGamesBook, onPickChapter, documentReload = 0, onOpenRepertoire,
}: Props) {
  const lead = leadingPanels && leadingPanels.length > 0 ? leadingPanels : null;
  const leadIds = lead ? lead.map((p) => p.id) : ["rail"];
  // Separators after the leading panels count on from the last of them.
  const off = leadIds.length - 1;
  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const full = tabs.length >= capacity;

  // Games picked in the rail with Ctrl-click: what "selected" means in the
  // rail menu. Without a pick, the menu acts on every open game. Keys of
  // games since closed drop out.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const pickedNow = [...picked].filter((k) => tabs.some((t) => t.key === k));
  const [railNote, setRailNote] = useState<string | null>(null);
  const [pdfGames, setPdfGames] = useState<{ games: ExportableGame[]; primary: "print" | "save" } | null>(null);
  useEffect(() => {
    if (!railNote) return;
    const t = window.setTimeout(() => setRailNote(null), 4000);
    return () => window.clearTimeout(t);
  }, [railNote]);

  /** Selection the way a file list does it: a click picks that game alone
   *  (and shows it); Ctrl-click adds or removes one, keeping the shown game
   *  in the set; Shift-click picks the run from the shown game to this one. */
  function pickTab(key: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    const keys = tabs.map((t) => t.key);
    if (e.shiftKey) {
      const from = keys.indexOf(activeKey ?? key);
      const to = keys.indexOf(key);
      const [a, b] = from <= to ? [from, to] : [to, from];
      const range = keys.slice(Math.max(a, 0), b + 1);
      setPicked((prev) => new Set(e.ctrlKey || e.metaKey ? [...prev, ...range] : range));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.size === 0 && activeKey) next.add(activeKey);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
      return;
    }
    onActivate(key);
    setPicked(new Set([key]));
  }
  /** The games a rail-menu command works on, in rail order. */
  // Chapters (#327) export from the Repertoire page; print and export here
  // are the games'.
  const targets = (scope: "all" | "picked") => (scope === "picked" ? tabs.filter((t) => picked.has(t.key)) : tabs).filter((t) => !t.document);
  async function exportPgn(scope: "all" | "picked") {
    const list = targets(scope);
    try {
      const pgns = await fetchPgns(list.map((t) => t.game.id));
      const ok = await savePgnFile(list.map((t) => t.game), pgns.filter((p): p is string => p !== null));
      if (ok) setRailNote(`${list.length === 1 ? "1 game" : `${list.length} games`} saved as PGN`);
    } catch (e) {
      setRailNote(`Could not export: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function printPdf(primary: "print" | "save", scope: "all" | "picked") {
    const list = targets(scope);
    try {
      const pgns = await fetchPgns(list.map((t) => t.game.id));
      // Each game prints the way its board stands: no orientation question.
      setPdfGames({ games: list.map((t, i) => ({ ...t.game, pgn: pgns[i], flipped: t.flipped })), primary });
    } catch (e) {
      setRailNote(`Could not load the games: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Commands over the open games live in the board's More menu, where print
  // and export are looked for — a menu of the rail's own was easy to miss.
  // Only with more than one game open: for one, the game's own entries say
  // the same, and its ✕ closes it.
  const railExtras: MenuEntry[] = (() => {
    if (tabs.length < 2 || lead) return [];
    const n = pickedNow.length;
    const subset = n > 0 && n < tabs.length;
    return [
      ...(subset ? [
        { label: `Print the ${n} selected…`, onClick: () => void printPdf("print", "picked") },
        { label: `Export the ${n} selected as PDF…`, onClick: () => void printPdf("save", "picked") },
        { label: `Export the ${n} selected as PGN…`, onClick: () => void exportPgn("picked") },
      ] : []),
      { label: "Print all games…", onClick: () => void printPdf("print", "all"), separated: subset },
      { label: "Export all games as PDF…", onClick: () => void printPdf("save", "all") },
      { label: "Export all games as PGN…", onClick: () => void exportPgn("all") },
      ...(subset ? [{
        label: `Close the ${n} selected`, separated: true,
        onClick: () => { onCloseMany(pickedNow); setPicked(new Set()); },
      }] : []),
      {
        label: "Close others", separated: !subset, disabled: !active,
        onClick: () => onCloseMany(tabs.filter((t) => t.key !== activeKey).map((t) => t.key)),
      },
      { label: "Close all", onClick: () => onCloseMany(tabs.map((t) => t.key)) },
      ...(n > 0 ? [{ label: "Select none", separated: true, onClick: () => setPicked(new Set()) }] : []),
    ];
  })();
  async function openRelated(game: GameSummary) {
    const left = await onOpenGame([game]);
    if (left > 0) setRailNote(`The board is full: it holds ${capacity} games. Close one to open another.`);
  }

  // Current board position of the active game, kept on the tab (see below).
  const currentFen = active?.fen ?? STARTPOS;
  const effFen = !currentFen || currentFen === "start" ? STARTPOS : currentFen;
  const atStart = effFen.startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w");
  const fenParts = effFen.split(" ");
  const movePrefix = fenParts[1] === "b" ? `${fenParts[5] ?? "1"}...` : `${fenParts[5] ?? "1"}.`;

  // The board reports (fen, gameId) rather than just a fen: it is a single
  // instance reused across tabs, so we map the report back onto the tab it
  // belongs to. Read `tabs` through a ref to keep this callback stable —
  // GameBoard reports from an effect keyed on the callback identity, and a new
  // identity per position update would feed back into itself.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // How the board's position arose, for the local engine. Not part of the
  // tab's saved state: the board reports it again whenever it moves.
  const [history, setHistory] = useState<EngineHistory | undefined>(undefined);
  const handlePositionChange = useCallback((fen: string, gameId: number, cursor: CursorPath, h?: EngineHistory) => {
    const tab = tabsRef.current.find((t) => t.game.id === gameId);
    if (tab) onTabState(tab.key, { fen, cursor });
    setHistory(h);
  }, [onTabState]);
  const handleFlippedChange = useCallback((flipped: boolean) => {
    if (activeKey) onTabState(activeKey, { flipped });
  }, [activeKey, onTabState]);

  // Right column, top: Reference or Games. Persisted so the view comes back
  // the way it was left, like the rest of the Analysis state. (The Engine
  // was a third tab; it now has the panel below, always shown.)
  const [tab, setTab] = useState<RightTab>(() => {
    const saved = localStorage.getItem(TAB_KEY);
    return saved === "related" || saved === "lines" || saved === "mine" || saved === "repertoire" ? saved : "reference";
  });
  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);
  // The Lines tab belongs to a chapter (#327): on a game it falls back.
  // The whole book picked on the Repertoire page: its games, under My games.
  const bookId = myGamesBook?.id ?? null;
  useEffect(() => { if (bookId != null) setTab("mine"); }, [bookId]);
  // Lines and My games are a repertoire chapter's — not a model game's:
  // elsewhere, Reference.
  const repertoireChapter = !!active?.document && !active.document.model;
  // The Repertoire tab is a game's: the chapters it went into.
  const repertoireMatch = !!active && !active.document && !!onOpenRepertoire;
  const shownTab: RightTab = ((tab === "lines" || tab === "mine") && !repertoireChapter) || (tab === "repertoire" && !repertoireMatch) ? "reference" : tab;
  // The line on the board — the game, or the variation the board is in —
  // else, until the board has said, the game's moves.
  const boardLine = history?.line;
  const gameMoves = useMemo(() => boardLine ?? active?.loaded.moves.map((m) => m.san) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardLine?.join(" "), active?.loaded.moves]);
  const match = useRepertoireMatch(gameMoves, active?.game.white ?? "", active?.game.black ?? "", repertoireMatch);
  const matched = match.matches && matchCount(match.matches);

  // A repertoire chapter (#327): its lines, the cursor asked for when one is
  // picked, and "→ at the end of a line goes on to the next".
  const [chapterVersion, setChapterVersion] = useState(0);
  // Bumped when the Lines tab saved the chapter (lines switched on or off):
  // the board reads it again.
  const [linesSaved, setLinesSaved] = useState(0);
  const linesRef = useRef<ChapterLine[]>([]);
  const [cursorRequest, setCursorRequest] = useState<{ cursor?: CursorPath; along?: { sans: string[]; ply: number }; seq: number } | null>(null);
  const requestCursor = useCallback((cursor: CursorPath) => setCursorRequest((r) => ({ cursor, seq: (r?.seq ?? 0) + 1 })), []);
  // The position after a line's first `ply` moves, as the board has the line.
  const requestAlong = useCallback((sans: string[], ply: number) => setCursorRequest((r) => ({ along: { sans, ply }, seq: (r?.seq ?? 0) + 1 })), []);
  // ↑ / ↓ on the board: the previous / next line, at its branching move.
  const lineStep = useCallback((delta: -1 | 1): boolean => {
    const t = tabsRef.current.find((x) => x.key === activeKey);
    const cur = t?.cursor;
    // A model game has no lines to step through.
    if (!cur || t?.document?.model) return false;
    const key = JSON.stringify(cur.steps);
    const i = linesRef.current.findIndex((l) => JSON.stringify(l.steps) === key);
    const to = i >= 0 ? linesRef.current[i + delta] : undefined;
    if (!to) return false;
    requestCursor({ steps: to.steps, index: to.branchIndex });
    return true;
  }, [activeKey, requestCursor]);
  const onChapterMutated = useCallback(() => { setChapterVersion((v) => v + 1); onGameMutated?.(); }, [onGameMutated]);
  const chapterDoc = active?.document
    ? { ...active.document, save: (movetext: string) => saveChapterMoves(active.document!.id, movetext).then(() => ({ ok: true as const })).catch((e) => ({ ok: false as const, error: String(e) })) }
    : undefined;

  // Engine games (TCEC, via the Lichess broadcasts) drown out the human ones
  // in both panels, so they are hidden unless asked for. Persisted like the tab.
  const [showEngines, setShowEngines] = useShowEngineGames();
  const engineParam = engineParamFor(showEngines);

  // rail | board | intel — three panels, so dividers need the neighbour-only rule.
  // rail | board | move text | intel — four sibling panels, so every divider
  // trades between exactly two of them. The move text used to live inside the
  // board panel, which is why dragging the intel divider resized the board and
  // left the move text alone.
  const rz = useNeighbourResize([...leadIds, "board", "moves", "side"]);
  const [moveHost, setMoveHost] = useState<HTMLDivElement | null>(null);
  const saved = useDefaultLayout({ id: layoutId, storage: localStorage });
  // Another layoutId — a panel folded or opened on the Repertoire page — sets
  // the new sizes in place. Remounting the group for it would remount the
  // board, and throw away an edit of the moves in progress. The layout last
  // used with this id is read while rendering, before the group commits its
  // new constraints under the id; without one, the leading panels take their
  // default sizes and the board takes up the difference.
  const group = useGroupRef();
  const remembered = saved.defaultLayout;
  const appliedLayout = useRef(layoutId);
  useLayoutEffect(() => {
    if (appliedLayout.current === layoutId) return;
    appliedLayout.current = layoutId;
    const g = group.current;
    if (!g) return;
    let next = remembered;
    if (!next) {
      next = { ...g.getLayout() };
      for (const p of lead ?? []) {
        const size = Number(p.size);
        next.board = (next.board ?? 0) + (next[p.id] ?? size) - size;
        next[p.id] = size;
      }
    }
    g.setLayout(next);
  }, [layoutId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sideCol = useDefaultLayout({ id: "analysis-side", storage: localStorage });

  // A related game being previewed in place — picking a row no longer opens a
  // whole tab, which was a heavy commitment for "how did that game go?".
  const [preview, setPreview] = useState<GameSummary | null>(null);
  // Whose preview it is — the Games tab's, or My games' — and the move it
  // opens at (My games: where the game left the chapter).
  const [previewFrom, setPreviewFrom] = useState<"related" | "mine">("related");
  const [previewStart, setPreviewStart] = useState(0);
  const [previewPly, setPreviewPly] = useState(0);
  // Bumped when the preview's Details changed the game (visibility, collections).
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const { game: previewGame, loading: previewLoading } = useGamePgn(preview?.id ?? null, previewReloadKey);
  useEffect(() => { setPreviewPly(previewStart); }, [preview?.id, previewStart]);
  // Move on and the Games tab's preview no longer belongs to what's listed
  // (My games' moves the board itself: it stays); switch tabs and neither.
  useEffect(() => { if (previewFrom === "related") setPreview(null); }, [effFen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPreview(null); }, [activeKey]);
  const previewRelated = (g: GameSummary) => { setPreviewFrom("related"); setPreviewStart(0); setPreview(g); };
  const previewMine = (g: GameSummary, ply: number) => { setPreviewFrom("mine"); setPreviewStart(ply); setPreview(g); };
  // The previewed game under a list (Games, or My games): its header, the
  // board and the moves, opening at its start move.
  const previewPane = preview ? (
                      <div className="shrink-0 h-[58%] min-h-0 flex flex-col border-t border-outline/40">
                        <GamePreview
                          game={preview}
                          loaded={previewGame}
                          loading={previewLoading}
                          ply={previewPly}
                          setPly={setPreviewPly}
                          onReload={() => setPreviewReloadKey((k) => k + 1)}
                          openEntries={[{
                            label: "Open in Analysis",
                            onClick: () => void openRelated(preview),
                            title: "Open this game in its own Analysis tab",
                          }]}
                          onClose={() => setPreview(null)}
                          boardId="analysis-related-preview"
                          layoutId="analysis-preview"
                          panelClass="h-full w-full min-h-0 min-w-0 overflow-hidden flex flex-col"
                          emptyText="—"
                          // A short space under the list: the board needs the most of it.
                          boardShare={70}
                        />
                      </div>
  ) : null;


  // Moves the panels ask the board to play — a Reference row or an Engine
  // line. They land on the board as a scratch line, which the game never sees
  // unless the user keeps it. `seq` lets the same move be sent twice.
  const [playRequest, setPlayRequest] = useState<{ sans: string[]; seq: number } | null>(null);
  const playSans = useCallback((sans: string[]) => {
    setPlayRequest((prev) => ({ sans, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const [refMoves, setRefMoves] = useState<MoveStats[]>([]);
  const [refLoading, setRefLoading] = useState(false);
  const refAbort = useRef<AbortController | null>(null);
  const [related, setRelated] = useState<GameSummary[]>([]);
  // How many games reach this position in total — the list is one capped page,
  // and "50+" hid the difference between 52 games and 3000.
  const [relatedTotal, setRelatedTotal] = useState<number | null>(null);
  const relAbort = useRef<AbortController | null>(null);

  // C — reference-DB moves from the current position (Zobrist / transposition-aware).
  useEffect(() => {
    if (!active) { setRefMoves([]); return; }
    refAbort.current?.abort();
    refAbort.current = new AbortController();
    setRefLoading(true);
    fetch(`/api/position/moves?fen=${encodeURIComponent(effFen)}${engineParam}`, { signal: refAbort.current.signal })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<MoveStats[]>; })
      .then((d) => { setRefMoves(d); setRefLoading(false); })
      .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) { setRefMoves([]); setRefLoading(false); } });
  }, [active?.key, effFen, engineParam]);

  // E — related games that reached this position (skip the start position).
  useEffect(() => {
    if (!active || atStart) { setRelated([]); setRelatedTotal(null); return; }
    relAbort.current?.abort();
    relAbort.current = new AbortController();
    const sig = relAbort.current.signal;
    // Strongest games first, both players counted: one colour's rating alone
    // put a 2726 against a 2404 above 2718 against 2766.
    fetch(`/api/games?fen=${encodeURIComponent(effFen)}&limit=50&sort=elo_sum${engineParam}`, { signal: sig })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<GameSummary[]>; })
      .then((d) => setRelated(d))
      .catch(() => {});
    fetch(`/api/games?fen=${encodeURIComponent(effFen)}&count=true${engineParam}`, { signal: sig })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<{ count: number }>; })
      .then((d) => setRelatedTotal(d.count))
      .catch(() => {});
  }, [active?.key, effFen, atStart, engineParam]);

  // The board's arrows (see HintArrows): the database's most played moves
  // (the Reference moves covering three quarters of the games) and every
  // engine's strong moves (from the Engine panel) — as the checkboxes have them.
  const [engineMoves, setEngineMoves] = useState<CombinedMove[]>([]);
  const arrowToggles = useArrowToggles("analysis");
  const hintArrows = useMemo(() => [
    ...(arrowToggles.on.db ? dbArrows(effFen, refMoves) : []),
    ...(arrowToggles.on.engine ? engineArrows(engineMoves) : []),
  ], [arrowToggles.on.db, arrowToggles.on.engine, effFen, refMoves, engineMoves]);

  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 overflow-hidden p-1.5 gap-1.5">
        {/* As wide as in the layout with a game open (what was dragged last,
            else the default), so closing the last chapter doesn't squeeze them. */}
        {lead?.map((p) => (
          <div key={p.id} className="shrink-0 min-h-0" style={{ width: `${saved.defaultLayout?.[p.id] ?? Number(p.size)}%` }}>{p.node}</div>
        ))}
        <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md px-6 text-center">
          {emptyState ?? 'Open a game from the Games or Players page ("Open in Analysis") to start analysing.'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden p-1.5">
      {/* Rail | board | position intel. One group, so every divider follows the
          same rule: it resizes the two panels it separates and nothing else. */}
      <Group orientation="horizontal" className="flex-1 min-w-0 flex" groupRef={group} defaultLayout={saved.defaultLayout} onLayoutChanged={saved.onLayoutChanged} onLayoutChange={rz.onLayout}>
      {/* A — open-game tabs (mini-board previews) */}
      {lead ? lead.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && <Separator className={vHandle} {...rz.separator(i - 1)} />}
          <Panel id={p.id} defaultSize={p.size} minSize={rz.floor(p.id) ?? p.min ?? p.size} maxSize={p.max ?? p.size}>
            {p.node}
          </Panel>
        </Fragment>
      )) : (
      <Panel id="rail" defaultSize="9" minSize={rz.floor("rail") ?? "5"} maxSize="16">
      <div className="h-full flex flex-col min-h-0">
        {/* The rail is also the export list: what is open, in this order, is
            what "Print all games" writes (from the More menu above the
            board). The count says how much room is left. */}
        <div className="shrink-0 flex items-center gap-1 pb-1 pr-2.5">
          <span
            className={`flex-1 min-w-0 truncate text-label-sm ${full ? "text-error" : "text-on-surface-variant"}`}
            title={full
              ? `The board is full: it holds ${capacity} games. Close one to open another.`
              : `${tabs.length} of ${capacity} games open. Ctrl-click or Shift-click selects games; ▲▼ change the order, which is the order they print in.`}
          >
            {tabs.length} of {capacity}{pickedNow.length ? ` · ${pickedNow.length} selected` : ""}
          </span>
        </div>
        {railNote && <div className="shrink-0 mb-1 mr-2.5 px-1.5 py-1 rounded-sm text-label-sm bg-surface-container-high text-on-surface">{railNote}</div>}
      {/* Right padding keeps the cards clear of the scrollbar, which WebKitGTK
          draws over the content instead of beside it — it hid the close ✕. */}
      <div className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-y-auto pr-2.5">
        {tabs.map((t, i) => {
          const on = t.key === activeKey;
          const isPicked = picked.has(t.key);
          const nav = "shrink-0 w-4 h-5 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 disabled:opacity-30 disabled:hover:bg-transparent text-[10px]";
          return (
            <div key={t.key} className={`shrink-0 rounded-md border ${on ? "border-primary" : "border-outline/40"} ${isPicked ? "ring-2 ring-tertiary" : ""} bg-surface-container-low overflow-hidden`}>
              <button
                onClick={(e) => pickTab(t.key, e)}
                className="w-full aspect-square block"
                title={`${t.document ? `${t.document.bookName} › ${t.document.chapterName}` : `${t.game.white} – ${t.game.black}`}\nCtrl-click adds it to the selection, Shift-click selects a run`}
              >
                <MiniBoard
                  game={t.loaded}
                  fen={t.fen ?? undefined}
                  flipped={t.flipped}
                  id={`analysis-mini-${t.key}`}
                  showHeader={false}
                  showNav={false}
                />
              </button>
              <div className="flex items-center gap-0.5 px-1 py-1 border-t border-outline/40">
                <span className={`flex-1 min-w-0 truncate text-label-sm ${on ? "text-on-surface" : "text-on-surface-variant"}`}>
                  {t.document ? `${t.document.chapterName}` : `${t.game.white.split(",")[0]} – ${t.game.black.split(",")[0]}`}
                </span>
                <button onClick={() => onMove(t.key, -1)} disabled={i === 0} className={nav} title="Move up">▲</button>
                <button onClick={() => onMove(t.key, 1)} disabled={i === tabs.length - 1} className={nav} title="Move down">▼</button>
                <button onClick={() => onClose(t.key)} className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 text-body-sm" title="Close">✕</button>
              </div>
            </div>
          );
        })}
      </div>
      </div>
      </Panel>
      )}

      <Separator className={vHandle} {...rz.separator(off)} />

      {/* Active game (editable board + comments + notation) */}
        <Panel id="board" defaultSize="38" minSize={rz.floor("board") ?? "20"}>
          <div className={panel}>
            {active && (
              <GameBoard
                game={active.game}
                hintArrows={hintArrows}
                arrowControls={<ArrowToggles {...arrowToggles} />}
                onPositionChange={handlePositionChange}
                initialCursor={active.cursor}
                flipped={active.flipped}
                onFlippedChange={handleFlippedChange}
                onGameMutated={active.document ? onChapterMutated : onGameMutated}
                onOpenProfile={onOpenProfile}
                moveListHost={moveHost}
                playRequest={playRequest}
                menuExtras={railExtras}
                chapter={chapterDoc}
                cursorRequest={cursorRequest}
                onLineStep={active.document ? lineStep : undefined}
                reloadKey={active.document ? documentReload + linesSaved : undefined}
              />
            )}
          </div>
        </Panel>

        <Separator className={vHandle} {...rz.separator(off + 1)} />

        {/* The game's move text — its own panel, not a sidebar of the board. */}
        <Panel id="moves" defaultSize="19" minSize={rz.floor("moves") ?? "10"}>
          <div className={panel}>
            <div ref={setMoveHost} className="flex-1 min-h-0" />
          </div>
        </Panel>

        <Separator className={vHandle} {...rz.separator(off + 2)} />

        {/* Position intel: Reference or the related games above, one tab at
            a time, and the engines below — always in view, so it is plain
            whether they run, and they keep running while the tabs change. */}
        <Panel
          id="side"
          defaultSize="30"
          minSize={rz.floor("side") ?? "18"}
        >
          <Group orientation="vertical" className="h-full w-full flex" defaultLayout={sideCol.defaultLayout} onLayoutChanged={sideCol.onLayoutChanged}>
            <Panel id="side-games" defaultSize="50" minSize="15">
              <div className={panel}>
                <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-outline/40">
                  {([
                    // Reference and Games are two views of the same games, so they
                    // sit together; the cloud engine is a different question.
                    { key: "reference", label: "Reference" },
                    { key: "related", label: `Games${relatedTotal != null ? ` · ${relatedTotal.toLocaleString()}` : ""}` },
                    ...(repertoireChapter ? [{ key: "lines" as RightTab, label: "Lines" }, { key: "mine" as RightTab, label: "My games" }] : []),
                    ...(repertoireMatch ? [{
                      key: "repertoire" as RightTab,
                      label: `Repertoire${matched ? ` · ${matched.chapters}` : ""}`,
                      title: matched
                        ? `This game went into ${matched.books} ${matched.books === 1 ? "book" : "books"}, ${matched.chapters} ${matched.chapters === 1 ? "chapter" : "chapters"} of your ${match.color === "white" ? "White" : "Black"} repertoire`
                        : undefined,
                    }] : []),
                  ] as { key: RightTab; label: string; title?: string }[]).map((t) => (
                    <button
                      key={t.key}
                      title={t.title}
                      onClick={() => setTab(t.key)}
                      className={`h-7 px-3 rounded-full text-label-md transition-colors duration-short3 ease-standard ${
                        shownTab === t.key ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                  <button
                    onClick={() => setShowEngines((v) => !v)}
                    className={`ml-auto h-7 px-3 rounded-full text-label-md transition-colors duration-short3 ease-standard ${
                      showEngines ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12"
                    }`}
                    title={showEngines
                      ? "Engine games (TCEC and the like) count in Reference and Games. Click to leave them out."
                      : "Engine games are left out of Reference and Games. Click to count them."}
                  >
                    Engine games
                  </button>
                </div>

                {shownTab === "repertoire" && active && onOpenRepertoire ? (
                  <RepertoireMatchPanel moves={gameMoves} match={match}
                    onShow={(m) => requestAlong(gameMoves, m.ply)}
                    onOpen={(m) => onOpenRepertoire(m, gameMoves)} />
                ) : shownTab === "mine" && repertoireChapter && active?.document ? (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <MyGamesPanel
                      chapterId={active.document.id}
                      book={myGamesBook ?? null}
                      onPickChapter={onPickChapter}
                      reloadKey={chapterVersion + documentReload}
                      onPick={requestCursor}
                      onOpen={(g) => void openRelated(g)}
                      onPreview={previewMine}
                    />
                    {previewFrom === "mine" && previewPane}
                  </div>
                ) : shownTab === "lines" && repertoireChapter && active?.document ? (
                  <LinesPanel
                    chapterId={active.document.id}
                    reloadKey={chapterVersion + documentReload}
                    analysedAt={active.document.analysedAt}
                    cursor={active.cursor}
                    onPick={requestCursor}
                    onLines={(ls) => { linesRef.current = ls; }}
                    color={active.document.color}
                    onSaved={() => { setLinesSaved((v) => v + 1); onChapterMutated(); }}
                  />
                ) : shownTab === "reference" ? (
                  refLoading ? (
                    <div className="p-3 text-center text-on-surface-variant text-body-sm">Loading…</div>
                  ) : refMoves.length === 0 ? (
                    <div className="p-3 text-center text-on-surface-variant text-body-sm">No games from this position</div>
                  ) : (
                    <div className="flex-1 overflow-y-auto p-2">
                      <div className="flex items-center text-label-sm text-on-surface-variant px-2 mb-1 select-none">
                        <span className="w-24">Move</span>
                        <span className="w-20 text-right">Games</span>
                        <span className="w-10 text-right">W%</span>
                        <span className="w-10 text-right">D%</span>
                        <span className="w-10 text-right">L%</span>
                        <span className="w-16 text-right">Last</span>
                        <span className="flex-1 min-w-0 pl-2" title="The highest-rated players (2500-3400) who played this move. The cap keeps engines out.">Played by</span>
                      </div>
                      {refMoves.map((s) => (
                        <button
                          key={s.mv}
                          onClick={() => playSans([s.mv])}
                          title="Play this move on the board (not saved in the game)"
                          className="w-full flex items-center text-body-sm px-2 py-1 rounded-sm text-on-surface text-left hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard">
                          <span className="w-24 font-mono truncate text-left">{movePrefix}{s.mv}</span>
                          <span className="w-20 text-right">{s.games.toLocaleString()}</span>
                          <span className="w-10 text-right text-success">{Math.round(s.w_pct)}</span>
                          <span className="w-10 text-right text-on-surface-variant">{Math.round(s.d_pct)}</span>
                          <span className="w-10 text-right text-error">{Math.round(s.l_pct)}</span>
                          <span className="w-16 text-right text-on-surface-variant">{s.last_played?.slice(0, 4) ?? "—"}</span>
                          <span className="flex-1 min-w-0 truncate text-left pl-2 text-on-surface-variant" title={s.elite ?? undefined}>{s.elite ?? ""}</span>
                        </button>
                      ))}
                    </div>
                  )
                ) : (
                  <div className="flex-1 min-h-0 flex flex-col">
                    {/* Enter opens the previewed game, a double-click the game
                        clicked — as the preview's "Open in Analysis" does. */}
                    <div
                      className="flex-1 min-h-0 overflow-y-auto"
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" || !preview) return;
                        e.preventDefault();
                        void openRelated(preview);
                      }}
                    >
                      {atStart ? (
                        <div className="p-3 text-center text-on-surface-variant text-body-sm">Play a move to see games reaching this position</div>
                      ) : related.length === 0 ? (
                        <div className="p-3 text-center text-on-surface-variant text-body-sm">No related games</div>
                      ) : (
                        related.map((g) => {
                          const on = previewFrom === "related" && preview?.id === g.id;
                          return (
                            <button
                              key={g.id}
                              onClick={() => previewRelated(g)}
                              onDoubleClick={() => void openRelated(g)}
                              className={`w-full flex items-baseline gap-2 px-3 py-1.5 text-body-sm text-left whitespace-nowrap transition-colors duration-short3 ease-standard ${
                                on ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
                              }`}
                              title="Preview this game. Double-click or Enter opens it in Analysis."
                            >
                              {/* Each rating in brackets after its player. Both
                                  count towards the order, so neither is singled out. */}
                              <span className="min-w-0 flex-1 truncate">
                                {g.white}
                                {g.white_elo != null && <span className="tabular-nums opacity-70"> ({g.white_elo})</span>}
                                {" – "}
                                {g.black}
                                {g.black_elo != null && <span className="tabular-nums opacity-70"> ({g.black_elo})</span>}
                              </span>
                              <span className="shrink-0 tabular-nums">{g.result ? (g.result === "1/2-1/2" ? "½-½" : g.result) : ""}</span>
                              <span className={`shrink-0 ${on ? "text-on-secondary-container/80" : "text-on-surface-variant"}`}>{g.date?.slice(0, 4) ?? ""}</span>
                            </button>
                          );
                        })
                      )}
                    </div>

                    {/* Preview of the highlighted game — the list stays above it, so
                        you can walk down the list without losing your place. */}
                    {previewFrom === "related" && previewPane}
                  </div>
                )}
              </div>
            </Panel>
            <Separator className={hHandle} />
            {/* The engines: always in view, so it shows whether they run. */}
            <Panel id="side-engine" defaultSize="50" minSize="8">
              <div className={panel}>
                <CloudEngine fen={effFen} history={history} watchLabel={active ? (active.document ? active.document.chapterName : `${active.game.white} – ${active.game.black}`) : "Position"} onPlayLine={playSans} onEngineMoves={setEngineMoves} />
              </div>
            </Panel>
          </Group>
        </Panel>
      </Group>
      {pdfGames && (
        <PrintDialog games={pdfGames.games} primary={pdfGames.primary} flipped={active?.flipped ?? false} onClose={() => setPdfGames(null)} />
      )}
    </div>
  );
}
