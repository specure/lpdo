// The drill's board: one's own moves by click (the piece, then its square)
// or by dragging; nothing asked of a server, so the phone can use it as it
// is. The last move is marked; a hint shows as an arrow, as do the moves a
// review shows, and the book's arrows and circles.

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import BoardErrorBoundary from "../components/BoardErrorBoundary";

interface Props {
  fen: string;
  orientation: "white" | "black";
  /** Moves are taken (one's own move to make). */
  active: boolean;
  /** A move played on the board, in UCI ("e2e4", "e7e8q"); false to take it
   *  back. A promotion takes the piece in `promotions` for that move, else a
   *  queen. */
  onMove: (uci: string) => boolean;
  /** The promotions the drill expects, by "from+to" (e.g. "e7e8" → "n"). */
  promotions?: Record<string, string>;
  lastMove?: { from: string; to: string } | null;
  hint?: { from: string; to: string } | null;
  /** More arrows: from, to, colour. */
  arrows?: { from: string; to: string; color: string }[];
  /** Squares ringed (the book's circles). */
  circles?: { square: string; color: string }[];
  id?: string;
}

const MIN = 200;

/** The book's move: a hint, and the line's move in a review. */
export const HINT_COLOR = "rgba(56, 142, 60, 0.85)";
/** The chapter's other moves in a review. */
export const BRANCH_COLOR = "rgba(30, 136, 229, 0.75)";

export default function DrillBoard({ fen, orientation, active, onMove, promotions, lastMove, hint, arrows = [], circles = [], id = "drill-board" }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(320);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize(Math.max(MIN, Math.floor(Math.min(r.width, r.height)) - 4));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [selected, setSelected] = useState<string | null>(null);
  const [shownFen, setShownFen] = useState(fen);
  if (shownFen !== fen) { setShownFen(fen); setSelected(null); }

  const legalFrom = (sq: string) => {
    try { return new Chess(fen).moves({ square: sq as never, verbose: true }).map((m) => m.to as string); } catch { return []; }
  };
  const play = (from: string, to: string): boolean => {
    let board: Chess;
    try { board = new Chess(fen); } catch { return false; }
    const legal = board.moves({ verbose: true }).filter((m) => m.from === from && m.to === to);
    if (!legal.length) return false;
    const promo = legal[0].promotion ? (promotions?.[from + to] ?? "q") : "";
    setSelected(null);
    return onMove(from + to + promo);
  };
  const click = (sq: string) => {
    if (!active) return;
    if (selected && selected !== sq && legalFrom(selected).includes(sq)) { play(selected, sq); return; }
    const piece = (() => { try { return new Chess(fen).get(sq as never); } catch { return undefined; } })();
    const turn = fen.split(" ")[1];
    setSelected(piece && piece.color === turn ? sq : null);
  };

  const styles: Record<string, CSSProperties> = {};
  const mark = "rgba(255, 213, 79, 0.45)";
  if (lastMove) { styles[lastMove.from] = { background: mark }; styles[lastMove.to] = { background: mark }; }
  for (const c of circles) styles[c.square] = { ...styles[c.square], boxShadow: `inset 0 0 0 4px ${c.color}`, borderRadius: "50%" };
  if (selected) {
    styles[selected] = { background: "rgba(56, 142, 60, 0.45)" };
    for (const to of legalFrom(selected)) {
      styles[to] = { ...styles[to], backgroundImage: "radial-gradient(circle, rgba(56,142,60,0.55) 22%, transparent 24%)" };
    }
  }

  return (
    <div ref={box} data-fen={fen} className="flex-1 min-h-0 min-w-0 w-full flex items-center justify-center overflow-hidden">
      <div style={{ width: size, height: size, flexShrink: 0 }}>
        <BoardErrorBoundary>
          <Chessboard
            options={{
              id,
              position: fen,
              boardOrientation: orientation,
              allowDragging: active,
              allowDrawingArrows: false,
              clearArrowsOnPositionChange: false,
              arrows: [
                ...arrows.map((a) => ({ startSquare: a.from, endSquare: a.to, color: a.color })),
                ...(hint ? [{ startSquare: hint.from, endSquare: hint.to, color: HINT_COLOR }] : []),
              ],
              squareStyles: styles,
              onPieceDrop: ({ sourceSquare, targetSquare }) => !!sourceSquare && !!targetSquare && play(sourceSquare, targetSquare),
              onSquareClick: ({ square }) => click(square),
              // The game board's fixed colours: the position board's light square
              // follows the theme, which the phone sets on the page's root.
              darkSquareStyle: { backgroundColor: "var(--color-board-game-dark)" },
              lightSquareStyle: { backgroundColor: "var(--color-board-game-light)" },
            }}
          />
        </BoardErrorBoundary>
      </div>
    </div>
  );
}
