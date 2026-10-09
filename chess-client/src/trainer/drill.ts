// The drill (#327): the opponent's moves are played, chosen by how often
// they are played; one's own moves are entered on the board. Each of one's
// decisions is a card — keyed by position and move, so it is the same card
// in every chapter and session it turns up in — on a spaced-repetition
// schedule: a card missed comes back in the same session, one known comes
// back later and later. See docs/design/opening-repertoire.md, "Training:
// study and drill". Works on the package alone, so the phone shares it.

import { Chess } from "chess.js";
import { bareSan, type LpdoChapter, type PNode, type Side, type Stats } from "./format";
import { chooseLines, type Session } from "./session";

/** A card's schedule. `box` 0 is due at once; each right answer moves it up
 *  a box, a wrong one back to 0. Times in ms since the epoch. */
export interface Card {
  box: number;
  due: number;
  right: number;
  wrong: number;
  last: number;
}

/** Days to the next review, by box. */
export const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60];
const DAY = 24 * 60 * 60 * 1000;

/** A card after an answer. A right answer to a card not yet due — met on the
 *  way to one that is — keeps its schedule; a wrong one always sends it back. */
export function review(card: Card | undefined, correct: boolean, now: number): Card {
  const c: Card = card ?? { box: 0, due: now, right: 0, wrong: 0, last: now };
  if (!correct) return { ...c, box: 0, due: now, wrong: c.wrong + 1, last: now };
  if (card && card.due > now) return { ...c, right: c.right + 1, last: now };
  const box = Math.min((card ? c.box : 0) + 1, INTERVAL_DAYS.length - 1);
  return { ...c, box, due: now + INTERVAL_DAYS[box] * DAY, right: c.right + 1, last: now };
}

export const isDue = (card: Card | undefined, now: number) => !card || card.due <= now;

/** Where cards are kept: on the desktop the browser's storage, on the phone
 *  its database. */
export interface CardStore {
  all(): Promise<Record<string, Card>>;
  put(key: string, card: Card): Promise<void>;
}

/** Cards in the browser's localStorage, under one key. */
export function localCardStore(key = "lpdoDrillCards"): CardStore {
  const read = (): Record<string, Card> => {
    try { return JSON.parse(localStorage.getItem(key) ?? "{}") ?? {}; } catch { return {}; }
  };
  return {
    all: async () => read(),
    put: async (k, card) => {
      const cards = read();
      cards[k] = card;
      try { localStorage.setItem(key, JSON.stringify(cards)); } catch { /* full or off: not kept */ }
    },
  };
}

/** A position the drill can be in: the moves to it, the FEN, the figures. */
export interface Spot {
  path: PNode[];
  fen: string;
  stats?: Stats;
}

/** A drill over a chapter: the session's lines, the positions on them, and
 *  each of one's own moves' card. */
export interface Drill {
  chapter: LpdoChapter;
  color: Side;
  session: Session;
  /** The moves on the session's lines. */
  inSession: Set<PNode>;
  /** The FEN before each move on them. */
  fenBefore: Map<PNode, string>;
  /** One's own moves on them, with their cards' keys. */
  cardOf: Map<PNode, string>;
  startFen: string;
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const fenKey = (fen: string) => fen.split(" ").slice(0, 3).join(" ");

export function buildDrill(chapter: LpdoChapter, coverage: number): Drill {
  const session = chooseLines(chapter, { coverage });
  const color = chapter.book.color;
  const inSession = new Set<PNode>();
  const fenBefore = new Map<PNode, string>();
  const cardOf = new Map<PNode, string>();
  for (const line of session.lines) {
    const board = new Chess(START_FEN);
    for (const n of line.path) {
      if (!fenBefore.has(n)) {
        const fen = board.fen();
        fenBefore.set(n, fen);
        const mover: Side = board.turn() === "w" ? "white" : "black";
        // The package's key where the server knew the position; else the
        // position's own — stable either way across sends.
        if (mover === color) cardOf.set(n, n.card ?? `${fenKey(fen)}:${n.uci}`);
      }
      inSession.add(n);
      try { board.move(n.san); } catch { break; }
    }
  }
  return { chapter, color, session, inSession, fenBefore, cardOf, startFen: START_FEN };
}

/** The session's moves from a position (`path` its moves; the start when
 *  empty), in the chapter's order. */
export function nextMoves(d: Drill, path: PNode[]): PNode[] {
  const level = path.length ? path[path.length - 1].children : d.chapter.tree;
  return level.filter((n) => d.inSession.has(n));
}

/** Whose move it is after `path`. */
export const sideToMove = (path: PNode[]): Side => (path.length % 2 === 0 ? "white" : "black");

/** A card due — or new — at or below this move, on the session's lines. */
export function hasWork(d: Drill, node: PNode, cards: Record<string, Card>, now: number): boolean {
  const key = d.cardOf.get(node);
  if (key && isDue(cards[key], now)) return true;
  return node.children.some((c) => d.inSession.has(c) && hasWork(d, c, cards, now));
}

/** The cards on the session's lines: how many, how many due now, how many
 *  never answered. */
export function cardCounts(d: Drill, cards: Record<string, Card>, now: number) {
  const keys = new Set(d.cardOf.values());
  let due = 0, fresh = 0;
  for (const k of keys) {
    if (!cards[k]) fresh++;
    else if (cards[k].due <= now) due++;
  }
  return { total: keys.size, due, fresh };
}

/** The opponent's reply: one of the session's moves here that leads to work
 *  (any of them when `anyLine`), chosen at random by its share of the games;
 *  null when there is none — the line is done. */
export function opponentMove(d: Drill, path: PNode[], cards: Record<string, Card>, now: number, anyLine: boolean, rnd = Math.random): PNode | null {
  const moves = nextMoves(d, path).filter((n) => anyLine || hasWork(d, n, cards, now));
  if (!moves.length) return null;
  const stats = path.length ? path[path.length - 1].stats : d.chapter.start.stats;
  const weights = moves.map((n) => {
    const m = stats?.moves.find(([s]) => bareSan(s) === bareSan(n.san));
    return m ? Math.max(m[1], 0.005) : 1 / moves.length;
  });
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < moves.length; i++) {
    r -= weights[i];
    if (r <= 0) return moves[i];
  }
  return moves[moves.length - 1];
}

/** One's own move played on the board, against the session's moves here:
 *  the move it is, or null when it is not one of them. */
export function matchOwn(d: Drill, path: PNode[], uci: string): PNode | null {
  return nextMoves(d, path).find((n) => n.uci === uci) ?? null;
}

/** "Nf3 — 62% of games, scores 55%": the book's move here with the
 *  database's figures for it, where it has them. */
export function describeBookMove(node: PNode, stats: Stats | undefined): string {
  const m = stats?.moves.find(([s]) => bareSan(s) === bareSan(node.san));
  if (!m) return node.san;
  return `${node.san} — ${Math.round(m[1] * 100)}% of games, scores ${Math.round(m[2] * 100)}%`;
}

/** The FEN after `path`. */
export function fenAfter(d: Drill, path: PNode[]): string {
  if (!path.length) return d.startFen;
  const last = path[path.length - 1];
  const board = new Chess(d.fenBefore.get(last) ?? d.startFen);
  try { board.move(last.san); } catch { /* the chapter's moves are legal */ }
  return board.fen();
}
