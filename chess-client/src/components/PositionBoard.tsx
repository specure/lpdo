import { useMemo, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Chessboard, Arrow } from "react-chessboard";
import { fitBoard } from "../lib/boardSize";
import BoardErrorBoundary from "./BoardErrorBoundary";
import { Chess } from "chess.js";
import { GameSummary, MoveStats } from "../types";
import PositionMoves from "./PositionMoves";
import { useClickToMove, oneClickPointer } from "./useClickToMove";
import { ArrowToggles, HintArrowsOverlay, dbArrows, engineArrows, type CombinedMove, type useArrowToggles } from "./HintArrows";

const IconFlip = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 2l3 3H5l3-3zM8 14l-3-3h6l-3 3z" />
    <rect x="7" y="4" width="2" height="8" />
  </svg>
);

function fenFromMoves(moves: string[]): string {
  const chess = new Chess();
  for (const mv of moves) {
    try { chess.move(mv); } catch { break; }
  }
  return chess.fen();
}

interface Props {
  moveSequence: string[];
  onBack: () => void;
  onReset: () => void;
  onForward?: () => void;
  onEnd?: () => void;
  onJumpTo?: (ply: number) => void;
  fullLine?: string[];
  relatedGame?: GameSummary | null;
  onSwitchToGame?: () => void;
  moveStats?: MoveStats[];
  selectedMoveSan?: string | null;
  showRelatedGame?: boolean;
  /** Render the nav + move list beside the board (Players). Off on the Games page,
   *  which shows them in a dedicated B1 panel. */
  showMoves?: boolean;
  /** Moves played on the board (SAN): dragged, two clicks, or one click on
   *  the destination — as on the Analysis board. Without it the board only
   *  shows the position. */
  onMove?: (san: string) => void;
  /** The engines' moves for this position (the Engine panel beside it), for
   *  their arrows. */
  engineMoves?: CombinedMove[];
  /** Which arrows show, with their checkboxes on the board. Without it, the
   *  database's arrows only (the Players page). */
  arrowToggles?: ReturnType<typeof useArrowToggles>;
}

export default function PositionBoard({
  moveSequence, onBack, onReset, onForward, onEnd, onJumpTo, fullLine,
  relatedGame, onSwitchToGame, moveStats, selectedMoveSan, showRelatedGame = true, showMoves = true, onMove, engineMoves = [], arrowToggles,
}: Props) {
  const [flipped, setFlipped] = useState(false);
  const [copiedFen, setCopiedFen] = useState(false);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [squareSize, setSquareSize] = useState(480);

  useLayoutEffect(() => {
    const el = boardContainerRef.current;
    if (!el) return;
    function measure() {
      const rect = el!.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        setSquareSize(fitBoard(rect, 4));
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stableRelatedGameRef = useRef(relatedGame);
  if (relatedGame) stableRelatedGameRef.current = relatedGame;
  const displayedGame = stableRelatedGameRef.current;

  const fen = useMemo(() => fenFromMoves(moveSequence), [moveSequence]);

  // Playing moves on the board (with onMove): the Analysis board's
  // click-to-move (useClickToMove). A pawn reaching the last rank becomes a
  // queen — this board explores openings, where under-promotions are rare.
  const tryMove = (from: string, to: string): boolean => {
    if (!onMove) return false;
    try {
      const c = new Chess(fen);
      const m = c.move({ from, to, promotion: "q" });
      if (!m) return false;
      // SAN as chess.js writes it — with "+", as the database's moves are.
      onMove(m.san);
      return true;
    } catch { return false; }
  };
  const ctm = useClickToMove({ active: !!onMove, fen, blocked: false, tryMove, resetKey: [fen] });
  const pressedRef = useRef(false);
  const oneClick = oneClickPointer(ctm, flipped, pressedRef);
  const clickStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};
    if (!ctm.selectedSquare) return styles;
    styles[ctm.selectedSquare] = { background: "rgba(255, 215, 0, 0.45)" };
    let board: Chess | null = null;
    try { board = new Chess(fen); } catch { board = null; }
    for (const sq of ctm.legalDestinations) {
      styles[sq] = board?.get(sq as never)
        ? { boxShadow: "inset 0 0 0 4px rgba(0,0,0,0.45)" }
        : { background: "radial-gradient(circle, rgba(0,0,0,0.35) 18%, transparent 22%)" };
    }
    return styles;
  }, [ctm.selectedSquare, ctm.legalDestinations, fen]);

  // The database's three most played moves, the engines' strong moves and
  // (see HintArrows), as the checkboxes have them.
  const on = arrowToggles?.on ?? { db: true, engine: false };
  const hints = useMemo(() => [
    ...(on.db ? dbArrows(fen, moveStats ?? [], selectedMoveSan) : []),
    ...(on.engine ? engineArrows(engineMoves) : []),
  ], [on.db, on.engine, fen, moveStats, selectedMoveSan, engineMoves]);

  // The one-click preview.
  const shownArrows: Arrow[] = ctm.previewMove
    ? [{ startSquare: ctm.previewMove.from, endSquare: ctm.previewMove.to, color: "rgba(56, 142, 60, 0.85)" }]
    : [];

  return (
    <div className="flex flex-1 overflow-hidden p-2 gap-2 bg-surface min-h-0 min-w-0">
      {/* A row above the board — the arrows' checkboxes on the left, flip and
          FEN on the right — then the board, scaled to fit what is left. */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div className="shrink-0 pb-1 flex items-center justify-between gap-2">
        <span>{arrowToggles && <ArrowToggles {...arrowToggles} />}</span>
        <span className="inline-flex items-center gap-1">
          <button
            onClick={() => { navigator.clipboard?.writeText(fen).then(() => { setCopiedFen(true); window.setTimeout(() => setCopiedFen(false), 1200); }).catch(() => {}); }}
            className="h-7 px-1.5 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 text-label-sm transition-colors duration-short3 ease-standard"
            title="Copy FEN of the current position to the clipboard"
          >
            {copiedFen ? "Copied" : "FEN"}
          </button>
          <button
            onClick={() => setFlipped((f) => !f)}
            className="w-7 h-7 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
            title="Flip board"
          >
            <IconFlip />
          </button>
        </span>
      </div>
      <div ref={boardContainerRef} className="flex-1 min-h-0 min-w-0 overflow-hidden relative flex items-center justify-center">
        <div
          style={{ width: squareSize, height: squareSize, flexShrink: 0, position: "relative" }}
          onPointerDown={onMove ? oneClick.onPointerDown : undefined}
          onPointerMove={onMove ? oneClick.onPointerMove : undefined}
          onPointerUp={onMove ? oneClick.onPointerUp : undefined}
          onPointerCancel={onMove ? oneClick.onPointerCancel : undefined}
        >
          <BoardErrorBoundary>
          <HintArrowsOverlay arrows={hints} flipped={flipped} size={squareSize} />
          <Chessboard
            options={{
              id: "position-board", // unique id — see MiniBoard note (shared default id collides)
              position: fen,
              boardOrientation: flipped ? "black" : "white",
              allowDragging: !!onMove,
              arrows: shownArrows,
              squareStyles: clickStyles,
              onPieceDrop: ({ sourceSquare, targetSquare }) => !!sourceSquare && !!targetSquare && tryMove(sourceSquare, targetSquare),
              onSquareClick: ({ square }) => ctm.clickSquare(square),
              clearArrowsOnPositionChange: false,
              allowDrawingArrows: false,
              darkSquareStyle: { backgroundColor: "var(--color-board-position-dark)" },
              lightSquareStyle: { backgroundColor: "var(--color-board-position-light)" },
              boardStyle: { alignContent: "start" },
            }}
          />
          </BoardErrorBoundary>
        </div>
      </div>
      </div>

      {showMoves && (
        <div className="w-40 shrink-0 flex flex-col min-h-0 gap-1.5">
          {showRelatedGame && displayedGame && (
            <button
              onClick={onSwitchToGame}
              className="shrink-0 text-body-sm text-on-surface-variant hover:text-on-surface transition-colors duration-short3 ease-standard text-left truncate"
              title={`${displayedGame.white} vs ${displayedGame.black}`}
            >
              → {displayedGame.white} <span className="text-outline">vs</span> {displayedGame.black}
              {displayedGame.result && <span className="ml-1">{displayedGame.result === "1/2-1/2" ? "½-½" : displayedGame.result}</span>}
              <span className="ml-1 text-outline">[Tab]</span>
            </button>
          )}
          <div className="flex-1 min-h-0">
            <PositionMoves
              moveSequence={moveSequence}
              fullLine={fullLine}
              onBack={onBack}
              onReset={onReset}
              onForward={onForward}
              onEnd={onEnd}
              onJumpTo={onJumpTo}
            />
          </div>
        </div>
      )}
    </div>
  );
}
