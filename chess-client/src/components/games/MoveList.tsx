import { LoadedGame, GameMove } from "../../lib/useGamePgn";

// Compact, read-only move list (area F of the Games page, #219). Linear mainline
// only — comments and variations are already "compressed" out by useGamePgn.
// Clicking a move jumps the shared `ply` (drives the mini board E).
export default function MoveList({
  game,
  ply,
  setPly,
}: {
  game: LoadedGame;
  ply: number;
  setPly: (p: number) => void;
}) {
  // Pair half-moves into "N. white black" rows.
  const rows: { no: number; white?: GameMove; black?: GameMove }[] = [];
  for (const m of game.moves) {
    const no = Math.ceil(m.ply / 2);
    if (m.color === "w") rows.push({ no, white: m });
    else {
      const last = rows[rows.length - 1];
      if (last && last.no === no && !last.black) last.black = m;
      else rows.push({ no, black: m });
    }
  }

  const moveBtn = (m: GameMove) =>
    `px-1 rounded-sm font-mono transition-colors duration-short3 ease-standard ${
      ply === m.ply
        ? "bg-secondary-container text-on-secondary-container"
        : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
    }`;

  // Keyboard nav when the move list has focus: ←/→ step, Home/End jump.
  const last = game.moves.length;
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") { e.preventDefault(); setPly(Math.max(0, ply - 1)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setPly(Math.min(last, ply + 1)); }
    else if (e.key === "Home") { e.preventDefault(); setPly(0); }
    else if (e.key === "End") { e.preventDefault(); setPly(last); }
  }

  if (game.moves.length === 0) {
    return <div className="p-3 text-center text-on-surface-variant text-body-sm">No moves</div>;
  }

  return (
    <div tabIndex={0} onKeyDown={onKeyDown} className="h-full overflow-y-auto p-2 text-body-sm leading-6 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
      <span className="align-baseline">
        {rows.map((r) => (
          <span key={r.no} className="mr-1 whitespace-nowrap">
            <span className="text-on-surface-variant select-none">{r.no}.</span>{" "}
            {r.white && <button className={moveBtn(r.white)} onClick={() => setPly(r.white!.ply)}>{r.white.san}</button>}
            {r.black && <> <button className={moveBtn(r.black)} onClick={() => setPly(r.black!.ply)}>{r.black.san}</button></>}
          </span>
        ))}
      </span>
    </div>
  );
}
