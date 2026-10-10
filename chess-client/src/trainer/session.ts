// A practice session (#327): which lines of a chapter to practise, chosen by
// how likely the opponent is to play them, up to a coverage or a time
// budget. See docs/design/opening-repertoire.md, "A session: choosing the
// lines". Works on the package alone.

import { bareSan, type LpdoChapter, type PNode, type Side, type Stats } from "./format";

/** A line: the moves from the chapter's start to a leaf. */
export interface Line {
  path: PNode[];
  /** The chance that a game from where the lines are counted follows the
   *  opponent's moves of this line all the way. */
  likelihood: number;
  /** The line's share of the games that stay within the chapter: at each
   *  opponent move, its share among the chapter's moves there. A chapter's
   *  main lines add up to 1, long or short. */
  weight: number;
  /** One of one's own moves in it is not the chapter's first choice there —
   *  an alternative, left out of the coverage. */
  alternative: boolean;
}

export interface Session {
  lines: Line[];
  /** Where the lines are counted from: the chapter's trunk — down to where
   *  it first branches — or the focus, whichever is deeper. */
  from: PNode[];
  /** All the lines from there (switched-off ones left out). */
  of: number;
  /** The share of the games from `from` that stay within the chapter to
   *  the end of one of its lines. */
  reach: number;
  /** The share of the games staying within the chapter that the lines
   *  chosen take in (their weight). */
  coverage: number;
  /** Distinct positions where it is one's own move. */
  decisions: number;
  minutes: number;
}

export type Target = { coverage: number } | { minutes: number };

/** A move the database does not have: rare, not impossible. */
const RARE = 0.005;
/** The estimate's guesses until there is practice to learn from. */
export const REPETITIONS = 3;
export const SECONDS_PER_DECISION = 15;

const share = (stats: Stats | undefined, san: string): number => {
  if (!stats || stats.games === 0) return 1; // beyond the database: the line's likelihood so far
  const m = stats.moves.find(([s]) => bareSan(s) === bareSan(san));
  return m ? m[1] : RARE;
};

/** The node the focus names, and the moves leading to it — or the start. */
export function focusRoot(chapter: LpdoChapter, focus: string[] | null = chapter.focus): { path: PNode[]; stats?: Stats } {
  const path: PNode[] = [];
  let level = chapter.tree;
  for (const san of focus ?? []) {
    const n = level.find((c) => bareSan(c.san) === bareSan(san));
    if (!n) break;
    path.push(n);
    level = n.children;
  }
  return { path, stats: path.length ? path[path.length - 1].stats : chapter.start.stats };
}

/** Every line below `path` (the start when empty), with its likelihood from
 *  there; switched-off moves and what follows them left out. */
export function linesFrom(chapter: LpdoChapter, path: PNode[] = []): Line[] {
  const color: Side = chapter.book.color;
  const out: Line[] = [];
  // Whose move the root's children are: the start is White's; after the
  // path, the other side of its last move.
  const whiteFirst = path.length % 2 === 0;
  const walk = (nodes: PNode[], stats: Stats | undefined, white: boolean, prefix: PNode[], p: number, w: number, alt: boolean) => {
    const on = nodes.filter((n) => !n.off);
    const own = (white ? "white" : "black") === color;
    const shares = on.map((n) => share(stats, n.san));
    const sum = shares.reduce((a, b) => a + b, 0);
    on.forEach((n, i) => {
      const q = own ? p : p * shares[i];
      const v = own ? w : w * (sum > 0 ? shares[i] / sum : 1 / on.length);
      const next = [...prefix, n];
      const alternative = alt || (own && i > 0);
      const kids = n.children.filter((c) => !c.off);
      if (!kids.length) out.push({ path: next, likelihood: q, weight: v, alternative });
      else walk(n.children, n.stats, !white, next, q, v, alternative);
    });
  };
  const root = path.length ? path[path.length - 1] : null;
  if (root?.off) return [];
  walk(root ? root.children : chapter.tree, root ? root.stats : chapter.start.stats, whiteFirst, path, 1, 1, false);
  return out;
}

/** `path` followed down while the chapter does not branch: a chapter's
 *  lines are only worth comparing from where they part. */
export function trunk(chapter: LpdoChapter, path: PNode[] = []): PNode[] {
  const out = [...path];
  for (;;) {
    const level = out.length ? out[out.length - 1].children : chapter.tree;
    const on = level.filter((n) => !n.off);
    if (on.length !== 1 || !on[0].children.some((c) => !c.off)) return out;
    out.push(on[0]);
  }
}

/** Distinct own-move positions in these lines: the moves the drill asks. */
export function decisions(lines: Line[], color: Side): number {
  const seen = new Set<PNode>();
  for (const l of lines) {
    l.path.forEach((n, i) => {
      const white = i % 2 === 0;
      if ((white ? "white" : "black") === color) seen.add(n);
    });
  }
  return seen.size;
}

export const estimateMinutes = (d: number) => (d * REPETITIONS * SECONDS_PER_DECISION) / 60;

/** The lines to practise below `path` (the focus by default), most likely
 *  first, up to `target` (at least one line). Counted from the trunk below
 *  `path`, by the lines' weight — their share of the games that stay in the
 *  chapter — so 75% can always be reached, and a line is not favoured for
 *  ending early. */
export function chooseLines(chapter: LpdoChapter, target: Target, path: PNode[] = focusRoot(chapter).path): Session {
  const from = trunk(chapter, path);
  const all = linesFrom(chapter, from);
  const reach = all.filter((l) => !l.alternative).reduce((n, l) => n + l.likelihood, 0);
  // One's main repertoire first, most likely first; then one's own
  // alternatives.
  const ranked = [...all].sort((a, b) => Number(a.alternative) - Number(b.alternative) || b.weight - a.weight);
  const color = chapter.book.color;
  const chosen: Line[] = [];
  let coverage = 0;
  for (const l of ranked) {
    if (chosen.length) {
      if ("coverage" in target && coverage >= target.coverage - 1e-9) break;
      if ("minutes" in target && estimateMinutes(decisions([...chosen, l], color)) > target.minutes) break;
    }
    chosen.push(l);
    if (!l.alternative) coverage += l.weight;
  }
  // Back in the chapter's order, for reading.
  const order = new Map(all.map((l, i) => [l, i]));
  chosen.sort((a, b) => order.get(a)! - order.get(b)!);
  const d = decisions(chosen, color);
  return { lines: chosen, from, of: all.length, reach: Math.min(reach, 1), coverage: Math.min(coverage, 1), decisions: d, minutes: estimateMinutes(d) };
}
