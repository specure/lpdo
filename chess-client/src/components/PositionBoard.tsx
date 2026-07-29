import { useMemo, useLayoutEffect, useRef, useState } from "react";
import { Chessboard, Arrow } from "react-chessboard";
import { Chess } from "chess.js";
import { GameSummary, MoveStats } from "../types";
import PositionMoves from "./PositionMoves";

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
}

export default function PositionBoard({
  moveSequence, onBack, onReset, onForward, onEnd, onJumpTo, fullLine,
  relatedGame, onSwitchToGame, moveStats, selectedMoveSan, showRelatedGame = true, showMoves = true,
}: Props) {
  const [flipped, setFlipped] = useState(false);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [squareSize, setSquareSize] = useState(480);

  useLayoutEffect(() => {
    const el = boardContainerRef.current;
    if (!el) return;
    function measure() {
      const rect = el!.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        setSquareSize(Math.floor(Math.min(rect.width, rect.height)) - 4);
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
    <div className="flex flex-1 overflow-hidden p-2 gap-2 bg-surface min-h-0 min-w-0">
      {/* Board (scales to fit) with a flip button overlaid top-right. */}
      <div ref={boardContainerRef} className="flex-1 min-h-0 min-w-0 overflow-hidden relative flex items-center justify-center">
        <button
          onClick={() => setFlipped((f) => !f)}
          className="absolute top-0 right-0 z-10 w-7 h-7 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
          title="Flip board"
        >
          <IconFlip />
        </button>
        <div style={{ width: squareSize, height: squareSize, flexShrink: 0 }}>
          <Chessboard
            options={{
              id: "position-board", // unique id — see MiniBoard note (shared default id collides)
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
