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

import { PDFDocument, PDFFont, PDFPage, PDFName, StandardFonts, rgb, RGB } from "pdf-lib";
import { PIECE_BODIES, PIECE_BOXES, PIECE_OUTLINES, PIECE_UNITS_PER_EM } from "./pieceOutlines";
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
/** The light squares of the diagram; the dark ones follow ChessBase's blue. */
const SQUARE_LIGHT = rgb(0.93, 0.93, 0.95);
const SQUARE_DARK = rgb(0.51, 0.58, 0.78);

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

type Block = Para | Diagram;

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
}

export interface PdfOptions {
  /** Draw diagrams from Black's side. */
  flipped?: boolean;
  /** Add a diagram of the final position even when the movetext asks for none. */
  diagramAtEnd?: boolean;
  /** Print pieces as figurines (♘f3) rather than letters (Nf3), the way a
   *  chess book sets moves. Letters stay for anyone who prefers them — and
   *  they are what a PGN holds either way. */
  figurines?: boolean;
  /** Shown in the running header, e.g. "LPDO 0.19.0". */
  producer?: string;
}


/** A SAN move that names a piece — a figurine can stand in for that letter.
 *  Pawn moves ("e4", "exd5") name none, and castling is written out. */
function isPiece(first: string | undefined): first is "K" | "Q" | "R" | "B" | "N" {
  return first === "K" || first === "Q" || first === "R" || first === "B" || first === "N";
}

/** `[#]` anywhere in a comment asks for a diagram; the rest is still printed. */
const DIAGRAM_MARKER = /\s*\[#\]\s*/;

export async function buildGamePdf(input: PdfGame, opts: PdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = {
    text: await doc.embedFont(StandardFonts.TimesRoman),
    bold: await doc.embedFont(StandardFonts.TimesRomanBold),
    italic: await doc.embedFont(StandardFonts.TimesRomanItalic),
  };

  const game = withPgnTags(input);
  const tree = parsePgnTree(game.pgn);
  const blocks = [
    ...headerBlocks(game, fonts),
    ...movetextBlocks(tree, fonts, !!opts.flipped, opts.figurines !== false),
  ];
  if (opts.diagramAtEnd) {
    const last = tree.mainLine[tree.mainLine.length - 1];
    blocks.push({ kind: "diagram", fen: last ? last.fen : tree.startFen, flipped: !!opts.flipped });
  }
  if (game.result) {
    blocks.push({
      kind: "para",
      indent: 0,
      spaceBefore: 4,
      runs: [{ text: prettyResult(game.result), font: fonts.bold, size: SIZE.move, color: INK }],
    });
  }

  layout(doc, blocks, fonts, runningHeader(game, opts.producer));

  doc.setTitle(`${game.white} – ${game.black}`);
  doc.setAuthor(opts.producer ?? "LPDO");
  doc.setSubject(describe(game));
  setXmpWithPgn(doc, game);

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
  blocks.push(para([
    run(name(game.white, game.white_elo), fonts.bold, SIZE.header, INK),
    ...(game.eco ? [run(`   ${game.eco}`, fonts.bold, SIZE.small, MUTED)] : []),
  ], 0, 1));
  blocks.push(para([run(name(game.black, game.black_elo), fonts.bold, SIZE.header, INK)], 0, 0));
  if (where || when) {
    blocks.push(para([run([where, when].filter(Boolean).join("  "), fonts.text, SIZE.small, MUTED)], 0, 1));
  }
  return blocks;
}

// ── Movetext → blocks ────────────────────────────────────────────────────────

interface Fonts { text: PDFFont; bold: PDFFont; italic: PDFFont }

function run(text: string, font: PDFFont, size: number, color: RGB): Run {
  return { text, font, size, color };
}
function para(runs: Run[], indent: number, spaceBefore: number): Para {
  return { kind: "para", runs, indent, spaceBefore };
}

/** Walk the tree into paragraphs: the main line as one flowing paragraph, each
 *  variation as its own bracketed, indented one — the shape a printed game has. */
function movetextBlocks(tree: AnnotatedGame, fonts: Fonts, flipped: boolean, figurines: boolean): Block[] {
  const blocks: Block[] = [];
  let current: Run[] = [];
  const flush = (indent: number, spaceBefore: number) => {
    if (current.length) blocks.push(para(current, indent, spaceBefore));
    current = [];
  };

  // A marker in the game's opening comment asks for the starting position —
  // which is how a game that begins from a diagram is annotated.
  if (tree.startComment) {
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

      const comment = node.annotations.comment ?? "";
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
    }
    y = PAGE.height - MARGIN.top;
  };

  for (const block of blocks) {
    if (block.kind === "diagram") {
      const size = DIAGRAM_WIDTH;
      const height = size + 14;               // board plus the file letters below
      if (y - height < MARGIN.bottom) nextColumn();
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
          drawPiece(page, item.piece, x - PIECE_BOXES[item.piece].x0 * scale, baseline, item.size * FIGURINE_EM);
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

function drawRunningHeader(page: PDFPage, fonts: Fonts, header: string, pageNumber: number) {
  const y = PAGE.height - MARGIN.top + 16;
  page.drawText(header, { x: MARGIN.left, y, size: SIZE.running, font: fonts.text, color: MUTED });
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
  const board = size - 12;                    // room for the coordinates
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
      // Each piece is scaled to its own height (see PIECE_HEIGHT) and centred
      // in its square on the ink it draws, both ways — kings and queens are
      // much narrower than rooks, and a bishop's ink dips below its baseline.
      // The path's y runs downward from the origin, so a point py of the
      // outline lands at origin − py·scale: the origin is set so the ink's
      // midpoint lands on the square's.
      const box = PIECE_BOXES[cell];
      const wanted = square * PIECE_HEIGHT[cell.toLowerCase()];
      const em = (wanted * PIECE_UNITS_PER_EM) / (box.y1 - box.y0);
      const scale = em / PIECE_UNITS_PER_EM;
      const inkWidth = (box.x1 - box.x0) * scale;
      drawPiece(
        page, cell,
        left + file * square + (square - inkWidth) / 2 - box.x0 * scale,
        bottom + rank * square + square / 2 + ((box.y0 + box.y1) / 2) * scale,
        em,
      );
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
}

/** How tall each piece stands, as a fraction of its square.
 *
 *  The font's own proportions cannot be used: these are text symbols, all
 *  drawn to fill a line of type, so its pawn is 96% as tall as its king. A
 *  diagram wants the proportions of a real set — a pawn a little over half the
 *  height of a king — so each piece is given its own. Measured against the
 *  ChessBase printout in #265. */
const PIECE_HEIGHT: Record<string, number> = {
  k: 0.85, q: 0.83, b: 0.79, n: 0.75, r: 0.71, p: 0.61,
};

/** A figurine is set a shade larger than the letter it replaces, which is how
 *  it matches the weight of the text around it. */
const FIGURINE_EM = 1.06;

function figurineScale(size: number): number {
  return (size * FIGURINE_EM) / PIECE_UNITS_PER_EM;
}

/** What a figurine occupies in a line: the piece's own width and a thin space,
 *  so "♕a3" sits as tightly as "Qa3". */
function figurineWidth(piece: string, size: number): number {
  const box = PIECE_BOXES[piece];
  return (box.x1 - box.x0) * figurineScale(size) + size * 0.06;
}

/** A whole figurine move — number, piece, square — as one width. */
function figurineRunWidth(r: Run): number {
  return (r.prefix ? r.font.widthOfTextAtSize(r.prefix, r.size) : 0)
    + figurineWidth(r.piece!, r.size)
    + r.font.widthOfTextAtSize(r.text, r.size);
}

/** One piece, `size` points tall, its baseline at (`x`, `y`).
 *
 *  Drawn in two passes so a piece is opaque on any colour of square, the way a
 *  printed diagram has it: the filled (Black) outline in white first, then the
 *  piece's own outline in black. A white piece would otherwise be a see-through
 *  drawing with the square showing through it. */
function drawPiece(page: PDFPage, piece: string, x: number, y: number, size: number) {
  const scale = size / PIECE_UNITS_PER_EM;
  const body = PIECE_BODIES[piece];
  const own = PIECE_OUTLINES[piece];
  if (!own || !body) return;
  // The body first, in white: it has no holes, so nothing of the square shows
  // through the piece. Then the piece itself in black — where it leaves holes
  // (a white piece's interior, a black piece's detail lines) the white body
  // shows, which is how a printed diagram draws them.
  page.drawSvgPath(body, { x, y, scale, color: rgb(1, 1, 1) });
  page.drawSvgPath(own, { x, y, scale, color: INK });
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
function setXmpWithPgn(doc: PDFDocument, game: PdfGame) {
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:lpdo="https://github.com/specure/lpdo/ns/pgn/1.0/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(describe(game))}</rdf:li></rdf:Alt></dc:title>
      <dc:format>application/pdf</dc:format>
      <lpdo:games>1</lpdo:games>
      <lpdo:pgn>${xml(game.pgn)}</lpdo:pgn>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const stream = doc.context.stream(xmp, {
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
  const text = new TextDecoder("latin1").decode(bytes);
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
