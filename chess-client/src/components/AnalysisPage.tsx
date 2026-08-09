import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { GameSummary, MoveStats } from "../types";
import { LoadedGame } from "../lib/useGamePgn";
import MiniBoard from "./games/MiniBoard";
import GameBoard from "./GameBoard";

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
  /** Persist per-tab view state (position, orientation) in the owning store. */
  onTabState: (key: string, patch: { fen?: string; flipped?: boolean }) => void;
  onGameMutated?: () => void;
}

const panel = "bg-surface-container-low border border-outline/40 rounded-md overflow-hidden flex flex-col min-h-0 min-w-0 h-full w-full";
const vHandle = "w-1.5 bg-transparent hover:bg-primary/30 data-[resize-handle-state=drag]:bg-primary/50 transition-colors";
const hHandle = "h-1.5 bg-transparent hover:bg-primary/30 data-[resize-handle-state=drag]:bg-primary/50 transition-colors";
const STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

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
  const handlePositionChange = useCallback((fen: string, gameId: number) => {
    const tab = tabsRef.current.find((t) => t.game.id === gameId);
    if (tab) onTabState(tab.key, { fen });
  }, [onTabState]);
  const handleFlippedChange = useCallback((flipped: boolean) => {
    if (activeKey) onTabState(activeKey, { flipped });
  }, [activeKey, onTabState]);

  const [refMoves, setRefMoves] = useState<MoveStats[]>([]);
  const [refLoading, setRefLoading] = useState(false);
  const refAbort = useRef<AbortController | null>(null);
  const [related, setRelated] = useState<GameSummary[]>([]);
  const relAbort = useRef<AbortController | null>(null);

  // C — reference-DB moves from the current position (Zobrist / transposition-aware).
  useEffect(() => {
    if (!active) { setRefMoves([]); return; }
    refAbort.current?.abort();
    refAbort.current = new AbortController();
    setRefLoading(true);
    fetch(`/api/position/moves?fen=${encodeURIComponent(effFen)}`, { signal: refAbort.current.signal })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<MoveStats[]>; })
      .then((d) => { setRefMoves(d); setRefLoading(false); })
      .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) { setRefMoves([]); setRefLoading(false); } });
  }, [active?.key, effFen]);

  // E — related games that reached this position (skip the start position).
  useEffect(() => {
    if (!active || atStart) { setRelated([]); return; }
    relAbort.current?.abort();
    relAbort.current = new AbortController();
    fetch(`/api/games?fen=${encodeURIComponent(effFen)}&limit=50`, { signal: relAbort.current.signal })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<GameSummary[]>; })
      .then((d) => setRelated(d))
      .catch(() => {});
  }, [active?.key, effFen, atStart]);

  if (tabs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md px-6 text-center">
        Open a game from the Games or Players page ("Open in Analysis") to start analysing.
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden p-1.5 gap-1.5">
      {/* A — open-game tabs (mini-board previews) */}
      <div className="w-32 shrink-0 flex flex-col gap-1.5 overflow-y-auto">
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

      {/* Active game (editable board + comments + notation) | C over E */}
      <PanelGroup direction="horizontal" autoSaveId="analysis-main" className="flex-1 min-w-0">
        <Panel defaultSize={64} minSize={35}>
          <div className={panel}>
            {active && (
              <GameBoard
                game={active.game}
                onPositionChange={handlePositionChange}
                flipped={active.flipped}
                onFlippedChange={handleFlippedChange}
                onGameMutated={onGameMutated}
              />
            )}
          </div>
        </Panel>

        <PanelResizeHandle className={vHandle} />

        <Panel defaultSize={36} minSize={22}>
          <PanelGroup direction="vertical" autoSaveId="analysis-ce" className="h-full w-full">
            {/* C — reference-DB moves from this position */}
            <Panel defaultSize={50} minSize={20}>
              <div className={panel}>
                <div className="px-3 py-2 shrink-0 text-label-md text-on-surface-variant uppercase tracking-wider border-b border-outline/40">Reference moves</div>
                {refLoading ? (
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
                    </div>
                    {refMoves.map((s) => (
                      <div key={s.mv} className="w-full flex items-center text-body-sm px-2 py-1 rounded-sm text-on-surface">
                        <span className="w-24 font-mono truncate text-left">{movePrefix}{s.mv}</span>
                        <span className="w-20 text-right">{s.games.toLocaleString()}</span>
                        <span className="w-10 text-right text-success">{Math.round(s.w_pct)}</span>
                        <span className="w-10 text-right text-on-surface-variant">{Math.round(s.d_pct)}</span>
                        <span className="w-10 text-right text-error">{Math.round(s.l_pct)}</span>
                        <span className="w-16 text-right text-on-surface-variant">{s.last_played?.slice(0, 4) ?? "—"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Panel>

            <PanelResizeHandle className={hHandle} />

            {/* E — related games from the reference DB */}
            <Panel defaultSize={50} minSize={20}>
              <div className={panel}>
                <div className="px-3 py-2 shrink-0 text-label-md text-on-surface-variant uppercase tracking-wider border-b border-outline/40">
                  Related games{related.length ? ` · ${related.length}${related.length >= 50 ? "+" : ""}` : ""}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {atStart ? (
                    <div className="p-3 text-center text-on-surface-variant text-body-sm">Play a move to see games reaching this position</div>
                  ) : related.length === 0 ? (
                    <div className="p-3 text-center text-on-surface-variant text-body-sm">No related games</div>
                  ) : (
                    related.map((g) => (
                      <button
                        key={g.id}
                        onClick={() => onOpenGame(g)}
                        className="w-full flex items-baseline gap-2 px-3 py-1.5 text-body-sm text-left whitespace-nowrap text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
                        title="Open in a new tab"
                      >
                        <span className="min-w-0 flex-1 truncate">{g.white} – {g.black}</span>
                        <span className="shrink-0 tabular-nums">{g.result ? (g.result === "1/2-1/2" ? "½-½" : g.result) : ""}</span>
                        <span className="shrink-0 text-on-surface-variant">{g.date?.slice(0, 4) ?? ""}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  );
}
