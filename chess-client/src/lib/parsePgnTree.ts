import { Chess } from "chess.js";
import { parseComment, nagToSymbol, CalArrow, CslCircle } from "./parseAnnotations";

export interface Annotations {
  comment?: string;
  arrows?: CalArrow[];
  circles?: CslCircle[];
  nag?: string;
}

export interface MoveNode {
  san: string;
  color: "w" | "b";
  fen: string;
  annotations: Annotations;
  variations: MoveNode[][];
}

export interface AnnotatedGame {
  startFen: string;
  startComment?: string;
  startAnnotations?: { arrows?: CalArrow[]; circles?: CslCircle[] };
  mainLine: MoveNode[];
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

type TokenType = "move_number" | "move" | "nag" | "comment" | "var_start" | "var_end" | "result";

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(movetext: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < movetext.length) {
    // Skip whitespace
    if (/\s/.test(movetext[i])) { i++; continue; }

    // Comment
    if (movetext[i] === "{") {
      const end = movetext.indexOf("}", i + 1);
      if (end === -1) { i++; continue; }
      tokens.push({ type: "comment", value: movetext.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    // Variation start/end
    if (movetext[i] === "(") { tokens.push({ type: "var_start", value: "(" }); i++; continue; }
    if (movetext[i] === ")") { tokens.push({ type: "var_end", value: ")" }); i++; continue; }

    // NAG
    if (movetext[i] === "$") {
      const m = movetext.slice(i).match(/^\$(\d+)/);
      if (m) { tokens.push({ type: "nag", value: m[1] }); i += m[0].length; continue; }
    }

    // Result
    const resultMatch = movetext.slice(i).match(/^(1-0|0-1|1\/2-1\/2|\*)/);
    if (resultMatch) {
      tokens.push({ type: "result", value: resultMatch[0] });
      i += resultMatch[0].length;
      continue;
    }

    // Move number (e.g. "1." or "1...")
    const numMatch = movetext.slice(i).match(/^(\d+)(\.{1,3})/);
    if (numMatch) {
      tokens.push({ type: "move_number", value: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }

    // SAN move — match chess moves including O-O-O, promotions, annotations like +, #
    const sanMatch = movetext.slice(i).match(/^([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O-O[+#]?|O-O[+#]?)/);
    if (sanMatch) {
      tokens.push({ type: "move", value: sanMatch[0] });
      i += sanMatch[0].length;
      continue;
    }

    // Skip semicolon comments (rest of line)
    if (movetext[i] === ";") {
      const nl = movetext.indexOf("\n", i);
      i = nl === -1 ? movetext.length : nl + 1;
      continue;
    }

    // Skip unknown character
    i++;
  }

  return tokens;
}

// ── Parser ───────────────────────────────────────────────────────────────────

function extractMovetext(pgn: string): { movetext: string; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const tagRe = /\[(\w+)\s+"([^"]*)"\]/g;
  let m: RegExpExecArray | null;
  let lastTagEnd = 0;
  while ((m = tagRe.exec(pgn)) !== null) {
    headers.set(m[1], m[2]);
    lastTagEnd = m.index + m[0].length;
  }
  const movetext = pgn.slice(lastTagEnd).trim();
  return { movetext, headers };
}

class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
  }

  next(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos++] : null;
  }

  parseLine(chess: Chess): MoveNode[] {
    const nodes: MoveNode[] = [];

    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (!tok) break;

      if (tok.type === "var_end" || tok.type === "result") break;

      if (tok.type === "move_number") { this.next(); continue; }

      if (tok.type === "comment") {
        this.next();
        // Comment before any move in this line — attach to previous node or skip
        if (nodes.length > 0) {
          this.attachComment(nodes[nodes.length - 1], tok.value);
        }
        // If no nodes yet, this is a pre-move comment — we'll handle it at the caller level
        else {
          // Store as a sentinel node — caller handles startComment
          nodes.push(this.makeCommentSentinel(tok.value));
        }
        continue;
      }

      if (tok.type === "nag") {
        this.next();
        if (nodes.length > 0) {
          nodes[nodes.length - 1].annotations.nag = nagToSymbol(parseInt(tok.value, 10));
        }
        continue;
      }

      if (tok.type === "move") {
        this.next();
        const preFen = chess.fen();

        try {
          chess.move(tok.value);
        } catch {
          // Invalid move — skip
          continue;
        }

        const node: MoveNode = {
          san: tok.value,
          color: chess.turn() === "w" ? "b" : "w", // the color that just moved
          fen: chess.fen(),
          annotations: {},
          variations: [],
        };
        nodes.push(node);

        // Consume trailing NAGs and comments
        while (this.peek()?.type === "nag" || this.peek()?.type === "comment") {
          const t = this.next()!;
          if (t.type === "nag") {
            node.annotations.nag = nagToSymbol(parseInt(t.value, 10));
          } else if (t.type === "comment") {
            this.attachComment(node, t.value);
          }
        }

        // Consume variations
        while (this.peek()?.type === "var_start") {
          this.next(); // consume '('
          const varChess = new Chess();
          varChess.load(preFen);
          const variation = this.parseLine(varChess);
          // Filter out comment-sentinel nodes
          const realMoves = variation.filter(n => n.san !== "");
          if (realMoves.length > 0) {
            node.variations.push(realMoves);
          }
          if (this.peek()?.type === "var_end") this.next(); // consume ')'
        }

        continue;
      }

      // Skip anything else
      this.next();
    }

    return nodes;
  }

  private attachComment(node: MoveNode, raw: string) {
    const parsed = parseComment(raw);
    if (parsed.text) {
      node.annotations.comment = node.annotations.comment
        ? node.annotations.comment + " " + parsed.text
        : parsed.text;
    }
    if (parsed.arrows.length) {
      node.annotations.arrows = [...(node.annotations.arrows ?? []), ...parsed.arrows];
    }
    if (parsed.circles.length) {
      node.annotations.circles = [...(node.annotations.circles ?? []), ...parsed.circles];
    }
  }

  private makeCommentSentinel(raw: string): MoveNode {
    const parsed = parseComment(raw);
    return {
      san: "",
      color: "w",
      fen: "",
      annotations: {
        comment: parsed.text || undefined,
        arrows: parsed.arrows.length ? parsed.arrows : undefined,
        circles: parsed.circles.length ? parsed.circles : undefined,
      },
      variations: [],
    };
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function parsePgnTree(pgn: string): AnnotatedGame {
  const { movetext, headers } = extractMovetext(pgn);
  const startFen = headers.get("FEN") ?? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  const tokens = tokenize(movetext);
  const chess = new Chess();
  if (headers.has("FEN")) {
    chess.load(startFen);
  }

  const parser = new Parser(tokens);
  const rawLine = parser.parseLine(chess);

  // Extract start comment if first node is a sentinel
  let startComment: string | undefined;
  let startAnnotations: { arrows?: CalArrow[]; circles?: CslCircle[] } | undefined;
  const mainLine: MoveNode[] = [];

  for (const node of rawLine) {
    if (node.san === "" && mainLine.length === 0) {
      startComment = node.annotations.comment;
      if (node.annotations.arrows || node.annotations.circles) {
        startAnnotations = {
          arrows: node.annotations.arrows,
          circles: node.annotations.circles,
        };
      }
    } else if (node.san !== "") {
      mainLine.push(node);
    }
  }

  return { startFen, startComment, startAnnotations, mainLine };
}
