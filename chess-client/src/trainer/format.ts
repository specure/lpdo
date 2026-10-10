// The practice package (#327): a chapter enriched with the database's
// figures, as it goes to the phone — `lpdo-chapter`, version 1. See
// docs/design/opening-repertoire.md, "The chapter format".
//
// Everything under src/trainer/ works on this format alone — no server
// calls, no app state — so the phone trainer can share it as it is.

export const FORMAT = "lpdo-chapter";
export const VERSION = 1;

export type Side = "white" | "black";

/** A stored engine evaluation, from White's side. */
export type Eval = { cp: number } | { mate: number };

/** What the database knows of a position (the one after a node's move, or
 *  the start position). `moves`: [SAN, share of the games, score for the
 *  side playing it] — the most played moves and every move the chapter has
 *  here, most played first. */
export interface Stats {
  games: number;
  moves: [string, number, number][];
  eval?: Eval;
}

/** One's own games through a position — with the book's colour, from the
 *  period the package's `mine` says: how many, one's wins, draws, losses
 *  from there, a performance rating (with three rated opponents or more),
 *  and the moves played next with how often. */
export interface Mine {
  games: number;
  w: number;
  d: number;
  l: number;
  perf: number | null;
  moves: [string, number][];
}

export interface PNode {
  san: string;
  uci: string;
  /** Own moves only (the book's colour): the position's hash + the move in
   *  UCI — the key a card's history is kept under. */
  card?: string;
  /** Comment after the move; `pre`: before it (a variation's intro). */
  comment?: string;
  pre?: string;
  nags?: number[];
  /** Arrows and circles as PGN codes: "Gc4c5", "Rd4". */
  arrows?: string[];
  circles?: string[];
  /** Switched off: not in the repertoire from here (the node and below). */
  off?: true;
  /** The position after the move. */
  stats?: Stats;
  /** One's own games through the position after the move. */
  mine?: Mine;
  /** The moves from the position after this one, in the chapter's order —
   *  the first is the main line. */
  children: PNode[];
}

export interface LpdoChapter {
  format: typeof FORMAT;
  version: typeof VERSION;
  /** Which chapter, which version; `ord`: its place in the book — the
   *  phone lists a book's chapters in the book's order (absent from
   *  packages made before it was sent). */
  chapter: { id: number; updated: string | null; ord?: number };
  sent: string;
  book: { name: string; author: string | null; color: Side };
  name: string;
  /** A branch to start from, as the SAN path to it; null for none. */
  focus: string[] | null;
  /** Which of one's own games the `mine` figures count: with `color`, from
   *  `since` (null: all) — `games` of them; absent when one's player is not
   *  known. */
  mine?: { color: Side; since: string | null; games: number };
  /** The start position: the chapter's intro and the database's figures. */
  start: { comment?: string; stats?: Stats; mine?: Mine };
  /** The moves from the start position. */
  tree: PNode[];
}

/** SAN without check marks or annotation glyphs — how moves are compared. */
export const bareSan = (san: string) => san.replace(/[+#!?]+$/, "");

/** A package's problems, or none — for one read from a file or a scan. */
export function validate(x: unknown): string | null {
  const c = x as Partial<LpdoChapter> | null;
  if (!c || typeof c !== "object") return "not a chapter";
  if (c.format !== FORMAT) return "not an LPDO chapter";
  if (typeof c.version !== "number" || c.version > VERSION) return `version ${c.version} is newer than this trainer reads (${VERSION})`;
  if (!Array.isArray(c.tree) || !c.book || !c.chapter) return "an incomplete chapter";
  return null;
}
