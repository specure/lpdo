// A chapter's lines (#327), listed in reading order: the main line, then the
// variations that branch off it — each written out whole, from move 1: the
// moves it shares with the line it branches off greyed, its own solid. Clicking a
// line puts the board on its first own move; → at the end of a line goes on
// to the next (the host asks `onLines` for the list). Off lines are greyed.
// A line not in the chapter's practice analysis — never analysed, or moves
// added since — is marked so; the header says how many are.

import { useEffect, useState } from "react";
import { parsePgnTree } from "../../lib/parsePgnTree";
import { chapterLines, type ChapterLine } from "../../lib/repertoireLines";
import { getMoveNum } from "../../lib/moveTreeNav";
import type { MoveNode } from "../../lib/parsePgnTree";
import { getChapter, getStoredAnalysis } from "../../lib/repertoire";
import { positionKey } from "../../trainer/buildPackage";
import type { CursorPath } from "../../lib/moveTreeNav";

interface Props {
  chapterId: number;
  /** Bumped when the chapter was saved, to read it again. */
  reloadKey: number;
  /** When the chapter was last analysed: the analysis is read again when it
   *  changes. */
  analysedAt?: string | null;
  /** Where the board stands, to mark the line it is on. */
  cursor: CursorPath | null;
  onPick: (cursor: CursorPath) => void;
  onLines?: (lines: ChapterLine[]) => void;
}

/** A line written out: White's moves numbered ("5.c3"), a Black move after
 *  nothing numbered too ("5...c5") — the shared moves greyed, the line's own
 *  solid. */
function LineText({ before, own }: { before: MoveNode[]; own: MoveNode[] }) {
  const moves = [...before.map((n) => ({ n, shared: true })), ...own.filter((n) => n.san).map((n) => ({ n, shared: false }))];
  return (
    <span className="min-w-0 flex-1 leading-6">
      {moves.map(({ n, shared }, i) => {
        const num = n.color === "w" ? `${getMoveNum(n)}.` : i === 0 ? `${getMoveNum(n)}...` : "";
        return (
          <span key={i} className={shared ? "text-on-surface-variant/60" : ""}>
            {i > 0 ? " " : ""}<span className="whitespace-nowrap">{num}{n.san}</span>
          </span>
        );
      })}
    </span>
  );
}

export default function LinesPanel({ chapterId, reloadKey, analysedAt, cursor, onPick, onLines }: Props) {
  const [lines, setLines] = useState<ChapterLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The positions of the stored analysis; null while there is none.
  const [analysed, setAnalysed] = useState<Set<string> | null>(null);
  useEffect(() => {
    let gone = false;
    getStoredAnalysis(chapterId)
      .then((a) => { if (!gone) setAnalysed(a.analysed_at ? new Set(a.positions.map((p) => p.key)) : null); })
      .catch(() => { if (!gone) setAnalysed(null); });
    return () => { gone = true; };
  }, [chapterId, reloadKey, analysedAt]);
  const isAnalysed = (l: ChapterLine) => !!analysed && l.line.every((n) => !n.san || analysed.has(positionKey(n.fen)));
  useEffect(() => {
    let gone = false;
    getChapter(chapterId)
      .then((c) => {
        if (gone) return;
        const ls = chapterLines(parsePgnTree(c.pgn));
        setLines(ls);
        setError(null);
        onLines?.(ls);
      })
      .catch((e) => { if (!gone) setError(String(e)); });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, reloadKey]);

  if (error) return <div className="p-3 text-center text-error text-body-sm">{error}</div>;
  if (!lines) return <div className="p-3 text-center text-on-surface-variant text-body-sm">Loading…</div>;
  if (lines.length === 0) return <div className="p-3 text-center text-on-surface-variant text-body-sm">No moves yet — Edit game… and play the lines in.</div>;

  const cursorKey = cursor ? JSON.stringify(cursor.steps) : null;
  const off = lines.filter((l) => l.off).length;
  const done = analysed ? lines.filter(isAnalysed).length : 0;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-1 shrink-0 text-label-sm text-on-surface-variant border-b border-outline/40">
        {lines.length} {lines.length === 1 ? "line" : "lines"}{off ? ` · ${off} off` : ""}
        {" · "}{analysed ? (done === lines.length ? "all analysed" : `${done} analysed`) : "not analysed"}
        <span className="ml-2 text-outline">→ at the end of a line goes on to the next</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {lines.map((l, i) => {
          const on = cursorKey === JSON.stringify(l.steps);
          return (
            <button
              key={i}
              onClick={() => onPick({ steps: l.steps, index: l.branchIndex })}
              className={`w-full flex items-start gap-2 px-3 py-2 text-left text-body-sm border-b border-outline/20 transition-colors duration-short3 ease-standard ${
                on ? "bg-primary-container text-on-primary-container" : "text-on-surface hover:bg-on-surface/8"
              } ${l.off ? "opacity-50" : ""}`}
              title={`${l.name}${l.off ? " — switched off, not in the active repertoire" : ""}`}
            >
              <span className="text-on-surface-variant tabular-nums w-6 shrink-0 text-right leading-6">{i + 1}.</span>
              <LineText before={l.before} own={l.line} />
              {l.off && <span className="shrink-0 leading-6 text-label-sm text-on-surface-variant">off</span>}
              {/* Only a line the analysis lacks is marked: usually all are in. */}
              {analysed && !isAnalysed(l) && (
                <span className="shrink-0 leading-6 text-label-sm text-tertiary" title="Moves added since the chapter was analysed — analyse it again">not analysed</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
