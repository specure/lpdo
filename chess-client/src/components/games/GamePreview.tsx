import { useEffect, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { GameSummary } from "../../types";
import { LoadedGame } from "../../lib/useGamePgn";
import GamePreviewHeader from "./GamePreviewHeader";
import GameMoreMenu, { MenuEntry } from "./GameMoreMenu";
import MiniBoard from "./MiniBoard";
import MoveList from "./MoveList";
import { DetailsPanel, DetailsToggleButton } from "../GameBoard";
import { myColorIn } from "../MyStatsWidget";

// A game previewed in place: its header (with Details and the More menu), the
// board and the moves, the board over the moves in a resizable split. One
// component for every preview — the Players/Games page's and the Analysis
// board's related games — so they look and work the same. The host owns which
// game and the move it is at (its list's keys step it); the preview owns the
// rest: a variation's position while one is picked, the board's orientation
// and whether Details is open — the last two remembered for every preview.

/** A remembered on/off setting (localStorage — a per-viewer convenience). */
function useRemembered(key: string): [boolean, (f: (v: boolean) => boolean) => void] {
  const [value, setValue] = useState(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* not remembered */ }
  }, [key, value]);
  return [value, setValue];
}

export default function GamePreview({
  game, loaded, loading, ply, setPly, onReload, openEntries, menuExtras,
  onExportPgn, onExportPdf, onPrint, onClose, notes, boardId, layoutId,
  panelClass, emptyText = "Select a game", boardShare = 55,
}: {
  /** The listed game: the header's players, result and event. */
  game: GameSummary | null;
  /** Its moves and PGN, once loaded. */
  loaded: LoadedGame | null;
  loading: boolean;
  /** The main-line move shown, owned by the host. */
  ply: number;
  setPly: (p: number) => void;
  /** Fetch the game again — Details changed it on the server. */
  onReload: () => void;
  /** First in the More menu: opening the game in Analysis. */
  openEntries?: MenuEntry[];
  /** Last in the More menu: the host's own entries. */
  menuExtras?: MenuEntry[];
  onExportPgn?: () => void;
  onExportPdf?: () => void;
  onPrint?: () => void;
  /** A ✕ that closes the preview, when the host has a place to close it to. */
  onClose?: () => void;
  /** Messages under the header (an export done, a full Analysis board). */
  notes?: ReactNode;
  /** The board's DOM id, unique on the page. */
  boardId: string;
  /** Where the board/moves split is remembered. */
  layoutId: string;
  /** Classes of the two halves (the host's panel look). */
  panelClass: string;
  emptyText?: string;
  /** The board half's default share of the height, in percent, until the
   *  split is dragged (and remembered). */
  boardShare?: number;
}) {
  const [variationFen, setVariationFen] = useState<string | null>(null);
  const [flipped, setFlipped] = useRemembered("previewFlipped");
  // One of the user's own games: the board from their side — flipped by
  // hand after, until the next game. Others' games keep it as left.
  const mine = game ? myColorIn({ ...game, white_id: loaded?.detail?.white_id, black_id: loaded?.detail?.black_id }) : null;
  useEffect(() => {
    if (mine) setFlipped(() => mine === "black");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id, mine]);
  const [detailsOpen, setDetailsOpen] = useRemembered("previewDetailsOpen");
  const split = useDefaultLayout({ id: layoutId, storage: localStorage });

  return (
    <Group orientation="vertical" className="h-full w-full flex" defaultLayout={split.defaultLayout} onLayoutChanged={split.onLayoutChanged}>
      <Panel defaultSize={String(boardShare)} minSize="20">
        <div className={panelClass}>
          {game && (
            <div className="shrink-0 px-2 py-1 border-b border-outline/40 flex items-center gap-2">
              <GamePreviewHeader game={game} />
              {loaded?.detail && <DetailsToggleButton detail={loaded.detail} open={detailsOpen} onToggle={() => setDetailsOpen((o) => !o)} />}
              {loaded && (
                <GameMoreMenu
                  pgn={loaded.pgn}
                  fen={loaded.fens[ply] ?? loaded.fens[0]}
                  lineSans={loaded.moves.map((m) => m.san)}
                  ply={ply}
                  startFen={loaded.fens[0]}
                  gameUrl={loaded.gameUrl}
                  leading={openEntries}
                  extras={menuExtras}
                  onExportPgn={onExportPgn}
                  onExportPdf={onExportPdf}
                  onPrint={onPrint}
                />
              )}
              {onClose && (
                <button
                  onClick={onClose}
                  className="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 text-body-sm"
                  title="Close the preview"
                >✕</button>
              )}
            </div>
          )}
          {game && detailsOpen && loaded?.detail && (
            <DetailsPanel
              detail={loaded.detail}
              onClose={() => setDetailsOpen(() => false)}
              onDetailChanged={onReload}
              maxHeight="max-h-[45%]"
            />
          )}
          {notes}
          {loaded ? (
            // The header above already names the players and the result, so
            // the board's own line would repeat it.
            <MiniBoard
              game={loaded} ply={ply} setPly={setPly} fen={variationFen ?? undefined} id={boardId}
              showHeader={!game} flipped={flipped} onFlip={() => setFlipped((f) => !f)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-center text-on-surface-variant text-body-sm px-3">
              {loading ? "Loading…" : emptyText}
            </div>
          )}
        </div>
      </Panel>
      <Separator className="h-1.5 bg-transparent hover:bg-primary/30 data-[resize-handle-state=drag]:bg-primary/50 transition-colors" />
      <Panel defaultSize={String(100 - boardShare)} minSize="12">
        <div className={panelClass}>
          {loaded ? (
            <MoveList game={loaded} ply={ply} setPly={setPly} onShowFen={setVariationFen} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-sm px-3">—</div>
          )}
        </div>
      </Panel>
    </Group>
  );
}
