// Turn the app's own chess pieces into drawing instructions for the PDF export.
//
// The board on screen uses react-chessboard's default set — Colin M.L.
// Burnett's pieces, the ones on Wikipedia and Lichess — as inline SVG. A
// printed diagram should show the same pieces, so this renders each one to
// SVG markup, walks it, and writes the paths and circles out as data with
// every style resolved and every transform and arc baked in. The PDF then
// only has to fill and stroke.
//
// The set is triple-licensed by its author (BSD, GPLv2+, GFDL); the BSD terms
// are the ones an Apache-2.0 project uses. See src/assets/pieces/LICENSE.txt.
//
// Run from chess-client/ if the library's pieces ever change:
//   node scripts/extract-piece-set.mjs
import { defaultPieces } from "react-chessboard";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { writeFileSync } from "fs";

const TARGET = "src/lib/pieceSet.ts";
const NAMES = { K: "wK", Q: "wQ", R: "wR", B: "wB", N: "wN", P: "wP", k: "bK", q: "bQ", r: "bR", b: "bB", n: "bN", p: "bP" };

// ── A tiny SVG walker: enough for <g>, <path> and <circle> with styles ─────────

/** `key:value;…` style text and bare attributes, as one object. */
function styleOf(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") {
      for (const rule of v.split(";")) {
        const [key, val] = rule.split(":").map((s) => s?.trim());
        if (key && val) out[key] = val;
      }
    } else if (["fill", "stroke", "stroke-width", "stroke-linecap", "fill-rule"].includes(k)) {
      out[k] = v;
    }
  }
  return out;
}

function attrsOf(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

// 2-D affine matrices as [a, b, c, d, e, f] (SVG's own layout).
const IDENTITY = [1, 0, 0, 1, 0, 0];
function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function parseTransform(text) {
  let m = IDENTITY;
  for (const t of text.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const v = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (t[1] === "matrix") m = multiply(m, v);
    else if (t[1] === "translate") m = multiply(m, [1, 0, 0, 1, v[0], v[1] ?? 0]);
    else if (t[1] === "scale") m = multiply(m, [v[0], 0, 0, v[1] ?? v[0], 0, 0]);
    else throw new Error(`transform not handled: ${t[0]}`);
  }
  return m;
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Elements in document order, each with its resolved style and transform. */
function walk(svg) {
  const stack = [{ style: {}, transform: IDENTITY }];
  const out = [];
  for (const m of svg.matchAll(/<(\/?)(\w+)([^>]*?)(\/?)>/g)) {
    const [, closing, name, attrText, selfClosing] = m;
    if (closing) { if (name === "g" || name === "svg") stack.pop(); continue; }
    const attrs = attrsOf(attrText);
    const parent = stack[stack.length - 1];
    const style = { ...parent.style, ...styleOf(attrs) };
    const transform = attrs.transform ? multiply(parent.transform, parseTransform(attrs.transform)) : parent.transform;
    if (name === "g" || name === "svg") { if (!selfClosing) stack.push({ style, transform }); continue; }
    if (name === "path" || name === "circle") out.push({ name, attrs, style, transform });
    else throw new Error(`element not handled: <${name}>`);
    if (!selfClosing && name === "g") stack.push({ style, transform });
  }
  return out;
}

// ── Paths: absolute, arcs and quadratics as cubics, then transformed ──────────

function tokens(d) {
  return d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
}

/** SVG arc → cubic Béziers (SVG implementation notes, F.6.5), ≤90° each. */
function arcToCubics(x1, y1, rx, ry, phi, large, sweep, x2, y2) {
  if (rx === 0 || ry === 0) return [["L", x2, y2]];
  const rad = (phi * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = coef * (rx * y1p / ry), cyp = coef * (-ry * x1p / rx);
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const segments = Math.ceil(Math.abs(delta) / (Math.PI / 2));
  const step = delta / segments;
  const out = [];
  let t = theta1;
  const point = (a) => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos];
  const tangent = (a) => [-rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos];
  for (let i = 0; i < segments; i++) {
    const k = (4 / 3) * Math.tan(step / 4);
    const [p0x, p0y] = point(t), [p3x, p3y] = point(t + step);
    const [t0x, t0y] = tangent(t), [t3x, t3y] = tangent(t + step);
    out.push(["C", p0x + k * t0x, p0y + k * t0y, p3x - k * t3x, p3y - k * t3y, p3x, p3y]);
    t += step;
  }
  return out;
}

/** A path as absolute M / L / C / Z segments, in the given transform. */
function normalisePath(d, m) {
  const t = tokens(d);
  const out = [];
  let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0, cpx = null, cpy = null, qx = null, qy = null;
  const num = () => Number(t[i++]);
  const emit = (seg) => {
    if (seg[0] === "C") {
      const [a, b] = apply(m, seg[1], seg[2]), [c, e] = apply(m, seg[3], seg[4]), [f, g] = apply(m, seg[5], seg[6]);
      out.push(["C", a, b, c, e, f, g]);
    } else if (seg[0] === "Z") out.push(["Z"]);
    else { const [a, b] = apply(m, seg[1], seg[2]); out.push([seg[0], a, b]); }
  };
  while (i < t.length) {
    if (/[A-Za-z]/.test(t[i])) cmd = t[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "Z") { emit(["Z"]); x = sx; y = sy; cpx = cpy = qx = qy = null; if (i < t.length && !/[A-Za-z]/.test(t[i])) cmd = rel ? "l" : "L"; continue; }
    if (C === "M") { const nx = num(), ny = num(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; sx = x; sy = y; emit(["M", x, y]); cmd = rel ? "l" : "L"; cpx = cpy = qx = qy = null; continue; }
    if (C === "L") { const nx = num(), ny = num(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; emit(["L", x, y]); cpx = cpy = qx = qy = null; continue; }
    if (C === "H") { const nx = num(); x = rel ? x + nx : nx; emit(["L", x, y]); cpx = cpy = qx = qy = null; continue; }
    if (C === "V") { const ny = num(); y = rel ? y + ny : ny; emit(["L", x, y]); cpx = cpy = qx = qy = null; continue; }
    if (C === "C") {
      let x1 = num(), y1 = num(), x2 = num(), y2 = num(), nx = num(), ny = num();
      if (rel) { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y; }
      emit(["C", x1, y1, x2, y2, nx, ny]); cpx = x2; cpy = y2; x = nx; y = ny; qx = qy = null; continue;
    }
    if (C === "S") {
      let x2 = num(), y2 = num(), nx = num(), ny = num();
      if (rel) { x2 += x; y2 += y; nx += x; ny += y; }
      const x1 = cpx === null ? x : 2 * x - cpx, y1 = cpy === null ? y : 2 * y - cpy;
      emit(["C", x1, y1, x2, y2, nx, ny]); cpx = x2; cpy = y2; x = nx; y = ny; qx = qy = null; continue;
    }
    if (C === "Q" || C === "T") {
      let x1, y1, nx, ny;
      if (C === "Q") { x1 = num(); y1 = num(); nx = num(); ny = num(); if (rel) { x1 += x; y1 += y; nx += x; ny += y; } }
      else { nx = num(); ny = num(); if (rel) { nx += x; ny += y; } x1 = qx === null ? x : 2 * x - qx; y1 = qy === null ? y : 2 * y - qy; }
      emit(["C", x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), nx + (2 / 3) * (x1 - nx), ny + (2 / 3) * (y1 - ny), nx, ny]);
      qx = x1; qy = y1; x = nx; y = ny; cpx = cpy = null; continue;
    }
    if (C === "A") {
      const rx = num(), ry = num(), phi = num(), large = num(), sweep = num();
      let nx = num(), ny = num();
      if (rel) { nx += x; ny += y; }
      for (const seg of arcToCubics(x, y, rx, ry, phi, large, sweep, nx, ny)) emit(seg);
      x = nx; y = ny; cpx = cpy = qx = qy = null; continue;
    }
    throw new Error(`path command not handled: ${cmd}`);
  }
  const f = (n) => Number(n.toFixed(3)).toString();
  return out.map((s) => s[0] === "Z" ? "Z" : `${s[0]}${s.slice(1).map(f).join(" ")}`).join(" ");
}

// ── The set ──────────────────────────────────────────────────────────────────

const colour = (v) => (!v || v === "none" ? null : v);
const set = {};
const boxes = {};

/** The ink's bounds — every coordinate a path or circle names, plus half the
 *  stroke — so a figurine can be set by what it draws, not by its 45-unit box. */
function inkBox(ops) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const op of ops) {
    const half = op.stroke ? op.strokeWidth / 2 : 0;
    if (op.kind === "circle") {
      x0 = Math.min(x0, op.cx - op.r - half); x1 = Math.max(x1, op.cx + op.r + half);
      y0 = Math.min(y0, op.cy - op.r - half); y1 = Math.max(y1, op.cy + op.r + half);
      continue;
    }
    const nums = op.d.match(/-?\d*\.?\d+/g).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) {
      x0 = Math.min(x0, nums[i] - half); x1 = Math.max(x1, nums[i] + half);
      y0 = Math.min(y0, nums[i + 1] - half); y1 = Math.max(y1, nums[i + 1] + half);
    }
  }
  return { x0: +x0.toFixed(2), y0: +y0.toFixed(2), x1: +x1.toFixed(2), y1: +y1.toFixed(2) };
}
for (const [piece, name] of Object.entries(NAMES)) {
  const svg = renderToStaticMarkup(createElement(defaultPieces[name]));
  const ops = [];
  for (const el of walk(svg)) {
    const s = el.style;
    const base = {
      fill: colour(s.fill),
      stroke: colour(s.stroke),
      strokeWidth: Number(s["stroke-width"] ?? 1) * Math.sqrt(Math.abs(el.transform[0] * el.transform[3] - el.transform[1] * el.transform[2])),
      cap: s["stroke-linecap"] === "square" ? "square" : s["stroke-linecap"] === "round" ? "round" : "butt",
    };
    if (el.name === "path") {
      ops.push({ kind: "path", d: normalisePath(el.attrs.d, el.transform), ...base });
    } else {
      const [cx, cy] = apply(el.transform, Number(el.attrs.cx), Number(el.attrs.cy));
      const r = Number(el.attrs.r) * Math.sqrt(Math.abs(el.transform[0] * el.transform[3] - el.transform[1] * el.transform[2]));
      ops.push({ kind: "circle", cx: +cx.toFixed(3), cy: +cy.toFixed(3), r: +r.toFixed(3), ...base });
    }
  }
  set[piece] = ops;
  boxes[piece] = inkBox(ops);
}

writeFileSync(TARGET, `// GENERATED by scripts/extract-piece-set.mjs — do not edit by hand.
//
// The pieces the app draws on its own board, as fill-and-stroke instructions
// for the PDF export: Colin M.L. Burnett's set, as shipped by react-chessboard.
// Licensed by its author under the BSD licence (also GPLv2+ and GFDL); see
// src/assets/pieces/LICENSE.txt. Coordinates are on a ${45}-unit square with
// y pointing down, the way the SVG has them.

export const PIECE_SET_SIZE = 45;

export type PieceOp =
  | { kind: "path"; d: string; fill: string | null; stroke: string | null; strokeWidth: number; cap: "butt" | "round" | "square" }
  | { kind: "circle"; cx: number; cy: number; r: number; fill: string | null; stroke: string | null; strokeWidth: number; cap: "butt" | "round" | "square" };

/** Upper case is White, lower case Black, as in a FEN. */
export const PIECE_SET: Record<string, PieceOp[]> = ${JSON.stringify(set, null, 1).replace(/"(\w+)":/g, "$1:")};

/** What each piece draws, stroke included, in the same 45-unit coordinates. */
export const PIECE_SET_BOXES: Record<string, { x0: number; y0: number; x1: number; y1: number }> = ${JSON.stringify(boxes, null, 1).replace(/"(\w+)":/g, "$1:")};
`);
console.log(`${TARGET}: ${Object.keys(set).length} pieces, ${Object.values(set).reduce((n, ops) => n + ops.length, 0)} drawing ops`);
