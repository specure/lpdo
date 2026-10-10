// The drill on a chapter's package (#327): the session's lines up to a
// coverage of the games; the opponent's moves played by their share, one's
// own entered on the board. Only what is to be practised is asked: a move due
// again, or a new one — shown first (the book's move with an arrow, to be
// played), asked later in the session, then on the schedule. A move known and
// not due is played by itself, quickly, so a line starts where the work is. A
// day takes in only so many new moves of a chapter; once they are met, more
// can be added for the day. A miss shows the book's move with the database's
// figures, to be played; its card comes back in the session. A line with a
// miss stops at its end: replayed — the same moves again, every one of
// one's own asked, the chapter's comments shown, nothing counted — or the
// next. Shared by the desktop (the Repertoire page) and the phone trainer.

import { useEffect, useMemo, useRef, useState } from "react";
import { hasComments, type LpdoChapter, type PNode } from "./format";
import {
  NEW_PER_DAY_CHOICES, buildDrill, cardCounts, describeBookMove, fenAfter, introduce, matchOwn, newPerDay,
  newToday, nextMoves, nextStep, opponentMove, review, saveNewPerDay, saveNewToday, sideToMove,
  type Card, type CardStore, type NewToday,
} from "./drill";
import DrillBoard from "./DrillBoard";
import MoveStats from "./MoveStats";

interface Props {
  chapter: LpdoChapter;
  store: CardStore;
  onClose?: () => void;
}

/** own: a move to answer; show: a new move shown, to be played; missed: a
 *  miss, the book's move to be played; auto: a move known and not due,
 *  played by itself; opponent: the opponent's reply coming; lineEnd: a line
 *  with a miss done — replay it, or the next; replayEnd: a replay done. */
type Phase = "loading" | "own" | "show" | "missed" | "auto" | "opponent" | "lineDone" | "lineEnd" | "replayEnd" | "sessionDone";

/** A line as text, "1.c4 e5 2.g3 Nc6 …": the moves missed marked, and the
 *  one the replay is at. */
function LineText({ moves, missed, at }: { moves: PNode[]; missed: number[]; at?: number }) {
  return (
    <div className="font-mono text-label-md leading-relaxed">
      {moves.map((m, i) => (
        <span key={i} className={`${missed.includes(i) ? "text-error font-semibold" : ""} ${at === i ? "underline underline-offset-2" : ""}`}>
          {i % 2 === 0 ? `${i / 2 + 1}.` : i === 0 ? "1…" : ""}{m.san}{" "}
        </span>
      ))}
    </div>
  );
}

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
  // Where this line had a miss (its plies); the line just done, to replay;
  // the moves of the line being replayed (null: drilling).
  const [missedPlies, setMissedPlies] = useState<number[]>([]);
  const [lastLine, setLastLine] = useState<{ moves: PNode[]; missed: number[] } | null>(null);
  const [replaying, setReplaying] = useState<PNode[] | null>(null);

  useEffect(() => { void store.all().then(setCards); }, [store]);

  const color = drill.color;
  const budget = perDay === 0 ? Infinity : perDay + today.extra;
  const allowed = (t: NewToday = today, any = anyLine) => any || perDay === 0 || t.met < perDay + t.extra;

  /** What happens at `p`, and the move it is about. In a replay: the line's
   *  next move, the opponent's played, one's own asked. */
  const phaseAt = (p: PNode[], cs: Record<string, Card>, any: boolean, t: NewToday, rp: PNode[] | null): { phase: Phase; target: PNode | null } => {
    if (rp) {
      if (p.length >= rp.length) return { phase: "replayEnd", target: null };
      return { phase: sideToMove(p) === color ? "own" : "opponent", target: rp[p.length] };
    }
    const step = nextStep(drill, p, cs, Date.now(), allowed(t, any), any);
    if (step.kind === "done") return { phase: "lineDone", target: null };
    if (step.kind === "opponent") return { phase: "opponent", target: null };
    return { phase: step.kind === "ask" ? "own" : step.kind, target: step.move };
  };

  const go = (p: PNode[], cs: Record<string, Card> = cards ?? {}, any = anyLine, t: NewToday = today, rp: PNode[] | null = replaying) => {
    setPath(p);
    setLastMove(p.length ? squares(p[p.length - 1].uci) : null);
    const next = phaseAt(p, cs, any, t, rp);
    setPhase(next.phase);
    setTarget(next.target);
  };

  const startLine = (cs: Record<string, Card>, any: boolean, t: NewToday = today) => {
    answered.current = new Set();
    setReplaying(null);
    setMissedPlies([]);
    const first = phaseAt([], cs, any, t, null);
    // Nothing to do from the start: the session is over.
    if (first.phase === "lineDone") { setPhase("sessionDone"); setTarget(null); setPath([]); setLastMove(null); return; }
    setNote(null);
    go([], cs, any, t, null);
  };

  /** The line again from its start: the same moves, nothing counted. */
  const startReplay = (moves: PNode[]) => {
    setReplaying(moves);
    setNote(null);
    go([], cards ?? {}, anyLine, today, moves);
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
      // The line's own move, nothing counted; a miss shows it.
      if (phase !== "own" && phase !== "missed") return false;
      if (node && node === target) {
        setNote(phase === "own" ? { text: `✓ ${node.san}`, tone: "good" } : null);
        go([...path, node]);
        return true;
      }
      if (phase === "own" && target) {
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
  const budgetUsed = perDay > 0 && today.met >= budget;

  const status = phase === "loading" ? "Reading your cards…"
    : phase === "own" ? "Your move"
    : phase === "show" ? "New move — play it"
    : phase === "missed" ? "Play the book move"
    : phase === "opponent" || phase === "auto" ? "…"
    : phase === "lineDone" ? "Line done"
    : phase === "lineEnd" ? "Line done — replay it?"
    : phase === "replayEnd" ? "Replay done"
    : anyLine ? "Every line drilled" : "Done for today";
  // The chapter's comment on the move just played — in a replay, where the
  // line is being understood (in the drill it could give away the next move).
  const lastPlayed = path.length ? path[path.length - 1] : null;
  const comment = replaying ? lastPlayed?.comment : phase === "missed" && !replaying ? target?.comment : undefined;
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
        <div className="shrink-0 h-60 md:h-auto overflow-y-auto md:w-72 p-3 flex flex-col gap-3 border-t md:border-t-0 md:border-l border-outline/40">
          {replaying && (
            <div className="flex items-center gap-2">
              <span className="text-label-md text-primary">Replay — not counted</span>
              {/* Out of the replay at any point, not only at its end. */}
              {phase !== "replayEnd" && cards && (
                <button onClick={() => startLine(cards, anyLine)} className="ml-auto text-label-md text-primary hover:underline">Next line →</button>
              )}
            </div>
          )}
          {replaying && !withComments && (
            <div className="text-label-sm text-on-surface-variant">Sent without its comments — send it again with comments to see them here.</div>
          )}
          <div className={`text-title-sm ${phase === "missed" ? "text-error" : phase === "show" ? "text-primary" : ""}`}>{status}</div>
          {phase === "show" && target && (
            <div className="text-body-sm">The book plays {describeBookMove(target, statsBefore())}</div>
          )}
          {phase !== "show" && note && (
            <div className={`text-body-sm ${note.tone === "bad" ? "text-on-surface" : note.tone === "good" ? "text-success" : "text-on-surface-variant"}`}>{note.text}</div>
          )}
          {comment && <div className="text-body-sm italic text-on-surface-variant">{comment}</div>}
          {/* In a replay: how the move just played stands among the moves
              played there — one's own and the opponent's. */}
          {replaying && lastPlayed && (
            <MoveStats move={lastPlayed} ply={path.length - 1}
              stats={path.length >= 2 ? path[path.length - 2].stats : chapter.start.stats}
              own={sideToMove(path.slice(0, -1)) === color} />
          )}
          {/* The line as text: at its end, and while it is replayed. */}
          {(replaying || phase === "lineEnd") && (
            <LineText moves={replaying ?? lastLine?.moves ?? path} missed={lastLine?.missed ?? missedPlies}
              at={replaying ? path.length - 1 : undefined} />
          )}
          {/* At the line's end: Stockfish's verdict, kept by the analysis job. */}
          {(phase === "lineEnd" || phase === "replayEnd") && lastLine && (() => {
            const end = lastLine.moves[lastLine.moves.length - 1]?.engine;
            return end ? (
              <div className="text-body-sm">
                End of the line: <span className="font-semibold tabular-nums">{"mate" in end.eval
                  ? `${end.eval.mate > 0 ? "" : "−"}#${Math.abs(end.eval.mate)}`
                  : `${end.eval.cp > 0 ? "+" : end.eval.cp < 0 ? "−" : ""}${(Math.abs(end.eval.cp) / 100).toFixed(2)}`}</span>
                <span className="text-on-surface-variant"> · {end.name}, depth {end.depth}</span>
              </div>
            ) : (
              <div className="text-label-sm text-on-surface-variant">No engine evaluation of the line's end yet — analyse the chapter on the computer (Stockfish at the ends of the lines).</div>
            );
          })()}
          {(phase === "lineEnd" || phase === "replayEnd") && cards && lastLine && (
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => startReplay(lastLine.moves)} className={`${pill} bg-primary text-on-primary`}>
                {phase === "replayEnd" ? "Replay again" : "Replay this line"}
              </button>
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
            <button onClick={() => startReplay(lastLine.moves)} className="self-start text-label-md text-primary hover:underline">
              ↺ Replay last line
            </button>
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
