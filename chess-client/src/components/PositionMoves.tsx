// Nav arrows + scrollable, clickable move list for the position explorer. Used
// standalone as the Games page's B1 panel, and inline inside PositionBoard on the
// Players page. Driven by a cursor model: `fullLine` is the explored line and
// `moveSequence` is the active prefix (its length is the cursor).

import { Fragment } from "react";
import { IconFirst, IconPrev, IconNext, IconLast } from "./navIcons";

interface Props {
  /** Active line up to the cursor (its length = current ply). */
  moveSequence: string[];
  onBack: () => void;
  /** Rewind to the start. */
  onReset: () => void;
  /** Step forward along `fullLine` (›). Omit to hide. */
  onForward?: () => void;
  /** Jump to the end of `fullLine`. Omit to hide. */
  onEnd?: () => void;
  /** Click a move → set the cursor to that ply. Omit → not clickable. */
  onJumpTo?: (ply: number) => void;
  /** Full explored line incl. moves ahead of the cursor; defaults to moveSequence. */
  fullLine?: string[];
}

export default function PositionMoves({ moveSequence, onBack, onReset, onForward, onEnd, onJumpTo, fullLine }: Props) {
  const list = fullLine ?? moveSequence;
  const cursor = moveSequence.length;
  const hasSequence = cursor > 0;
  const canForward = cursor < list.length;

  const rows: { no: number; w?: { san: string; i: number }; b?: { san: string; i: number } }[] = [];
  list.forEach((san, i) => {
    const no = Math.floor(i / 2) + 1;
    if (i % 2 === 0) rows.push({ no, w: { san, i } });
    else {
      const last = rows[rows.length - 1];
      if (last && last.no === no && !last.b) last.b = { san, i };
      else rows.push({ no, b: { san, i } });
    }
  });

  // As the Analysis board's nav, a size smaller.
  const navBtn = "shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-25 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors duration-short3 ease-standard";
  const moveCls = (i: number) =>
    `px-1 rounded-sm font-mono ${onJumpTo ? "cursor-pointer" : ""} ${
      i === cursor - 1
        ? "bg-secondary-container text-on-secondary-container"
        : "text-on-surface hover:bg-on-surface/8"
    }`;
  const moveClick = (i: number) => (onJumpTo ? () => onJumpTo(i + 1) : undefined);

  // Keyboard nav when the move list has focus: ←/→ step, Home/End jump.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") { e.preventDefault(); onBack(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); onForward?.(); }
    else if (e.key === "Home") { e.preventDefault(); onReset(); }
    else if (e.key === "End") { e.preventDefault(); onEnd?.(); }
  }

  return (
    <div className="flex flex-col h-full min-h-0 gap-1.5">
      <div className="flex items-center gap-0.5 shrink-0">
        <button className={navBtn} onClick={onReset} disabled={!hasSequence} title="First move"><IconFirst /></button>
        <button className={navBtn} onClick={onBack} disabled={!hasSequence} title="Previous move"><IconPrev /></button>
        {onForward && <button className={navBtn} onClick={onForward} disabled={!canForward} title="Next move"><IconNext /></button>}
        {onEnd && <button className={navBtn} onClick={onEnd} disabled={!canForward} title="Last move"><IconLast /></button>}
      </div>
      <div tabIndex={0} onKeyDown={onKeyDown} className="flex-1 min-h-0 overflow-y-auto text-body-sm leading-6 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded-sm">
        {rows.length === 0 ? (
          <span className="text-on-surface-variant">Starting position</span>
        ) : (
          rows.map((r) => (
            // Keep "N. white black" together (whitespace-nowrap), but emit a real
            // space between move-pairs so the list wraps to new lines instead of
            // scrolling horizontally.
            <Fragment key={r.no}>
              <span className="whitespace-nowrap">
                <span className="text-on-surface-variant select-none">{r.no}.</span>{" "}
                {r.w && <span className={moveCls(r.w.i)} onClick={moveClick(r.w.i)}>{r.w.san}</span>}
                {r.b && <> <span className={moveCls(r.b.i)} onClick={moveClick(r.b.i)}>{r.b.san}</span></>}
              </span>{" "}
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}
