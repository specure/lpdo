// The drill on a chapter's package (#327): the session's lines up to a
// coverage of the games; the opponent's moves played by their share, one's
// own entered on the board. A miss shows the book's move with the
// database's figures, to be played; its card comes back in the session.
// Each line runs until no card below it is due; the session until none is.
// Shared by the desktop (the Repertoire page) and the phone trainer.

import { useEffect, useMemo, useRef, useState } from "react";
import type { LpdoChapter, PNode } from "./format";
import {
  buildDrill, cardCounts, describeBookMove, fenAfter, hasWork, matchOwn, nextMoves, opponentMove, review, sideToMove,
  type Card, type CardStore, type Drill,
} from "./drill";
import DrillBoard from "./DrillBoard";

interface Props {
  chapter: LpdoChapter;
  store: CardStore;
  onClose?: () => void;
}

type Phase = "loading" | "own" | "missed" | "opponent" | "lineDone" | "sessionDone";

const COVERAGES = [0.5, 0.75, 0.9, 1];
const squares = (uci: string) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) });

export default function DrillView({ chapter, store, onClose }: Props) {
  const [coverage, setCoverage] = useState(0.75);
  const drill = useMemo(() => buildDrill(chapter, coverage), [chapter, coverage]);
  const [cards, setCards] = useState<Record<string, Card> | null>(null);
  const [path, setPath] = useState<PNode[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  // After the session: keep drilling, the schedule aside.
  const [anyLine, setAnyLine] = useState(false);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [missed, setMissed] = useState<PNode | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tally, setTally] = useState({ right: 0, wrong: 0 });
  // The cards answered in this line: a retry after a miss does not count.
  const answered = useRef(new Set<string>());

  useEffect(() => { void store.all().then(setCards); }, [store]);

  const color = drill.color;
  const now = Date.now();
  const rootHasWork = (d: Drill, cs: Record<string, Card>, any: boolean) =>
    nextMoves(d, []).some((n) => any || hasWork(d, n, cs, Date.now()));

  /** What happens at `p`: whose move, or the line's end. */
  const phaseAt = (p: PNode[], cs: Record<string, Card>, any: boolean): Phase => {
    const moves = nextMoves(drill, p);
    if (!moves.length) return "lineDone";
    if (!any && p.length && !moves.some((n) => hasWork(drill, n, cs, Date.now()))) return "lineDone";
    return sideToMove(p) === color ? "own" : "opponent";
  };

  const go = (p: PNode[], cs: Record<string, Card> = cards ?? {}, any = anyLine) => {
    setPath(p);
    setLastMove(p.length ? squares(p[p.length - 1].uci) : null);
    setMissed(null);
    setPhase(phaseAt(p, cs, any));
  };

  const startLine = (cs: Record<string, Card>, any: boolean) => {
    answered.current = new Set();
    setNote(null);
    if (!rootHasWork(drill, cs, any)) { setPhase("sessionDone"); setPath([]); setLastMove(null); return; }
    go([], cs, any);
  };

  // A new session: the cards read, or the coverage changed.
  useEffect(() => {
    if (!cards) return;
    setAnyLine(false);
    setTally({ right: 0, wrong: 0 });
    startLine(cards, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards === null, drill]);

  // The opponent's move, after a moment.
  useEffect(() => {
    if (phase !== "opponent" || !cards) return;
    const t = window.setTimeout(() => {
      const pick = opponentMove(drill, path, cards, Date.now(), anyLine);
      if (!pick) { setPhase("lineDone"); return; }
      go([...path, pick]);
    }, 450);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, path]);

  // The line done: the next one, after a moment.
  useEffect(() => {
    if (phase !== "lineDone" || !cards) return;
    const t = window.setTimeout(() => startLine(cards, anyLine), 1100);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const answer = (node: PNode, correct: boolean) => {
    const key = drill.cardOf.get(node);
    if (!key || !cards || answered.current.has(key)) return;
    answered.current.add(key);
    const card = review(cards[key], correct, Date.now());
    const next = { ...cards, [key]: card };
    setCards(next);
    void store.put(key, card);
    setTally((t) => (correct ? { ...t, right: t.right + 1 } : { ...t, wrong: t.wrong + 1 }));
    return next;
  };

  const onMove = (uci: string): boolean => {
    if (phase !== "own" && phase !== "missed") return false;
    const node = matchOwn(drill, path, uci);
    const book = nextMoves(drill, path);
    if (node) {
      const cs = phase === "own" ? answer(node, true) ?? cards ?? {} : cards ?? {};
      setNote(phase === "own" ? `✓ ${node.san}` : null);
      go([...path, node], cs);
      return true;
    }
    if (phase === "own") {
      // A miss: the book's move (its first, where it has several) comes back.
      const main = book[0];
      answer(main, false);
      const stats = path.length ? path[path.length - 1].stats : chapter.start.stats;
      setMissed(main);
      setNote(`The book move is ${describeBookMove(main, stats)}`);
      setPhase("missed");
    }
    return false;
  };

  const counts = cards ? cardCounts(drill, cards, now) : null;
  const fen = fenAfter(drill, path);
  const promotions = Object.fromEntries(nextMoves(drill, path).filter((n) => n.uci.length === 5).map((n) => [n.uci.slice(0, 4), n.uci[4]]));
  const s = drill.session;

  const status = phase === "loading" ? "Reading your cards…"
    : phase === "own" ? "Your move"
    : phase === "missed" ? "Play the book move"
    : phase === "opponent" ? "…"
    : phase === "lineDone" ? "Line done"
    : anyLine ? "Every line drilled" : "Nothing due — every card in this session is known";

  return (
    <div className="h-full w-full flex flex-col bg-surface text-on-surface">
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-outline/40 flex-wrap">
        <div className="min-w-0">
          <div className="text-body-md truncate">{chapter.name}</div>
          <div className="text-label-sm text-on-surface-variant truncate">{chapter.book.name} · as {color === "white" ? "White" : "Black"}</div>
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-label-md text-on-surface-variant"
          title="The lines drilled: the most played first, until they take in this share of the games that stay in the chapter">
          Lines
          <select value={coverage} onChange={(e) => setCoverage(Number(e.target.value))}
            className="h-7 px-1 rounded-sm bg-surface-container border border-outline/40 text-on-surface text-label-md">
            {COVERAGES.map((c) => <option key={c} value={c}>{Math.round(c * 100)}% of games</option>)}
          </select>
        </label>
        {onClose && (
          <button onClick={onClose} className="h-8 px-3 rounded-full text-label-md text-primary hover:bg-primary/8">Close</button>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <div className="flex-1 min-h-0 min-w-0 flex p-2">
          <DrillBoard fen={fen} orientation={color} active={phase === "own" || phase === "missed"} onMove={onMove}
            promotions={promotions} lastMove={lastMove} hint={missed ? squares(missed.uci) : null} />
        </div>
        <div className="shrink-0 md:w-72 p-3 flex flex-col gap-3 border-t md:border-t-0 md:border-l border-outline/40">
          <div className={`text-title-sm ${phase === "missed" ? "text-error" : ""}`}>{status}</div>
          {note && <div className={`text-body-sm ${phase === "missed" ? "text-on-surface" : "text-success"}`}>{note}</div>}
          <div className="text-body-sm text-on-surface-variant space-y-1">
            <div>{s.lines.length} of {s.of} lines · {Math.round(s.coverage * 100)}% of the games</div>
            {counts && <div>{counts.total} decisions · {counts.fresh} new · {counts.due} due</div>}
            <div>This session: <span className="text-success">{tally.right} right</span> · <span className="text-error">{tally.wrong} missed</span></div>
          </div>
          {phase === "sessionDone" && cards && (
            <button onClick={() => { setAnyLine(true); startLine(cards, true); }}
              className="self-start h-8 px-3 rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110">
              Keep drilling
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
