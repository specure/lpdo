// Merging repertoire chapters (#327): the lines of one or more chapters folded
// into another's tree. The target keeps its order — its main line and the
// order of its variations; a move the target lacks is added as a variation
// where it branches off. Comments, line intros and NAGs missing in the target
// are taken over; where both have one and they differ, the difference is a
// conflict, left as the target has it until the user chooses (`resolveMerge`).
// Arrows and circles are joined; a move switched off in either stays off.

import { parsePgnTree, type AnnotatedGame, type MoveNode } from "./parsePgnTree";
import { serializeMovetext } from "./serializeMovetext";
import { nagsToString } from "./parseAnnotations";

export interface MergeChapter { name: string; pgn: string }

export type ConflictKind = "comment" | "intro" | "nags";

export interface MergeConflict {
  id: number;
  kind: ConflictKind;
  /** The line to the move, "1.c4 e5 2.g3 … 7.e3" — "" for the chapter's intro. */
  where: string;
  /** The distinct versions, the target's first; `chapter` names where each
   *  comes from ("A, B" when two chapters agree). */
  options: { chapter: string; text: string }[];
}

export interface MergeResult {
  game: AnnotatedGame;
  conflicts: MergeConflict[];
  /** Moves added from the other chapters. */
  added: number;
  /** What those added moves bring along: comments and line intros, and marks
   *  (NAGs, arrows, circles). */
  carried: { comments: number; marks: number };
  /** Comments, intros, NAGs, arrows and circles added to moves the target
   *  already had (where it had none, or lacked that arrow or circle). */
  takenOver: number;
}

/** Per conflict: the index of the option chosen, or "all" for every version
 *  (texts joined, NAGs combined). Missing: the target's, as it is. */
export type MergeChoices = Map<number, number | "all">;

interface Pending {
  conflict: MergeConflict;
  /** The raw values behind the options, same order. */
  values: (string | number[])[];
  set: (v: string | number[] | undefined) => void;
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const sameNags = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/** "7.e3", "7...Nxd5" — the move's number from the position after it. */
function moveLabel(n: MoveNode): string {
  const full = Number(n.fen.split(/\s+/)[5]) || 1;
  return n.color === "w" ? `${full}.${n.san}` : `${full - 1}...${n.san}`;
}

function lineLabel(path: MoveNode[]): string {
  return path.map((n, i) => (n.color === "w" || i === 0 ? moveLabel(n) : n.san)).join(" ");
}

function countMoves(line: MoveNode[]): number {
  return line.reduce((sum, n) => sum + 1 + n.variations.reduce((s, v) => s + countMoves(v), 0), 0);
}

/** The comments and marks on a line and its variations, added to `into`. */
function countNotes(line: MoveNode[], into: { comments: number; marks: number }) {
  for (const n of line) {
    const a = n.annotations;
    if (norm(a.comment)) into.comments++;
    if (norm(n.preComment)) into.comments++;
    into.marks += (a.nags?.length ?? 0) + (a.arrows?.length ?? 0) + (a.circles?.length ?? 0);
    for (const v of n.variations) countNotes(v, into);
  }
}

/** A move from a position: the node at `line[i]` and the rest of `line` after it. */
interface At { line: MoveNode[]; i: number }

/** Every move from the position before `line[i]`: that one and its
 *  variations (and theirs, where a variation's first move has some). */
function alternatives(line: MoveNode[], i: number): At[] {
  if (i >= line.length) return [];
  const out: At[] = [{ line, i }];
  for (const v of line[i].variations) out.push(...alternatives(v, 0));
  return out;
}

class Merger {
  pending = new Map<string, Pending>();
  keys = new WeakMap<object, number>();
  nextKey = 0;
  added = 0;
  carried = { comments: 0, marks: 0 };
  takenOver = 0;

  constructor(private chapters: string[]) {}

  private keyOf(o: object): number {
    let k = this.keys.get(o);
    if (k == null) { k = this.nextKey++; this.keys.set(o, k); }
    return k;
  }

  /** One text field: taken over, equal, or a conflict. */
  private text(owner: object, kind: ConflictKind, where: string, cur: string | undefined, incoming: string | undefined, from: number, set: (v: string | undefined) => void) {
    if (!norm(incoming)) return;
    if (!norm(cur)) { set(incoming); this.takenOver++; return; }
    this.record(owner, kind, where, cur!, incoming!, from, (a, b) => norm(a as string) === norm(b as string), set as Pending["set"]);
  }

  private nags(node: MoveNode, where: string, incoming: number[] | undefined, from: number) {
    if (!incoming?.length) return;
    const cur = node.annotations.nags;
    if (!cur?.length) { node.annotations.nags = [...incoming]; this.takenOver++; return; }
    this.record(node, "nags", where, cur, incoming, from, (a, b) => sameNags(a as number[], b as number[]),
      (v) => { node.annotations.nags = v as number[] | undefined; });
  }

  private record(owner: object, kind: ConflictKind, where: string, cur: string | number[], incoming: string | number[], from: number,
    same: (a: string | number[], b: string | number[]) => boolean, set: Pending["set"]) {
    const key = `${this.keyOf(owner)}:${kind}`;
    let p = this.pending.get(key);
    if (!p) {
      if (same(cur, incoming)) return;
      p = {
        conflict: { id: this.pending.size, kind, where, options: [{ chapter: this.chapters[0], text: show(cur) }] },
        values: [cur], set,
      };
      this.pending.set(key, p);
    }
    const at = p.values.findIndex((v) => same(v, incoming));
    const name = this.chapters[from];
    if (at >= 0) {
      const o = p.conflict.options[at];
      if (!o.chapter.split(", ").includes(name)) o.chapter += `, ${name}`;
    } else {
      p.values.push(incoming);
      p.conflict.options.push({ chapter: name, text: show(incoming) });
    }
  }

  /** What a move carries besides its comment, joined. */
  private marks(t: MoveNode, s: MoveNode) {
    const ta = t.annotations, sa = s.annotations;
    if (sa.arrows?.length) {
      const have = new Set((ta.arrows ?? []).map((a) => `${a.from}${a.to}`));
      const extra = sa.arrows.filter((a) => !have.has(`${a.from}${a.to}`));
      if (extra.length) { ta.arrows = [...(ta.arrows ?? []), ...extra]; this.takenOver += extra.length; }
    }
    if (sa.circles?.length) {
      const have = new Set((ta.circles ?? []).map((c) => c.square));
      const extra = sa.circles.filter((c) => !have.has(c.square));
      if (extra.length) { ta.circles = [...(ta.circles ?? []), ...extra]; this.takenOver += extra.length; }
    }
    if (sa.off) ta.off = true;
  }

  /** The same move in both: its annotations. */
  private node(t: MoveNode, s: MoveNode, path: MoveNode[], from: number) {
    const where = lineLabel([...path, t]);
    this.text(t, "comment", where, t.annotations.comment, s.annotations.comment, from, (v) => { t.annotations.comment = v; });
    this.text(t, "intro", where, t.preComment, s.preComment, from, (v) => { t.preComment = v; });
    this.nags(t, where, s.annotations.nags, from);
    this.marks(t, s);
  }

  /** The moves from one position: `target` from `line[i]`, `source` from
   *  `sline[si]`. Every move of the source's is matched with the target's
   *  of the same SAN and followed down, or added as a variation. */
  from(line: MoveNode[], i: number, sline: MoveNode[], si: number, path: MoveNode[], from: number) {
    if (si >= sline.length) return;
    if (i >= line.length) {
      // The target's line ends here: the rest of the source's continues it.
      const rest = structuredClone(sline.slice(si));
      this.added += countMoves(rest);
      countNotes(rest, this.carried);
      line.push(...rest);
      return;
    }
    const mine = alternatives(line, i);
    for (const alt of alternatives(sline, si)) {
      const s = alt.line[alt.i];
      const match = mine.find((m) => m.line[m.i].san === s.san);
      if (match) {
        const t = match.line[match.i];
        this.node(t, s, path, from);
        this.from(match.line, match.i + 1, alt.line, alt.i + 1, [...path, t], from);
      } else {
        // A new move here: a variation of the target's, with the rest of the
        // source's line after it (its own alternatives are handled in turn).
        const v = structuredClone(alt.line.slice(alt.i));
        v[0].variations = [];
        this.added += countMoves(v);
        countNotes(v, this.carried);
        line[i].variations.push(v);
        mine.push({ line: v, i: 0 });
      }
    }
  }

  merge(target: AnnotatedGame, source: AnnotatedGame, from: number) {
    this.text(target, "intro", "", target.startComment, source.startComment, from, (v) => { target.startComment = v; });
    const sa = source.startAnnotations;
    if (sa?.arrows?.length || sa?.circles?.length) {
      const holder = { san: "", color: "w", fen: "", annotations: { ...target.startAnnotations }, variations: [] } as MoveNode;
      this.marks(holder, { ...holder, annotations: { ...sa } });
      target.startAnnotations = { arrows: holder.annotations.arrows, circles: holder.annotations.circles };
    }
    this.from(target.mainLine, 0, source.mainLine, 0, [], from);
  }
}

function show(v: string | number[]): string {
  return typeof v === "string" ? v : nagsToString(v);
}

/** The moves (as SANs from the start) of every line's last move: the main
 *  line's and each variation's, theirs too. */
function lineEnds(line: MoveNode[], before: string[] = [], out: string[][] = []): string[][] {
  line.forEach((n, i) => {
    for (const v of n.variations) lineEnds(v, [...before, ...line.slice(0, i).map((m) => m.san)], out);
  });
  if (line.length) out.push([...before, ...line.map((m) => m.san)]);
  return out;
}

/** The node the moves lead to in `line`, wherever among the variations. */
function follow(line: MoveNode[], sans: string[]): MoveNode | null {
  let at: At = { line, i: 0 };
  let node: MoveNode | null = null;
  for (const san of sans) {
    const m = alternatives(at.line, at.i).find((a) => a.line[a.i].san === san);
    if (!m) return null;
    node = m.line[m.i];
    at = { line: m.line, i: m.i + 1 };
  }
  return node;
}

/** Merge `sources` into `target`, in order. The conflicts are left as the
 *  target has them until `resolveMerge`. */
export function mergeChapters(target: MergeChapter, sources: MergeChapter[]): MergeResult & { pending: Pending[]; endings: Map<MoveNode, string[]> } {
  const game = parsePgnTree(target.pgn);
  const m = new Merger([target.name, ...sources.map((s) => s.name)]);
  // Where each chapter's lines end, for noting their names there.
  const ends: { name: string; sans: string[] }[] = lineEnds(game.mainLine).map((sans) => ({ name: target.name, sans }));
  sources.forEach((s, k) => {
    const g = parsePgnTree(s.pgn);
    for (const sans of lineEnds(g.mainLine)) ends.push({ name: s.name, sans });
    m.merge(game, g, k + 1);
  });
  const endings = new Map<MoveNode, string[]>();
  for (const e of ends) {
    const node = follow(game.mainLine, e.sans);
    if (!node) continue;
    const names = endings.get(node) ?? [];
    if (!names.includes(e.name)) names.push(e.name);
    endings.set(node, names);
  }
  const pending = [...m.pending.values()];
  return { game, conflicts: pending.map((p) => p.conflict), added: m.added, carried: m.carried, takenOver: m.takenOver, pending, endings };
}

/** Apply the choices and give the merged chapter's movetext. `noteChapters`:
 *  each line's last move gets the chapter it came from in its comment,
 *  "… (Theory 3D: #24)" — several where their lines end on the same move. */
export function resolveMerge(result: ReturnType<typeof mergeChapters>, choices: MergeChoices, noteChapters = false): string {
  for (const p of result.pending) {
    const c = choices.get(p.conflict.id);
    if (c == null || c === 0) continue;
    if (c === "all") {
      if (p.conflict.kind === "nags") {
        const all: number[] = [];
        for (const v of p.values as number[][]) for (const n of v) if (!all.includes(n)) all.push(n);
        p.set(all);
      } else {
        p.set((p.values as string[]).map((v) => v.trim()).join(" "));
      }
    } else {
      p.set(p.values[c]);
    }
  }
  if (noteChapters) {
    for (const [node, names] of result.endings) {
      const note = `(${names.join(", ")})`;
      const c = (node.annotations.comment ?? "").trim();
      if (!c.endsWith(note)) node.annotations.comment = c ? `${c} ${note}` : note;
    }
  }
  return serializeMovetext(result.game);
}
