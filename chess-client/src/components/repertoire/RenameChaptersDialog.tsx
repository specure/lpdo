// Renaming a book's chapters at once (#327): find and replace over the names,
// every chapter's new name shown before anything is saved.

import { useState } from "react";
import type { ChapterSummary } from "../../lib/repertoire";
import { compileRule, renamed, type RenameRule } from "../../lib/renameChapters";

interface Props {
  bookName: string;
  chapters: ChapterSummary[];
  busy: boolean;
  onRename: (changes: { id: number; name: string }[]) => void;
  onCancel: () => void;
}

const field = "h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface";
const plain = "h-8 px-3 inline-flex items-center rounded-full text-label-lg text-primary hover:bg-primary/8 disabled:opacity-40 transition-colors duration-short3 ease-standard whitespace-nowrap";

export default function RenameChaptersDialog({ bookName, chapters, busy, onRename, onCancel }: Props) {
  const [rule, setRule] = useState<RenameRule>({ find: bookName, replace: "", regex: false, matchCase: false, trim: true });
  const set = (patch: Partial<RenameRule>) => setRule((r) => ({ ...r, ...patch }));

  const re = compileRule(rule);
  const rows = chapters.map((c) => {
    const next = re instanceof RegExp ? renamed(c.name, re, rule) : null;
    return { c, next, empty: next != null && !next.trim() };
  });
  const changes = rows.filter((r) => r.next != null && !r.empty).map((r) => ({ id: r.c.id, name: r.next!.trim() }));

  const check = (label: string, value: boolean, key: "regex" | "matchCase" | "trim", title: string) => (
    <label className="inline-flex items-center gap-1.5 text-body-sm text-on-surface-variant cursor-pointer" title={title}>
      <input type="checkbox" checked={value} onChange={(e) => set({ [key]: e.target.checked })} className="accent-primary" />
      {label}
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40" onClick={busy ? undefined : onCancel}>
      <form className="bg-surface-container-high rounded-xl shadow-2xl w-[48rem] max-w-[92vw] max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (changes.length && !busy) onRename(changes); }}>
        <div className="px-6 pt-4 pb-2 shrink-0 flex flex-col gap-2">
          <h2 className="text-title-md text-on-surface">Rename chapters</h2>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
            <span className="text-label-md text-on-surface-variant">Find</span>
            <input autoFocus value={rule.find} onChange={(e) => set({ find: e.target.value })} className={`${field} ${rule.regex ? "font-mono" : ""}`} />
            <span className="text-label-md text-on-surface-variant">Replace with</span>
            <input value={rule.replace} onChange={(e) => set({ replace: e.target.value })} placeholder="nothing — remove it" className={`${field} ${rule.regex ? "font-mono" : ""}`} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {check("Trim leftover separators", rule.trim, "trim", "Remove the spaces, dashes and colons a removal leaves at the start or end of a name")}
            {check("Match case", rule.matchCase, "matchCase", "Only where the case is the same")}
            {check("Regular expression", rule.regex, "regex", "Find is a regular expression; $1, $2 … in Replace are its groups")}
          </div>
          {typeof re === "string" && <div className="text-label-sm text-error">{re}</div>}
        </div>
        <div className="px-6 py-2 flex-1 min-h-0 overflow-y-auto">
          <table className="w-full text-body-sm">
            <tbody>
              {rows.map(({ c, next, empty }) => (
                <tr key={c.id} className={next == null ? "text-on-surface-variant opacity-60" : "text-on-surface"}>
                  <td className="py-0.5 pr-2 align-top break-words">{c.name}</td>
                  <td className="py-0.5 px-1 align-top text-on-surface-variant">→</td>
                  <td className="py-0.5 align-top break-words">
                    {next == null ? <span className="italic">unchanged</span>
                      : empty ? <span className="italic text-error">would be empty — left as it is</span>
                      : <span className="font-medium">{next}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-4 shrink-0 flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={plain}>Cancel</button>
          <button type="submit" disabled={busy || !changes.length}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard">
            {busy ? "Renaming…" : changes.length ? `Rename ${changes.length}` : "Rename"}
          </button>
        </div>
      </form>
    </div>
  );
}
