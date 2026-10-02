// A chapter's lines (#327), listed in reading order: the main line, then the
// variations that branch off it — each written out whole, from move 1: the
// moves it shares with the line it branches off greyed, its own solid. Clicking a
// line puts the board on its first own move; → at the end of a line goes on
// to the next (the host asks `onLines` for the list). Off lines are greyed.
// A line not in the chapter's practice analysis — never analysed, or moves
// added since — is marked so; the header says how many are.
//
// The repertoire's off-switch lives here: each line on or off at its
// branching move, and in the header "Off: my sidelines" — one's own second
// choices switched off wherever the chapter has more than one — and "All
// on". Each saves the chapter.

import { useEffect, useState } from "react";
import { parsePgnTree, type AnnotatedGame } from "../../lib/parsePgnTree";
import { serializeMovetext } from "../../lib/serializeMovetext";
import { chapterLines, switchAllOn, switchOffSidelines, type ChapterLine } from "../../lib/repertoireLines";
import { getMoveNum } from "../../lib/moveTreeNav";
import { getChapter, getStoredAnalysis, saveChapterMoves, type BookColor } from "../../lib/repertoire";
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
  /** The book's colour: whose sidelines "Off: my sidelines" switches off. */
  color: BookColor;
  /** The chapter was saved here (lines switched on or off). */
  onSaved?: () => void;
}

/** A line written out: White's moves numbered ("5.c3"), a Black move after
 *  nothing numbered too ("5...c5") — the shared moves greyed, the line's own
 *  solid. */
function LineText({ line, onMove }: { line: ChapterLine; onMove: (cursor: CursorPath) => void }) {
  // Each move with where it is: a shared one in the line it comes from.
  const moves = [
    ...line.before.map((n, k) => ({ n, shared: true, at: line.beforeAt[k] })),
    ...line.line.map((n, k) => ({ n, shared: false, at: { steps: line.steps, index: k + 1 } })).filter((m) => m.n.san),
  ];
  return (
    <span className="min-w-0 flex-1 leading-6">
      {moves.map(({ n, shared }, i) => {
        const num = n.color === "w" ? `${getMoveNum(n)}.` : i === 0 ? `${getMoveNum(n)}...` : "";
        return (
          <span key={i} className={shared ? "text-on-surface-variant/60" : ""}>
            {i > 0 ? " " : ""}
            <span role="button" tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onMove(moves[i].at); }}
              className="whitespace-nowrap rounded-sm cursor-pointer hover:bg-on-surface/12 hover:text-on-surface"
              title="The board to this move">{num}{n.san}</span>
          </span>
        );
      })}
    </span>
  );
}

export default function LinesPanel({ chapterId, reloadKey, analysedAt, cursor, onPick, onLines, color, onSaved }: Props) {
  const [lines, setLines] = useState<ChapterLine[] | null>(null);
  const [tree, setTree] = useState<AnnotatedGame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setNote(null), [chapterId]);

  /** Change the switches (on the tree the lines come from), save, read the
   *  chapter again everywhere. */
  async function change(f: (t: AnnotatedGame) => string | void) {
    if (!tree || saving) return;
    const said = f(tree);
    setSaving(true);
    try {
      await saveChapterMoves(chapterId, serializeMovetext(tree));
      setNote(said || null);
      onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  const mine = color === "white" ? "w" : "b";
  // How many own sidelines are on — counted on a copy, nothing changed.
  const sidelines = tree ? switchOffSidelines(structuredClone(tree), mine) : 0;
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
        const t = parsePgnTree(c.pgn);
        const ls = chapterLines(t);
        setTree(t);
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
        <span className="ml-2 text-outline">click a move: the board there · ↑ ↓ previous / next line · End: the end of the line</span>
      </div>
      <div className="px-3 py-1 shrink-0 flex items-center gap-1.5 flex-wrap border-b border-outline/40 text-label-sm">
        <button disabled={saving || sidelines === 0}
          onClick={() => void change((t) => { const n = switchOffSidelines(t, mine); return `Switched off ${n} ${n === 1 ? "sideline" : "sidelines"} of yours.`; })}
          className="h-6 px-2 rounded-full border border-outline/40 text-on-surface-variant hover:bg-on-surface/8 disabled:opacity-40"
          title={`Wherever you have more than one move (as ${color === "white" ? "White" : "Black"}), keep the first and switch the others off — with everything below them. The opponent's alternatives stay on.`}>
          Off: my sidelines{sidelines ? ` (${sidelines})` : ""}
        </button>
        <button disabled={saving || off === 0}
          onClick={() => void change((t) => { const n = switchAllOn(t); return `Switched ${n} ${n === 1 ? "move" : "moves"} back on.`; })}
          className="h-6 px-2 rounded-full border border-outline/40 text-on-surface-variant hover:bg-on-surface/8 disabled:opacity-40"
          title="Switch every line of the chapter back on">All on</button>
        {saving ? <span className="text-on-surface-variant">Saving…</span> : note && <span className="text-on-surface-variant">{note}</span>}
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
              <LineText line={l} onMove={onPick} />
              {/* On or off at the line's branching move (the main line has
                  none of its own); off through a line above, it is switched
                  on there. */}
              {l.depth > 0 && (() => {
                const own = !!l.line[0]?.annotations.off;
                const inherited = l.off && !own;
                return inherited
                  ? <span className="shrink-0 leading-6 text-label-sm text-on-surface-variant" title="Off through a line above — switch that one on">off</span>
                  : (
                    <span role="button" tabIndex={-1}
                      onClick={(e) => { e.stopPropagation(); if (!saving) void change(() => { l.line[0].annotations.off = own ? undefined : true; }); }}
                      className={`shrink-0 self-start mt-0.5 h-5 px-1.5 inline-flex items-center rounded-full border text-[11px] leading-none cursor-pointer ${
                        own ? "border-primary text-primary hover:bg-primary/8" : "border-outline/50 text-on-surface-variant hover:bg-on-surface/8"
                      }`}
                      title={own ? "Switched off — click to switch it on" : "Switch this line off: not in my repertoire from its branching move"}>
                      {own ? "on" : "off"}
                    </span>
                  );
              })()}
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
