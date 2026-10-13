// How a move of the line stands among the moves played in its position
// (#327), from the database's figures the package carries — offline: the
// most played moves there as bars with their share and score — and the
// median rating of those who played it and their performance with it, where
// the package has them — the line's move marked, and a word on it ("2nd most
// played", "rare — 3% of games").
// Shown when a new move is learnt, and in a review, for one's own moves and
// the opponent's.

import { bareSan, type Eval, type PNode, type Stats } from "./format";

/** White's edge, in rating points: what a side performs against its own
 *  rating on average — White above, Black below — so a performance is
 *  coloured against that, not against the rating itself. */
const WHITE_EDGE = 35;
/** A performance this far from what the side scores on average is coloured
 *  (a small sample's performance wanders by more than the edge). */
const PERF_BAND = 40;

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
  // Any rating or performance among the moves shown: the column, and its key.
  const rated = shown.some((m) => m[3] != null || m[4] != null);
  // What the side scores on average against its rating: the colour's zero.
  const edge = ply % 2 === 0 ? WHITE_EDGE : -WHITE_EDGE;
  const tone = (perf: number | null | undefined, elo: number | null | undefined) =>
    perf == null || elo == null ? "" : perf - (elo + edge) >= PERF_BAND ? "text-success" : perf - (elo + edge) <= -PERF_BAND ? "text-error" : "";
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
        {shown.map(([san, share, score, perf, elo]) => {
          const line = mine?.[0] === san;
          return (
            <div key={san} className={`flex items-center gap-2 ${line ? "text-on-surface font-medium" : "text-on-surface-variant"}`}>
              <span className="w-12 shrink-0 font-mono truncate">{san}</span>
              <span className="w-9 shrink-0 text-right tabular-nums">{pct(share)}</span>
              <span className="flex-1 min-w-6 h-2 rounded-full bg-on-surface/8 overflow-hidden">
                <span className={`block h-full ${line ? "bg-primary" : "bg-on-surface/30"}`} style={{ width: `${Math.max(3, (share / top) * 100)}%` }} />
              </span>
              <span className="w-9 shrink-0 text-right tabular-nums" title="The score for the side playing it">{pct(score)}</span>
              {/* Two columns and an arrow between — the arrow and the
                  performance left out where there is none, the rating
                  staying in its column. */}
              {rated && (
                <span className="shrink-0 inline-flex items-center tabular-nums whitespace-nowrap"
                  title={`${elo != null ? `Median rating ${elo}` : "No ratings"}${perf != null ? ` · performance ${perf} (${ply % 2 === 0 ? "White" : "Black"} scores about ${edge > 0 ? "+" : "−"}${WHITE_EDGE} on average; coloured from ${PERF_BAND} off that)` : " · too few rated games for a performance"}`}>
                  <span className="w-10 text-right">{elo ?? ""}</span>
                  <span className="w-4 text-center text-on-surface-variant/70">{perf != null ? "→" : ""}</span>
                  <span className={`w-10 text-right ${tone(perf, elo)}`}>{perf ?? ""}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-label-sm text-on-surface-variant">
        of {stats.games.toLocaleString()} games · share, score{rated ? ", rating → performance" : ""}{stats.eval ? ` · position ${fmtEval(stats.eval)}` : ""}
      </div>
    </div>
  );
}
