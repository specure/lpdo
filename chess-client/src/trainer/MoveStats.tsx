// How a move of the line stands among the moves played in its position
// (#327), from the database's figures the package carries — offline: the
// most played moves there as bars with their share and score, the line's
// move marked, and a word on it ("2nd most played", "rare — 3% of games").
// Shown when a new move is learnt, and in a review, for one's own moves and
// the opponent's.

import { bareSan, type Eval, type PNode, type Stats } from "./format";

const ordinal = (n: number) => (n === 1 ? "most played" : `${n}${n === 2 ? "nd" : n === 3 ? "rd" : "th"} most played`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmtEval = (e: Eval) => ("mate" in e ? `${e.mate > 0 ? "" : "-"}M${Math.abs(e.mate)}` : `${e.cp > 0 ? "+" : ""}${(e.cp / 100).toFixed(2)}`);

interface Props {
  /** The move of the line, and its place in it (half-moves before it). */
  move: PNode;
  ply: number;
  /** The figures of the position the move was played from. */
  stats: Stats | undefined;
  /** It is one's own move (the book's), not the opponent's. */
  own: boolean;
}

export default function MoveStats({ move, ply, stats, own }: Props) {
  const label = `${Math.floor(ply / 2) + 1}${ply % 2 ? "…" : "."}${move.san}`;
  if (!stats || stats.games === 0 || stats.moves.length === 0) {
    return <div className="text-label-md text-on-surface-variant">{label} — beyond the database's figures</div>;
  }
  const ranked = [...stats.moves].sort((a, b) => b[1] - a[1]);
  const at = ranked.findIndex(([s]) => bareSan(s) === bareSan(move.san));
  const mine = at >= 0 ? ranked[at] : null;
  // The three most played, and the line's move when it is not among them.
  const shown = ranked.slice(0, 3);
  if (mine && at >= 3) shown.push(mine);
  const top = ranked[0][1] || 1;
  // One's own rare move: the opponent will seldom have met it.
  const verdict = !mine ? `not among the moves played here${own ? " — a surprise" : ""}`
    : mine[1] < 0.05 ? `rare — ${pct(mine[1])} of games${own ? ", a surprise" : ""}`
    : ordinal(at + 1);
  return (
    <div className="text-label-md space-y-1">
      <div>
        <span className="font-medium">{label}</span>
        <span className="text-on-surface-variant"> — {own ? "book move · " : ""}{verdict}</span>
      </div>
      <div className="space-y-0.5">
        {shown.map(([san, share, score]) => {
          const line = mine?.[0] === san;
          return (
            <div key={san} className={`flex items-center gap-2 ${line ? "text-on-surface font-medium" : "text-on-surface-variant"}`}>
              <span className="w-12 shrink-0 font-mono truncate">{san}</span>
              <span className="w-9 shrink-0 text-right tabular-nums">{pct(share)}</span>
              <span className="flex-1 h-2 rounded-full bg-on-surface/8 overflow-hidden">
                <span className={`block h-full ${line ? "bg-primary" : "bg-on-surface/30"}`} style={{ width: `${Math.max(3, (share / top) * 100)}%` }} />
              </span>
              <span className="w-20 shrink-0 text-right tabular-nums">scores {pct(score)}</span>
            </div>
          );
        })}
      </div>
      <div className="text-label-sm text-on-surface-variant">
        of {stats.games.toLocaleString()} games{stats.eval ? ` · position ${fmtEval(stats.eval)}` : ""}
      </div>
    </div>
  );
}
