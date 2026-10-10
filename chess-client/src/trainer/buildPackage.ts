// Building a chapter's practice package on the desktop: the chapter's tree
// (lib/parsePgnTree) with the server's figures for its positions
// (GET /repertoire/chapters/{id}/stats). Only the desktop builds packages;
// the phone only reads them.

import { Chess } from "chess.js";
import { parsePgnTree, type MoveNode } from "../lib/parsePgnTree";
import { encodeCal, encodeCsl } from "../lib/parseAnnotations";
import { FORMAT, VERSION, bareSan, type LpdoChapter, type Mine, type PNode, type Side, type Stats } from "./format";

/** The server's figures for one position (see chess-db repertoire.rs). */
export interface PositionStat {
  key: string;
  zobrist: string;
  games: number;
  moves: { san: string; games: number; score: number }[];
  eval: { cp: number } | { mate: number } | null;
  /** At a line's end: Stockfish's evaluation, as kept (White's side). */
  engine?: { cp?: number; mate?: number; depth: number; engine: string } | null;
}

/** One's own games, from the live lookup (GET /repertoire/chapters/{id}/mine). */
export interface OwnGamesInput {
  color: Side;
  since: string | null;
  games: number;
  positions: { key: string; mine: Mine }[];
}

export interface PackageInput {
  chapter: { id: number; name: string; updated_at: string | null; pgn: string; ord?: number };
  book: { name: string; author: string | null; color: Side };
  stats: PositionStat[];
  /** One's own games, when one's player is known. */
  mine?: OwnGamesInput | null;
  focus?: string[] | null;
  /** Leave the comments out (a smaller package, for drilling only). */
  noComments?: boolean;
}

/** How a position is found in the server's figures: the FEN's board, side
 *  to move and castling rights (see `position_key` on the server). */
export const positionKey = (fen: string) => fen.split(" ").slice(0, 3).join(" ");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** "[%cal Gc4c5,Rd4d5]" → ["Gc4c5", "Rd4d5"]. */
const codes = (tag: string) => (tag ? tag.replace(/^\[%\w+ |\]$/g, "").split(",") : []);

function toStats(s: PositionStat | undefined): Stats | undefined {
  if (!s) return undefined;
  const total = s.moves.reduce((n, m) => n + m.games, 0) || 1;
  const out: Stats = {
    games: s.games,
    moves: s.moves.map((m) => [m.san, round(m.games / total), round(m.score)]),
  };
  if (s.eval) out.eval = s.eval;
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export function buildPackage(input: PackageInput): LpdoChapter {
  const game = parsePgnTree(input.chapter.pgn);
  const byKey = new Map(input.stats.map((s) => [s.key, s]));
  const mineByKey = new Map((input.mine?.positions ?? []).map((p) => [p.key, p.mine]));
  const color = input.book.color;
  const keep = (text: string | undefined) => (input.noComments ? undefined : text || undefined);

  /** Every move from the position before `line[i]`: that one and its
   *  variations (and theirs, where a variation's first move has some). */
  function alternatives(line: MoveNode[], i: number): { line: MoveNode[]; i: number }[] {
    if (i >= line.length) return [];
    const out = [{ line, i }];
    for (const v of line[i].variations) out.push(...alternatives(v, 0));
    return out;
  }

  /** The moves from the position `fen`, each followed down. */
  function children(line: MoveNode[], i: number, fen: string): PNode[] {
    return alternatives(line, i).map((a) => toNode(a.line, a.i, fen));
  }

  function toNode(line: MoveNode[], i: number, fenBefore: string): PNode {
    const n = line[i];
    const board = new Chess(fenBefore);
    const mv = board.move(n.san);
    const uci = mv.from + mv.to + (mv.promotion ?? "");
    const mover: Side = n.color === "w" ? "white" : "black";
    const out: PNode = { san: n.san, uci, children: [] };
    if (mover === color) {
      const z = byKey.get(positionKey(fenBefore))?.zobrist;
      if (z) out.card = `${z}:${uci}`;
    }
    const a = n.annotations;
    const comment = keep(a.comment), pre = keep(n.preComment);
    if (comment) out.comment = comment;
    if (pre) out.pre = pre;
    if (a.nags?.length) out.nags = a.nags;
    if (!input.noComments && a.arrows?.length) out.arrows = codes(encodeCal(a.arrows));
    if (!input.noComments && a.circles?.length) out.circles = codes(encodeCsl(a.circles));
    if (a.off) out.off = true;
    const stats = toStats(byKey.get(positionKey(n.fen)));
    if (stats) out.stats = stats;
    const after = byKey.get(positionKey(n.fen))?.engine;
    if (after && (after.cp != null || after.mate != null)) {
      out.engine = { eval: after.mate != null ? { mate: after.mate } : { cp: after.cp! }, depth: after.depth, name: after.engine };
    }
    const mine = mineByKey.get(positionKey(n.fen));
    if (mine) out.mine = mine;
    out.children = children(line, i + 1, n.fen);
    return out;
  }

  const start: LpdoChapter["start"] = {};
  const intro = keep(game.startComment);
  if (intro) start.comment = intro;
  const startStats = toStats(byKey.get(positionKey(START_FEN)));
  if (startStats) start.stats = startStats;
  const startMine = mineByKey.get(positionKey(START_FEN));
  if (startMine) start.mine = startMine;

  return {
    format: FORMAT,
    version: VERSION,
    chapter: { id: input.chapter.id, updated: input.chapter.updated_at, ...(input.chapter.ord != null ? { ord: input.chapter.ord } : {}) },
    sent: new Date().toISOString(),
    book: input.book,
    name: input.chapter.name,
    focus: input.focus?.map(bareSan) ?? null,
    ...(input.mine ? { mine: { color: input.mine.color, since: input.mine.since, games: input.mine.games } } : {}),
    start,
    tree: children(game.mainLine, 0, game.startFen),
  };
}
