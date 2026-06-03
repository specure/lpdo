// Helpers for editing the soft-delete tag on a single PGN block and for
// re-assembling a list of blocks back into a file.

const DELETED_TAG_RE = /^\[Deleted\s+"[^"]*"\][ \t]*\r?\n?/m;

const TAG_LINE_RE = /^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\][ \t]*$/;

/** PGN Seven Tag Roster — always present in the editor, can't be deleted. */
export const STR_TAGS = ["Event", "Site", "Date", "Round", "White", "Black", "Result"] as const;

export type Tag = { name: string; value: string };

/** Unescape a PGN tag value: \\ → \, \" → ". */
function unescapeTagValue(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/** Escape a PGN tag value: \ → \\, " → \". */
function escapeTagValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Split a block into its (name, value) tag list and the body (moves + result). */
export function parseBlockTags(block: string): { tags: Tag[]; body: string } {
  const lines = block.split(/\r?\n/);
  const tags: Tag[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    const m = TAG_LINE_RE.exec(line);
    if (!m) break;
    tags.push({ name: m[1], value: unescapeTagValue(m[2]) });
  }
  // Skip a single conventional blank line between tags and body.
  if (lines[i] !== undefined && lines[i].trim() === "") i++;
  const body = lines.slice(i).join("\n");
  return { tags, body };
}

/** Build a block from a tag list and a preserved body string. */
export function buildBlock(tags: Tag[], body: string): string {
  const tagLines = tags.map((t) => `[${t.name} "${escapeTagValue(t.value)}"]`).join("\n");
  const trimmedBody = body.replace(/^\s+/, "").replace(/\s+$/, "");
  return trimmedBody.length > 0 ? `${tagLines}\n\n${trimmedBody}` : tagLines;
}

/** Validate a tag name per PGN: alpha-then-alnum-or-underscore. */
export function isValidTagName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

/** Today as an ISO 8601 date string (YYYY-MM-DD) in local time. */
export function todayPgnDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Persisted across sessions in localStorage. Most users play in a small set of
// recurring venues (their club, recent tournament cities), so prefilling Site
// from the most recent value is a strong default.
//
// First-time users get "lpdo.com" as the fallback — same convention lichess
// uses for online games (their Site tag is "https://lichess.org"). Once the
// user enters their own value (in a new-game form), it overrides this.
const SITE_DEFAULT_KEY = "defaultPgnSite";
const SITE_FALLBACK = "lpdo.com";

export function defaultPgnSite(): string {
  try {
    const saved = localStorage.getItem(SITE_DEFAULT_KEY);
    return saved && saved.trim() ? saved : SITE_FALLBACK;
  } catch {
    return SITE_FALLBACK;
  }
}

export function rememberPgnSite(site: string): void {
  const trimmed = (site || "").trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(SITE_DEFAULT_KEY, trimmed);
  } catch {
    // localStorage unavailable (private mode, etc.) — silently skip
  }
}

/** Default tags for a new game: STR in spec order with sensible placeholders. */
export function defaultNewGameTags(): Tag[] {
  const date = todayPgnDate();
  const site = defaultPgnSite();
  return STR_TAGS.map<Tag>((name) => {
    if (name === "Date") return { name, value: date };
    if (name === "Round") return { name, value: "-" };
    if (name === "Result") return { name, value: "*" };
    if (name === "Site") return { name, value: site };
    return { name, value: "" };
  });
}

/**
 * Return `block` with a `[Deleted "<isoTimestamp>"]` tag inserted at the end
 * of its tag section. If a Deleted tag already exists, it is replaced.
 */
export function markBlockDeleted(block: string, isoTimestamp: string): string {
  const stripped = block.replace(DELETED_TAG_RE, "");
  // Find the end of the tag section: the last line that starts with '['.
  const lines = stripped.split(/\r?\n/);
  let lastTagIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("[")) lastTagIdx = i;
    else if (lastTagIdx !== -1 && lines[i].trim() === "") break;
  }
  const insertAt = lastTagIdx === -1 ? 0 : lastTagIdx + 1;
  lines.splice(insertAt, 0, `[Deleted "${isoTimestamp}"]`);
  return lines.join("\n");
}

/** Return `block` with any `[Deleted "..."]` tag removed. */
export function unmarkBlockDeleted(block: string): string {
  return block.replace(DELETED_TAG_RE, "");
}

/**
 * Assemble blocks into file content. Each block is trimmed of trailing
 * whitespace, separated by a blank line, with a single trailing newline.
 */
export function assemblePgnFile(blocks: string[]): string {
  const cleaned = blocks
    .map((b) => b.replace(/\s+$/g, ""))
    .filter((b) => b.length > 0);
  return cleaned.length === 0 ? "" : cleaned.join("\n\n") + "\n";
}

// ── Move-number injection ────────────────────────────────────────────────────
//
// Some games are stored with a bare-moves body ("e4 e5 Nf3 ..." + result),
// which strict PGN parsers reject. `ensureMoveNumbers(pgn)` parses the body
// and re-emits it with proper move numbering, so exported `.pgn` files load
// cleanly into ChessBase, lichess, etc.

type BodyTok =
  | { type: "move_number" }
  | { type: "move"; value: string }
  | { type: "nag"; value: string }
  | { type: "comment"; value: string }
  | { type: "var_start" }
  | { type: "var_end" }
  | { type: "result"; value: string };

function tokenizeBody(body: string): BodyTok[] {
  const tokens: BodyTok[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (/\s/.test(c)) { i++; continue; }

    if (c === "{") {
      const end = body.indexOf("}", i + 1);
      if (end === -1) { i++; continue; }
      tokens.push({ type: "comment", value: body.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === "(") { tokens.push({ type: "var_start" }); i++; continue; }
    if (c === ")") { tokens.push({ type: "var_end" }); i++; continue; }

    if (c === "$") {
      const m = body.slice(i).match(/^\$(\d+)/);
      if (m) { tokens.push({ type: "nag", value: m[1] }); i += m[0].length; continue; }
    }

    const result = body.slice(i).match(/^(1-0|0-1|1\/2-1\/2|\*)/);
    if (result) {
      tokens.push({ type: "result", value: result[0] });
      i += result[0].length;
      continue;
    }

    const num = body.slice(i).match(/^(\d+)(\.{1,3})/);
    if (num) {
      tokens.push({ type: "move_number" });
      i += num[0].length;
      continue;
    }

    const san = body.slice(i).match(/^([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O-O[+#]?|O-O[+#]?)/);
    if (san) {
      tokens.push({ type: "move", value: san[0] });
      i += san[0].length;
      continue;
    }

    // Unknown char — skip
    i++;
  }
  return tokens;
}

interface NumberFrame {
  /** Move number for the next white half-move (1-based). */
  num: number;
  /** Whose half-move comes next. */
  side: "w" | "b";
  /** When true, prefix the next move with a number even if it's Black's
   *  (used after a comment, NAG, or variation, per PGN convention). */
  forceNumber: boolean;
}

/** Re-emit a movetext body with proper PGN move numbers. Existing numbers
 *  are dropped and regenerated; comments, NAGs and variations are preserved. */
function addMoveNumbers(body: string): string {
  const tokens = tokenizeBody(body);
  const stack: NumberFrame[] = [];
  let frame: NumberFrame = { num: 1, side: "w", forceNumber: false };
  const out: string[] = [];

  for (const tok of tokens) {
    switch (tok.type) {
      case "move_number":
        // Drop — we emit our own.
        break;

      case "move":
        if (frame.side === "w") {
          out.push(`${frame.num}.`);
          out.push(tok.value);
          frame.side = "b";
        } else {
          if (frame.forceNumber) out.push(`${frame.num}...`);
          out.push(tok.value);
          frame.side = "w";
          frame.num++;
        }
        frame.forceNumber = false;
        break;

      case "comment":
        out.push(`{${tok.value}}`);
        // After a comment, a Black move must re-display its number.
        frame.forceNumber = true;
        break;

      case "nag":
        out.push(`$${tok.value}`);
        frame.forceNumber = true;
        break;

      case "var_start": {
        // The variation replaces the just-emitted move. Step the frame back
        // one half-move so the variation's first move shows the right number.
        stack.push({ ...frame });
        if (frame.side === "b") {
          // Last emitted was White's move N. Variation alternative is for that
          // White move at the same N.
          frame = { num: frame.num, side: "w", forceNumber: true };
        } else {
          // Last emitted was Black's move N (we've since incremented to N+1).
          frame = { num: frame.num - 1, side: "b", forceNumber: true };
        }
        out.push("(");
        break;
      }

      case "var_end": {
        out.push(")");
        const popped = stack.pop();
        if (popped) {
          frame = popped;
          // Returning to the parent line — the next move needs a fresh number.
          frame.forceNumber = true;
        }
        break;
      }

      case "result":
        out.push(tok.value);
        break;
    }
  }

  return out.join(" ");
}

/** Round-trip a full PGN block to guarantee the body has proper move numbers.
 *  Tag block is preserved verbatim (modulo re-escaping). */
export function ensureMoveNumbers(pgn: string): string {
  const { tags, body } = parseBlockTags(pgn);
  return buildBlock(tags, addMoveNumbers(body));
}
