import { useLayoutEffect, useRef, useState } from "react";
import { Chessboard } from "react-chessboard";
import { LoadedGame } from "../../lib/useGamePgn";

// Small read-only board (area E of the Games page, #219) showing the selected
// game at the current ply. Nav sits below the board in the unified order shared
// with the position board: ⏮ ‹ › ⏭. Shares the lifted `ply` with the move list (F).
export default function MiniBoard({
  game,
  ply,
  setPly,
}: {
  game: LoadedGame;
  ply: number;
  setPly: (p: number) => void;
}) {
  const last = game.fens.length - 1;
  const at = Math.min(Math.max(ply, 0), last);
  const fen = game.fens[at];

  // react-chessboard needs an explicit pixel size to compute move animations
  // correctly — a fluid aspect-ratio container makes it overshoot. Measure the
  // available box and hand the board a fixed square size (as the position board does).
  const boardBoxRef = useRef<HTMLDivElement>(null);
  const [squareSize, setSquareSize] = useState(240);
  useLayoutEffect(() => {
    const el = boardBoxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSquareSize(Math.floor(Math.min(r.width, r.height)) - 4);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const navBtn = "w-7 h-7 inline-flex items-center justify-center rounded-full text-on-surface-variant text-body-md hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-30 disabled:hover:bg-transparent transition-colors duration-short3 ease-standard";

  return (
    <div className="flex flex-col h-full min-h-0 p-2 gap-2">
      <div className="text-body-sm text-on-surface truncate shrink-0">
        {game.white} – {game.black}
        {game.result && <span className="text-on-surface-variant"> · {game.result === "1/2-1/2" ? "½-½" : game.result}</span>}
      </div>
      <div ref={boardBoxRef} className="flex-1 min-h-0 min-w-0 flex items-center justify-center overflow-hidden">
        <div style={{ width: squareSize, height: squareSize, flexShrink: 0 }}>
          <Chessboard
            options={{
              position: fen,
              allowDragging: false,
              allowDrawingArrows: false,
              darkSquareStyle: { backgroundColor: "var(--color-board-game-dark)" },
              lightSquareStyle: { backgroundColor: "var(--color-board-game-light)" },
              // Anchor the square grid to the top so react-chessboard's absolutely
              // positioned animation layer lines up — without this pieces overshoot.
              boardStyle: { alignContent: "start" },
            }}
          />
        </div>
      </div>
      <div className="shrink-0 flex flex-wrap items-center justify-center gap-1">
        <button className={navBtn} disabled={at === 0} onClick={() => setPly(0)} title="Rewind to start">⏮</button>
        <button className={navBtn} disabled={at === 0} onClick={() => setPly(at - 1)} title="Back">‹</button>
        <button className={navBtn} disabled={at >= last} onClick={() => setPly(at + 1)} title="Forward">›</button>
        <button className={navBtn} disabled={at >= last} onClick={() => setPly(last)} title="Fast-forward to end">⏭</button>
      </div>
    </div>
  );
}
