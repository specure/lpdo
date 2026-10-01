// Renaming a book's chapters at once (#327): find and replace over their
// names — the book's name repeated in every chapter's, say — with the
// separators left over trimmed.

export interface RenameRule {
  find: string;
  replace: string;
  /** `find` is a regular expression (`$1` … in `replace`). */
  regex: boolean;
  matchCase: boolean;
  /** Trim what a removal leaves at either end: spaces, dashes, colons. */
  trim: boolean;
}

/** Leading and trailing separators — not dots, which end "5...Nb6"-like names
 *  only as part of a move. */
const EDGES = /^[\s\-–—:·|,;]+|[\s\-–—:·|,;]+$/g;

/** The rule as a RegExp, or the error of an invalid pattern. */
export function compileRule(rule: RenameRule): RegExp | string | null {
  if (!rule.find) return null;
  const src = rule.regex ? rule.find : rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try { return new RegExp(src, rule.matchCase ? "g" : "gi"); } catch (e) { return (e as Error).message; }
}

/** A chapter's new name, or null when the rule leaves it as it is. */
export function renamed(name: string, re: RegExp, rule: RenameRule): string | null {
  re.lastIndex = 0;
  if (!re.test(name)) return null;
  re.lastIndex = 0;
  let out = name.replace(re, rule.regex ? rule.replace : rule.replace.replace(/\$/g, "$$$$"));
  if (rule.trim) out = out.replace(EDGES, "");
  out = out.replace(/\s{2,}/g, " ");
  return out === name ? null : out;
}
