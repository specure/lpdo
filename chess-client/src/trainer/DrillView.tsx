// The drill on a chapter's package (#327): the session's lines up to a
// coverage of the games; the opponent's moves played by their share, one's
// own entered on the board. Only what is to be practised is asked: a move due
// again, or a new one — shown first (the book's move with an arrow, to be
// played), asked later in the session, then on the schedule. A move known and
// not due is played by itself, quickly, so a line starts where the work is. A
// day takes in only so many new moves of a chapter; once they are met, more
// can be added for the day. A miss shows the book's move with the database's
// figures, to be played; its card comes back in the session. A line with a
// miss stops at its end, for one of two: tested again — the same moves, the
// opponent's played, one's own asked where due or new and played by
// themselves where known, a miss counting as one — or reviewed: stepped
// through by hand (⏮ ◀ ▶ ⏭, the arrow keys, a swipe on the phone, a move
// tapped in the text) with the chapter's comments, the moves' figures and
// Stockfish at the end, nothing asked. Test and review are switched at any
// point of a line, from where one is; the session's lines are walked back
// and forth (‹ Previous · Next ›) at any point, the next after the last
// being a new line of the drill. What there is to know is in tabs — the
// line, the comments, the engine, the database's figures, the session.
// Shared by the desktop (the Repertoire page) and the phone trainer.

import { useEffect, useMemo, useRef, useState } from "react";
import { bareSan, hasComments, type Eval, type LpdoChapter, type PNode } from "./format";
import {
  COVERAGE_CHOICES, NEW_PER_DAY_CHOICES, buildDrill, cardCounts, describeBookMove, drillCoverage, drillCut, fenAfter, introduce, lineOver,
  matchOwn, newPerDay, newToday, nextMoves, nextStep, opponentMove, review, saveCoverage, saveCut, saveNewPerDay, saveNewToday, sideToMove,
  type Card, type CardStore, type NewToday,
} from "./drill";
import DrillBoard, { BRANCH_COLOR, HINT_COLOR } from "./DrillBoard";
import { DRAW_COLORS } from "../lib/parseAnnotations";
import MoveStats from "./MoveStats";

interface Props {
  chapter: LpdoChapter;
  store: CardStore;
  onClose?: () => void;
}

/** own: a move to answer; show: a new move shown, to be played; missed: a
 *  miss, the book's move to be played; auto: a move known and not due,
 *  played by itself; opponent: the opponent's reply coming; lineEnd: a line
 *  with a miss done — test it again, review it, or the next; review: a line
 *  being reviewed; replayEnd: a test or a review done. */
type Phase = "loading" | "own" | "show" | "missed" | "auto" | "opponent" | "lineDone" | "lineEnd" | "review" | "replayEnd" | "sessionDone";

/** How a line is gone through: tested — the drill, or the same moves again —
 *  or reviewed, nothing asked. */
type Mode = "test" | "review";

/** A line of the session: its moves, and where it had a miss (plies). */
interface LineRec { moves: PNode[]; missed: number[] }

type Tab = "line" | "tree" | "comments" | "engine" | "reference" | "session";
const TABS: { id: Tab; label: string }[] = [
  { id: "line", label: "Line" }, { id: "tree", label: "Tree" }, { id: "comments", label: "Comments" }, { id: "engine", label: "Engine" },
  { id: "reference", label: "Reference" }, { id: "session", label: "Session" },
];
const TAB_KEY = "lpdoDrillTab";
const readTab = (): Tab => { try { const v = localStorage.getItem(TAB_KEY); return TABS.some((t) => t.id === v) ? (v as Tab) : "line"; } catch { return "line"; } };

/** A line as text, "1.c4 e5 2.g3 Nc6 …": the moves missed marked, and the
 *  one the replay is at; a move tapped goes there (`onPick`, its index). With
 *  `more`, the line goes on past what is shown (a test's moves to come). */
function LineText({ moves, missed, at, onPick, more }: { moves: PNode[]; missed: number[]; at?: number; onPick?: (i: number) => void; more?: boolean }) {
  return (
    <div className="font-mono text-label-md leading-relaxed">
      {moves.map((m, i) => (
        <span key={i}>
          {i % 2 === 0 ? `${i / 2 + 1}.` : i === 0 ? "1…" : ""}
          <span onClick={onPick && (() => onPick(i))}
            className={`${missed.includes(i) ? "text-error font-semibold" : ""} ${at === i ? "underline underline-offset-2" : ""} ${onPick ? "cursor-pointer rounded-sm hover:bg-on-surface/8" : ""}`}>
            {m.san}
          </span>{" "}
        </span>
      ))}
      {moves.length === 0 && <span className="text-on-surface-variant">The start position </span>}
      {more && <span className="text-on-surface-variant">…</span>}
    </div>
  );
}

/** The chapter's tree (the Tree tab): a line's moves in a row, each
 *  variation on its own line under it, indented, in the chapter's order.
 *  The line at hand in bold, the session's other lines plain, lines the
 *  coverage leaves out greyed, switched-off ones struck. The move at hand is
 *  marked and scrolled to. A move tapped: `pick` with the moves to it. */
function Tree({ nodes, path, inSession, onLine, at, pick, depth = 0 }: {
  nodes: PNode[]; path: PNode[]; inSession: Set<PNode>; onLine: Set<PNode>; at: PNode | null; pick: (path: PNode[]) => void; depth?: number;
}) {
  const main: PNode[] = [];
  const variations: { prefix: PNode[]; nodes: PNode[] }[] = [];
  let level = nodes, prefix = path;
  while (level.length) {
    const n = level[0];
    main.push(n);
    if (level.length > 1) variations.push({ prefix, nodes: level.slice(1) });
    prefix = [...prefix, n];
    level = n.children;
  }
  return (
    <div className={depth ? "pl-2.5 ml-1 border-l border-outline/30" : ""}>
      <div className="font-mono text-label-md leading-relaxed">
        {main.map((n, i) => {
          const p = path.length + i;
          const num = p % 2 === 0 ? `${p / 2 + 1}.` : i === 0 ? `${Math.floor(p / 2) + 1}…` : "";
          const here = n === at;
          const tone = n.off ? "line-through text-on-surface-variant/50" : onLine.has(n) ? "font-semibold text-primary" : inSession.has(n) ? "text-on-surface" : "text-on-surface-variant/50";
          return (
            <span key={n.uci + i}>
              <span className="text-on-surface-variant/70">{num}</span>
              <span onClick={() => pick([...path, ...main.slice(0, i + 1)])}
                ref={here ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                className={`cursor-pointer rounded-sm hover:bg-on-surface/8 ${tone} ${here ? "underline underline-offset-2 bg-primary/15" : ""}`}>
                {n.san}
              </span>{" "}
            </span>
          );
        })}
      </div>
      {variations.map((v) => v.nodes.map((n) => (
        <Tree key={`${v.prefix.length}-${n.uci}`} nodes={[n]} path={v.prefix} inSession={inSession} onLine={onLine} at={at} pick={pick} depth={depth + 1} />
      )))}
    </div>
  );
}

/** The replay's steps, drawn: as characters iOS shows them as emoji. */
const STEP_ICONS = {
  first: "M6 5h2v14H6zM19 5v14L9 12z",
  back: "M17 5v14L6 12z",
  on: "M7 5v14l11-7z",
  last: "M5 5v14l10-7zM16 5h2v14h-2z",
};

/** The chapter's other moves drawn as arrows in a review, the most played;
 *  the rest are only listed. */
const BRANCH_ARROWS = 3;

/** A review's arrows: the book's (its arrows and circles on the move just
 *  played) or the moves here (the line's and the chapter's others) — one at
 *  a time, the two together being a muddle. The choice is kept. */
type Layer = "book" | "moves";
const LAYER_KEY = "lpdoReviewArrows";
const readLayer = (): Layer | null => { try { const v = localStorage.getItem(LAYER_KEY); return v === "book" || v === "moves" ? v : null; } catch { return null; } };

/** A PGN colour code ("G", "R"…) as the desktop draws it. */
const bookColor = (code: string) => (DRAW_COLORS.find((d) => d.code === code) ?? DRAW_COLORS[0]).rgba;
const squares = (uci: string) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
/** "+0.35", "−1.20", "#3", "−#2": an evaluation from White's side. */
const fmtEval = (e: Eval) => ("mate" in e
  ? `${e.mate > 0 ? "" : "−"}#${Math.abs(e.mate)}`
  : `${e.cp > 0 ? "+" : e.cp < 0 ? "−" : ""}${(Math.abs(e.cp) / 100).toFixed(2)}`);

export default function DrillView({ chapter, store, onClose }: Props) {
  const [coverage, setCoverage] = useState(() => drillCoverage());
  const [cut, setCut] = useState(() => drillCut());
  const drill = useMemo(() => buildDrill(chapter, coverage, cut), [chapter, coverage, cut]);
  const chapterId = chapter.chapter.id;
  const [perDay, setPerDay] = useState(() => newPerDay());
  const [today, setToday] = useState<NewToday>(() => newToday(chapterId));
  const [cards, setCards] = useState<Record<string, Card> | null>(null);
  const [path, setPath] = useState<PNode[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  // The move the phase is about: to answer, shown, missed, or played by itself.
  const [target, setTarget] = useState<PNode | null>(null);
  // After the session: keep drilling, the schedule aside.
  const [anyLine, setAnyLine] = useState(false);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [note, setNote] = useState<{ text: string; tone: "good" | "bad" | "info" } | null>(null);
  const [tally, setTally] = useState({ right: 0, wrong: 0, fresh: 0 });
  // The cards answered in this line: a retry after a miss does not count.
  const answered = useRef(new Set<string>());
  // Where this run of the line had a miss (its plies).
  const [missedPlies, setMissedPlies] = useState<number[]>([]);
  // The session's lines so far, in order, and which of them is at hand —
  // null while the drill's own line is in progress (it joins them when it
  // is done, or left).
  const [lines, setLines] = useState<LineRec[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  // The moves of the line tested again or reviewed (null: drilling).
  const [replaying, setReplaying] = useState<PNode[] | null>(null);
  // The line reviewed (stepped through), not tested.
  const [reviewing, setReviewing] = useState(false);
  const [layer, setLayer] = useState<Layer | null>(readLayer);
  const [tab, setTab] = useState<Tab>(readTab);
  // On the phone: the board shrunk to give the panel room, while one reads.
  const [roomy, setRoomy] = useState(false);
  const board = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number; t: number; onBoard: boolean } | null>(null);

  useEffect(() => { void store.all().then(setCards); }, [store]);

  const color = drill.color;
  const budget = perDay === 0 ? Infinity : perDay + today.extra;
  const allowed = (t: NewToday = today, any = anyLine) => any || perDay === 0 || t.met < perDay + t.extra;

  /** What happens at `p`, and the move it is about. Tested again: the
   *  line's next move — the opponent's played; one's own asked where due,
   *  shown where never met, played by itself where known and not due (all
   *  asked when every line counts). Reviewed: nothing until a step. */
  const phaseAt = (p: PNode[], cs: Record<string, Card>, any: boolean, t: NewToday, rp: PNode[] | null, rv = reviewing): { phase: Phase; target: PNode | null } => {
    if (rp) {
      if (p.length >= rp.length) return { phase: "replayEnd", target: null };
      const move = rp[p.length];
      if (rv) return { phase: "review", target: move };
      if (sideToMove(p) !== color) return { phase: "opponent", target: move };
      const key = drill.cardOf.get(move);
      const card = key ? cs[key] : undefined;
      const kind: Phase = !key ? "own" : !card ? "show" : any || card.due <= Date.now() ? "own" : "auto";
      return { phase: kind, target: move };
    }
    const step = nextStep(drill, p, cs, Date.now(), allowed(t, any), any);
    if (step.kind === "done") return { phase: "lineDone", target: null };
    if (step.kind === "opponent") return { phase: "opponent", target: null };
    return { phase: step.kind === "ask" ? "own" : step.kind, target: step.move };
  };

  const go = (p: PNode[], cs: Record<string, Card> = cards ?? {}, any = anyLine, t: NewToday = today, rp: PNode[] | null = replaying, rv = reviewing) => {
    setPath(p);
    setLastMove(p.length ? squares(p[p.length - 1].uci) : null);
    const next = phaseAt(p, cs, any, t, rp, rv);
    setPhase(next.phase);
    setTarget(next.target);
  };

  /** `moves` on down the chapter's main continuation, to the end of the line. */
  const extend = (moves: PNode[]) => {
    const out = [...moves];
    for (let next = nextMoves(drill, out)[0]; next; next = nextMoves(drill, out)[0]) out.push(next);
    return out;
  };

  /** A new line of the drill. */
  const startLine = (cs: Record<string, Card>, any: boolean, t: NewToday = today) => {
    answered.current = new Set();
    setReplaying(null);
    setReviewing(false);
    setMissedPlies([]);
    setCursor(null);
    const first = phaseAt([], cs, any, t, null, false);
    // Nothing to do from the start: the session is over.
    if (first.phase === "lineDone") { setPhase("sessionDone"); setTarget(null); setPath([]); setLastMove(null); return; }
    setNote(null);
    go([], cs, any, t, null, false);
  };

  /** The line tested again from the ply `at` (its start by default): one's
   *  moves asked where due, the opponent's played; a miss counts — once a
   *  move, as in the drill. */
  const testAgain = (moves: PNode[], at = 0) => {
    answered.current = new Set();
    setReplaying(moves);
    setReviewing(false);
    setMissedPlies([]);
    setNote(null);
    go(moves.slice(0, at), cards ?? {}, anyLine, today, moves, false);
  };

  /** The line reviewed, from the ply `at` (its start by default). */
  const reviewLine = (moves: PNode[], at = 0) => {
    setReplaying(moves);
    setReviewing(true);
    setNote(null);
    go(moves.slice(0, at), cards ?? {}, anyLine, today, moves, true);
  };

  /** The line at hand among the session's lines — the drill's line in
   *  progress joins them (its moves so far on down the chapter's main
   *  continuation): the lines, and its index. */
  const keepLine = (): { ls: LineRec[]; i: number } => {
    if (cursor !== null) return { ls: lines, i: cursor };
    const ls = [...lines, { moves: replaying ?? extend(path), missed: missedPlies }];
    setLines(ls);
    setCursor(ls.length - 1);
    return { ls, i: ls.length - 1 };
  };

  /** One of the session's lines, in the mode at hand. */
  const openLine = (ls: LineRec[], i: number) => {
    setCursor(i);
    if (reviewing) reviewLine(ls[i].moves); else testAgain(ls[i].moves);
  };

  const canPrev = cursor !== null ? cursor > 0 : lines.length > 0;
  const canNext = phase !== "loading" && ((cursor !== null && cursor + 1 < lines.length) || phase !== "sessionDone");

  /** The line before this one — the drill's line in progress kept, to come
   *  back to. */
  const prevLine = () => {
    let ls = lines, i = cursor ?? lines.length;
    if (cursor === null && path.length) ({ ls, i } = keepLine());
    if (i <= 0) return;
    openLine(ls, i - 1);
  };

  /** The line after this one; after the last, a new line of the drill. */
  const nextLine = () => {
    if (!cards) return;
    if (cursor !== null && cursor + 1 < lines.length) { openLine(lines, cursor + 1); return; }
    if (cursor === null && path.length && phase !== "sessionDone") keepLine();
    startLine(cards, anyLine);
  };

  /** Test or review, from where one is in the line — at its end (or the
   *  mode already on, at its end), from the start. */
  const setMode = (m: Mode) => {
    if (!cards || phase === "loading") return;
    let at: { ls: LineRec[]; i: number } | null;
    if (phase === "sessionDone" && cursor === null) at = lines.length ? { ls: lines, i: lines.length - 1 } : null;
    else at = keepLine();
    if (!at) return;
    const moves = replaying ?? at.ls[at.i].moves;
    const over = atEnd || phase === "sessionDone" || path.length >= moves.length;
    const from = over ? 0 : path.length;
    if (m === "review") {
      if (reviewing && !over) return;
      reviewLine(moves, from);
    } else {
      if (!reviewing && !over) return; // testing already
      testAgain(moves, from);
    }
  };

  /** A step through the line reviewed, to the ply `to` (clamped). */
  const step = (to: number) => {
    if (!replaying || !reviewing) return;
    const at = Math.max(0, Math.min(replaying.length, to));
    if (at !== path.length) go(replaying.slice(0, at));
  };

  // The arrow keys, Home and End step through a review.
  useEffect(() => {
    if (!replaying || !reviewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, select, textarea")) return;
      const to = e.key === "ArrowLeft" ? path.length - 1 : e.key === "ArrowRight" ? path.length + 1
        : e.key === "Home" ? 0 : e.key === "End" ? replaying.length : null;
      if (to === null) return;
      e.preventDefault();
      step(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaying, reviewing, path]);

  // A new session: the cards read, or the lines changed.
  useEffect(() => {
    if (!cards) return;
    setAnyLine(false);
    setTally({ right: 0, wrong: 0, fresh: 0 });
    setLines([]);
    startLine(cards, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards === null, drill]);

  // The opponent's move, after a moment; a known move, quickly.
  useEffect(() => {
    if (!cards) return;
    if (phase === "opponent" && replaying && target) {
      const t = window.setTimeout(() => go([...path, target]), 450);
      return () => window.clearTimeout(t);
    }
    if (phase === "opponent") {
      const t = window.setTimeout(() => {
        const pick = opponentMove(drill, path, cards, Date.now(), anyLine, allowed());
        if (!pick) { setPhase("lineDone"); return; }
        go([...path, pick]);
      }, 450);
      return () => window.clearTimeout(t);
    }
    if (phase === "auto" && target) {
      const t = window.setTimeout(() => go([...path, target]), 250);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, path]);

  // The drill's line done: it joins the session's lines, to come back to;
  // with a miss it waits — test it again, review it, or the next; else the
  // next one, after a moment.
  useEffect(() => {
    if (phase !== "lineDone" || !cards) return;
    // On to its end — where the run stopped (nothing further due) the
    // chapter's main continuation, to the end of the line.
    const ls = [...lines, { moves: extend(path), missed: missedPlies }];
    setLines(ls);
    setCursor(ls.length - 1);
    if (missedPlies.length) { setPhase("lineEnd"); return; }
    const t = window.setTimeout(() => startLine(cards, anyLine), 1100);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const keep = (key: string, card: Card) => {
    const next = { ...(cards ?? {}), [key]: card };
    setCards(next);
    void store.put(key, card);
    return next;
  };

  /** One's move answered: its card on, or back. */
  const answer = (node: PNode, correct: boolean) => {
    const key = drill.cardOf.get(node);
    if (!key || !cards || answered.current.has(key)) return cards ?? {};
    answered.current.add(key);
    setTally((t) => (correct ? { ...t, right: t.right + 1 } : { ...t, wrong: t.wrong + 1 }));
    return keep(key, review(cards[key], correct, Date.now()));
  };

  /** The figures of the position at hand: the moves from it. */
  const statsHere = () => (path.length ? path[path.length - 1].stats : chapter.start.stats);

  const onMove = (uci: string): boolean => {
    // In a test of a line, its move is the one asked; another of the
    // session's moves here is a miss.
    const node = replaying ? (target?.uci === uci ? target : null) : matchOwn(drill, path, uci);
    if (phase === "show") {
      // A new move: played as shown, it is met — asked later in the session.
      if (!node || node !== target) return false;
      const key = drill.cardOf.get(node);
      let cs = cards ?? {};
      let t = today;
      if (key && !cs[key]) {
        cs = keep(key, introduce(Date.now()));
        t = { ...today, met: today.met + 1 };
        setToday(t);
        saveNewToday(chapterId, t);
        setTally((x) => ({ ...x, fresh: x.fresh + 1 }));
      }
      if (key) answered.current.add(key);
      setNote({ text: `New: ${node.san} — it comes again shortly`, tone: "info" });
      go([...path, node], cs, anyLine, t);
      return true;
    }
    if (phase === "missed") {
      if (!node) return false;
      setNote(null);
      go([...path, node]);
      return true;
    }
    if (phase !== "own") return false;
    if (node) {
      // Right. Tested again, a move right moves no card on — it was just seen.
      const cs = replaying ? cards ?? {} : answer(node, true);
      setNote({ text: `✓ ${node.san}`, tone: "good" });
      go([...path, node], cs);
      return true;
    }
    // A miss: the move asked comes back, shown with its figures; the line
    // stops at its end, to be replayed.
    const main = target ?? nextMoves(drill, path)[0];
    if (!main) return false;
    answer(main, false);
    setMissedPlies((m) => (m.includes(path.length) ? m : [...m, path.length]));
    setNote({ text: `The book move is ${describeBookMove(main, statsHere())}`, tone: "bad" });
    setPhase("missed");
    setTarget(main);
    return false;
  };

  const counts = cards ? cardCounts(drill, cards, Date.now()) : null;
  const fen = fenAfter(drill, path);
  const promotions = Object.fromEntries((replaying ? replaying.slice(path.length, path.length + 1) : nextMoves(drill, path)).filter((n) => n.uci.length === 5).map((n) => [n.uci.slice(0, 4), n.uci[4]]));
  const s = drill.session;
  const hint = (phase === "show" || phase === "missed") && target ? squares(target.uci) : null;
  // In a review, where the chapter branches: the line's move and the
  // chapter's others here (not those switched off), the most played first.
  const here = path.length ? path[path.length - 1].children : chapter.tree;
  const shareHere = (n: PNode) => statsHere()?.moves.find(([san]) => bareSan(san) === bareSan(n.san))?.[1] ?? 0;
  const branches = phase === "review" && target
    ? here.filter((n) => n !== target && !n.off).sort((a, b) => shareHere(b) - shareHere(a))
    : [];
  const movesLayer = branches.length > 0 && !!target;
  // The book's arrows and circles on the move just played.
  const lastPlayed = path.length ? path[path.length - 1] : null;
  const bookArrows = reviewing && lastPlayed ? (lastPlayed.arrows ?? []).map((c) => ({ from: c.slice(1, 3), to: c.slice(3, 5), color: bookColor(c[0]) })) : [];
  const bookCircles = reviewing && lastPlayed ? (lastPlayed.circles ?? []).map((c) => ({ square: c.slice(1, 3), color: bookColor(c[0]) })) : [];
  const bookLayer = bookArrows.length + bookCircles.length > 0;
  // Both: the kept choice, else the book's (the author's own); one: that one.
  const shown: Layer | null = bookLayer && movesLayer ? (layer ?? "book") : bookLayer ? "book" : movesLayer ? "moves" : null;
  const arrows = shown === "book" ? bookArrows
    : shown === "moves" && target
      // The line's last: drawn on top.
      ? [...branches.slice(0, BRANCH_ARROWS).map((n) => ({ ...squares(n.uci), color: BRANCH_COLOR })), { ...squares(target.uci), color: HINT_COLOR }]
      : [];
  const pickLayer = (l: Layer) => { setLayer(l); try { localStorage.setItem(LAYER_KEY, l); } catch { /* per-device convenience only */ } };
  const pickTab = (t: Tab) => { setTab(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* per-device convenience only */ } };
  /** The chapter's line through the moves `p`: on down its main
   *  continuation (switched-off moves aside), joining the session's lines —
   *  the drill's line in progress kept first — and reviewed from the ply
   *  `at` (a test, if one is on, is left). */
  const openLineThrough = (p: PNode[], at: number) => {
    if (!cards) return;
    const moves = [...p];
    for (let next = moves[moves.length - 1]?.children.find((c) => !c.off); next; next = next.children.find((c) => !c.off)) moves.push(next);
    let ls = lines;
    if (cursor === null && path.length) ({ ls } = keepLine());
    const next = [...ls, { moves, missed: [] }];
    setLines(next);
    setCursor(next.length - 1);
    reviewLine(moves, at);
  };
  /** Another of the chapter's moves here reviewed instead. */
  const reviewBranch = (n: PNode) => openLineThrough([...path, n], path.length);
  const budgetUsed = perDay > 0 && today.met >= budget;
  const boardActive = phase === "own" || phase === "show" || phase === "missed";
  const mode: Mode = reviewing ? "review" : "test";
  const atEnd = phase === "lineEnd" || phase === "replayEnd";
  // The line at hand, as a record: the one replayed or the drill's just done.
  const atLine = cursor !== null ? lines[cursor] : null;
  // The line's moves, when they are known: in a replay, or the drill's done
  // (in progress, the opponent may still turn either way).
  const lineMoves = replaying ?? (atEnd ? atLine?.moves ?? null : null);
  // The line at hand's moves, for the tree: the drill's in progress on
  // down the main continuation.
  const onLine = useMemo(() => new Set(lineMoves ?? (cursor !== null ? atLine?.moves ?? [] : extend(path))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lineMoves, cursor, atLine, path, drill]);

  const status = phase === "loading" ? "Reading your cards…"
    : phase === "review" ? "Reviewing the line"
    : phase === "own" ? "Your move"
    : phase === "show" ? "New move — play it"
    : phase === "missed" ? "Play the book move"
    : phase === "opponent" || phase === "auto" ? "…"
    : phase === "lineDone" ? "Line done"
    : phase === "lineEnd" ? "Line done — Test it again, Review it, or Next"
    : phase === "replayEnd" ? (reviewing ? "End of the line — Test it, or Next" : "Test done — again, Review it, or Next")
    : anyLine ? "Every line drilled" : "Done for today";
  // The chapter's comment on the move at hand — in a review, the move just
  // played, where the line is being understood; in the drill and a test, the
  // move shown or missed (before, it could give away the move).
  const commentOn = reviewing ? lastPlayed : phase === "missed" || phase === "show" ? target : null;
  const comment = reviewing && !lastPlayed ? chapter.start.comment : commentOn?.comment;
  const pre = commentOn?.pre;
  const pill = "h-8 px-3 rounded-full text-label-md hover:brightness-110";
  const tool = "h-8 px-2 rounded-md text-label-md text-primary hover:bg-primary/8 disabled:opacity-35 disabled:hover:bg-transparent";
  const withComments = useMemo(() => hasComments(chapter), [chapter]);
  // The figures to show: a new or missed move, the book's, where it stands;
  // in a review the move just played; in a test the opponent's move just
  // played (one's own would give away the book's reply).
  const ownLast = lastPlayed ? sideToMove(path.slice(0, -1)) === color : false;
  const figures = (phase === "show" || phase === "missed") && target
    ? { move: target, ply: path.length, stats: statsHere(), own: true }
    : lastPlayed && (reviewing || !ownLast)
      ? { move: lastPlayed, ply: path.length - 1, stats: path.length >= 2 ? path[path.length - 2].stats : chapter.start.stats, own: ownLast }
      : null;
  const mineHere = lastPlayed ? lastPlayed.mine : chapter.start.mine;
  const evalHere = statsHere()?.eval;
  const endEval = lineMoves ? lineMoves[lineMoves.length - 1]?.engine : undefined;

  const learnMore = () => {
    if (!cards) return;
    const t = { ...today, extra: today.extra + perDay };
    setToday(t);
    saveNewToday(chapterId, t);
    startLine(cards, false, t);
  };

  /** The move text of the line at hand: in a review, the whole line, the
   *  move tapped stepped to; in a test, the moves so far (the rest would be
   *  given away), the move tapped reviewed from there; the drill's line
   *  done, whole, with its misses. */
  const lineTab = () => {
    const missed = [...new Set([...(atLine?.missed ?? []), ...missedPlies])];
    if (replaying && reviewing) {
      return <LineText moves={replaying} missed={missed} at={path.length - 1} onPick={(i) => step(i + 1)} />;
    }
    if (atEnd && atLine) {
      return <LineText moves={atLine.moves} missed={missed} onPick={(i) => reviewLine(atLine.moves, i + 1)} />;
    }
    return <LineText moves={path} missed={missed} more={phase !== "sessionDone"}
      onPick={cards ? (i) => { const { ls, i: k } = keepLine(); reviewLine(replaying ?? ls[k].moves, i + 1); } : undefined} />;
  };

  return (
    <div className="h-full w-full flex flex-col bg-surface text-on-surface touch-pan-y overscroll-x-none"
      // A swipe in a review steps a move: to the left on, to the right back
      // (as turning a page). Not one begun on a piece to be moved. The
      // browser leaves sideways swipes alone here (pan-y): a swipe to the
      // right was going back a page in Chrome.
      onTouchStart={(e) => {
        const t = e.touches[0];
        const onBoard = !!board.current?.contains(e.target as Node);
        swipe.current = reviewing && e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: Date.now(), onBoard } : null;
      }}
      onTouchEnd={(e) => {
        const s0 = swipe.current;
        swipe.current = null;
        if (!s0 || !reviewing) return;
        if (s0.onBoard && boardActive) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - s0.x, dy = t.clientY - s0.y;
        if (Math.abs(dx) < 40 || Math.abs(dx) < 2 * Math.abs(dy) || Date.now() - s0.t > 800) return;
        step(path.length + (dx < 0 ? 1 : -1));
      }}>
      {/* On a short screen (the phone sideways) one line. */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 short:py-1 border-b border-outline/40">
        <div className="min-w-0 flex-1 short:flex short:items-baseline short:gap-2">
          <div className="text-body-md truncate short:text-label-md">{chapter.name}</div>
          <div className="text-label-sm text-on-surface-variant truncate short:min-w-0">{chapter.book.name} · as {color === "white" ? "White" : "Black"}</div>
        </div>
        <div className="text-label-sm text-on-surface-variant tabular-nums whitespace-nowrap" title="This session: right · missed">
          <span className="text-success">{tally.right}</span> · <span className="text-error">{tally.wrong}</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="h-8 px-3 rounded-full text-label-md text-primary hover:bg-primary/8">Close</button>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        {/* The board: on the phone (portrait) a square the width of the
            screen, whatever the panel says — a longer message must not
            shrink it or move it; on wider screens (the phone sideways, the
            desktop) a square of the height, the panel taking the rest of
            the width (at least 20rem of it). */}
        <div className={`shrink-0 w-full aspect-square ${roomy ? "max-h-[30dvh]" : "max-h-[60dvh]"} md:max-h-none md:w-auto md:h-full md:max-w-[calc(100%-20rem)] flex p-2`}>
          <div ref={board} className="flex-1 min-h-0 min-w-0 flex">
          <DrillBoard fen={fen} orientation={color} active={boardActive} onMove={onMove}
            promotions={promotions} lastMove={lastMove} hint={hint} arrows={arrows} circles={shown === "book" ? bookCircles : []} />
          </div>
        </div>
        <div className="flex-1 min-h-0 min-w-0 md:min-w-80 flex flex-col border-t md:border-t-0 md:border-l border-outline/40">
          <div className="shrink-0 px-3 pt-2 flex flex-col gap-2">
            {/* The session's lines, back and forth; test or review, from here. */}
            <div className="flex items-center gap-1">
              <button onClick={prevLine} disabled={!canPrev} className={tool} title="The line before this one">‹ Previous</button>
              <div className="flex-1 flex justify-center">
                <div className="inline-flex rounded-full border border-outline/40 overflow-hidden" role="group" aria-label="Test or review">
                  {(["test", "review"] as const).map((m) => (
                    <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m}
                      title={m === "test" ? "Your moves asked where due, the opponent's played; a miss counts. At the end: the line again" : "Step through the line with its comments, the moves' figures and Stockfish at the end; nothing asked"}
                      className={`h-7 px-3 text-label-md ${mode === m ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-on-surface/8"}`}>
                      {m === "test" ? "Test" : "Review"}
                    </button>
                  ))}
                </div>
              </div>
              <button onClick={nextLine} disabled={!canNext} className={tool} title="The line after this one; after the last, a new line">Next ›</button>
            </div>
            {/* Stepping through the review. */}
            {replaying && reviewing && (
              <div className="flex items-center gap-1">
                {([["first", 0, "To the start (Home)"], ["back", path.length - 1, "A move back (←)"], ["on", path.length + 1, "A move on (→)"], ["last", replaying.length, "To the end (End)"]] as const).map(([icon, to, title], i) => {
                  const off = i < 2 ? path.length === 0 : path.length >= replaying.length;
                  return (
                    <button key={icon} onClick={() => step(to)} disabled={off} title={title} aria-label={title}
                      className="h-9 flex-1 inline-flex items-center justify-center rounded-md bg-surface-container text-on-surface hover:bg-on-surface/8 disabled:opacity-35">
                      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current" aria-hidden="true"><path d={STEP_ICONS[icon]} /></svg>
                    </button>
                  );
                })}
              </div>
            )}
            <div className={`text-title-sm ${phase === "missed" ? "text-error" : phase === "show" ? "text-primary" : ""}`}>{status}</div>
            {/* A new move: the book's, and how it stands among the moves
                played here (the figures in Reference). */}
            {phase === "show" && target && (
              <div className="text-body-sm">The book plays {describeBookMove(target, statsHere())}</div>
            )}
            {phase !== "show" && note && (
              <div className={`text-body-sm ${note.tone === "bad" ? "text-on-surface" : note.tone === "good" ? "text-success" : "text-on-surface-variant"}`}>{note.text}</div>
            )}
            {phase === "sessionDone" && !anyLine && (
              <div className="text-body-sm">
                {tally.right + tally.wrong} reviewed · {tally.fresh} new
                {counts && counts.fresh > 0 && perDay > 0 && (
                  <> · {counts.fresh} new left in these lines — about {Math.ceil(counts.fresh / perDay)} {Math.ceil(counts.fresh / perDay) === 1 ? "day" : "days"} at {perDay} a day</>
                )}
              </div>
            )}
            {phase === "sessionDone" && cards && (
              <div className="flex gap-2 flex-wrap pb-1">
                {!anyLine && budgetUsed && counts && counts.fresh > 0 && (
                  <button onClick={learnMore} className={`${pill} bg-primary text-on-primary`}>
                    Learn {Math.min(perDay, counts.fresh)} more today
                  </button>
                )}
                <button onClick={() => { setAnyLine(true); startLine(cards, true); }} className={`${pill} bg-secondary-container text-on-secondary-container`}>
                  Keep drilling
                </button>
              </div>
            )}
          </div>

          {/* What there is to know, by kind; a dot where there is something
              here now one might not expect. */}
          <div className="shrink-0 mt-1 px-2 flex border-b border-outline/40 overflow-x-auto" role="tablist">
            {TABS.map((t) => {
              const dot = (t.id === "comments" && !!comment) || (t.id === "engine" && atEnd && !!endEval);
              return (
                <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => pickTab(t.id)}
                  className={`h-9 px-1.5 text-label-md whitespace-nowrap border-b-2 -mb-px ${tab === t.id ? "border-primary text-primary" : "border-transparent text-on-surface-variant hover:text-on-surface"}`}>
                  {t.label}
                  {dot && tab !== t.id && <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-primary align-middle" aria-label="something here" />}
                </button>
              );
            })}
            <button onClick={() => setRoomy((r) => !r)} aria-pressed={roomy} title={roomy ? "The board back to its size" : "More room to read: the board made small"}
              aria-label={roomy ? "The board back to its size" : "More room to read"}
              className="md:hidden ml-auto shrink-0 w-9 h-9 inline-flex items-center justify-center rounded-md text-on-surface-variant hover:bg-on-surface/8">
              <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current" aria-hidden="true">
                <path d={roomy ? "M12 20l-5-5h3V9H7l5-5 5 5h-3v6h3z" : "M7 14h10l-5 5zM7 10h10l-5-5z"} />
              </svg>
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3" role="tabpanel">
            {tab === "line" && (<>
              {lineTab()}
              {/* Both kinds of arrows here: which to draw. */}
              {bookLayer && movesLayer && (
                <div className="flex items-center gap-2 text-label-md">
                  <span className="text-on-surface-variant">Arrows</span>
                  <div className="inline-flex rounded-full border border-outline/40 overflow-hidden">
                    {(["book", "moves"] as const).map((l) => (
                      <button key={l} onClick={() => pickLayer(l)}
                        className={`h-7 px-3 ${shown === l ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-on-surface/8"}`}>
                        {l === "book" ? "Book" : "Moves"}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* The chapter's other moves here, in their arrows' colour: one
                  tapped is reviewed instead. */}
              {movesLayer && target && (
                <div className="text-label-md flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-on-surface-variant">Here the line plays</span>
                  <span className="font-mono font-semibold" style={{ color: HINT_COLOR }}>{target.san}</span>
                  <span className="text-on-surface-variant">· also in the chapter:</span>
                  {/* The most played drawn (in their colour when the moves are
                      shown); the rest only listed. */}
                  {branches.map((n, i) => (
                    <button key={n.uci} onClick={() => reviewBranch(n)} title="Review this one instead"
                      className={`font-mono font-semibold underline-offset-2 hover:underline ${shown === "moves" && i < BRANCH_ARROWS ? "" : "text-on-surface-variant"}`}
                      style={shown === "moves" && i < BRANCH_ARROWS ? { color: BRANCH_COLOR } : undefined}>{n.san}</button>
                  ))}
                </div>
              )}
              {!reviewing && phase !== "sessionDone" && phase !== "loading" && (
                <div className="text-label-sm text-on-surface-variant">A move tapped is reviewed from there.</div>
              )}
            </>)}
            {tab === "tree" && (<>
              <Tree nodes={chapter.tree} path={[]} inSession={drill.inSession} onLine={onLine} at={lastPlayed} pick={(p) => openLineThrough(p, p.length)} />
              <div className="text-label-sm text-on-surface-variant">
                <b className="font-semibold text-primary">Blue</b>: this line · plain: the session's others · grey: left out at {Math.round(coverage * 100)}% ·
                <s> struck</s>: switched off. A move tapped is reviewed from there — its line, out of a test.
              </div>
            </>)}
            {tab === "comments" && (<>
              {pre && <div className="text-body-sm italic text-on-surface-variant">{pre}</div>}
              {comment && <div className="text-body-sm">{comment}</div>}
              {!comment && !pre && (
                <div className="text-label-sm text-on-surface-variant">
                  {!withComments ? "Sent without its comments — send it again with comments to see them here."
                    : reviewing || phase === "missed" || phase === "show" ? "No comment on this move."
                    : "The chapter's comments are shown in a review, and on a move shown or missed — before, one could give the move away."}
                </div>
              )}
            </>)}
            {tab === "engine" && (<>
              <div className="text-body-sm">
                {evalHere
                  ? <>This position: <span className="font-semibold tabular-nums">{fmtEval(evalHere)}</span><span className="text-on-surface-variant"> · a stored evaluation</span></>
                  : <span className="text-on-surface-variant">No stored evaluation of this position.</span>}
              </div>
              {lineMoves ? (() => {
                // Checkmate or stalemate: nothing for Stockfish there.
                const over = endEval ? null : lineOver(drill, lineMoves);
                return endEval ? (
                  <div className="text-body-sm">
                    End of the line: <span className="font-semibold tabular-nums">{fmtEval(endEval.eval)}</span>
                    <span className="text-on-surface-variant"> · {endEval.name}, depth {endEval.depth}</span>
                  </div>
                ) : over ? (
                  <div className="text-body-sm">End of the line: <span className="font-semibold">{over}</span>.</div>
                ) : (
                  <div className="text-label-sm text-on-surface-variant">No engine evaluation of the line's end yet — analyse the chapter on the computer (Stockfish at the ends of the lines).</div>
                );
              })() : (
                <div className="text-label-sm text-on-surface-variant">The end of the line, once the line is done: the opponent may still turn either way.</div>
              )}
              <div className="text-label-sm text-on-surface-variant">From White's side. No engine runs here; the figures come with the chapter.</div>
            </>)}
            {tab === "reference" && (<>
              {figures ? <MoveStats move={figures.move} ply={figures.ply} stats={figures.stats} own={figures.own} /> : (
                <div className="text-label-md text-on-surface-variant">
                  {statsHere()?.games ? `${statsHere()!.games.toLocaleString()} games reached this position` : "Beyond the database's figures here"}
                  {phase === "own" && " — the moves, once yours is played."}
                </div>
              )}
              {chapter.mine && mineHere && mineHere.games > 0 && (
                <div className="text-label-md">
                  <span className="text-on-surface-variant">Your games through here: </span>
                  {mineHere.games} · +{mineHere.w} ={mineHere.d} −{mineHere.l}
                  {mineHere.perf != null && <span className="text-on-surface-variant"> · performance {mineHere.perf}</span>}
                  {(reviewing || atEnd) && mineHere.moves.length > 0 && (
                    <span className="text-on-surface-variant"> · you played {mineHere.moves.map(([san, n]) => `${san} ${n}×`).join(", ")}</span>
                  )}
                </div>
              )}
            </>)}
            {tab === "session" && (<>
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-1.5 text-label-md text-on-surface-variant"
                  title="The lines drilled: the most played first, until they take in this share of the games that stay in the chapter">
                  Lines
                  <select value={coverage} onChange={(e) => { const c = Number(e.target.value); setCoverage(c); saveCoverage(c); }}
                    className="h-7 px-1 rounded-sm bg-surface-container border border-outline/40 text-on-surface text-label-md">
                    {COVERAGE_CHOICES.map((c) => <option key={c} value={c}>{Math.round(c * 100)}%</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-label-md text-on-surface-variant"
                  title="Below 100%: the lines' ends cut where they get rare — a move valued by the share of the chapter's games that reach it (the opponent's moves lower it, yours never), the least valued cut first, the longest line first among equals, keeping the same share of the lines' use; the book's variations nobody plays go first">
                  <input type="checkbox" checked={cut} onChange={(e) => { setCut(e.target.checked); saveCut(e.target.checked); }} className="accent-primary" />
                  Cut rare ends{cut && (coverage >= 1 ? <span className="text-on-surface-variant"> · none at 100%</span> : s.cut > 0 && <span className="text-on-surface-variant"> · {s.cut} {s.cut === 1 ? "move" : "moves"} cut</span>)}
                </label>
                <label className="flex items-center gap-1.5 text-label-md text-on-surface-variant"
                  title="How many new moves of a chapter a day takes in; moves due again are always asked">
                  New a day
                  <select value={perDay} onChange={(e) => {
                    const n = Number(e.target.value);
                    setPerDay(n);
                    saveNewPerDay(n);
                    if (cards && (phase === "sessionDone" || phase === "lineDone")) startLine(cards, anyLine);
                  }}
                    className="h-7 px-1 rounded-sm bg-surface-container border border-outline/40 text-on-surface text-label-md">
                    {NEW_PER_DAY_CHOICES.map((n) => <option key={n} value={n}>{n === 0 ? "all" : n}</option>)}
                  </select>
                </label>
              </div>
              <div className="text-body-sm text-on-surface-variant space-y-1">
                <div>{s.lines.length} of {s.of} lines · {Math.round(s.coverage * 100)}% of the games</div>
                {counts && <div>{counts.total} moves · {counts.fresh} new · {counts.due} due</div>}
                {perDay > 0 && <div>New today: {today.met} of {budget}</div>}
                <div>This session: <span className="text-success">{tally.right} right</span> · <span className="text-error">{tally.wrong} missed</span>{tally.fresh > 0 && <> · {tally.fresh} new</>}</div>
                <div>{lines.length} {lines.length === 1 ? "line" : "lines"} so far{cursor !== null && <> · at line {cursor + 1}</>}</div>
              </div>
            </>)}
          </div>
        </div>
      </div>
    </div>
  );
}
