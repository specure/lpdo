// The drill on a chapter's package (#327): the session's lines up to a
// coverage of the games; the opponent's moves played by their share, one's
// own entered on the board. Only what is to be practised is asked: a move due
// again, or a new one — shown first (the book's move with an arrow, to be
// played), asked later in the session, then on the schedule. A move known and
// not due is played by itself, quickly, so a line starts where the work is. A
// day takes in only so many new moves of a chapter; once they are met, more
// can be added for the day. A miss shows the book's move with the database's
// figures, to be played; its card comes back in the session. Shared by the
// desktop (the Repertoire page) and the phone trainer.

import { useEffect, useMemo, useRef, useState } from "react";
import type { LpdoChapter, PNode } from "./format";
import {
  NEW_PER_DAY_CHOICES, buildDrill, cardCounts, describeBookMove, fenAfter, introduce, matchOwn, newPerDay,
  newToday, nextMoves, nextStep, opponentMove, review, saveNewPerDay, saveNewToday,
  type Card, type CardStore, type NewToday,
} from "./drill";
import DrillBoard from "./DrillBoard";

interface Props {
  chapter: LpdoChapter;
  store: CardStore;
  onClose?: () => void;
}

/** own: a move to answer; show: a new move shown, to be played; missed: a
 *  miss, the book's move to be played; auto: a move known and not due,
 *  played by itself; opponent: the opponent's reply coming. */
type Phase = "loading" | "own" | "show" | "missed" | "auto" | "opponent" | "lineDone" | "sessionDone";

const COVERAGES = [0.5, 0.75, 0.9, 1];
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

  useEffect(() => { void store.all().then(setCards); }, [store]);

  const color = drill.color;
  const budget = perDay === 0 ? Infinity : perDay + today.extra;
  const allowed = (t: NewToday = today, any = anyLine) => any || perDay === 0 || t.met < perDay + t.extra;

  /** What happens at `p`, and the move it is about. */
  const phaseAt = (p: PNode[], cs: Record<string, Card>, any: boolean, t: NewToday): { phase: Phase; target: PNode | null } => {
    const step = nextStep(drill, p, cs, Date.now(), allowed(t, any), any);
    if (step.kind === "done") return { phase: "lineDone", target: null };
    if (step.kind === "opponent") return { phase: "opponent", target: null };
    return { phase: step.kind === "ask" ? "own" : step.kind, target: step.move };
  };

  const go = (p: PNode[], cs: Record<string, Card> = cards ?? {}, any = anyLine, t: NewToday = today) => {
    setPath(p);
    setLastMove(p.length ? squares(p[p.length - 1].uci) : null);
    const next = phaseAt(p, cs, any, t);
    setPhase(next.phase);
    setTarget(next.target);
  };

  const startLine = (cs: Record<string, Card>, any: boolean, t: NewToday = today) => {
    answered.current = new Set();
    const first = phaseAt([], cs, any, t);
    // Nothing to do from the start: the session is over.
    if (first.phase === "lineDone") { setPhase("sessionDone"); setTarget(null); setPath([]); setLastMove(null); return; }
    setNote(null);
    go([], cs, any, t);
  };

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

  // The line done: the next one, after a moment.
  useEffect(() => {
    if (phase !== "lineDone" || !cards) return;
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
    // A miss: the move asked comes back, shown with its figures.
    const main = target ?? nextMoves(drill, path)[0];
    answer(main, false);
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
  const budgetUsed = perDay > 0 && today.met >= budget;

  const status = phase === "loading" ? "Reading your cards…"
    : phase === "own" ? "Your move"
    : phase === "show" ? "New move — play it"
    : phase === "missed" ? "Play the book move"
    : phase === "opponent" || phase === "auto" ? "…"
    : phase === "lineDone" ? "Line done"
    : anyLine ? "Every line drilled" : "Done for today";

  const learnMore = () => {
    if (!cards) return;
    const t = { ...today, extra: today.extra + perDay };
    setToday(t);
    saveNewToday(chapterId, t);
    startLine(cards, false, t);
  };

  return (
    <div className="h-full w-full flex flex-col bg-surface text-on-surface">
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
          <DrillBoard fen={fen} orientation={color} active={phase === "own" || phase === "show" || phase === "missed"} onMove={onMove}
            promotions={promotions} lastMove={lastMove} hint={hint} />
        </div>
        {/* Below the board (portrait): a fixed height, whatever it says — a
            longer message must not shrink the board or move it. Beside it
            (wider screens), its own column. */}
        <div className="shrink-0 h-52 md:h-auto overflow-y-auto md:w-72 p-3 flex flex-col gap-3 border-t md:border-t-0 md:border-l border-outline/40">
          <div className={`text-title-sm ${phase === "missed" ? "text-error" : phase === "show" ? "text-primary" : ""}`}>{status}</div>
          {phase === "show" && target && (
            <div className="text-body-sm">The book plays {describeBookMove(target, statsBefore())}</div>
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
          <div className="text-body-sm text-on-surface-variant space-y-1">
            <div>{s.lines.length} of {s.of} lines · {Math.round(s.coverage * 100)}% of the games</div>
            {counts && <div>{counts.total} moves · {counts.fresh} new · {counts.due} due</div>}
            {perDay > 0 && <div>New today: {today.met} of {budget}</div>}
            <div>This session: <span className="text-success">{tally.right} right</span> · <span className="text-error">{tally.wrong} missed</span>{tally.fresh > 0 && <> · {tally.fresh} new</>}</div>
          </div>
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
