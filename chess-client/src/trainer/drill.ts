// The drill (#327): the opponent's moves are played, chosen by how often
// they are played; one's own moves are entered on the board. Each of one's
// moves is a card — keyed by position and move, so it is the same card in
// every chapter and session it turns up in — on a spaced-repetition
// schedule: a card missed comes back in the same session, one known comes
// back later and later. A move never met is new: shown first, then asked;
// a day takes in only so many new moves of a chapter (`newToday`). See
// docs/design/opening-repertoire.md, "Training: study and drill". Works on
// the package alone, so the phone shares it.

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

/** A new move, shown for the first time: due again at once, so it is asked
 *  later in the same session — then on the schedule. */
export const introduce = (now: number): Card => ({ box: 0, due: now, right: 0, wrong: 0, last: now });

/** Whether a move is to be practised now: met before and due, or new while
 *  the day still takes new moves. */
export const isWork = (card: Card | undefined, now: number, newAllowed: boolean) => (card ? card.due <= now : newAllowed);

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

/** A move to practise at or below this one, on the session's lines: a
 *  card due, or a new one while new moves are `newAllowed`. */
export function hasWork(d: Drill, node: PNode, cards: Record<string, Card>, now: number, newAllowed = true): boolean {
  const key = d.cardOf.get(node);
  if (key && isWork(cards[key], now, newAllowed)) return true;
  return node.children.some((c) => d.inSession.has(c) && hasWork(d, c, cards, now, newAllowed));
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

/** What happens at a position (`path` its moves): the opponent to reply;
 *  one's own move to answer (`ask`) or — new — to be shown first (`show`); a
 *  move known and not due played by itself towards a move to practise
 *  further on (`auto`); or the line done (nothing to practise below). With
 *  `anyLine` every line and move counts, the schedule aside. */
export type Step = { kind: "opponent" } | { kind: "ask" | "show" | "auto"; move: PNode } | { kind: "done" };

export function nextStep(d: Drill, path: PNode[], cards: Record<string, Card>, now: number, newAllowed: boolean, anyLine: boolean): Step {
  const moves = nextMoves(d, path);
  if (!moves.length) return { kind: "done" };
  if (sideToMove(path) !== d.color) {
    if (!anyLine && !moves.some((n) => hasWork(d, n, cards, now, newAllowed))) return { kind: "done" };
    return { kind: "opponent" };
  }
  const card = (n: PNode) => cards[d.cardOf.get(n) ?? ""];
  if (anyLine) return { kind: card(moves[0]) ? "ask" : "show", move: moves[0] };
  const ask = moves.find((n) => isWork(card(n), now, newAllowed));
  if (ask) return { kind: card(ask) ? "ask" : "show", move: ask };
  const on = moves.find((n) => hasWork(d, n, cards, now, newAllowed));
  return on ? { kind: "auto", move: on } : { kind: "done" };
}

/** The opponent's reply: one of the session's moves here that leads to a
 *  move to practise (any of them when `anyLine`), chosen at random by its
 *  share of the games; null when there is none — the line is done. */
export function opponentMove(d: Drill, path: PNode[], cards: Record<string, Card>, now: number, anyLine: boolean, newAllowed = true, rnd = Math.random): PNode | null {
  const moves = nextMoves(d, path).filter((n) => anyLine || hasWork(d, n, cards, now, newAllowed));
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

/** How a line's last position ends the game, if it does — nothing there for
 *  Stockfish to evaluate (the server leaves such ends out). */
export function lineOver(d: Drill, moves: PNode[]): "checkmate" | "stalemate" | null {
  const board = new Chess(fenAfter(d, moves));
  return board.isCheckmate() ? "checkmate" : board.isStalemate() ? "stalemate" : null;
}

// ── New moves a day ──────────────────────────────────────────────────────────

/** New moves a day, by default; 0 for no limit. */
export const NEW_PER_DAY = 15;
export const NEW_PER_DAY_CHOICES = [5, 10, 15, 25, 0];

/** Today's new moves of a chapter: how many were met, and how many more the
 *  day was given ("Learn 15 more today"). Kept in this device's storage. */
export interface NewToday { day: string; met: number; extra: number }

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const DAY_KEY = "lpdoDrillNewToday";
const PER_DAY_KEY = "lpdoDrillNewPerDay";

function readDays(): Record<string, NewToday> {
  try { return JSON.parse(localStorage.getItem(DAY_KEY) ?? "{}") ?? {}; } catch { return {}; }
}

export function newToday(chapterId: number): NewToday {
  const t = readDays()[chapterId];
  return t && t.day === today() ? t : { day: today(), met: 0, extra: 0 };
}

export function saveNewToday(chapterId: number, t: NewToday): void {
  const all = readDays();
  // Only today's are worth keeping.
  for (const k of Object.keys(all)) if (all[k].day !== t.day) delete all[k];
  all[chapterId] = t;
  try { localStorage.setItem(DAY_KEY, JSON.stringify(all)); } catch { /* not kept */ }
}

export function newPerDay(): number {
  try { const v = Number(localStorage.getItem(PER_DAY_KEY)); return localStorage.getItem(PER_DAY_KEY) !== null && Number.isFinite(v) ? v : NEW_PER_DAY; } catch { return NEW_PER_DAY; }
}

export function saveNewPerDay(n: number): void {
  try { localStorage.setItem(PER_DAY_KEY, String(n)); } catch { /* not kept */ }
}

