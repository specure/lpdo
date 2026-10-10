// The drill on a chapter's package (#327): the session's lines up to a
// coverage of the games; the opponent's moves played by their share, one's
// own entered on the board. Only what is to be practised is asked: a move due
// again, or a new one — shown first (the book's move with an arrow, to be
// played), asked later in the session, then on the schedule. A move known and
// not due is played by itself, quickly, so a line starts where the work is. A
// day takes in only so many new moves of a chapter; once they are met, more
// can be added for the day. A miss shows the book's move with the database's
// figures, to be played; its card comes back in the session. A line with a
// miss stops at its end, for one of two: tested again — the same moves,
// every one of one's own asked, the opponent's played, a miss counting as
// one — or reviewed: stepped through by hand (⏮ ◀ ▶ ⏭, the arrow keys, a
// swipe on the phone, a move tapped in the text) with the chapter's
// comments, the moves' figures and Stockfish at the end, nothing asked. Or
// the next line. Shared by the desktop (the Repertoire page) and the phone
// trainer.

import { useEffect, useMemo, useRef, useState } from "react";
import { bareSan, hasComments, type LpdoChapter, type PNode } from "./format";
import {
  NEW_PER_DAY_CHOICES, buildDrill, cardCounts, describeBookMove, fenAfter, introduce, lineOver, matchOwn, newPerDay,
  newToday, nextMoves, nextStep, opponentMove, review, saveNewPerDay, saveNewToday, sideToMove,
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

/** A line as text, "1.c4 e5 2.g3 Nc6 …": the moves missed marked, and the
 *  one the replay is at; a move tapped goes there (`onPick`, its index). */
function LineText({ moves, missed, at, onPick }: { moves: PNode[]; missed: number[]; at?: number; onPick?: (i: number) => void }) {
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

const COVERAGES = [0.5, 0.75, 0.9, 1];

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

export default function DrillView({ chapter, store, onClose }: Props) {
  const [coverage, setCoverage] = useState(0.75);
  const drill = useMemo(() => buildDrill(chapter, coverage), [chapter, coverage]);
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
  // Where this line had a miss (its plies); the line just done, to test
  // again or review; the moves of the line tested again or reviewed (null:
  // drilling).
  const [missedPlies, setMissedPlies] = useState<number[]>([]);
  const [lastLine, setLastLine] = useState<{ moves: PNode[]; missed: number[] } | null>(null);
  const [replaying, setReplaying] = useState<PNode[] | null>(null);
  // The line reviewed (stepped through), not tested again.
  const [reviewing, setReviewing] = useState(false);
  const [layer, setLayer] = useState<Layer | null>(readLayer);
  const board = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number; t: number; onBoard: boolean } | null>(null);

  useEffect(() => { void store.all().then(setCards); }, [store]);

  const color = drill.color;
  const budget = perDay === 0 ? Infinity : perDay + today.extra;
  const allowed = (t: NewToday = today, any = anyLine) => any || perDay === 0 || t.met < perDay + t.extra;

  /** What happens at `p`, and the move it is about. Tested again: the
   *  line's next move, the opponent's played, one's own asked; reviewed:
   *  nothing until a step. */
  const phaseAt = (p: PNode[], cs: Record<string, Card>, any: boolean, t: NewToday, rp: PNode[] | null, rv = reviewing): { phase: Phase; target: PNode | null } => {
    if (rp) {
      if (p.length >= rp.length) return { phase: "replayEnd", target: null };
      if (rv) return { phase: "review", target: rp[p.length] };
      return { phase: sideToMove(p) === color ? "own" : "opponent", target: rp[p.length] };
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

  const startLine = (cs: Record<string, Card>, any: boolean, t: NewToday = today) => {
    answered.current = new Set();
    setReplaying(null);
    setReviewing(false);
    setMissedPlies([]);
    const first = phaseAt([], cs, any, t, null);
    // Nothing to do from the start: the session is over.
    if (first.phase === "lineDone") { setPhase("sessionDone"); setTarget(null); setPath([]); setLastMove(null); return; }
    setNote(null);
    go([], cs, any, t, null);
  };

  /** The line tested again from its start: one's moves asked, the
   *  opponent's played; a miss counts — once a move, as in the drill. */
  const testAgain = (moves: PNode[]) => {
    answered.current = new Set();
    setReplaying(moves);
    setReviewing(false);
    setNote(null);
    go([], cards ?? {}, anyLine, today, moves, false);
  };

  /** The line reviewed, from the ply `at` (its start by default). */
  const reviewLine = (moves: PNode[], at = 0) => {
    setReplaying(moves);
    setReviewing(true);
    setNote(null);
    go(moves.slice(0, at), cards ?? {}, anyLine, today, moves, true);
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

  // The line done: kept, to replay; with a miss it waits — replay it, or the
  // next; else the next one, after a moment.
  useEffect(() => {
    if (phase !== "lineDone" || !cards) return;
    // The line to replay: on to its end — where the run stopped (nothing
    // further due) the chapter's main continuation, to the end of the line.
    const moves = [...path];
    for (let next = nextMoves(drill, moves)[0]; next; next = nextMoves(drill, moves)[0]) moves.push(next);
    setLastLine({ moves, missed: missedPlies });
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

  const statsBefore = () => (path.length ? path[path.length - 1].stats : chapter.start.stats);

  const onMove = (uci: string): boolean => {
    const node = matchOwn(drill, path, uci);
    if (replaying) {
      // Tested again: the line's own move. A miss counts, as in the drill
      // (once a move); a move right moves no card on — it was just seen.
      if (phase !== "own" && phase !== "missed") return false;
      if (node && node === target) {
        setNote(phase === "own" ? { text: `✓ ${node.san}`, tone: "good" } : null);
        go([...path, node]);
        return true;
      }
      if (phase === "own" && target) {
        answer(target, false);
        setNote({ text: `The book move is ${describeBookMove(target, statsBefore())}`, tone: "bad" });
        setPhase("missed");
      }
      return false;
    }
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
      const cs = answer(node, true);
      setNote({ text: `✓ ${node.san}`, tone: "good" });
      go([...path, node], cs);
      return true;
    }
    // A miss: the move asked comes back, shown with its figures; the line
    // stops at its end, to be replayed.
    const main = target ?? nextMoves(drill, path)[0];
    answer(main, false);
    setMissedPlies((m) => (m.includes(path.length) ? m : [...m, path.length]));
    setNote({ text: `The book move is ${describeBookMove(main, statsBefore())}`, tone: "bad" });
    setPhase("missed");
    setTarget(main);
    return false;
  };

  const counts = cards ? cardCounts(drill, cards, Date.now()) : null;
  const fen = fenAfter(drill, path);
  const promotions = Object.fromEntries(nextMoves(drill, path).filter((n) => n.uci.length === 5).map((n) => [n.uci.slice(0, 4), n.uci[4]]));
  const s = drill.session;
  const hint = (phase === "show" || phase === "missed") && target ? squares(target.uci) : null;
  // In a review, where the chapter branches: the line's move and the
  // chapter's others here (not those switched off), the most played first.
  const here = path.length ? path[path.length - 1].children : chapter.tree;
  const shareHere = (n: PNode) => statsBefore()?.moves.find(([san]) => bareSan(san) === bareSan(n.san))?.[1] ?? 0;
  const branches = phase === "review" && target
    ? here.filter((n) => n !== target && !n.off).sort((a, b) => shareHere(b) - shareHere(a))
    : [];
  const movesLayer = branches.length > 0 && !!target;
  // The book's arrows and circles on the move just played.
  const lastPlayedNode = path.length ? path[path.length - 1] : null;
  const bookArrows = reviewing && lastPlayedNode ? (lastPlayedNode.arrows ?? []).map((c) => ({ from: c.slice(1, 3), to: c.slice(3, 5), color: bookColor(c[0]) })) : [];
  const bookCircles = reviewing && lastPlayedNode ? (lastPlayedNode.circles ?? []).map((c) => ({ square: c.slice(1, 3), color: bookColor(c[0]) })) : [];
  const bookLayer = bookArrows.length + bookCircles.length > 0;
  // Both: the kept choice, else the book's (the author's own); one: that one.
  const shown: Layer | null = bookLayer && movesLayer ? (layer ?? "book") : bookLayer ? "book" : movesLayer ? "moves" : null;
  const arrows = shown === "book" ? bookArrows
    : shown === "moves" && target
      // The line's last: drawn on top.
      ? [...branches.slice(0, BRANCH_ARROWS).map((n) => ({ ...squares(n.uci), color: BRANCH_COLOR })), { ...squares(target.uci), color: HINT_COLOR }]
      : [];
  const pickLayer = (l: Layer) => { setLayer(l); try { localStorage.setItem(LAYER_KEY, l); } catch { /* per-device convenience only */ } };
  /** Another of the chapter's moves here reviewed instead: on down its main
   *  continuation, from this position. */
  const reviewBranch = (n: PNode) => {
    const moves = [...path, n];
    for (let next = moves[moves.length - 1].children.find((c) => !c.off); next; next = next.children.find((c) => !c.off)) moves.push(next);
    reviewLine(moves, path.length);
  };
  const budgetUsed = perDay > 0 && today.met >= budget;
  const boardActive = phase === "own" || phase === "show" || phase === "missed";

  const status = phase === "loading" ? "Reading your cards…"
    : phase === "review" ? "Reviewing the line"
    : phase === "own" ? "Your move"
    : phase === "show" ? "New move — play it"
    : phase === "missed" ? "Play the book move"
    : phase === "opponent" || phase === "auto" ? "…"
    : phase === "lineDone" ? "Line done"
    : phase === "lineEnd" ? "Line done — test it again, or review it?"
    : phase === "replayEnd" ? (reviewing ? "End of the line" : "Test done")
    : anyLine ? "Every line drilled" : "Done for today";
  // The chapter's comment on the move just played — in a review, where the
  // line is being understood; in the drill and a test, on a miss (before,
  // it could give away the move).
  const lastPlayed = path.length ? path[path.length - 1] : null;
  const comment = reviewing ? lastPlayed?.comment : phase === "missed" ? target?.comment : undefined;
  const pill = "h-8 px-3 rounded-full text-label-md hover:brightness-110";
  const withComments = useMemo(() => hasComments(chapter), [chapter]);

  const learnMore = () => {
    if (!cards) return;
    const t = { ...today, extra: today.extra + perDay };
    setToday(t);
    saveNewToday(chapterId, t);
    startLine(cards, false, t);
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
      <div className="shrink-0 flex items-center gap-x-3 gap-y-1 px-3 py-2 border-b border-outline/40 flex-wrap">
        <div className="min-w-0">
          <div className="text-body-md truncate">{chapter.name}</div>
          <div className="text-label-sm text-on-surface-variant truncate">{chapter.book.name} · as {color === "white" ? "White" : "Black"}</div>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-label-md text-on-surface-variant"
            title="The lines drilled: the most played first, until they take in this share of the games that stay in the chapter">
            Lines
            <select value={coverage} onChange={(e) => setCoverage(Number(e.target.value))}
              className="h-7 px-1 rounded-sm bg-surface-container border border-outline/40 text-on-surface text-label-md">
              {COVERAGES.map((c) => <option key={c} value={c}>{Math.round(c * 100)}%</option>)}
            </select>
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
          {onClose && (
            <button onClick={onClose} className="h-8 px-3 rounded-full text-label-md text-primary hover:bg-primary/8">Close</button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <div className="flex-1 min-h-0 min-w-0 flex p-2">
          <div ref={board} className="flex-1 min-h-0 min-w-0 flex">
          <DrillBoard fen={fen} orientation={color} active={boardActive} onMove={onMove}
            promotions={promotions} lastMove={lastMove} hint={hint} arrows={arrows} circles={shown === "book" ? bookCircles : []} />
          </div>
        </div>
        {/* Below the board (portrait): a fixed height, whatever it says — a
            longer message must not shrink the board or move it. Beside it
            (wider screens), its own column. */}
        <div className="shrink-0 h-60 md:h-auto overflow-y-auto md:w-72 p-3 flex flex-col gap-3 border-t md:border-t-0 md:border-l border-outline/40">
          {replaying && (
            <div className="flex items-center gap-2">
              <span className="text-label-md text-primary">{reviewing ? "Review — nothing asked" : "Test again — a miss counts"}</span>
              {/* Out of it at any point, not only at its end. */}
              {phase !== "replayEnd" && cards && (
                <button onClick={() => startLine(cards, anyLine)} className="ml-auto text-label-md text-primary hover:underline">Next line →</button>
              )}
            </div>
          )}
          {/* Stepping through the review. */}
          {replaying && reviewing && (
            <div className="flex items-center gap-1">
              {([["first", 0, "To the start (Home)"], ["back", path.length - 1, "A move back (←)"], ["on", path.length + 1, "A move on (→)"], ["last", replaying.length, "To the end (End)"]] as const).map(([icon, to, title], i) => {
                const off = i < 2 ? path.length === 0 : path.length >= replaying.length;
                return (
                  <button key={icon} onClick={() => step(to)} disabled={off} title={title} aria-label={title}
                    className="h-10 flex-1 max-w-14 inline-flex items-center justify-center rounded-md bg-surface-container text-on-surface hover:bg-on-surface/8 disabled:opacity-35">
                    <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current" aria-hidden="true"><path d={STEP_ICONS[icon]} /></svg>
                  </button>
                );
              })}
            </div>
          )}
          {/* The line as text: at its end, and in a review — a move tapped
              goes there (from the end, into a review). Not in a test: it
              would give the moves away. */}
          {((replaying && reviewing) || phase === "lineEnd") && (
            <LineText moves={replaying ?? lastLine?.moves ?? path} missed={lastLine?.missed ?? missedPlies}
              at={replaying ? path.length - 1 : undefined}
              onPick={replaying ? (i) => step(i + 1) : lastLine ? (i) => reviewLine(lastLine.moves, i + 1) : undefined} />
          )}
          {/* The chapter's other moves here, in their arrows' colour: one
              tapped is reviewed instead. */}
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
          {reviewing && !withComments && (
            <div className="text-label-sm text-on-surface-variant">Sent without its comments — send it again with comments to see them here.</div>
          )}
          <div className={`text-title-sm ${phase === "missed" ? "text-error" : phase === "show" ? "text-primary" : ""}`}>{status}</div>
          {/* A new move: the book's, with how it stands among the moves
              played here — the most played, or one the opponent will
              rarely have met. */}
          {phase === "show" && target && (
            <>
              <div className="text-body-sm">The book plays {target.san}</div>
              <MoveStats move={target} ply={path.length} stats={statsBefore()} own />
            </>
          )}
          {phase !== "show" && note && (
            <div className={`text-body-sm ${note.tone === "bad" ? "text-on-surface" : note.tone === "good" ? "text-success" : "text-on-surface-variant"}`}>{note.text}</div>
          )}
          {comment && <div className="text-body-sm italic text-on-surface-variant">{comment}</div>}
          {/* In a review: how the move just played stands among the moves
              played there — one's own and the opponent's. */}
          {reviewing && lastPlayed && (
            <MoveStats move={lastPlayed} ply={path.length - 1}
              stats={path.length >= 2 ? path[path.length - 2].stats : chapter.start.stats}
              own={sideToMove(path.slice(0, -1)) === color} />
          )}
          {/* At the line's end, and a review's: Stockfish's verdict, kept by
              the analysis job. */}
          {(phase === "lineEnd" || (phase === "replayEnd" && reviewing)) && lastLine && (() => {
            const end = lastLine.moves[lastLine.moves.length - 1]?.engine;
            // Checkmate or stalemate: nothing for Stockfish there.
            const over = end ? null : lineOver(drill, lastLine.moves);
            return end ? (
              <div className="text-body-sm">
                End of the line: <span className="font-semibold tabular-nums">{"mate" in end.eval
                  ? `${end.eval.mate > 0 ? "" : "−"}#${Math.abs(end.eval.mate)}`
                  : `${end.eval.cp > 0 ? "+" : end.eval.cp < 0 ? "−" : ""}${(Math.abs(end.eval.cp) / 100).toFixed(2)}`}</span>
                <span className="text-on-surface-variant"> · {end.name}, depth {end.depth}</span>
              </div>
            ) : over ? (
              <div className="text-body-sm">End of the line: <span className="font-semibold">{over}</span>.</div>
            ) : (
              <div className="text-label-sm text-on-surface-variant">No engine evaluation of the line's end yet — analyse the chapter on the computer (Stockfish at the ends of the lines).</div>
            );
          })()}
          {(phase === "lineEnd" || phase === "replayEnd") && cards && lastLine && (
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => testAgain(lastLine.moves)} className={`${pill} bg-primary text-on-primary`}
                title="The same moves: yours asked, the opponent's played; a miss counts">Test again</button>
              <button onClick={() => reviewLine(lastLine.moves)} className={`${pill} bg-primary text-on-primary`}
                title="Step through the line with its comments, the moves' figures and Stockfish at the end; nothing asked">Review the line</button>
              <button onClick={() => startLine(cards, anyLine)} className={`${pill} bg-secondary-container text-on-secondary-container`}>Next line</button>
            </div>
          )}
          {phase === "sessionDone" && !anyLine && (
            <div className="text-body-sm">
              {tally.right + tally.wrong} reviewed · {tally.fresh} new
              {counts && counts.fresh > 0 && perDay > 0 && (
                <> · {counts.fresh} new left in these lines — about {Math.ceil(counts.fresh / perDay)} {Math.ceil(counts.fresh / perDay) === 1 ? "day" : "days"} at {perDay} a day</>
              )}
            </div>
          )}
          <div className="text-body-sm text-on-surface-variant space-y-1">
            <div>{s.lines.length} of {s.of} lines · {Math.round(s.coverage * 100)}% of the games</div>
            {counts && <div>{counts.total} moves · {counts.fresh} new · {counts.due} due</div>}
            {perDay > 0 && <div>New today: {today.met} of {budget}</div>}
            <div>This session: <span className="text-success">{tally.right} right</span> · <span className="text-error">{tally.wrong} missed</span>{tally.fresh > 0 && <> · {tally.fresh} new</>}</div>
          </div>
          {!replaying && lastLine && phase !== "lineEnd" && phase !== "loading" && (
            <div className="flex gap-3 text-label-md">
              <span className="text-on-surface-variant">The last line:</span>
              <button onClick={() => testAgain(lastLine.moves)} className="text-primary hover:underline">↺ Test again</button>
              <button onClick={() => reviewLine(lastLine.moves)} className="text-primary hover:underline">Review</button>
            </div>
          )}
          {phase === "sessionDone" && cards && (
            <div className="flex gap-2 flex-wrap">
              {!anyLine && budgetUsed && counts && counts.fresh > 0 && (
                <button onClick={learnMore}
                  className="h-8 px-3 rounded-full bg-primary text-on-primary text-label-md hover:brightness-110">
                  Learn {Math.min(perDay, counts.fresh)} more today
                </button>
              )}
              <button onClick={() => { setAnyLine(true); startLine(cards, true); }}
                className="h-8 px-3 rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110">
                Keep drilling
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
