import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { GameSummary, MoveStats } from "../types";
import { LoadedGame } from "../lib/useGamePgn";
import MiniBoard from "./games/MiniBoard";
import MoveList from "./games/MoveList";

// The Analysis board (#220): the editable, multi-game workbench. Several games
// open at once as mini-board tabs (A); the active one drives the main board (B),
// reference-DB moves for the current position (C), the notation (D) and related
// games from the DB (E). Phase 1 is read-only navigation + multi-game switching;
// editing (scratch) + persistence + save/export come in later phases.

export interface AnalysisTab {
  key: string;          // stable per open game (dedupe by game id)
  game: GameSummary;
  loaded: LoadedGame;   // parsed moves + fens
  ply: number;          // current position within this game
}

interface Props {
  tabs: AnalysisTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onSetPly: (key: string, ply: number) => void;
  onOpenGame: (game: GameSummary) => void;   // open a related game as a new tab
}

const panel = "bg-surface-container-low border border-outline/40 rounded-md overflow-hidden flex flex-col min-h-0 min-w-0 h-full w-full";
const vHandle = "w-1.5 bg-transparent hover:bg-primary/30 data-[resize-handle-state=drag]:bg-primary/50 transition-colors";
const hHandle = "h-1.5 bg-transparent hover:bg-primary/30 data-[resize-handle-state=drag]:bg-primary/50 transition-colors";

export default function AnalysisPage({ tabs, activeKey, onActivate, onClose, onSetPly, onOpenGame }: Props) {
  const active = tabs.find((t) => t.key === activeKey) ?? null;

  // Current position of the active game → drives C (ref moves) and E (related games).
  const firstMoves = active ? active.loaded.moves.slice(0, active.ply).map((m) => m.san).join(" ") : "";
  const fen = active ? active.loaded.fens[Math.min(active.ply, active.loaded.fens.length - 1)] : "";

  const [refMoves, setRefMoves] = useState<MoveStats[]>([]);
  const [refLoading, setRefLoading] = useState(false);
  const refAbort = useRef<AbortController | null>(null);
  const [related, setRelated] = useState<GameSummary[]>([]);
  const relAbort = useRef<AbortController | null>(null);

  // C — reference-DB moves from the current position (transposition-aware server-side).
  useEffect(() => {
    if (!active) { setRefMoves([]); return; }
    refAbort.current?.abort();
    refAbort.current = new AbortController();
    setRefLoading(true);
    const params = new URLSearchParams();
    if (firstMoves) params.set("first_moves", firstMoves);
    fetch(`/api/position/moves?${params}`, { signal: refAbort.current.signal })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<MoveStats[]>; })
      .then((d) => { setRefMoves(d); setRefLoading(false); })
      .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) { setRefMoves([]); setRefLoading(false); } });
  }, [active?.key, firstMoves]);

  // E — related games that reached this position (by Zobrist of the FEN).
  useEffect(() => {
    if (!active || active.ply === 0) { setRelated([]); return; }
    relAbort.current?.abort();
    relAbort.current = new AbortController();
    const params = new URLSearchParams({ fen, limit: "50" });
    fetch(`/api/games?${params}`, { signal: relAbort.current.signal })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<GameSummary[]>; })
      .then((d) => setRelated(d))
      .catch(() => {});
  }, [active?.key, fen, active?.ply]);

  const moveNo = active ? Math.floor(active.ply / 2) + 1 : 1;
  const movePrefix = active && active.ply % 2 === 0 ? `${moveNo}.` : `${moveNo}...`;

  if (tabs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md px-6 text-center">
        Open a game from the Games or Players page ("Open in Analysis") to start analysing.
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden p-1.5">
      <PanelGroup direction="horizontal" autoSaveId="analysis-cols" className="h-full w-full">
        {/* A — open-game tabs (mini-board previews) */}
        <Panel defaultSize={15} minSize={8}>
          <div className="h-full flex flex-col gap-1.5 overflow-y-auto pr-1">
            {tabs.map((t) => {
              const on = t.key === activeKey;
              return (
                <div key={t.key} className={`shrink-0 rounded-md border ${on ? "border-primary" : "border-outline/40"} bg-surface-container-low overflow-hidden`}>
                  <button onClick={() => onActivate(t.key)} className="w-full aspect-square block" title={`${t.game.white} – ${t.game.black}`}>
                    <MiniBoard game={t.loaded} ply={t.ply} setPly={() => {}} id={`analysis-mini-${t.key}`} showHeader={false} showNav={false} />
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

        <PanelResizeHandle className={vHandle} />

        {/* B/D left column and C/E right column — independent vertical splits */}
        <Panel defaultSize={85} minSize={40}>
          <PanelGroup direction="horizontal" autoSaveId="analysis-main" className="h-full w-full">
            {/* Left: B (board) over D (notation) */}
            <Panel defaultSize={58} minSize={30}>
              <PanelGroup direction="vertical" autoSaveId="analysis-bd" className="h-full w-full">
                {/* B — main board */}
                <Panel defaultSize={62} minSize={25}>
                  <div className={panel}>
                    {active && <MiniBoard game={active.loaded} ply={active.ply} setPly={(p) => onSetPly(active.key, p)} id="analysis-main-board" />}
                  </div>
                </Panel>
                <PanelResizeHandle className={hHandle} />
                {/* D — notation */}
                <Panel defaultSize={38} minSize={15}>
                  <div className={panel}>
                    <div className="px-3 py-2 shrink-0 text-label-md text-on-surface-variant uppercase tracking-wider border-b border-outline/40">Notation</div>
                    {active && <MoveList game={active.loaded} ply={active.ply} setPly={(p) => onSetPly(active.key, p)} />}
                  </div>
                </Panel>
              </PanelGroup>
            </Panel>

            <PanelResizeHandle className={vHandle} />

            {/* Right: C (reference moves) over E (related games), ~50:50 */}
            <Panel defaultSize={42} minSize={22}>
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
                      {active && active.ply === 0 ? (
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
        </Panel>
      </PanelGroup>
    </div>
  );
}
