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

interface Props {
  /** The active line up to the cursor — drives the board position + arrows. */
  moveSequence: string[];
  onBack: () => void;
  /** Rewind to the starting position (the ⏮ button). */
  onReset: () => void;
  /** Step forward along `fullLine` (the › button). Omit to hide it. */
  onForward?: () => void;
  /** Jump to the end of `fullLine` (the ⏭ button). Omit to hide it. */
  onEnd?: () => void;
  /** Click a move in the list → set the cursor to that ply. Omit → not clickable. */
  onJumpTo?: (ply: number) => void;
  /** Full explored line incl. moves ahead of the cursor; defaults to moveSequence. */
  fullLine?: string[];
  relatedGame?: GameSummary | null;
  onSwitchToGame?: () => void;
  moveStats?: MoveStats[];
  selectedMoveSan?: string | null;
  /** Show the "→ White vs Black [Tab]" related-game line. Off on the Games page,
   *  where a dedicated game list + mini board replace it. */
  showRelatedGame?: boolean;
}

export default function PositionBoard({
  moveSequence, onBack, onReset, onForward, onEnd, onJumpTo, fullLine,
  relatedGame, onSwitchToGame, moveStats, selectedMoveSan, showRelatedGame = true,
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
  const hasSequence = moveSequence.length > 0;

  // Move list: the full explored line, with a cursor at the active ply. Moves
  // before the cursor are played; moves at/after it are "ahead" (dimmed).
  const list = fullLine ?? moveSequence;
  const cursor = moveSequence.length;
  const canForward = cursor < list.length;
  const rows = useMemo(() => {
    const out: { no: number; w?: { san: string; i: number }; b?: { san: string; i: number } }[] = [];
    list.forEach((san, i) => {
      const no = Math.floor(i / 2) + 1;
      if (i % 2 === 0) out.push({ no, w: { san, i } });
      else {
        const last = out[out.length - 1];
        if (last && last.no === no && !last.b) last.b = { san, i };
        else out.push({ no, b: { san, i } });
      }
    });
    return out;
  }, [list]);

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

  const navBtn = "shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-on-surface-variant text-body-md hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-30 disabled:hover:bg-transparent transition-colors duration-short3 ease-standard";
  const moveCls = (i: number) =>
    `px-1 rounded-sm font-mono ${onJumpTo ? "cursor-pointer" : ""} ${
      i === cursor - 1
        ? "bg-secondary-container text-on-secondary-container"
        : i >= cursor
        ? "text-on-surface-variant/50 hover:bg-on-surface/8"
        : "text-on-surface hover:bg-on-surface/8"
    }`;
  const moveClick = (i: number) => (onJumpTo ? () => onJumpTo(i + 1) : undefined);

  return (
    <div className="flex flex-1 overflow-hidden p-2 gap-2 bg-surface min-h-0 min-w-0">
      {/* Board (left) — scales to fit the panel */}
      <div ref={boardContainerRef} className="flex-1 min-h-0 min-w-0 overflow-hidden flex items-center justify-center">
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

      {/* Controls (right) — nav arrows, optional related game, scrollable move list */}
      <div className="w-40 shrink-0 flex flex-col min-h-0 gap-1.5">
        <div className="flex items-center gap-0.5 shrink-0">
          <button className={navBtn} onClick={onReset} disabled={!hasSequence} title="Rewind to start">⏮</button>
          <button className={navBtn} onClick={onBack} disabled={!hasSequence} title="Back">‹</button>
          {onForward && <button className={navBtn} onClick={onForward} disabled={!canForward} title="Forward">›</button>}
          {onEnd && <button className={navBtn} onClick={onEnd} disabled={!canForward} title="To end">⏭</button>}
          <button className={`${navBtn} ml-auto`} onClick={() => setFlipped((f) => !f)} title="Flip board"><IconFlip /></button>
        </div>

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

        <div className="flex-1 min-h-0 overflow-y-auto text-body-sm leading-6">
          {rows.length === 0 ? (
            <span className="text-on-surface-variant">Starting position</span>
          ) : (
            rows.map((r) => (
              <span key={r.no} className="mr-1 whitespace-nowrap">
                <span className="text-on-surface-variant select-none">{r.no}.</span>{" "}
                {r.w && <span className={moveCls(r.w.i)} onClick={moveClick(r.w.i)}>{r.w.san}</span>}
                {r.b && <> <span className={moveCls(r.b.i)} onClick={moveClick(r.b.i)}>{r.b.san}</span></>}
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
