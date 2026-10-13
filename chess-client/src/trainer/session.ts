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
  /** One's own moves cut from the lines' ends where they get rare
   *  (`cutRare`); 0 when the lines are whole. */
  cut: number;
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

/** A move never played in a position the database knows: nobody plays
 *  the book's variation. */
const neverPlayed = (stats: Stats | undefined, san: string): boolean =>
  !!stats && stats.games > 0 && !stats.moves.some(([s, share]) => bareSan(s) === bareSan(san) && share > 0);

/** Every line below `path` (the start when empty), with its likelihood from
 *  there; switched-off moves and what follows them left out. With `use`, each
 *  of one's own moves' use is kept in it: its line's weight so far — the
 *  share of the games staying in the chapter that reach its position — and
 *  0 where nothing can be known of it: beyond the database's figures, or
 *  below an opponent's move never played. */
export function linesFrom(chapter: LpdoChapter, path: PNode[] = [], use?: Map<PNode, number>): Line[] {
  const color: Side = chapter.book.color;
  const out: Line[] = [];
  // Whose move the root's children are: the start is White's; after the
  // path, the other side of its last move.
  const whiteFirst = path.length % 2 === 0;
  const walk = (nodes: PNode[], stats: Stats | undefined, white: boolean, prefix: PNode[], p: number, w: number, alt: boolean, dead: boolean) => {
    const on = nodes.filter((n) => !n.off);
    const own = (white ? "white" : "black") === color;
    const shares = on.map((n) => share(stats, n.san));
    const sum = shares.reduce((a, b) => a + b, 0);
    on.forEach((n, i) => {
      const q = own ? p : p * shares[i];
      const v = own ? w : w * (sum > 0 ? shares[i] / sum : 1 / on.length);
      const gone = dead || (!own && neverPlayed(stats, n.san));
      if (own && use) use.set(n, !gone && stats && stats.games > 0 ? w : 0);
      const next = [...prefix, n];
      const alternative = alt || (own && i > 0);
      const kids = n.children.filter((c) => !c.off);
      if (!kids.length) out.push({ path: next, likelihood: q, weight: v, alternative });
      else walk(n.children, n.stats, !white, next, q, v, alternative, gone);
    });
  };
  const root = path.length ? path[path.length - 1] : null;
  if (root?.off) return [];
  walk(root ? root.children : chapter.tree, root ? root.stats : chapter.start.stats, whiteFirst, path, 1, 1, false, false);
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

/** The lines' ends cut where they get rare: each of one's own moves has a
 *  use (`use`: its line's weight so far — the share of the games staying
 *  in the chapter that reach it; 0 beyond the database's figures and below
 *  a move never played) and the least used are cut first, the deepest first
 *  among equals (the longest line), a cut taking one's move and the
 *  opponent's before it, so a line still ends after one's own move; as long
 *  as the moves left keep `keep` of the lines' use. So the book's variations
 *  nobody plays and everything beyond the database's depth go first, then
 *  the ends of the rarest lines. Lines cut to the same moves become one.
 *  (The chance of reaching a position among all games would not do: it
 *  falls at every opponent's move, forced or not, and 80% of it is the
 *  first few moves.) */
export function cutRare(lines: Line[], use: Map<PNode, number>, color: Side, keep: number): { lines: Line[]; cut: number } {
  const kept = new Set<PNode>();
  const parent = new Map<PNode, PNode | null>();
  const depth = new Map<PNode, number>();
  for (const l of lines) l.path.forEach((n, i) => { kept.add(n); parent.set(n, i ? l.path[i - 1] : null); depth.set(n, i); });
  const own = (n: PNode) => ((depth.get(n)! % 2 === 0) ? "white" : "black") === color;
  const value = (n: PNode) => use.get(n) ?? 0;
  const total = [...kept].filter(own).reduce((s, n) => s + value(n), 0);
  let left = total;
  let cut = 0;
  const keptChildren = (n: PNode) => n.children.filter((c) => kept.has(c));
  for (;;) {
    // One's moves at the ends: nothing of one's own kept below them.
    const ends = [...kept].filter((n) => own(n) && keptChildren(n).every((c) => keptChildren(c).length === 0));
    if (!ends.length) break;
    ends.sort((a, b) => value(a) - value(b) || depth.get(b)! - depth.get(a)!);
    const n = ends[0];
    if (left - value(n) < keep * total - 1e-9) break;
    left -= value(n);
    cut++;
    for (const c of keptChildren(n)) kept.delete(c);
    kept.delete(n);
    const p = parent.get(n);
    if (p && keptChildren(p).length === 0) kept.delete(p);
  }
  if (!cut) return { lines, cut };
  // Each line to where it is still kept; lines cut to the same end merged,
  // their weights together.
  const byEnd = new Map<PNode | null, Line>();
  for (const l of lines) {
    const path = l.path.filter((n) => kept.has(n));
    const end = path.length ? path[path.length - 1] : null;
    const had = byEnd.get(end);
    if (had) { had.weight += l.weight; had.likelihood = Math.max(had.likelihood, l.likelihood); had.alternative = had.alternative && l.alternative; }
    else byEnd.set(end, { path, likelihood: l.likelihood, weight: l.weight, alternative: l.alternative });
  }
  return { lines: [...byEnd.values()].filter((l) => l.path.length > 0), cut };
}

/** The lines to practise below `path` (the focus by default), most likely
 *  first, up to `target` (at least one line). Counted from the trunk below
 *  `path`, by the lines' weight — their share of the games that stay in the
 *  chapter — so 80% can always be reached, and a line is not favoured for
 *  ending early. With `cut`, below 100%, the lines' rare ends are cut
 *  (`cutRare`), keeping the coverage's share of the lines' use. */
export function chooseLines(chapter: LpdoChapter, target: Target, path: PNode[] = focusRoot(chapter).path, cut = false): Session {
  const from = trunk(chapter, path);
  const use = new Map<PNode, number>();
  const all = linesFrom(chapter, from, use);
  // The trunk's own moves: every game in the chapter reaches them.
  from.forEach((n, i) => { if (((i % 2 === 0) ? "white" : "black") === chapter.book.color) use.set(n, 1); });
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
  // At 100% the lines are whole, nobody-plays-it or not.
  const keep = "coverage" in target ? target.coverage : 1;
  const trimmed = cut && keep < 1 ? cutRare(chosen, use, color, keep) : { lines: chosen, cut: 0 };
  const d = decisions(trimmed.lines, color);
  return { lines: trimmed.lines, cut: trimmed.cut, from, of: all.length, reach: Math.min(reach, 1), coverage: Math.min(coverage, 1), decisions: d, minutes: estimateMinutes(d) };
}
