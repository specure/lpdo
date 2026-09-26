import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { GameSummary, MoveStats } from "../types";
import { LoadedGame } from "../lib/useGamePgn";
import { CursorPath } from "../lib/moveTreeNav";
import MiniBoard from "./games/MiniBoard";
import MoveList from "./games/MoveList";
import GamePreviewHeader from "./games/GamePreviewHeader";
import GameShareMenu from "./games/GameShareMenu";
import GameBoard from "./GameBoard";
import CloudEngine from "./CloudEngine";
import { useGamePgn } from "../lib/useGamePgn";
import { useNeighbourResize } from "../lib/panelResize";

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
  onOpenGame: (game: GameSummary) => void;   // open a related game as a new tab
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

export default function AnalysisPage({ tabs, activeKey, onActivate, onClose, onOpenGame, onTabState, onGameMutated }: Props) {
  const active = tabs.find((t) => t.key === activeKey) ?? null;

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
      {/* Right padding keeps the cards clear of the scrollbar, which WebKitGTK
          draws over the content instead of beside it — it hid the close ✕. */}
      <div className="h-full flex flex-col gap-1.5 overflow-y-auto pr-2.5">
        {tabs.map((t) => {
          const on = t.key === activeKey;
          return (
            <div key={t.key} className={`shrink-0 rounded-md border ${on ? "border-primary" : "border-outline/40"} bg-surface-container-low overflow-hidden`}>
              <button onClick={() => onActivate(t.key)} className="w-full aspect-square block" title={`${t.game.white} – ${t.game.black}`}>
                <MiniBoard
                  game={t.loaded}
                  fen={t.fen ?? undefined}
                  flipped={t.flipped}
                  id={`analysis-mini-${t.key}`}
                  showHeader={false}
                  showNav={false}
                />
              </button>
              <div className="flex items-center gap-1 px-1.5 py-1 border-t border-outline/40">
                <span className={`flex-1 min-w-0 truncate text-label-sm ${on ? "text-on-surface" : "text-on-surface-variant"}`}>
                  {t.game.white.split(",")[0]} – {t.game.black.split(",")[0]}
                </span>
                <button onClick={() => onClose(t.key)} className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 text-body-sm" title="Close">✕</button>
              </div>
            </div>
          );
        })}
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
                        <GameShareMenu
                          pgn={previewGame.pgn}
                          fen={previewGame.fens[previewPly] ?? previewGame.fens[0]}
                          lineSans={previewGame.moves.map((m) => m.san)}
                          startFen={previewGame.fens[0]}
                          gameUrl={previewGame.gameUrl}
                        />
                      )}
                      <button
                        onClick={() => onOpenGame(preview)}
                        className="shrink-0 text-label-md text-primary hover:bg-primary/8 active:bg-primary/12 px-2.5 h-7 rounded-full transition-colors duration-short3 ease-standard"
                        title="Open this game in its own Analysis tab"
                      >
                        Open in Analysis ↗
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
    </div>
  );
}
