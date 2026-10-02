// Merging chapters (#327): what the merge does, and for each place where the
// chapters' comments (or NAGs) differ, which version stays. The lines are
// already merged (lib/mergeChapters.ts); this only picks among the texts.

import { diffPieces } from "../../lib/textDiff";
import { useState } from "react";
import type { MergeChoices, MergeConflict } from "../../lib/mergeChapters";

interface Props {
  target: string;
  others: string[];
  added: number;
  carried: { comments: number; marks: number };
  takenOver: number;
  conflicts: MergeConflict[];
  busy: boolean;
  /** `noteChapters`: each line's chapter noted in its last move's comment. */
  onMerge: (choices: MergeChoices, noteChapters: boolean) => void;
  onCancel: () => void;
}

const plain = "h-8 px-3 inline-flex items-center rounded-full text-label-lg text-primary hover:bg-primary/8 disabled:opacity-40 transition-colors duration-short3 ease-standard whitespace-nowrap";
const chip = "h-7 px-3 inline-flex items-center rounded-full border border-outline/40 text-label-md text-on-surface-variant hover:bg-on-surface/8 transition-colors duration-short3 ease-standard whitespace-nowrap max-w-full truncate";

const KIND: Record<MergeConflict["kind"], string> = { comment: "comment", intro: "line intro", nags: "move marks" };

const NOTE_KEY = "repertoireMergeNoteChapters";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** ", with their 37 comments and 12 marks" — what the added moves bring along. */
function carryText({ comments, marks }: { comments: number; marks: number }): string {
  const parts = [comments && plural(comments, "comment", "comments"), marks && plural(marks, "mark", "marks")].filter(Boolean);
  return parts.length ? `, with their ${parts.join(" and ")}` : "";
}

export default function MergeChaptersDialog({ target, others, added, carried, takenOver, conflicts, busy, onMerge, onCancel }: Props) {
  const [choices, setChoices] = useState<MergeChoices>(() => new Map());
  // Remembered for the next merge.
  const [noteChapters, setNoteChapters] = useState(() => {
    try { return localStorage.getItem(NOTE_KEY) === "1"; } catch { return false; }
  });
  const toggleNote = (on: boolean) => {
    setNoteChapters(on);
    try { localStorage.setItem(NOTE_KEY, on ? "1" : "0"); } catch { /* not remembered */ }
  };
  const pick = (id: number, c: number | "all") => setChoices((m) => new Map(m).set(id, c));
  const chapters = [target, ...others];
  const allFrom = (name: string) => setChoices((m) => {
    const next = new Map(m);
    for (const c of conflicts) {
      const at = c.options.findIndex((o) => o.chapter.split(", ").includes(name));
      if (at >= 0) next.set(c.id, at);
    }
    return next;
  });
  const allBoth = () => setChoices(new Map(conflicts.map((c) => [c.id, "all" as const])));
  // The chapters that have a version in some place that differs, in order.
  const involved = chapters.filter((n) => conflicts.some((c) => c.options.some((o) => o.chapter.split(", ").includes(n))));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40" onClick={busy ? undefined : onCancel}>
      <div className="bg-surface-container-high rounded-xl shadow-2xl w-[48rem] max-w-[92vw] max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 pt-4 pb-2 shrink-0">
          <h2 className="text-title-md text-on-surface">Merge chapters</h2>
          <p className="mt-1 text-body-sm text-on-surface-variant">
            Into <span className="text-on-surface">“{target}”</span>, which keeps its name, its place and its main line;{" "}
            {others.length <= 5
              ? others.map((o, i) => <span key={i}>{i ? ", " : ""}<span className="text-on-surface">“{o}”</span></span>)
              : <span className="text-on-surface underline decoration-dotted underline-offset-2 cursor-help" title={others.join("\n")}>the {others.length} other chapters</span>}{" "}
            {others.length === 1 ? "is" : "are"} deleted after the merge.
          </p>
          <p className="mt-1 text-body-sm text-on-surface-variant">
            {[
              added > 0 && `${plural(added, "move", "moves")} added as variations${carryText(carried)}`,
              takenOver > 0 && `${plural(takenOver, "comment or mark", "comments or marks")} added to moves already in “${target}”`,
              conflicts.length ? `${plural(conflicts.length, "place", "places")} where they differ:` : "no conflicting comments.",
            ].filter(Boolean).join("; ").replace(/^./, (c) => c.toUpperCase())}
          </p>
          {conflicts.length > 1 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-label-md text-on-surface-variant">Everywhere:</span>
              {/* Only the chapters with a version in the places that differ —
                  of 50 merged, a handful; past six, a list to pick from. */}
              {involved.length <= 6
                ? involved.map((n, i) => <button key={i} onClick={() => allFrom(n)} className={chip} title={`Take “${n}”'s version wherever it has one`}>{n}</button>)
                : (
                  <select value="" onChange={(e) => { if (e.target.value) allFrom(e.target.value); }}
                    className="h-7 px-2 rounded-full border border-outline/40 bg-surface-container text-label-md text-on-surface-variant max-w-full"
                    title="Take this chapter's version wherever it has one">
                    <option value="">a chapter's version…</option>
                    {involved.map((n, i) => <option key={i} value={n}>{n}</option>)}
                  </select>
                )}
              <button onClick={allBoth} className={chip} title="Keep every version, one after the other">Both</button>
            </div>
          )}
        </div>
        {conflicts.length > 0 && (
          <div className="px-6 py-2 flex-1 min-h-0 overflow-y-auto flex flex-col gap-3">
            {conflicts.map((c) => {
              const chosen = choices.get(c.id) ?? 0;
              return (
                <div key={c.id} className="rounded-md border border-outline/40 bg-surface-container-low">
                  <div className="px-3 py-1.5 flex items-baseline gap-2 border-b border-outline/40">
                    <span className="flex-1 min-w-0 font-mono text-body-sm text-on-surface break-words">{c.where || "Start of the chapter"}</span>
                    <span className="shrink-0 text-label-sm text-on-surface-variant">{KIND[c.kind]}</span>
                  </div>
                  <div className="p-2 flex flex-col gap-1">
                    {/* What differs marked: the target's against every other
                        version, another's against the target's. */}
                    {c.options.map((o, i) => (
                      <Option key={i} name={c.id} checked={chosen === i} onChange={() => pick(c.id, i)} label={o.chapter} text={o.text}
                        against={i === 0 ? c.options.slice(1).map((x) => x.text) : [c.options[0].text]} />
                    ))}
                    <Option name={c.id} checked={chosen === "all"} onChange={() => pick(c.id, "all")}
                      label={c.options.length === 2 ? "Both" : "All"}
                      text={c.kind === "nags" ? "Every mark from each version" : "Every version, one after the other"} muted />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="px-6 py-4 shrink-0 flex items-center justify-end gap-2">
          <label className="mr-auto flex items-center gap-2 text-body-sm text-on-surface-variant cursor-pointer"
            title="Each line's last move gets the chapter it came from at the end of its comment, e.g. “… (Theory 3D: #24)”">
            <input type="checkbox" checked={noteChapters} onChange={(e) => toggleNote(e.target.checked)} className="accent-primary" />
            Note each line's chapter at its end
          </label>
          <button onClick={onCancel} disabled={busy} className={plain}>Cancel</button>
          <button onClick={() => onMerge(choices, noteChapters)} disabled={busy}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard">
            {busy ? "Merging…" : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Option({ name, checked, onChange, label, text, against, muted = false }: {
  name: number; checked: boolean; onChange: () => void; label: string; text: string; muted?: boolean;
  /** The versions to mark the differences against, in yellow. */
  against?: string[];
}) {
  return (
    <label className={`flex items-start gap-2 px-2 py-1.5 rounded-sm cursor-pointer ${checked ? "bg-primary-container/40" : "hover:bg-on-surface/4"}`}>
      <input type="radio" name={`merge-${name}`} checked={checked} onChange={onChange} className="accent-primary mt-1 shrink-0" />
      <span className="min-w-0">
        <span className="block text-label-md text-on-surface-variant">{label}</span>
        <span className={`block text-body-sm whitespace-pre-wrap break-words ${muted ? "text-on-surface-variant italic" : "text-on-surface"}`}>
          {against
            ? diffPieces(text, against).map((p, k) => p.differs
              ? <mark key={k} className="rounded-[2px] px-px" style={{ backgroundColor: "rgba(250, 204, 21, 0.45)", color: "inherit" }}>{p.text}</mark>
              : <span key={k}>{p.text}</span>)
            : text}
        </span>
      </span>
    </label>
  );
}
