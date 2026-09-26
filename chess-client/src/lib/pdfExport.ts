// Printing a game the way a chess book does it: A4, two columns, the main line
// in bold, variations indented in brackets, and a board diagram wherever the
// movetext asks for one.
//
// The diagram marker is ChessBase's: a comment containing `[#]` means "show the
// position here", so games imported from ChessBase already carry their author's
// diagrams. The marker is drawn, not printed.
//
// The game's PGN travels in the PDF's XMP metadata, so a PDF exported here can
// be imported again with nothing lost — the printed page is a view of the game,
// the metadata is the game itself.

import { LineCapStyle, PDFDocument, PDFFont, PDFPage, PDFName, StandardFonts, rgb, RGB } from "pdf-lib";
import { PIECE_SET, PIECE_SET_BOXES, PIECE_SET_SIZE } from "./pieceSet";
import { Chess } from "chess.js";
import { parsePgnTree, AnnotatedGame, MoveNode } from "./parsePgnTree";
import { getMoveNum } from "./moveTreeNav";
import { nagsToString } from "./parseAnnotations";

// ── Page geometry (points; A4 is 595.28 × 841.89) ───────────────────────────
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 56, bottom: 48, left: 46, right: 46 };
const GUTTER = 18;
const COLUMN_WIDTH = (PAGE.width - MARGIN.left - MARGIN.right - GUTTER) / 2;
/** Leading for the move text: 1.35× the move size, which is what lets a dense
 *  page of moves, comments and figurines be read line by line. */
const LINE_HEIGHT = 12.4;
/** How wide a diagram is drawn: about two thirds of the column, the proportion
 *  a printed game uses — a board the full column width swamps the moves. */
const DIAGRAM_WIDTH = COLUMN_WIDTH * 0.66;
const SIZE = { move: 9.2, variation: 8.4, header: 10.5, small: 8.2, running: 9 };
const INK = rgb(0, 0, 0);
const MUTED = rgb(0.32, 0.32, 0.32);
/** The board's colours on screen (index.css, light theme), so a printed
 *  diagram looks like the board the game was studied on. */
const SQUARE_LIGHT = rgb(0.933, 0.933, 0.824);   // #eeeed2
const SQUARE_DARK = rgb(0.463, 0.588, 0.337);    // #769656

/** One piece of text with the font it is drawn in. A run with `piece` set is
 *  a figurine — drawn from the piece outlines rather than from a font, so the
 *  move text and the diagrams show the same pieces. */
interface Run {
  text: string;
  font: PDFFont;
  size: number;
  color: RGB;
  /** A figurine move: `prefix` (the move number) is drawn, then the piece,
   *  then `text` (the square and any marks) — all as one unbreakable word,
   *  so a line never ends on the piece and starts on its square. */
  piece?: string;
  prefix?: string;
  /** A colour swatch instead of text: the hollow or filled square that says
   *  which player is White and which is Black in the heading. */
  swatch?: "white" | "black";
}

/** A paragraph of runs, indented by `indent` points. */
interface Para {
  kind: "para";
  runs: Run[];
  indent: number;
  /** Space above, for the gap between the main line and a variation. */
  spaceBefore: number;
}

interface Diagram {
  kind: "diagram";
  fen: string;
  /** Whose view: diagrams are drawn from White's side unless asked otherwise. */
  flipped: boolean;
}

/** Where one game ends and the next begins: a gap and a rule, or a new page. */
interface GameBreak {
  kind: "break";
  newPage: boolean;
}

type Block = Para | Diagram | GameBreak;

/** What the header block prints. Anything missing here is read from the PGN's
 *  own tags, which is where the round and the site usually are. */
export interface PdfGame {
  white: string;
  black: string;
  white_elo?: number | null;
  black_elo?: number | null;
  event?: string | null;
  site?: string | null;
  date?: string | null;
  round?: string | null;
  result?: string | null;
  eco?: string | null;
  pgn: string;
  /** Draw this game's diagrams from Black's side — the way its board stood
   *  on screen. Overrides the document-wide `flipped`. */
  flipped?: boolean;
}

export interface PdfOptions {
  /** Draw diagrams from Black's side (unless a game says otherwise). */
  flipped?: boolean;
  /** A title for a document of several games, used in the running header
   *  and the metadata instead of "N games". */
  title?: string;
  /** Add a diagram of the final position even when the movetext asks for none. */
  diagramAtEnd?: boolean;
  /** Print pieces as figurines (♘f3) rather than letters (Nf3), the way a
   *  chess book sets moves. Letters stay for anyone who prefers them — and
   *  they are what a PGN holds either way. */
  figurines?: boolean;
  /** Shown in the running header, e.g. "LPDO 0.19.0". */
  producer?: string;
  /** With several games: start each on a fresh page rather than flowing on. */
  newPagePerGame?: boolean;
  /** Draw each diagram from the side to move — the way a puzzle or a
   *  critical position is set — rather than from one fixed side. */
  sideToMove?: boolean;
  /** Bulletin style: the moves alone, no comments and no diagrams — the most
   *  games on the least paper. */
  compact?: boolean;
}


/** A SAN move that names a piece — a figurine can stand in for that letter.
 *  Pawn moves ("e4", "exd5") name none, and castling is written out. */
function isPiece(first: string | undefined): first is "K" | "Q" | "R" | "B" | "N" {
  return first === "K" || first === "Q" || first === "R" || first === "B" || first === "N";
}

/** `[#]` anywhere in a comment asks for a diagram; the rest is still printed. */
const DIAGRAM_MARKER = /\s*\[#\]\s*/;

export async function buildGamePdf(input: PdfGame, opts: PdfOptions): Promise<Uint8Array> {
  return buildGamesPdf([input], opts);
}

/** Several games in one document, in the order given: each with its own
 *  heading, flowing on after a rule (or on a new page), the way a printed
 *  bulletin sets them. All their PGN travels in the metadata. */
export async function buildGamesPdf(inputs: PdfGame[], opts: PdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = {
    text: await doc.embedFont(StandardFonts.TimesRoman),
    bold: await doc.embedFont(StandardFonts.TimesRomanBold),
    italic: await doc.embedFont(StandardFonts.TimesRomanItalic),
  };
  const compact = !!opts.compact;
  const games = inputs.map(withPgnTags);

  // The title goes in the running header, where it names every page; it is
  // not repeated above the first game.
  const title = opts.title?.trim() || "";
  const blocks: Block[] = [];
  games.forEach((game, i) => {
    if (i > 0) blocks.push({ kind: "break", newPage: !!opts.newPagePerGame });
    const flipped = game.flipped ?? !!opts.flipped;
    const tree = parsePgnTree(game.pgn);
    blocks.push(...headerBlocks(game, fonts));
    blocks.push(...movetextBlocks(tree, fonts, flipped, opts.figurines !== false, compact));
    if (opts.diagramAtEnd && !compact) {
      const last = tree.mainLine[tree.mainLine.length - 1];
      blocks.push({ kind: "diagram", fen: last ? last.fen : tree.startFen, flipped });
    }
    if (game.result) {
      blocks.push(para([run(prettyResult(game.result), fonts.bold, SIZE.move, INK)], 0, 4));
    }
  });

  const many = title || `${games.length} games`;
  const header = games.length === 1
    ? runningHeader(games[0], opts.producer)
    : [opts.producer ?? "LPDO", many].join(" — ");
  if (opts.sideToMove) {
    for (const b of blocks) if (b.kind === "diagram") b.flipped = b.fen.split(" ")[1] === "b";
  }
  layout(doc, blocks, fonts, header);

  doc.setTitle(games.length === 1 ? `${games[0].white} – ${games[0].black}` : many);
  doc.setAuthor(opts.producer ?? "LPDO");
  doc.setSubject(games.length === 1 ? describe(games[0]) : games.map(describe).join("; ").slice(0, 500));
  setXmpWithPgn(doc, games, many);

  return doc.save();
}

/** Fill the gaps in what the caller knew from the PGN's own tags. */
function withPgnTags(game: PdfGame): PdfGame {
  const tag = (name: string): string | null => {
    const m = game.pgn.match(new RegExp(`\\[${name} "([^"]*)"`));
    const value = m?.[1]?.trim();
    return value && !/^[?\s-]*$/.test(value) ? value : null;
  };
  return {
    ...game,
    event: game.event ?? tag("Event"),
    site: game.site ?? tag("Site"),
    round: game.round ?? tag("Round"),
    date: game.date ?? tag("Date")?.replace(/\./g, "-") ?? null,
    eco: game.eco ?? tag("ECO"),
    result: game.result ?? tag("Result"),
  };
}

// ── The game's own heading, as a chess book prints it ────────────────────────

function headerBlocks(game: PdfGame, fonts: Fonts): Block[] {
  const name = (who: string, elo?: number | null) => (elo ? `${who}  ${elo}` : who);
  const where = [
    game.event,
    game.round && !/^[?\-\s]*$/.test(game.round) ? `(${game.round})` : null,
    game.site && !/^https?:/i.test(game.site) ? game.site : null,
  ].filter(Boolean).join(" ");
  const when = game.date && !game.date.startsWith("????") ? game.date.replace(/-/g, ".") : "";

  const blocks: Block[] = [];
  // A hollow square before White, a filled one before Black — the way a
  // printed game says which is which, since a list of two names does not:
  // the second name is Black here, but the bottom player is White on any
  // board on screen.
  blocks.push(para([
    { ...run("", fonts.bold, SIZE.header, INK), swatch: "white" },
    run(name(game.white, game.white_elo), fonts.bold, SIZE.header, INK),
    ...(game.eco ? [run(`   ${game.eco}`, fonts.bold, SIZE.small, MUTED)] : []),
  ], 0, 1));
  blocks.push(para([
    { ...run("", fonts.bold, SIZE.header, INK), swatch: "black" },
    run(name(game.black, game.black_elo), fonts.bold, SIZE.header, INK),
  ], 0, 0));
  if (where || when) {
    blocks.push(para([run([where, when].filter(Boolean).join("  "), fonts.text, SIZE.small, MUTED)], 0, 1));
  }
  return blocks;
}

// ── Movetext → blocks ────────────────────────────────────────────────────────

interface Fonts { text: PDFFont; bold: PDFFont; italic: PDFFont }

function run(text: string, font: PDFFont, size: number, color: RGB): Run {
  return { text: printable(text), font, size, color };
}

// The standard PDF fonts cover WinAnsi — Western European letters and a few
// symbols — and pdf-lib refuses anything else. The evaluation signs chess
// uses beyond ± (∓, ∞, →, ↑ …) are spelled the way books without the glyphs
// print them; other letters lose their accents (Svrček → Svrcek) rather
// than the whole document failing. The PGN inside the file keeps the
// original text; only the printed page is affected.
const SPELLED: Record<string, string> = {
  "\u2213": "-/+",      // ∓ Black is slightly better
  "\u2a72": "+/=",      // ⩲ White is slightly better
  "\u2a71": "=/+",      // ⩱ Black is slightly better
  "\u221e": " (unclear)",  // ∞
  "\u2a00": " (zugzwang)", // ⨀
  "\u2192": " ->",       // → with attack
  "\u2191": " ^",        // ↑ with initiative
  "\u21c6": " <->",      // ⇆ counterplay
  "\u25a1": "[]",       // □ only move
  "\u2206": "D",        // ∆ with the idea
  "\u2212": "-",        // − minus sign
  "\u2012": "-", "\u2011": "-", "\u2010": "-",
  "\u00a0": " ", "\u2009": " ", "\u202f": " ",
};
// Unicode points WinAnsi places in 0x80–0x9F, beyond Latin-1.
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);
function encodable(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return c === 0x0a || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(c);
}
export function printable(text: string): string {
  let out = "";
  for (const ch of text) {
    if (encodable(ch)) { out += ch; continue; }
    if (SPELLED[ch] !== undefined) { out += SPELLED[ch]; continue; }
    const bare = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (bare && [...bare].every(encodable)) { out += bare; continue; }
    const mapped = ({ "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ı": "i", "ß": "ss" } as Record<string, string>)[ch];
    out += mapped ?? "?";
  }
  return out;
}
function para(runs: Run[], indent: number, spaceBefore: number): Para {
  return { kind: "para", runs, indent, spaceBefore };
}

/** Walk the tree into paragraphs: the main line as one flowing paragraph, each
 *  variation as its own bracketed, indented one — the shape a printed game has. */
function movetextBlocks(tree: AnnotatedGame, fonts: Fonts, flipped: boolean, figurines: boolean, compact = false): Block[] {
  const blocks: Block[] = [];
  let current: Run[] = [];
  const flush = (indent: number, spaceBefore: number) => {
    if (current.length) blocks.push(para(current, indent, spaceBefore));
    current = [];
  };

  // A marker in the game's opening comment asks for the starting position —
  // which is how a game that begins from a diagram is annotated.
  if (tree.startComment && !compact) {
    const text = tree.startComment.replace(DIAGRAM_MARKER, " ").trim();
    if (text) blocks.push(para([run(text, fonts.italic, SIZE.variation, MUTED)], 0, 0));
    if (DIAGRAM_MARKER.test(tree.startComment)) {
      blocks.push({ kind: "diagram", fen: tree.startFen, flipped });
    }
  }

  const walk = (line: MoveNode[], depth: number) => {
    const isMain = depth === 0;
    const size = isMain ? SIZE.move : SIZE.variation;
    const moveFont = isMain ? fonts.bold : fonts.text;
    const indent = depth === 0 ? 0 : 6 + (depth - 1) * 6;

    if (!isMain) current.push(run("[ ", fonts.text, size, MUTED));

    line.forEach((node, i) => {
      // A move number leads White's moves, and Black's when something came
      // between it and its White move — a comment, a variation, a line start.
      const needsNumber = node.color === "w" || i === 0 || hasBreakBefore(line[i - 1]);
      const prefix = needsNumber
        ? `${getMoveNum(node)}${node.color === "w" ? "." : "..."}`
        : "";
      const tail = `${node.san.slice(figurines && isPiece(node.san[0]) ? 1 : 0)}${nagsToString(node.annotations.nags)} `;
      if (figurines && isPiece(node.san[0])) {
        // The piece as a figurine, the square in the text font — one move, two
        // runs. The symbols font has no bold, so a main-line move's figurine is
        // a shade lighter than its square; at this size that reads as normal.
        // Black's moves take the filled pieces, White's the outlined ones —
        // the move reads as the side that played it.
        const piece = node.color === "b" ? node.san[0].toLowerCase() : node.san[0];
        current.push({ ...run(tail, moveFont, size, INK), piece, prefix });
      } else {
        current.push(run(`${prefix}${tail}`, moveFont, size, INK));
      }

      const comment = compact ? "" : node.annotations.comment ?? "";
      const wantsDiagram = DIAGRAM_MARKER.test(comment);
      const text = comment.replace(DIAGRAM_MARKER, " ").trim();
      if (text) current.push(run(`${text} `, fonts.italic, size, MUTED));

      if (wantsDiagram) {
        flush(indent, isMain ? 2 : 1);
        blocks.push({ kind: "diagram", fen: node.fen, flipped });
        if (!isMain) current.push(run("", fonts.text, size, MUTED));
      }

      for (const variation of node.variations) {
        flush(indent, isMain ? 2 : 1);
        walk(variation, depth + 1);
        flush(6 + depth * 6, 1);
      }
    });

    if (!isMain) current.push(run("] ", fonts.text, size, MUTED));
    flush(indent, isMain ? 2 : 1);
  };

  walk(tree.mainLine, 0);
  flush(0, 2);
  return blocks;
}

/** Whether the node before a Black move ended with something that separates it
 *  from its move number: a comment, a diagram or a variation. */
function hasBreakBefore(prev: MoveNode | undefined): boolean {
  if (!prev) return false;
  return !!prev.annotations.comment || prev.variations.length > 0;
}

// ── Laying blocks into two columns ───────────────────────────────────────────

function layout(doc: PDFDocument, blocks: Block[], fonts: Fonts, header: string) {
  let page = doc.addPage([PAGE.width, PAGE.height]);
  let column = 0;
  let y = PAGE.height - MARGIN.top;
  let pageNumber = 1;
  drawRunningHeader(page, fonts, header, pageNumber);

  const columnLeft = () => MARGIN.left + column * (COLUMN_WIDTH + GUTTER);
  const nextColumn = () => {
    column += 1;
    if (column > 1) {
      column = 0;
      page = doc.addPage([PAGE.width, PAGE.height]);
      pageNumber += 1;
      drawRunningHeader(page, fonts, header, pageNumber);
    } else {
      // The rule down the gutter is drawn once the second column is in use
      // — a last page with one column of text needs no line beside nothing.
      drawColumnRule(page);
    }
    y = PAGE.height - MARGIN.top;
  };

  for (const [index, block] of blocks.entries()) {
    if (block.kind === "break") {
      if (block.newPage) {
        // Straight to a fresh page, whatever column we are in.
        column = 1;
        nextColumn();
        continue;
      }
      // A gap and a rule across the column, unless the column is fresh anyway.
      if (y < PAGE.height - MARGIN.top - 1) {
        if (y - 22 < MARGIN.bottom) { nextColumn(); continue; }
        y -= 10;
        page.drawLine({
          start: { x: columnLeft(), y }, end: { x: columnLeft() + COLUMN_WIDTH, y },
          thickness: 0.4, color: MUTED,
        });
        y -= 12;
      }
      continue;
    }
    if (block.kind === "diagram") {
      const size = DIAGRAM_WIDTH;
      const height = size + 14;               // board plus the file letters below
      // A diagram keeps the paragraph after it — the result, when it is the
      // final position — in the same column: a board on one page and "1-0"
      // alone on the next reads as a mistake.
      const next = blocks[index + 1];
      const keep = next && next.kind === "para" ? next.spaceBefore + LINE_HEIGHT : 0;
      if (y - height - 6 - keep < MARGIN.bottom) nextColumn();
      drawDiagram(page, fonts, block, columnLeft(), y - height + 6, size);
      y -= height + 6;
      continue;
    }

    y -= block.spaceBefore;
    const lines = wrap(block.runs, COLUMN_WIDTH - block.indent);
    for (const line of lines) {
      if (y - LINE_HEIGHT < MARGIN.bottom) nextColumn();
      let x = columnLeft() + block.indent;
      for (const item of line) {
        if (item.swatch) {
          const side = item.size * 0.72;
          page.drawRectangle({
            x, y: y - LINE_HEIGHT + 3 + item.size * 0.06, width: side, height: side,
            color: item.swatch === "black" ? INK : rgb(1, 1, 1),
            borderColor: INK, borderWidth: 0.7,
          });
          x += swatchWidth(item.size);
          continue;
        }
        if (item.piece) {
          // Number, then the piece on the text baseline like the letter it
          // replaces, then the square — the piece taking only the width it
          // draws, so the square follows as closely as after a letter.
          const baseline = y - LINE_HEIGHT + 3;
          if (item.prefix) {
            page.drawText(item.prefix, { x, y: baseline, size: item.size, font: item.font, color: item.color });
            x += item.font.widthOfTextAtSize(item.prefix, item.size);
          }
          const scale = figurineScale(item.size);
          const box = PIECE_SET_BOXES[item.piece];
          // The piece's lowest ink sits just under the baseline, as a letter
          // with a descender would; `top` is where the 45-unit box begins.
          drawPiece(page, item.piece, x - box.x0 * scale, baseline - item.size * 0.05 + box.y1 * scale, item.size * FIGURINE_EM);
          x += figurineWidth(item.piece, item.size);
          page.drawText(item.text, { x, y: baseline, size: item.size, font: item.font, color: item.color });
          x += item.font.widthOfTextAtSize(item.text, item.size);
          continue;
        }
        page.drawText(item.text, { x, y: y - LINE_HEIGHT + 3, size: item.size, font: item.font, color: item.color });
        x += item.font.widthOfTextAtSize(item.text, item.size);
      }
      y -= LINE_HEIGHT;
    }
  }
}

/** A hairline down the gutter, so the eye reads each column to its end before
 *  crossing — a two-column page without one invites reading straight across. */
function drawColumnRule(page: PDFPage) {
  const x = MARGIN.left + COLUMN_WIDTH + GUTTER / 2;
  page.drawLine({
    start: { x, y: PAGE.height - MARGIN.top + 4 },
    end: { x, y: MARGIN.bottom },
    thickness: 0.4, color: MUTED,
  });
}

function drawRunningHeader(page: PDFPage, fonts: Fonts, header: string, pageNumber: number) {
  const y = PAGE.height - MARGIN.top + 16;
  page.drawText(printable(header), { x: MARGIN.left, y, size: SIZE.running, font: fonts.text, color: MUTED });
  const label = String(pageNumber);
  page.drawText(label, {
    x: PAGE.width - MARGIN.right - fonts.text.widthOfTextAtSize(label, SIZE.running),
    y, size: SIZE.running, font: fonts.text, color: MUTED,
  });
  page.drawLine({
    start: { x: MARGIN.left, y: y - 4 },
    end: { x: PAGE.width - MARGIN.right, y: y - 4 },
    thickness: 0.5, color: MUTED,
  });
}

/** Greedy word wrap across runs: a run is split on spaces, never mid-word. */
function wrap(runs: Run[], width: number): Run[][] {
  const lines: Run[][] = [];
  let line: Run[] = [];
  let used = 0;
  for (const r of runs) {
    if (r.swatch) {
      line.push(r);
      used += swatchWidth(r.size);
      continue;
    }
    if (r.piece) {
      // A figurine move is one indivisible word: number, piece and square.
      const w = figurineRunWidth(r);
      if (used + w > width && used > 0) { lines.push(line); line = []; used = 0; }
      line.push(r);
      used += w;
      continue;
    }
    for (const word of r.text.split(/(?<=\s)/)) {
      if (!word) continue;
      const w = r.font.widthOfTextAtSize(word, r.size);
      if (used + w > width && used > 0) {
        lines.push(line);
        line = [];
        used = 0;
        if (/^\s+$/.test(word)) continue;     // no leading space on a new line
      }
      line.push({ ...r, text: word });
      used += w;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

// ── The diagram ──────────────────────────────────────────────────────────────

function drawDiagram(page: PDFPage, fonts: Fonts, diagram: Diagram, x: number, y: number, size: number) {
  const board = size - 22;                    // room for the coordinates and the mover's mark
  const square = board / 8;
  const left = x + 10;
  const bottom = y + 12;
  const rows = [...Array(8).keys()];
  const placement = diagram.fen.split(" ")[0];
  const grid = expandFen(placement);

  for (const rank of rows) {
    for (const file of rows) {
      const dark = (rank + file) % 2 === 0;
      page.drawRectangle({
        x: left + file * square,
        y: bottom + rank * square,
        width: square, height: square,
        color: dark ? SQUARE_DARK : SQUARE_LIGHT,
      });
      const cell = diagram.flipped
        ? grid[rank][7 - file]
        : grid[7 - rank][file];
      if (!cell) continue;
      // The set is designed to fill its square, with its own margins — drawn
      // exactly as the board on screen draws it.
      drawPiece(page, cell, left + file * square, bottom + (rank + 1) * square, square);
    }
  }
  page.drawRectangle({
    x: left, y: bottom, width: board, height: board,
    borderColor: MUTED, borderWidth: 0.6,
  });

  // Files below, ranks to the left — the way a printed diagram is labelled.
  for (const i of rows) {
    const file = diagram.flipped ? "hgfedcba"[i] : "abcdefgh"[i];
    const rank = diagram.flipped ? String(i + 1) : String(8 - i);
    const fw = fonts.text.widthOfTextAtSize(file, 6.5);
    page.drawText(file, {
      x: left + i * square + (square - fw) / 2, y: bottom - 8,
      size: 6.5, font: fonts.text, color: MUTED,
    });
    page.drawText(rank, {
      x: left - 7, y: bottom + board - (i + 1) * square + square / 2 - 2.5,
      size: 6.5, font: fonts.text, color: MUTED,
    });
  }

  // Whose move: a small circle beside the mover's back rank, the way ChessBase
  // marks it — hollow for White, filled for Black. The back rank is at the
  // bottom for the side the board is seen from, so it swaps with `flipped`.
  const whiteToMove = diagram.fen.split(" ")[1] !== "b";
  const atBottom = whiteToMove !== diagram.flipped;
  const markY = atBottom ? bottom + square / 2 : bottom + board - square / 2;
  page.drawCircle({
    x: left + board + 7,
    y: markY,
    size: square * 0.2,
    color: whiteToMove ? rgb(1, 1, 1) : INK,
    borderColor: INK,
    borderWidth: 0.6,
  });
}

/** A figurine's 45-unit box, relative to the type size. The set draws its
 *  pieces with margins inside that box (a king's ink is 36 of the 45 units),
 *  so at 1.05 em a king stands a shade taller than a capital letter — enough
 *  presence to read as a piece, not so much that it looms over the square. */
const FIGURINE_EM = 1.05;

function figurineScale(size: number): number {
  return (size * FIGURINE_EM) / PIECE_SET_SIZE;
}

/** What a figurine occupies in a line: the piece's own width and a thin space,
 *  so "♕a3" sits as tightly as "Qa3". */
function figurineWidth(piece: string, size: number): number {
  const box = PIECE_SET_BOXES[piece];
  return (box.x1 - box.x0) * figurineScale(size) + size * 0.05;
}

/** The colour swatch and the gap after it, in the heading. */
function swatchWidth(size: number): number {
  return size * 0.72 + size * 0.45;
}

/** A whole figurine move — number, piece, square — as one width. */
function figurineRunWidth(r: Run): number {
  return (r.prefix ? r.font.widthOfTextAtSize(r.prefix, r.size) : 0)
    + figurineWidth(r.piece!, r.size)
    + r.font.widthOfTextAtSize(r.text, r.size);
}

const colourCache = new Map<string, RGB>();
function hex(colour: string): RGB {
  let c = colourCache.get(colour);
  if (!c) {
    const n = parseInt(colour.slice(1), 16);
    c = rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    colourCache.set(colour, c);
  }
  return c;
}

const CAP = { butt: LineCapStyle.Butt, round: LineCapStyle.Round, square: LineCapStyle.Projecting };

/** One piece from the set, its 45-unit box `size` points wide with its top-left
 *  corner at (`x`, `top`) — the same artwork the board on screen draws, filled
 *  and stroked op by op. */
function drawPiece(page: PDFPage, piece: string, x: number, top: number, size: number) {
  const scale = size / PIECE_SET_SIZE;
  for (const op of PIECE_SET[piece] ?? []) {
    const color = op.fill ? hex(op.fill) : undefined;
    const borderColor = op.stroke ? hex(op.stroke) : undefined;
    if (op.kind === "path") {
      // pdf-lib scales the stroke with the path, so the width stays in the
      // set's own units.
      page.drawSvgPath(op.d, {
        x, y: top, scale, color, borderColor,
        borderWidth: borderColor ? op.strokeWidth : undefined,
        borderLineCap: CAP[op.cap],
      });
    } else {
      page.drawCircle({
        x: x + op.cx * scale, y: top - op.cy * scale, size: op.r * scale,
        color, borderColor,
        borderWidth: borderColor ? op.strokeWidth * scale : undefined,
      });
    }
  }
}

/** FEN placement → 8 rows of 8 cells, rank 8 first, "" for an empty square. */
function expandFen(placement: string): string[][] {
  return placement.split("/").map((row) => {
    const cells: string[] = [];
    for (const ch of row) {
      if (/\d/.test(ch)) cells.push(...Array(Number(ch)).fill(""));
      else cells.push(ch);
    }
    return cells;
  });
}

// ── Metadata ─────────────────────────────────────────────────────────────────

function runningHeader(game: PdfGame, producer?: string): string {
  return [producer ?? "LPDO", describe(game)].filter(Boolean).join(" — ");
}

function describe(game: PdfGame): string {
  const when = game.date && !game.date.startsWith("????") ? game.date.slice(0, 4) : "";
  return [`${game.white} – ${game.black}`, game.event, when].filter(Boolean).join(", ");
}

function prettyResult(result: string): string {
  return result === "1/2-1/2" ? "½–½" : result;
}

/** Put the game's PGN in the document's XMP metadata, so the PDF can be read
 *  back as a game. The printed page is a view; this is the game itself. */
function setXmpWithPgn(doc: PDFDocument, games: PdfGame[], manyTitle: string) {
  const pgn = games.map((g) => g.pgn.trim()).join("\n\n") + "\n";
  const title = games.length === 1 ? describe(games[0]) : manyTitle;
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:lpdo="https://github.com/specure/lpdo/ns/pgn/1.0/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(title)}</rdf:li></rdf:Alt></dc:title>
      <dc:format>application/pdf</dc:format>
      <lpdo:games>${games.length}</lpdo:games>
      <lpdo:pgn>${xml(pgn)}</lpdo:pgn>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  // XMP is UTF-8 by definition. Handed a string, pdf-lib writes one byte
  // per character, which mangled every letter beyond Latin-1 (Svrček came
  // back as Svrek) — so the bytes are encoded here.
  const stream = doc.context.stream(new TextEncoder().encode(xmp), {
    Type: PDFName.of("Metadata"),
    Subtype: PDFName.of("XML"),
  });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(stream));
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Read a PGN back out of a PDF this exporter wrote. */
export function pgnFromPdfBytes(bytes: Uint8Array): string | null {
  // The metadata is UTF-8; the rest of the file is binary, which the lenient
  // decoder turns into replacement characters outside the packet.
  const text = new TextDecoder("utf-8").decode(bytes);
  const match = text.match(/<lpdo:pgn>([\s\S]*?)<\/lpdo:pgn>/);
  if (!match) return null;
  return match[1]
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** The position after a line of SAN moves — used by callers that want a
 *  diagram of somewhere other than a marked move. */
export function fenAfter(sans: string[]): string {
  const chess = new Chess();
  for (const san of sans) {
    try { chess.move(san); } catch { break; }
  }
  return chess.fen();
}
