import { Chessboard } from "react-chessboard";
import { LoadedGame } from "../../lib/useGamePgn";

// Small read-only board (area E of the Games page, #219) showing the selected
// game at the current ply. Navigation (right of the board, unified with the
// position board) is shared with the compact move list (F) via the lifted `ply`.
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

  const navBtn = "w-7 h-7 inline-flex items-center justify-center rounded-full text-on-surface-variant text-body-md hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-30 disabled:hover:bg-transparent transition-colors duration-short3 ease-standard";

  return (
    <div className="flex flex-col h-full min-h-0 p-2 gap-2">
      <div className="text-body-sm text-on-surface truncate shrink-0">
        {game.white} – {game.black}
        {game.result && <span className="text-on-surface-variant"> · {game.result === "1/2-1/2" ? "½-½" : game.result}</span>}
      </div>
      <div className="flex-1 min-h-0 min-w-0 flex items-stretch gap-1">
        <div className="flex-1 min-w-0 flex items-center justify-center overflow-hidden">
          <div style={{ height: "100%", maxWidth: "100%", aspectRatio: "1 / 1" }}>
            <Chessboard
              options={{
                position: fen,
                allowDragging: false,
                allowDrawingArrows: false,
                darkSquareStyle: { backgroundColor: "var(--color-board-game-dark)" },
                lightSquareStyle: { backgroundColor: "var(--color-board-game-light)" },
              }}
            />
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-center justify-center gap-1">
          <button className={navBtn} disabled={at === 0} onClick={() => setPly(0)} title="Start">⏮</button>
          <button className={navBtn} disabled={at === 0} onClick={() => setPly(at - 1)} title="Back">‹</button>
          <button className={navBtn} disabled={at >= last} onClick={() => setPly(at + 1)} title="Forward">›</button>
          <button className={navBtn} disabled={at >= last} onClick={() => setPly(last)} title="End">⏭</button>
        </div>
      </div>
    </div>
  );
}
