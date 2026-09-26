import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { GameSummary, MoveStats } from "../types";
import { LoadedGame } from "../lib/useGamePgn";
import { CursorPath } from "../lib/moveTreeNav";
import MiniBoard from "./games/MiniBoard";
import MoveList from "./games/MoveList";
import GamePreviewHeader from "./games/GamePreviewHeader";
import GameMoreMenu from "./games/GameMoreMenu";
import GameBoard from "./GameBoard";
import CloudEngine from "./CloudEngine";
import { useGamePgn } from "../lib/useGamePgn";
import { useNeighbourResize } from "../lib/panelResize";
import { fetchPgns, savePgnFile } from "../lib/exportPgn";
import PrintDialog, { ExportableGame } from "./games/PrintDialog";

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
  /** Open a related game as a new tab. Resolves to 0, or to how many did not
   *  fit (the rail is full) — then it stayed closed. */
  onOpenGame: (games: GameSummary[]) => Promise<number>;
  /** Persist per-tab view state (position, cursor, orientation) in the owning store. */
  onTabState: (key: string, patch: { fen?: string; cursor?: CursorPath; flipped?: boolean }) => void;
  onGameMutated?: () => void;
}

const panel = "bg-surface-container-low border border-outline/40 rounded-md overflow-hidden flex flex-col min-h-0 min-w-0 h-full w-full";
const vHandle = "w-1.5 bg-transparent hover:bg-primary/30 data-[resize-handle-state=drag]:bg-primary/50 transition-colors";
const STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

type RightTab = "reference" | "engine" | "related";
const TAB_KEY = "analysisRightTab";
const ENGINES_KEY = "analysisShowEngines";

export default function AnalysisPage({ tabs, activeKey, onActivate, onClose, onCloseMany, onMove, capacity, onOpenGame, onTabState, onGameMutated }: Props) {
  const active = tabs.find((t) => t.key === activeKey) ?? null;
  const full = tabs.length >= capacity;

  // Games picked in the rail with Ctrl-click: what "selected" means in the
  // rail menu. Without a pick, the menu acts on every open game. Keys of
  // games since closed drop out.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const pickedNow = [...picked].filter((k) => tabs.some((t) => t.key === k));
  // The menu is positioned on the page, not in the rail: the rail is narrow
  // and clips whatever hangs out of it.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const railMenu = menuAt !== null;
  const setRailMenu = (open: boolean) => { if (!open) setMenuAt(null); };
  const railMenuRef = useRef<HTMLDivElement>(null);
  const [railNote, setRailNote] = useState<string | null>(null);
  const [pdfGames, setPdfGames] = useState<{ games: ExportableGame[]; primary: "print" | "save" } | null>(null);
  useEffect(() => {
    if (!railMenu) return;
    const onDown = (e: MouseEvent) => {
      if (railMenuRef.current && !railMenuRef.current.contains(e.target as Node)) setRailMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [railMenu]);
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
  const targets = (scope: "all" | "picked") => (scope === "picked" ? tabs.filter((t) => picked.has(t.key)) : tabs);
  async function exportPgn(scope: "all" | "picked") {
    setRailMenu(false);
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
    setRailMenu(false);
    const list = targets(scope);
    try {
      const pgns = await fetchPgns(list.map((t) => t.game.id));
      // Each game prints the way its board stands: no orientation question.
      setPdfGames({ games: list.map((t, i) => ({ ...t.game, pgn: pgns[i], flipped: t.flipped })), primary });
    } catch (e) {
      setRailNote(`Could not load the games: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // The rail's commands, offered again in the board's More menu: that is
  // where print and export are looked for, and the rail's own menu is easy
  // to miss. Only with more than one game open — for one, the game's own
  // entries above say the same.
  const railExtras = (() => {
    if (tabs.length < 2) return [];
    const n = pickedNow.length;
    const subset = n > 0 && n < tabs.length;
    const all = "all games";
    return [
      ...(subset ? [
        { label: `Print the ${n} selected…`, onClick: () => void printPdf("print", "picked") },
        { label: `Export the ${n} selected as PDF…`, onClick: () => void printPdf("save", "picked") },
        { label: `Export the ${n} selected as PGN…`, onClick: () => void exportPgn("picked") },
      ] : []),
      { label: `Print ${all}…`, onClick: () => void printPdf("print", "all") },
      { label: `Export ${all} as PDF…`, onClick: () => void printPdf("save", "all") },
      { label: `Export ${all} as PGN…`, onClick: () => void exportPgn("all") },
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
  const handlePositionChange = useCallback((fen: string, gameId: number, cursor: CursorPath) => {
    const tab = tabsRef.current.find((t) => t.game.id === gameId);
    if (tab) onTabState(tab.key, { fen, cursor });
  }, [onTabState]);
  const handleFlippedChange = useCallback((flipped: boolean) => {
    if (activeKey) onTabState(activeKey, { flipped });
  }, [activeKey, onTabState]);

  // Right column: one panel at a time. Persisted so the view comes back the way
  // it was left, like the rest of the Analysis state.
  const [tab, setTab] = useState<RightTab>(() => {
    const saved = localStorage.getItem(TAB_KEY);
    return saved === "engine" || saved === "related" ? saved : "reference";
  });
  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);

  // Engine games (TCEC, via the Lichess broadcasts) drown out the human ones
  // in both panels, so they are hidden unless asked for. Persisted like the tab.
  const [showEngines, setShowEngines] = useState(() => localStorage.getItem(ENGINES_KEY) === "1");
  useEffect(() => { localStorage.setItem(ENGINES_KEY, showEngines ? "1" : "0"); }, [showEngines]);
  const engineParam = showEngines ? "" : "&exclude_engines=true";

  // rail | board | intel — three panels, so dividers need the neighbour-only rule.
  // rail | board | move text | intel — four sibling panels, so every divider
  // trades between exactly two of them. The move text used to live inside the
  // board panel, which is why dragging the intel divider resized the board and
  // left the move text alone.
  const rz = useNeighbourResize(["rail", "board", "moves", "side"]);
  const [moveHost, setMoveHost] = useState<HTMLDivElement | null>(null);
  const saved = useDefaultLayout({ id: "analysis-main", storage: localStorage });

  // A related game being previewed in place — picking a row no longer opens a
  // whole tab, which was a heavy commitment for "how did that game go?".
  const [preview, setPreview] = useState<GameSummary | null>(null);
  const [previewPly, setPreviewPly] = useState(0);
  const { game: previewGame, loading: previewLoading } = useGamePgn(preview?.id ?? null);
  useEffect(() => { setPreviewPly(0); }, [preview?.id]);
  // Move on, or switch tabs, and the preview no longer belongs to what's listed.
  useEffect(() => { setPreview(null); }, [effFen, activeKey]);

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

  if (tabs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md px-6 text-center">
        Open a game from the Games or Players page ("Open in Analysis") to start analysing.
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden p-1.5">
      {/* Rail | board | position intel. One group, so every divider follows the
          same rule: it resizes the two panels it separates and nothing else. */}
      <Group orientation="horizontal" className="flex-1 min-w-0 flex" defaultLayout={saved.defaultLayout} onLayoutChanged={saved.onLayoutChanged} onLayoutChange={rz.onLayout}>
      {/* A — open-game tabs (mini-board previews) */}
      <Panel
        id="rail"
        defaultSize="9"
        minSize={rz.floor("rail") ?? "5"}
        maxSize="16"
      >
      <div className="h-full flex flex-col min-h-0">
        {/* The rail is also the export list: what is open, in this order, is
            what "Export all" writes. The count says how much room is left. */}
        <div className="shrink-0 flex items-center gap-1 pb-1 pr-2.5" ref={railMenuRef}>
          <span
            className={`flex-1 min-w-0 truncate text-label-sm ${full ? "text-error" : "text-on-surface-variant"}`}
            title={full
              ? `The board is full: it holds ${capacity} games. Close one to open another.`
              : `${tabs.length} of ${capacity} games open. Ctrl-click or Shift-click selects games; ▲▼ change the order, which is the order they print in.`}
          >
            {tabs.length} of {capacity}{pickedNow.length ? ` · ${pickedNow.length} selected` : ""}
          </span>
          <div className="relative">
            <button
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenuAt(railMenu ? null : { x: r.left, y: r.bottom + 4 });
              }}
              className={`w-6 h-6 inline-flex items-center justify-center rounded-full text-body-md transition-colors duration-short3 ease-standard ${
                railMenu ? "bg-on-surface/12 text-on-surface" : "text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12"
              }`}
              title="Print, export or close the open games"
            >
              ⋯
            </button>
            {railMenu && (() => {
              const item = "w-full text-left px-3 py-1.5 text-label-md text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-40 disabled:hover:bg-transparent transition-colors duration-short3 ease-standard whitespace-nowrap";
              // A picked subset gets its own entries above the ones for all;
              // picking every game, or none, is the same as all.
              const subset = pickedNow.length > 0 && pickedNow.length < tabs.length;
              const n = pickedNow.length;
              return (
                <div style={{ position: "fixed", left: menuAt!.x, top: menuAt!.y }} className="z-30 py-1 rounded-md bg-surface-container-high shadow-xl min-w-52">
                  {subset && (
                    <>
                      <button className={item} onClick={() => void exportPgn("picked")}>Export {n} selected as PGN…</button>
                      <button className={item} onClick={() => void printPdf("save", "picked")}>Export {n} selected as PDF…</button>
                      <button className={item} onClick={() => void printPdf("print", "picked")}>Print {n} selected…</button>
                      <div className="my-1 h-px bg-outline-variant" />
                    </>
                  )}
                  <button className={item} onClick={() => void exportPgn("all")}>Export all as PGN…</button>
                  <button className={item} onClick={() => void printPdf("save", "all")}>Export all as PDF…</button>
                  <button className={item} onClick={() => void printPdf("print", "all")}>Print all…</button>
                  <div className="my-1 h-px bg-outline-variant" />
                  {subset && (
                    <button className={item} onClick={() => { setRailMenu(false); onCloseMany(pickedNow); setPicked(new Set()); }}>
                      Close {pickedNow.length} selected
                    </button>
                  )}
                  <button className={item} disabled={!active || tabs.length < 2} onClick={() => { setRailMenu(false); onCloseMany(tabs.filter((t) => t.key !== activeKey).map((t) => t.key)); }}>
                    Close others
                  </button>
                  <button className={item} onClick={() => { setRailMenu(false); onCloseMany(tabs.map((t) => t.key)); }}>
                    Close all
                  </button>
                  {pickedNow.length > 0 && (
                    <>
                      <div className="my-1 h-px bg-outline-variant" />
                      <button className={item} onClick={() => { setRailMenu(false); setPicked(new Set()); }}>Select none</button>
                    </>
                  )}
                </div>
              );
            })()}
          </div>
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
                title={`${t.game.white} – ${t.game.black}\nCtrl-click adds it to the selection, Shift-click selects a run`}
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
                  {t.game.white.split(",")[0]} – {t.game.black.split(",")[0]}
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

      <Separator className={vHandle} {...rz.separator(0)} />

      {/* Active game (editable board + comments + notation) */}
        <Panel id="board" defaultSize="38" minSize={rz.floor("board") ?? "20"}>
          <div className={panel}>
            {active && (
              <GameBoard
                game={active.game}
                onPositionChange={handlePositionChange}
                initialCursor={active.cursor}
                flipped={active.flipped}
                onFlippedChange={handleFlippedChange}
                onGameMutated={onGameMutated}
                moveListHost={moveHost}
                playRequest={playRequest}
                menuExtras={railExtras}
              />
            )}
          </div>
        </Panel>

        <Separator className={vHandle} {...rz.separator(1)} />

        {/* The game's move text — its own panel, not a sidebar of the board. */}
        <Panel id="moves" defaultSize="19" minSize={rz.floor("moves") ?? "10"}>
          <div className={panel}>
            <div ref={setMoveHost} className="flex-1 min-h-0" />
          </div>
        </Panel>

        <Separator className={vHandle} {...rz.separator(2)} />

        {/* Position intel + related games, one tab at a time. Tabs rather than
            more stacked panels: this column would otherwise hold four ~180px
            strips, and the engine (and a related-game preview) need height.
            The inactive tabs unmount, so the engine asks for no evaluations
            while you are reading something else. */}
        <Panel
          id="side"
          defaultSize="30"
          minSize={rz.floor("side") ?? "18"}
        >
          <div className={panel}>
            <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-outline/40">
              {([
                // Reference and Games are two views of the same games, so they
                // sit together; the cloud engine is a different question.
                { key: "reference", label: "Reference" },
                { key: "related", label: `Games${relatedTotal != null ? ` · ${relatedTotal.toLocaleString()}` : ""}` },
                { key: "engine", label: "Engine" },
              ] as { key: RightTab; label: string }[]).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`h-7 px-3 rounded-full text-label-md transition-colors duration-short3 ease-standard ${
                    tab === t.key ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12"
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

            {tab === "reference" ? (
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
            ) : tab === "engine" ? (
              <CloudEngine fen={effFen} watchLabel={active ? `${active.game.white} – ${active.game.black}` : "Position"} onPlayLine={playSans} />
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {atStart ? (
                    <div className="p-3 text-center text-on-surface-variant text-body-sm">Play a move to see games reaching this position</div>
                  ) : related.length === 0 ? (
                    <div className="p-3 text-center text-on-surface-variant text-body-sm">No related games</div>
                  ) : (
                    related.map((g) => {
                      const on = preview?.id === g.id;
                      return (
                        <button
                          key={g.id}
                          onClick={() => setPreview(g)}
                          className={`w-full flex items-baseline gap-2 px-3 py-1.5 text-body-sm text-left whitespace-nowrap transition-colors duration-short3 ease-standard ${
                            on ? "bg-secondary-container text-on-secondary-container" : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
                          }`}
                          title="Preview this game"
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
                {preview && (
                  <div className="shrink-0 h-[58%] min-h-0 flex flex-col border-t border-outline/40">
                    <div className="shrink-0 px-2 py-1 flex items-center gap-2 border-b border-outline/40">
                      <GamePreviewHeader game={preview} />
                      {previewGame && (
                        <GameMoreMenu
                          pgn={previewGame.pgn}
                          fen={previewGame.fens[previewPly] ?? previewGame.fens[0]}
                          lineSans={previewGame.moves.map((m) => m.san)}
                          ply={previewPly}
                          startFen={previewGame.fens[0]}
                          gameUrl={previewGame.gameUrl}
                        />
                      )}
                      <button
                        onClick={() => void openRelated(preview)}
                        className="shrink-0 text-label-md text-primary hover:bg-primary/8 active:bg-primary/12 px-2.5 h-7 rounded-full transition-colors duration-short3 ease-standard"
                        title="Open this game in its own Analysis tab"
                      >
                        Open in Analysis →
                      </button>
                      <button
                        onClick={() => setPreview(null)}
                        className="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 text-body-sm"
                        title="Close the preview"
                      >✕</button>
                    </div>
                    {previewGame ? (
                      <div className="flex-1 min-h-0 flex flex-col">
                        <div className="flex-[3] min-h-0">
                          <MiniBoard game={previewGame} ply={previewPly} setPly={setPreviewPly} id="analysis-related-preview" showHeader={false} />
                        </div>
                        <div className="flex-[2] min-h-0 border-t border-outline/40">
                          <MoveList game={previewGame} ply={previewPly} setPly={setPreviewPly} />
                        </div>
                      </div>
                    ) : (
                      <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-sm">
                        {previewLoading ? "Loading…" : "—"}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </Panel>
      </Group>
      {pdfGames && (
        <PrintDialog games={pdfGames.games} primary={pdfGames.primary} flipped={active?.flipped ?? false} onClose={() => setPdfGames(null)} />
      )}
    </div>
  );
}
