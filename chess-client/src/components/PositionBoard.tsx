import { useMemo, useLayoutEffect, useRef, useState } from "react";
import { Chessboard, Arrow } from "react-chessboard";
import { Chess } from "chess.js";
import { GameSummary, MoveStats } from "../types";

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

function formatMoveSequence(moves: string[]): string {
  return moves
    .map((mv, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}.${mv}` : mv))
    .join(" ");
}

interface Props {
  moveSequence: string[];
  onBack: () => void;
  onReset: () => void;
  relatedGame?: GameSummary | null;
  onSwitchToGame?: () => void;
  moveStats?: MoveStats[];
  selectedMoveSan?: string | null;
  /** Show the "→ White vs Black [Tab]" related-game line under the header.
   *  Off on the Games page, where a dedicated game list + mini board replace it. */
  showRelatedGame?: boolean;
}

export default function PositionBoard({ moveSequence, onBack, onReset, relatedGame, onSwitchToGame, moveStats, selectedMoveSan, showRelatedGame = true }: Props) {
  const [flipped, setFlipped] = useState(false);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [squareSize, setSquareSize] = useState(480);

  useLayoutEffect(() => {
    const el = boardContainerRef.current;
    if (!el) return;
    function measure() {
      const rect = el!.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        setSquareSize(Math.floor(Math.min(rect.width, rect.height)) - 16);
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
  const hasSequence = moveSequence.length > 0;

  const arrows = useMemo((): Arrow[] => {
    if (!moveStats?.length) return [];
    const chess = new Chess();
    try { chess.load(fen); } catch { return []; }
    const verboseMoves = chess.moves({ verbose: true });
    const others: Arrow[] = [];
    let selected: Arrow | null = null;
    for (const stat of moveStats) {
      const match = verboseMoves.find((m) => m.san === stat.mv);
      if (!match) continue;
      if (stat.mv === selectedMoveSan) {
        selected = { startSquare: match.from, endSquare: match.to, color: "rgba(255, 170, 0, 0.9)" };
      } else {
        others.push({ startSquare: match.from, endSquare: match.to, color: "rgba(255, 170, 0, 0.3)" });
      }
    }
    return selected ? [...others, selected] : others;
  }, [fen, moveStats, selectedMoveSan]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden p-3 gap-3 bg-surface">
      {/* Position header */}
      <div className="shrink-0 space-y-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`font-mono text-body-md flex-1 truncate min-w-0 ${hasSequence ? "text-on-surface" : "text-on-surface-variant"}`}>
            {hasSequence ? formatMoveSequence(moveSequence) : "Starting position"}
          </span>
          {/* Standard icon buttons — circular with state-layer overlay */}
          <button
            onClick={onBack}
            disabled={!hasSequence}
            className={`shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard ${!hasSequence ? "invisible" : ""}`}
            title="Undo last move"
          >←</button>
          <button
            onClick={onReset}
            disabled={!hasSequence}
            className={`shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard ${!hasSequence ? "invisible" : ""}`}
            title="Reset to starting position"
          >✕</button>
          <button
            onClick={() => setFlipped((f) => !f)}
            className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
            title="Flip board"
          >
            <IconFlip />
          </button>
        </div>
        {showRelatedGame && <div className="h-4 flex items-center">
          {displayedGame && (
            <button
              onClick={onSwitchToGame}
              className="text-body-sm text-on-surface-variant hover:text-on-surface transition-colors duration-short3 ease-standard flex items-center gap-1 w-fit"
            >
              →{" "}
              <span>
                {displayedGame.white} <span className="text-outline">vs</span> {displayedGame.black}
              </span>
              {displayedGame.result && (
                <span className="ml-1">
                  {displayedGame.result === "1/2-1/2" ? "½-½" : displayedGame.result}
                </span>
              )}
              {displayedGame.date && (
                <span className="text-outline">{displayedGame.date.slice(0, 4)}</span>
              )}
              <span className="ml-1 text-outline">[Tab]</span>
            </button>
          )}
        </div>}
      </div>

      {/* Board */}
      <div
        ref={boardContainerRef}
        className="flex-1 min-h-0 min-w-0 overflow-hidden flex items-center justify-center"
      >
        <div style={{ width: squareSize, height: squareSize, flexShrink: 0 }}>
          <Chessboard
            options={{
              position: fen,
              boardOrientation: flipped ? "black" : "white",
              allowDragging: false,
              arrows,
              clearArrowsOnPositionChange: false,
              allowDrawingArrows: false,
              darkSquareStyle: { backgroundColor: "var(--color-board-position-dark)" },
              lightSquareStyle: { backgroundColor: "var(--color-board-position-light)" },
              boardStyle: { alignContent: "start" },
            }}
          />
        </div>
      </div>
    </div>
  );
}
