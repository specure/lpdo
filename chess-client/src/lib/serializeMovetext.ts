import type { AnnotatedGame, Annotations, MoveNode } from "./parsePgnTree";
import { encodeCal, encodeCsl, symbolToNag } from "./parseAnnotations";

// Inverse of `parsePgnTree`: turn a (possibly annotated, possibly branched)
// move tree back into PGN movetext. Emits movetext only — no tag pairs and no
// result token; the backend appends the canonical result from the games row.
//
// Round-trip target: `serializeMovetext(parsePgnTree(pgn))` reproduces an
// equivalent movetext (modulo whitespace) for SAN, move numbers, NAGs,
// comments, [%cal]/[%csl] graphics, and nested variations.

/** Build a `{ ... }` comment block from a node's annotations, or "" if empty.
 *  Text first, then circles, then arrows — order is irrelevant to the parser
 *  (`parseComment` extracts each independently). */
function encodeComment(ann: Annotations): string {
  const inner: string[] = [];
  if (ann.comment) inner.push(ann.comment);
  const csl = encodeCsl(ann.circles ?? []);
  if (csl) inner.push(csl);
  const cal = encodeCal(ann.arrows ?? []);
  if (cal) inner.push(cal);
  return inner.length ? `{${inner.join(" ")}}` : "";
}

/** Serialize one line of moves. `firstMoveNo`/`firstIsWhite` describe the first
 *  node's position in the game so move numbers come out correct for variations
 *  (which inherit the move number of the move they replace) and for games that
 *  start from a FEN. */
function serializeLine(line: MoveNode[], firstMoveNo: number, firstIsWhite: boolean): string {
  const parts: string[] = [];
  // A line always starts with a numbered move; a Black move also re-numbers
  // after a comment or a variation block (e.g. "4. d4 (4. Nf3) 4... exd4").
  let forceNumber = true;
  let moveNo = firstMoveNo;
  let isWhite = firstIsWhite;

  for (const node of line) {
    if (!node.san) continue; // skip comment sentinels / emptied nodes

    // Leading comment (line intro) — emitted before the move number.
    if (node.preComment) parts.push(`{${node.preComment}}`);

    if (isWhite) parts.push(`${moveNo}.`);
    else if (forceNumber) parts.push(`${moveNo}...`);

    parts.push(node.san);

    const nag = node.annotations.nag ? symbolToNag(node.annotations.nag) : null;
    if (nag !== null) parts.push(`$${nag}`);

    const comment = encodeComment(node.annotations);
    if (comment) parts.push(comment);

    // Variations attach to this node and start from the same position, so they
    // inherit this node's move number and colour.
    let hadBranch = false;
    for (const variation of node.variations) {
      const real = variation.filter((n) => n.san);
      if (!real.length) continue;
      hadBranch = true;
      parts.push(`(${serializeLine(variation, moveNo, isWhite)})`);
    }

    forceNumber = !!comment || hadBranch;

    // Advance to the next ply.
    if (isWhite) {
      isWhite = false;
    } else {
      isWhite = true;
      moveNo += 1;
    }
  }

  return parts.join(" ");
}

export function serializeMovetext(game: AnnotatedGame): string {
  const parts: string[] = [];

  // Leading comment / graphics before the first move.
  const startInner: string[] = [];
  if (game.startComment) startInner.push(game.startComment);
  const csl = encodeCsl(game.startAnnotations?.circles ?? []);
  if (csl) startInner.push(csl);
  const cal = encodeCal(game.startAnnotations?.arrows ?? []);
  if (cal) startInner.push(cal);
  if (startInner.length) parts.push(`{${startInner.join(" ")}}`);

  // Derive the starting move number / side from the start FEN (defaults to the
  // standard opening position: White to move, full-move 1).
  const fields = game.startFen.split(/\s+/);
  const firstIsWhite = fields[1] !== "b";
  const firstMoveNo = Number.parseInt(fields[5] ?? "1", 10) || 1;

  const body = serializeLine(game.mainLine, firstMoveNo, firstIsWhite);
  if (body) parts.push(body);

  return parts.join(" ").trim();
}
