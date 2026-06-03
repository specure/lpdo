import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { GameSummary } from "../types";
import { parsePgnTree, AnnotatedGame, MoveNode } from "../lib/parsePgnTree";
import { ensureMoveNumbers, parseBlockTags } from "../lib/pgnEditor";
import { useSidecarProgress } from "../hooks/useSidecarProgress";
import EditDbHeadersModal from "./EditDbHeadersModal";
import CollectionPicker from "./CollectionPicker";
import {
  useMovesEditor,
  MovesEditorRightPanel,
  MovesEditorToolbar,
  MovesEditorPromotionChooser,
  MovesEditorOverwriteConfirm,
  MovesEditorAnnotationGate,
  saveMovesViaSidecar,
} from "./MovesEditor";
import type { CalArrow, CslCircle } from "../lib/parseAnnotations";

// SVG nav icons — always white, no emoji color issues
const IconFirst = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="3" width="2" height="10" rx="1" />
    <path d="M13 3L6 8l7 5V3z" />
  </svg>
);
const IconPrev = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M11 3L4 8l7 5V3z" />
  </svg>
);
const IconNext = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M5 3l7 5-7 5V3z" />
  </svg>
);
const IconLast = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="12" y="3" width="2" height="10" rx="1" />
    <path d="M3 3l7 5-7 5V3z" />
  </svg>
);
const IconFlip = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: "rotate(90deg)" }}>
    <path d="M17 1l4 4-4 4" />
    <path d="M3 11V9a4 4 0 014-4h14" />
    <path d="M7 23l-4-4 4-4" />
    <path d="M21 13v2a4 4 0 01-4 4H3" />
  </svg>
);

interface GameDetail {
  id: number;
  white: string;
  black: string;
  white_fide_id: number | null;
  black_fide_id: number | null;
  white_elo: number | null;
  black_elo: number | null;
  event: string | null;
  date: string | null;
  result: string | null;
  eco: string | null;
  move_count: number | null;
  pgn: string | null;
  visibility: string | null;
  collections: string[];
  deleted_at: string | null;
}

// Legacy flat format for non-annotated games
interface MoveEntry {
  index: number;
  san: string;
  color: "w" | "b";
}

function buildGame(pgn: string): { fens: string[]; moves: MoveEntry[] } {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history({ verbose: true });
  const fens: string[] = [];
  const moves: MoveEntry[] = [];
  const replay = new Chess();
  fens.push(replay.fen());
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    replay.move(m.san);
    fens.push(replay.fen());
    moves.push({ index: i + 1, san: m.san, color: m.color });
  }
  return { fens, moves };
}

// ── Breadcrumb for variation navigation ──────────────────────────────────────

interface Breadcrumb {
  line: MoveNode[];
  index: number;
}

// ── Annotated Move List ─────────────────────────────────────────────────────

interface AnnotatedMoveListProps {
  game: AnnotatedGame;
  activeLine: MoveNode[];
  activeIndex: number;
  showAnnotations: boolean;
  collapsedNodes: Set<string>;
  partialNodes: Set<string>;
  inSubVariation: boolean;
  breadcrumbs: Breadcrumb[];
  onNavigate: (line: MoveNode[], index: number) => void;
  onToggleCollapse: (key: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onExpandSubVariations: () => void;
  onCollapseSubVariations: () => void;
  onToggleAnnotations: () => void;
}

function getMoveNum(node: MoveNode): number {
  const fenParts = node.fen.split(" ");
  const fullmove = parseInt(fenParts[5], 10);
  if (node.color === "w") return fullmove;
  return fullmove - 1;
}

function AnnotatedMoveList({
  game, activeLine, activeIndex, showAnnotations, collapsedNodes, partialNodes, inSubVariation,
  breadcrumbs, onNavigate, onToggleCollapse, onExpandAll, onCollapseAll,
  onExpandSubVariations, onCollapseSubVariations, onToggleAnnotations,
}: AnnotatedMoveListProps) {
  const activeRef = useRef<HTMLSpanElement>(null);

  // Build path map: for each line in the path, store the max move index that's "on the path"
  const pathMap = useMemo(() => {
    const map = new Map<MoveNode[], number>();
    // Breadcrumbs: each entry's line is on the path up to its index
    for (const bc of breadcrumbs) {
      map.set(bc.line, bc.index);
    }
    // Active line: on the path up to activeIndex
    map.set(activeLine, activeIndex);
    return map;
  }, [breadcrumbs, activeLine, activeIndex]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, activeLine]);

  function renderLine(line: MoveNode[], pathPrefix: string, depth: number) {
    const isActive = line === activeLine;
    const pathMaxIndex = pathMap.get(line); // undefined if not on path
    const elements: React.ReactNode[] = [];
    let needsBlackNumber = false;

    for (let i = 0; i < line.length; i++) {
      const node = line[i];
      const moveIdx = i + 1;
      const isCurrentMove = isActive && activeIndex === moveIdx;
      const isOnPath = pathMaxIndex !== undefined && moveIdx <= pathMaxIndex;
      const moveNum = getMoveNum(node);
      const nodeKey = `${pathPrefix}-${i}`;
      const hasVariations = node.variations.length > 0;
      const isCollapsed = hasVariations && collapsedNodes.has(nodeKey);

      const showNumber = node.color === "w" || i === 0 || needsBlackNumber;
      needsBlackNumber = false;

      const isPartial = hasVariations && partialNodes.has(nodeKey);

      // Variation toggle — show inline [+] when fully collapsed
      if (hasVariations && isCollapsed) {
        elements.push(
          <span
            key={`t-${i}`}
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(nodeKey); }}
            className="cursor-pointer text-on-surface-variant hover:text-on-surface select-none border border-outline rounded-xs px-0.5 mr-1 leading-none align-middle transition-colors duration-short3 ease-standard"
            style={{ fontSize: "0.75em" }}
            title="Expand variations"
          >+</span>
        );
      }

      // Move (with optional move number as single clickable unit)
      const numPrefix = showNumber
        ? (node.color === "w" ? `${moveNum}.` : `${moveNum}...`)
        : "";
      elements.push(
        <span
          key={`m-${i}`}
          ref={isCurrentMove ? activeRef : null}
          onClick={() => onNavigate(line, moveIdx)}
          className={`cursor-pointer rounded-sm transition-colors duration-short3 ease-standard ${
            isCurrentMove
              ? "bg-primary-container text-on-primary-container px-0.5"
              : isOnPath
              ? "text-primary"
              : "text-on-surface hover:bg-on-surface/8"
          }`}
        >
          {numPrefix}{node.san}{node.annotations.nag ?? ""}
        </span>
      );

      const hasGraphical = (node.annotations.arrows?.length ?? 0) > 0 || (node.annotations.circles?.length ?? 0) > 0;
      const hasComment = !!node.annotations.comment;
      const hasIndicators = hasGraphical || (hasComment && !showAnnotations);

      // Tighter space before indicators, normal space if no indicators
      if (hasIndicators) {
        elements.push(<span key={`s-${i}`} style={{ fontSize: "0.5em" }}>{" "}</span>);
      } else {
        elements.push(<span key={`s-${i}`}>{" "}</span>);
      }

      if (hasGraphical) {
        elements.push(
          <span key={`g-${i}`} className="text-xs opacity-70 annotation-hint">💠</span>
        );
      }

      // Inline comment
      if (hasComment) {
        if (showAnnotations) {
          // Space before comment text
          if (hasGraphical) elements.push(<span key={`gs-${i}`} style={{ fontSize: "0.5em" }}>{" "}</span>);
          elements.push(
            <span key={`c-${i}`} className={`italic text-body-sm font-sans ${isOnPath ? "text-primary/70" : "text-on-surface-variant"}`}>
              {node.annotations.comment}{" "}
            </span>
          );
          if (node.color === "w") needsBlackNumber = true;
        } else {
          if (hasGraphical) elements.push(<span key={`gs-${i}`} style={{ fontSize: "0.3em" }}>{" "}</span>);
          elements.push(
            <span key={`c-${i}`} className="text-xs opacity-30 annotation-hint" title={node.annotations.comment}>💬</span>
          );
        }
      }

      // Trailing space after indicators/move
      if (hasIndicators) {
        elements.push(<span key={`st-${i}`}>{" "}</span>);
      }

      // Variations — after a variation block, black also needs move number
      if (!isCollapsed && hasVariations) {
        // In partial mode, only show variations that are on the path
        const visibleVariations: { variation: MoveNode[]; vi: number }[] = [];
        for (let vi = 0; vi < node.variations.length; vi++) {
          const variation = node.variations[vi];
          if (isPartial) {
            // Only include if this variation is on the path (is activeLine or contains it)
            const isOnPathVar = pathMap.has(variation) || variation === activeLine;
            if (!isOnPathVar) {
              // Check deeper
              const hasPathDeeper = (function checkDeep(line: MoveNode[]): boolean {
                for (const n of line) {
                  for (const v of n.variations) {
                    if (v === activeLine || pathMap.has(v) || checkDeep(v)) return true;
                  }
                }
                return false;
              })(variation);
              if (!hasPathDeeper) continue;
            }
          }
          visibleVariations.push({ variation, vi });
        }

        const shortVars: React.ReactNode[] = [];
        const blockVars: React.ReactNode[] = [];

        for (const { variation, vi } of visibleVariations) {
          const varPath = `${nodeKey}-v${vi}`;
          const isShort = variation.length <= 3 && variation.every(n => n.variations.length === 0 && !n.annotations.comment);

          if (isShort) {
            shortVars.push(
              <span key={`v-${i}-${vi}`} className="text-on-surface-variant text-body-sm">
                {"( "}
                {renderLine(variation, varPath, depth + 1)}
                {") "}
              </span>
            );
          } else {
            blockVars.push(
              <div key={`v-${i}-${vi}`} className="text-body-sm text-on-surface-variant leading-normal">
                {renderLine(variation, varPath, depth + 1)}
              </div>
            );
          }
        }

        // Render short variations inline
        for (const sv of shortVars) {
          elements.push(sv);
        }

        // Render block variations in a single grouped container
        if (blockVars.length > 0) {
          const toggleLabel = isPartial ? "\u2026" : "\u2212"; // … or −
          const toggleTitle = isPartial ? "Show all variations" : "Collapse variations";
          elements.push(
            <div key={`vg-${i}`} className="text-body-sm text-on-surface-variant my-0.5 ml-1 relative pl-3 leading-normal">
              {/* Clickable border + collapse/partial button */}
              <div
                className="absolute left-0 top-0 bottom-0 w-3 cursor-pointer group"
                onClick={() => onToggleCollapse(nodeKey)}
                title={toggleTitle}
              >
                <div className="absolute left-0 top-0 bottom-0 w-px bg-outline-variant group-hover:bg-primary transition-colors duration-short3 ease-standard" />
                <span
                  className="absolute left-[-4px] top-0 text-on-surface-variant group-hover:text-on-surface select-none border border-outline group-hover:border-primary rounded-xs bg-surface px-0.5 leading-none transition-colors duration-short3 ease-standard"
                  style={{ fontSize: "0.75em" }}
                >{toggleLabel}</span>
              </div>
              {blockVars}
            </div>
          );
        }

        // After variations, next black move needs number
        if (node.color === "w") needsBlackNumber = true;
      }
    }

    return <>{elements}</>;
  }

  // M3 mini text-button used in the AnnotatedMoveList toolbar
  const miniBtn = "text-label-sm px-2 h-6 inline-flex items-center rounded-full text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors duration-short3 ease-standard";

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto font-mono text-body-md px-2 py-1">
        {showAnnotations && game.startComment && (
          <div className="text-on-surface-variant italic text-body-sm mb-1 font-sans">{game.startComment}</div>
        )}
        <div className="leading-normal">
          {renderLine(game.mainLine, "m", 0)}
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="shrink-0 px-2 py-1.5 flex items-center gap-1 flex-wrap">
        <button onClick={onExpandAll} className={miniBtn} title="Expand all variations">All+</button>
        <button onClick={onCollapseAll} className={miniBtn} title="Collapse all variations">All−</button>
        <button onClick={onExpandSubVariations} disabled={!inSubVariation} className={miniBtn} title="Expand sub-variations in current line">Sub+</button>
        <button onClick={onCollapseSubVariations} disabled={!inSubVariation} className={miniBtn} title="Collapse sub-variations in current line">Sub−</button>
        <button
          onClick={onToggleAnnotations}
          className={`${miniBtn} ${showAnnotations ? "" : "opacity-50"}`}
          title={showAnnotations ? "Hide annotations" : "Show annotations"}
        >💬</button>
      </div>
    </div>
  );
}

// ── Legacy Move List (for API-fetched games without tree) ───────────────────

interface MoveListProps {
  moves: MoveEntry[];
  currentIndex: number;
  onSelect: (index: number) => void;
}

function MoveList({ moves, currentIndex, onSelect }: MoveListProps) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentIndex]);

  const pairs: Array<[MoveEntry, MoveEntry | null]> = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push([moves[i], moves[i + 1] ?? null]);
  }

  return (
    <div className="flex-1 overflow-y-auto font-mono text-body-md">
      {pairs.map((pair, i) => (
        <div key={i} className="flex items-center hover:bg-on-surface/4 transition-colors duration-short3 ease-standard">
          <span className="w-8 shrink-0 text-right text-on-surface-variant pr-2 select-none text-body-sm">
            {i + 1}.
          </span>
          <button
            ref={currentIndex === pair[0].index ? activeRef : null}
            onClick={() => onSelect(pair[0].index)}
            className={`w-20 text-left px-1.5 py-1 rounded-sm transition-colors duration-short3 ease-standard ${
              currentIndex === pair[0].index
                ? "bg-secondary-container text-on-secondary-container"
                : "text-on-surface hover:bg-on-surface/8"
            }`}
          >
            {pair[0].san}
          </button>
          {pair[1] && (
            <button
              ref={currentIndex === pair[1]!.index ? activeRef : null}
              onClick={() => onSelect(pair[1]!.index)}
              className={`w-20 text-left px-1.5 py-1 rounded-sm transition-colors duration-short3 ease-standard ${
                currentIndex === pair[1]!.index
                  ? "bg-secondary-container text-on-secondary-container"
                  : "text-on-surface-variant hover:bg-on-surface/8"
              }`}
            >
              {pair[1]!.san}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Convert a pointer event on the sized board container to an algebraic
 *  square ("e4"), or null if the pointer is outside. Inverse of
 *  AnnotationOverlay.squareCenter — kept geometric (no DOM coupling) so it
 *  works regardless of react-chessboard internals. */
function resolveSquareFromPointer(
  e: React.PointerEvent<HTMLDivElement>,
  flipped: boolean,
): string | null {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
  const sq = rect.width / 8;
  const col = Math.floor(x / sq);
  const row = Math.floor(y / sq);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  const file = flipped ? 7 - col : col;
  const rank = flipped ? row : 7 - row;
  return `${String.fromCharCode(97 + file)}${rank + 1}`;
}

// ── Custom Annotation Overlay (arrows + circles) ────────────────────────────

const ANNOTATION_OPACITY = 0.7;
const ANNOTATION_STROKE_PCT = 3; // stroke width as % of square size

function AnnotationOverlay({ arrows, circles, flipped, size }: {
  arrows: CalArrow[];
  circles: CslCircle[];
  flipped: boolean;
  size: number;
}) {
  const sqSize = size / 8;

  function squareCenter(sq: string): { x: number; y: number } {
    const col = sq.charCodeAt(0) - 97; // a=0, h=7
    const row = parseInt(sq[1], 10) - 1; // 1=0, 8=7
    const x = flipped ? (7 - col + 0.5) * sqSize : (col + 0.5) * sqSize;
    const y = flipped ? (row + 0.5) * sqSize : (7 - row + 0.5) * sqSize;
    return { x, y };
  }

  const strokeW = sqSize * ANNOTATION_STROKE_PCT / 100 * 3; // ~9% of square
  const arrowHeadSize = strokeW * 3;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20 }}
    >
      <defs>
        {arrows.map((a, i) => (
          <marker
            key={`ah-${i}`}
            id={`arrow-head-${i}`}
            markerWidth={arrowHeadSize}
            markerHeight={arrowHeadSize}
            refX={arrowHeadSize * 0.8}
            refY={arrowHeadSize / 2}
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <polygon
              points={`0,0 ${arrowHeadSize},${arrowHeadSize / 2} 0,${arrowHeadSize}`}
              fill={a.color}
              opacity={ANNOTATION_OPACITY}
            />
          </marker>
        ))}
      </defs>

      {/* Circles */}
      {circles.map((c, i) => {
        const center = squareCenter(c.square);
        const r = sqSize / 2 - strokeW / 2;
        return (
          <circle
            key={`circle-${i}`}
            cx={center.x}
            cy={center.y}
            r={r}
            fill="none"
            stroke={c.color}
            strokeWidth={strokeW}
            opacity={ANNOTATION_OPACITY}
          />
        );
      })}

      {/* Arrows — always straight lines */}
      {arrows.map((a, i) => {
        const from = squareCenter(a.from);
        const to = squareCenter(a.to);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dist = Math.hypot(dx, dy);
        // Shorten: start offset by 20% of square, end offset for arrowhead
        const startOff = sqSize * 0.15;
        const endOff = arrowHeadSize * 0.7;
        const sx = from.x + (dx / dist) * startOff;
        const sy = from.y + (dy / dist) * startOff;
        const ex = to.x - (dx / dist) * endOff;
        const ey = to.y - (dy / dist) * endOff;
        return (
          <line
            key={`arrow-${i}`}
            x1={sx}
            y1={sy}
            x2={ex}
            y2={ey}
            stroke={a.color}
            strokeWidth={strokeW}
            opacity={ANNOTATION_OPACITY}
            markerEnd={`url(#arrow-head-${i})`}
          />
        );
      })}
    </svg>
  );
}

function formatMoveSequence(moves: string[]): string {
  return moves
    .map((mv, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}.${mv}` : mv))
    .join(" ");
}

interface Props {
  game: GameSummary;
  pgn?: string;
  moveSequence?: string[];
  onBackToPosition?: () => void;
  /** Fires when the user mutates the game from the DetailsPanel (soft-delete,
   * restore, future edits) so parents can re-fetch lists, counts, etc. */
  onGameMutated?: () => void;
}

// Tags shown in the compact view always; rest only appear when expanded.
const PROMINENT_TAGS = new Set([
  "Event", "Site", "Date", "EventDate", "Round",
  "White", "Black", "Result",
  "WhiteElo", "BlackElo", "WhiteFideId", "BlackFideId",
  "ECO", "Opening", "Variation", "TimeControl", "Termination", "Annotator",
]);

function VisibilityChip({ visibility, disabled, onToggle }: {
  visibility: string | null;
  disabled: boolean;
  onToggle: () => void;
}) {
  if (!visibility) return null;
  // M3 chip — public=success, private=warning. Clickable to flip.
  const cls = visibility === "public"
    ? "bg-success-container text-on-success-container hover:brightness-110 active:brightness-95"
    : "bg-warning-container text-on-warning-container hover:brightness-110 active:brightness-95";
  const next = visibility === "public" ? "private" : "public";
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      title={`Click to make ${next}`}
      className={`text-label-sm px-2 h-5 inline-flex items-center rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-short3 ease-standard ${cls}`}
    >
      {visibility}
    </button>
  );
}

function CollectionChip({ name, disabled, onRemove }: {
  name: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <span className="text-label-sm pl-2 pr-1 h-5 inline-flex items-center gap-1 rounded-full bg-tertiary-container text-on-tertiary-container">
      {name}
      <button
        onClick={onRemove}
        disabled={disabled}
        title={`Remove from "${name}"`}
        aria-label={`Remove from ${name}`}
        className="w-4 h-4 inline-flex items-center justify-center rounded-full text-on-tertiary-container/70 hover:text-on-tertiary-container hover:bg-on-tertiary-container/15 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-short3 ease-standard"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2 2 L8 8 M8 2 L2 8" />
        </svg>
      </button>
    </span>
  );
}

function DetailsToggleButton({ detail, open, onToggle }: {
  detail: GameDetail;
  open: boolean;
  onToggle: () => void;
}) {
  const isDeleted = detail.deleted_at != null;
  return (
    <button
      onClick={onToggle}
      className={`h-8 px-3 inline-flex items-center rounded-full text-label-md transition-colors duration-short3 ease-standard ${
        isDeleted
          ? "text-error hover:bg-error/10 active:bg-error/15"
          : "text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12"
      }`}
      title={open ? "Hide details" : "Show full headers, source, and collections"}
    >
      {isDeleted && <span className="mr-1">●</span>}
      {open ? "▾ Details" : "▸ Details"}
    </button>
  );
}

// ── PGN export helpers ───────────────────────────────────────────────────────
//
// Filename convention: YYYYMMDD-WhiteAbbr-BlackAbbr.pgn
//   "Svrcek, Jozef" → "SvrcekJ"   (lastname + first-name initials)
//   "2026.04.11"    → "20260411"  (digits only, padded to 8)
// Last directory the user picked is remembered in localStorage so the next
// export defaults to the same folder.

const PGN_EXPORT_DIR_KEY = "pgnExportDir";

function abbreviatePlayerName(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "Unknown";
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");
  if (trimmed.includes(",")) {
    const [last = "", first = ""] = trimmed.split(",").map((s) => s.trim());
    const initials = first
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => s.charAt(0).toUpperCase())
      .join("");
    return sanitize(last) + initials || "Unknown";
  }
  return sanitize(trimmed) || "Unknown";
}

function formatDateForFilename(dateStr: string | null): string {
  if (!dateStr) return "00000000";
  const digits = dateStr.replace(/[^0-9]/g, "");
  return (digits + "00000000").slice(0, 8);
}

function composePgnFilename(detail: GameDetail): string {
  return `${formatDateForFilename(detail.date)}-${abbreviatePlayerName(detail.white)}-${abbreviatePlayerName(detail.black)}.pgn`;
}

async function exportGameToPgn(detail: GameDetail): Promise<void> {
  if (!detail.pgn) return;

  const filename = composePgnFilename(detail);
  const lastDir = localStorage.getItem(PGN_EXPORT_DIR_KEY) ?? "";
  // Tauri's save dialog accepts an OS path or just a filename. When we have
  // a remembered directory, prefix it so the dialog opens there.
  const defaultPath = lastDir ? `${lastDir}/${filename}` : filename;

  const path = await save({
    defaultPath,
    filters: [{ name: "PGN", extensions: ["pgn"] }],
  });
  if (!path) return; // user cancelled

  // Re-emit the body with proper move numbers (DB games are often stored with
  // a bare-moves body that strict PGN parsers reject) before writing.
  const pgnContent = ensureMoveNumbers(detail.pgn) + "\n";
  await invoke("write_pgn_file", { path, content: pgnContent });

  // Persist the directory portion for next time. Handles both / and \ so the
  // logic works on Windows too.
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (lastSlash > 0) {
    localStorage.setItem(PGN_EXPORT_DIR_KEY, path.substring(0, lastSlash));
  }
}

// ── Action toolbar ───────────────────────────────────────────────────────────
//
// Always visible above the (collapsible) Details panel so the user doesn't have
// to expand Details to access game-level actions. Owns the state for the Edit
// headers modal, delete-confirmation flow, export error, and the sidecar
// progress used by soft-delete / restore.
function GameActionsBar({
  detail, onDetailChanged, onStartEditMoves, detailsOpen, onToggleDetails,
}: {
  detail: GameDetail;
  onDetailChanged: () => void;
  /** Fires when the user clicks "Edit moves…" — host enters inline edit mode. */
  onStartEditMoves: () => void;
  /** Details panel state — the toggle lives in this toolbar so it sits
   *  directly above the panel it controls. */
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const isDeleted = detail.deleted_at != null;
  const progress = useSidecarProgress();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function handleExport() {
    setExportError(null);
    try {
      await exportGameToPgn(detail);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  }

  // Refresh parent detail when the subprocess finishes successfully.
  useEffect(() => {
    if (progress.done) {
      onDetailChanged();
      progress.reset();
      setConfirmingDelete(false);
    }
  }, [progress.done]);

  function softDelete() {
    setConfirmingDelete(false);
    void progress.run(["games", "soft-delete", String(detail.id)]);
  }
  function restore() {
    void progress.run(["games", "restore", String(detail.id)]);
  }

  const tonalBtn = "h-8 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 active:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard";

  return (
    <div className="shrink-0 bg-surface-container rounded-lg p-3 space-y-3">
      {confirmingDelete && (
        <div className="bg-error-container text-on-error-container rounded-md p-3 text-body-sm space-y-2">
          <div>
            Soft-delete this game? It will disappear from search results and player stats but stays
            in the database — restore brings it back. Re-imports of the same source will not recreate it.
          </div>
          <div className="flex gap-2">
            <button
              onClick={softDelete}
              className="h-8 px-3 inline-flex items-center rounded-full bg-error text-on-error text-label-md hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
            >
              Yes, soft-delete
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="h-8 px-3 inline-flex items-center rounded-full text-on-error-container text-label-md hover:bg-on-error-container/10 transition-colors duration-short3 ease-standard"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {exportError && (
        <div className="bg-error-container text-on-error-container rounded-md p-2 text-body-sm">
          Export failed: {exportError}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setEditing(true)}
          disabled={progress.running || !detail.pgn}
          className={tonalBtn}
          title="Edit PGN headers"
        >
          Edit headers…
        </button>
        <button
          onClick={onStartEditMoves}
          disabled={progress.running || !detail.pgn}
          className={tonalBtn}
          title="Edit main-line moves"
        >
          Edit moves…
        </button>
        <button
          onClick={handleExport}
          disabled={!detail.pgn}
          className={tonalBtn}
          title="Save the game as a .pgn file"
        >
          Export PGN…
        </button>
        {/* Restore stays inline with the other actions — it's a recovery action,
            not destructive. Delete is broken out as a separate icon button on
            the right, in error colour, so it can't be confused with edit/export. */}
        {isDeleted && (
          <button
            onClick={restore}
            disabled={progress.running}
            className="h-8 px-3 inline-flex items-center rounded-full bg-success-container text-on-success-container text-label-md hover:brightness-110 disabled:opacity-50 transition-all duration-short3 ease-standard"
          >
            {progress.running ? "Restoring…" : "Restore"}
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <DetailsToggleButton detail={detail} open={detailsOpen} onToggle={onToggleDetails} />
          <span className="text-label-sm text-on-surface-variant font-mono">id {detail.id}</span>
        </div>
        {!isDeleted && (
          <button
            onClick={() => setConfirmingDelete(true)}
            disabled={progress.running || confirmingDelete}
            className="w-8 h-8 inline-flex items-center justify-center rounded-full text-error hover:bg-error/10 active:bg-error/15 disabled:opacity-50 disabled:hover:bg-transparent transition-colors duration-short3 ease-standard"
            title={progress.running ? "Deleting…" : "Delete game…"}
            aria-label="Delete game"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </button>
        )}
      </div>

      {progress.log.length > 0 && (
        <div className="text-label-sm font-mono text-on-surface-variant bg-surface-container-lowest p-2 rounded-sm max-h-20 overflow-y-auto">
          {progress.log.slice(-5).map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {editing && detail.pgn && (
        <EditDbHeadersModal
          gameId={detail.id}
          pgn={detail.pgn}
          whiteFideId={detail.white_fide_id}
          blackFideId={detail.black_fide_id}
          onClose={() => setEditing(false)}
          onSaved={onDetailChanged}
        />
      )}
    </div>
  );
}

// Details panel — collapsible. Owns the visibility/collection mutation flow:
// chips here are interactive (click visibility to flip; × to remove a
// collection; "+ Add to collection" opens a picker). Each mutation invokes a
// chess-db sidecar subcommand and asks the parent to refetch on completion.
function DetailsPanel({
  detail, onClose, onDetailChanged,
}: {
  detail: GameDetail;
  onClose: () => void;
  /** Refetch the GameDetail after a successful membership mutation. */
  onDetailChanged: () => void;
}) {
  const isDeleted = detail.deleted_at != null;
  const progress = useSidecarProgress();
  const [pickerOpen, setPickerOpen] = useState(false);

  // When a sidecar mutation completes, refetch the detail and clear the
  // hook so the next click starts fresh. Mirrors the pattern in GameActionsBar.
  useEffect(() => {
    if (progress.done) {
      onDetailChanged();
      progress.reset();
    }
  }, [progress.done]);

  const tags = useMemo(() => {
    if (!detail.pgn) return [] as { name: string; value: string }[];
    try { return parseBlockTags(detail.pgn).tags; } catch { return []; }
  }, [detail.pgn]);

  // Order tags: prominent first, then everything else alphabetical.
  const sorted = [...tags].sort((a, b) => {
    const ap = PROMINENT_TAGS.has(a.name) ? 0 : 1;
    const bp = PROMINENT_TAGS.has(b.name) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name);
  });

  const id = String(detail.id);
  function flipVisibility() {
    const next = detail.visibility === "public" ? "private" : "public";
    progress.run(["games", "set-visibility", id, next]);
  }
  function removeFromCollection(name: string) {
    progress.run(["games", "remove-collection", id, name]);
  }
  function addToCollection(name: string) {
    progress.run(["games", "add-collection", id, name]);
  }

  const busy = progress.running;

  return (
    <div className="bg-surface-container-high rounded-lg max-h-[40vh] overflow-y-auto p-4 space-y-3 shrink-0">
      {isDeleted && (
        <div className="bg-error-container text-on-error-container text-label-md px-3 py-2 rounded-md flex items-center justify-between gap-3">
          <span>● Soft-deleted on {detail.deleted_at?.slice(0, 19).replace("T", " ")}</span>
          <span className="opacity-70">Hidden from search and stats. Restore to bring it back.</span>
        </div>
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap gap-1.5 items-center">
          <VisibilityChip visibility={detail.visibility} disabled={busy} onToggle={flipVisibility} />
          {detail.collections.map((c) => (
            <CollectionChip key={c} name={c} disabled={busy} onRemove={() => removeFromCollection(c)} />
          ))}
          {/* Add-to-collection trigger + anchored picker. The wrapping div is
              `relative` so CollectionPicker's absolute positioning anchors here. */}
          <div className="relative">
            <button
              onClick={() => setPickerOpen((o) => !o)}
              disabled={busy}
              className="text-label-sm px-2 h-5 inline-flex items-center rounded-full border border-dashed border-outline text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-short3 ease-standard"
            >
              + Add to collection
            </button>
            {pickerOpen && (
              <CollectionPicker
                excluded={detail.collections}
                onPick={addToCollection}
                onClose={() => setPickerOpen(false)}
              />
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard text-base leading-none shrink-0"
          title="Close"
        >
          ×
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="text-body-sm text-on-surface-variant">No PGN headers available.</div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-label-md">
          {sorted.map((t) => (
            <div key={t.name} className="flex gap-2">
              <span className="text-on-surface-variant font-mono shrink-0 w-24 truncate" title={t.name}>{t.name}</span>
              <span className="text-on-surface break-all">{t.value || "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function GameBoard({ game, pgn: directPgn, moveSequence, onBackToPosition, onGameMutated }: Props) {
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(
    () => localStorage.getItem("gameDetailsOpen") === "1"
  );
  useEffect(() => {
    localStorage.setItem("gameDetailsOpen", detailsOpen ? "1" : "0");
  }, [detailsOpen]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Legacy flat state (for API-fetched games)
  const [fens, setFens] = useState<string[]>([]);
  const [moves, setMoves] = useState<MoveEntry[]>([]);

  // Annotated tree state
  const [annotatedGame, setAnnotatedGame] = useState<AnnotatedGame | null>(null);
  const [activeLine, setActiveLine] = useState<MoveNode[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  // Tracks whether the one-click pointer button is currently held. We need
  // this explicitly because `gestureActive` stays true between release and
  // the DB fetch landing (silent wait), and pointermove after that release
  // would otherwise overwrite the just-committed flag.
  const oneClickPressedRef = useRef(false);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [moveListWidth, setMoveListWidth] = useState(() => {
    const saved = localStorage.getItem("moveListWidth");
    return saved ? Number(saved) : 208;
  });
  useEffect(() => { localStorage.setItem("moveListWidth", String(moveListWidth)); }, [moveListWidth]);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [annotationPanelCollapsed, setAnnotationPanelCollapsed] = useState(true);
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [partialNodes, setPartialNodes] = useState<Set<string>>(new Set());
  const [annotationPanelHeight, setAnnotationPanelHeight] = useState(3); // in em units
  const panelDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // Variation choice modal
  const [varChoice, setVarChoice] = useState<{
    choices: { label: string; line: MoveNode[]; index: number }[];
    selected: number;
  } | null>(null);

  // Inline moves editor (state + handlers + overlay UI live in MovesEditor.tsx)
  const pendingFocusIndexRef = useRef<number | null>(null);
  const movesEditor = useMovesEditor({
    gameId: game.id,
    onSaved: (focusIndex) => {
      pendingFocusIndexRef.current = focusIndex;
      setDetailReloadKey((k) => k + 1);
      onGameMutated?.();
    },
  });

  // Auto-save on game switch: if the user navigates away while editing, fire
  // the same set-moves call against the *previous* game and exit edit mode.
  // Fire-and-forget so the new game can load without UI block. The editor's
  // ref keeps its latest state available even after the parent rerenders
  // with a new game.id.
  const editorRef = useRef(movesEditor);
  editorRef.current = movesEditor;
  const prevGameIdRef = useRef<number | null>(null);
  useEffect(() => {
    const prevId = prevGameIdRef.current;
    prevGameIdRef.current = game.id;
    if (prevId === null || prevId === game.id) return;
    const ed = editorRef.current;
    if (ed.active && ed.moves.length > 0) {
      const movesToSave = ed.moves.slice();
      ed.cancel();
      saveMovesViaSidecar(prevId, movesToSave).then((res) => {
        if (!res.ok) {
          // Surface enough to debug, without blocking the new game's UI.
          // eslint-disable-next-line no-console
          console.error(`Autosave on game switch (game ${prevId}) failed: ${res.error}`);
        } else {
          onGameMutated?.();
        }
      });
    }
  }, [game.id, onGameMutated]);

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [squareSize, setSquareSize] = useState(480);
  const moveSequenceRef = useRef(moveSequence);
  moveSequenceRef.current = moveSequence;

  const useAnnotated = annotatedGame !== null;

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: moveListWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX;
      setMoveListWidth(Math.max(208, dragRef.current.startWidth + delta));
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [moveListWidth]);

  const handlePanelDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const emSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    panelDragRef.current = { startY: e.clientY, startHeight: annotationPanelHeight };
    const onMove = (ev: MouseEvent) => {
      if (!panelDragRef.current) return;
      const deltaEm = (panelDragRef.current.startY - ev.clientY) / emSize;
      setAnnotationPanelHeight(Math.max(3, panelDragRef.current.startHeight + deltaEm));
    };
    const onUp = () => {
      panelDragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [annotationPanelHeight]);

  useLayoutEffect(() => {
    const el = boardContainerRef.current;
    if (!el) return;
    function measure() {
      const rect = el!.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        setSquareSize(Math.floor(Math.min(rect.width, rect.height)) - 16);
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [detail]);

  // Fetch game detail (or use direct PGN)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFens([]);
    setMoves([]);
    setCurrentIndex(0);
    setAnnotatedGame(null);
    setActiveLine([]);
    setActiveIndex(0);
    setBreadcrumbs([]);

    function applyDetail(data: GameDetail) {
      if (cancelled) return;
      setDetail(data);
      if (data.pgn) {
        try {
          const tree = parsePgnTree(data.pgn);
          setAnnotatedGame(tree);
          setActiveLine(tree.mainLine);
          setActiveIndex(0);

          // Post-save focus takes precedence: keep the user on the last move
          // they just entered rather than snapping to the starting position.
          const pendingFocus = pendingFocusIndexRef.current;
          pendingFocusIndexRef.current = null;
          if (pendingFocus != null) {
            setActiveIndex(Math.max(0, Math.min(pendingFocus, tree.mainLine.length)));
          } else if (game.move_number != null) {
            setActiveIndex(Math.min(game.move_number, tree.mainLine.length));
          } else {
            const seq = moveSequenceRef.current;
            if (seq && seq.length > 0) {
              let target = 0;
              for (let i = 0; i < Math.min(seq.length, tree.mainLine.length); i++) {
                if (tree.mainLine[i].san === seq[i]) target = i + 1;
                else break;
              }
              setActiveIndex(target);
            }
          }
        } catch {
          // Fallback to legacy parser for malformed PGNs
          const { fens, moves } = buildGame(data.pgn);
          setFens(fens);
          setMoves(moves);
          applyLegacyIndex(fens, moves);
        }
      }
      setLoading(false);
    }

    function applyLegacyIndex(fens: string[], moves: MoveEntry[]) {
      if (game.move_number != null) {
        setCurrentIndex(Math.min(game.move_number, fens.length - 1));
      } else {
        const seq = moveSequenceRef.current;
        if (seq && seq.length > 0) {
          let target = 0;
          for (let i = 0; i < Math.min(seq.length, moves.length); i++) {
            if (moves[i].san === seq[i]) target = i + 1;
            else break;
          }
          setCurrentIndex(target);
        }
      }
    }

    if (directPgn) {
      applyDetail({
        id: game.id,
        white: game.white,
        black: game.black,
        white_fide_id: null,
        black_fide_id: null,
        white_elo: game.white_elo,
        black_elo: game.black_elo,
        event: game.event,
        date: game.date,
        result: game.result,
        eco: game.eco,
        move_count: game.move_count,
        pgn: directPgn,
        visibility: null,
        collections: [],
        deleted_at: null,
      });
    } else {
      // Cache-bust on detailReloadKey so the webview always hits a freshly
       // respawned chess-db serve after a writer (set-moves / set-headers /
      // soft-delete) — otherwise a stale 200 would mask the new pgn.
      fetch(`/api/games/${game.id}?_=${detailReloadKey}`, { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error(`Server error ${r.status}`);
          return r.json() as Promise<GameDetail>;
        })
        .then(applyDetail)
        .catch((e) => {
          if (!cancelled) {
            setError(e.message);
            setLoading(false);
          }
        });
    }

    return () => { cancelled = true; };
  }, [game.id, directPgn, detailReloadKey]);

  // ── Navigation helpers ──────────────────────────────────────────────────

  const currentFen = useMemo(() => {
    if (movesEditor.active) return movesEditor.fen;
    if (useAnnotated) {
      if (activeIndex === 0) return annotatedGame!.startFen;
      return activeLine[activeIndex - 1]?.fen ?? annotatedGame!.startFen;
    }
    return fens[currentIndex] ?? "start";
  }, [movesEditor.active, movesEditor.fen, useAnnotated, annotatedGame, activeLine, activeIndex, fens, currentIndex]);

  // Pre-warm the position-moves cache as the user browses, so entering edit
  // mode and clicking on an empty square shows the right arrow without a
  // network round-trip. Skipped for "start" / empty placeholders.
  useEffect(() => {
    if (!currentFen || currentFen === "start") return;
    movesEditor.prefetchPositionMoves(currentFen);
  }, [currentFen, movesEditor.prefetchPositionMoves]);

  const currentMoveNode = useMemo(() => {
    if (useAnnotated && activeIndex > 0) return activeLine[activeIndex - 1];
    return null;
  }, [useAnnotated, activeLine, activeIndex]);

  const maxIndex = useAnnotated ? activeLine.length : fens.length - 1;

  const goTo = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, maxIndex));
    if (useAnnotated) setActiveIndex(clamped);
    else setCurrentIndex(clamped);
  }, [maxIndex, useAnnotated]);

  const effectiveIndex = useAnnotated ? activeIndex : currentIndex;

  // Find the path from a root line down to a target variation line
  // Stores the index of the move BEFORE the branching move (last move on the path)
  function findPathToLine(root: MoveNode[], target: MoveNode[]): Breadcrumb[] | null {
    if (root === target) return [];
    for (let i = 0; i < root.length; i++) {
      for (const variation of root[i].variations) {
        if (variation === target) {
          return [{ line: root, index: i }]; // i, not i+1: the branching move itself is NOT on the path
        }
        const deeper = findPathToLine(variation, target);
        if (deeper) {
          return [{ line: root, index: i }, ...deeper];
        }
      }
    }
    return null;
  }

  function handleNavigateToVariation(line: MoveNode[], index: number) {
    if (line !== activeLine) {
      if (annotatedGame) {
        // Build full breadcrumb path from main line to the target line
        const path = findPathToLine(annotatedGame.mainLine, line);
        if (path) {
          setBreadcrumbs(path);
        }
      }
      setActiveLine(line);
    }
    setActiveIndex(index);
  }

  function handleBackToMainLine() {
    if (breadcrumbs.length > 0) {
      const bc = breadcrumbs[breadcrumbs.length - 1];
      setBreadcrumbs((prev) => prev.slice(0, -1));
      setActiveLine(bc.line);
      setActiveIndex(bc.index);
    }
  }

  // ── Variation collapse helpers ───────────────────────────────────────────

  function handleToggleCollapse(key: string) {
    if (collapsedNodes.has(key)) {
      // Collapsed → Expanded (also clear partial)
      setCollapsedNodes((prev) => { const next = new Set(prev); next.delete(key); return next; });
      setPartialNodes((prev) => { const next = new Set(prev); next.delete(key); return next; });
    } else if (partialNodes.has(key)) {
      // Partial → Expanded (show all siblings)
      setPartialNodes((prev) => { const next = new Set(prev); next.delete(key); return next; });
    } else {
      // Expanded → Collapsed
      setCollapsedNodes((prev) => { const next = new Set(prev); next.add(key); return next; });
      setPartialNodes((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  }

  function collectAllKeys(line: MoveNode[], prefix: string): string[] {
    const keys: string[] = [];
    for (let i = 0; i < line.length; i++) {
      const node = line[i];
      const nodeKey = `${prefix}-${i}`;
      if (node.variations.length > 0) {
        keys.push(nodeKey);
        for (let vi = 0; vi < node.variations.length; vi++) {
          keys.push(...collectAllKeys(node.variations[vi], `${nodeKey}-v${vi}`));
        }
      }
    }
    return keys;
  }

  function handleExpandAll() {
    setCollapsedNodes(new Set());
    setPartialNodes(new Set());
  }

  // Find node keys that must stay expanded to keep the active line visible
  function collectPathKeys(target: MoveNode[], line: MoveNode[], prefix: string): string[] | null {
    if (target === line) return [];
    for (let i = 0; i < line.length; i++) {
      const nodeKey = `${prefix}-${i}`;
      for (let vi = 0; vi < line[i].variations.length; vi++) {
        const deeper = collectPathKeys(target, line[i].variations[vi], `${nodeKey}-v${vi}`);
        if (deeper !== null) return [nodeKey, ...deeper];
      }
    }
    return null;
  }

  function handleCollapseAll() {
    if (!annotatedGame) return;
    const allKeys = collectAllKeys(annotatedGame.mainLine, "m");
    const pathKeys = new Set(collectPathKeys(activeLine, annotatedGame.mainLine, "m") ?? []);
    // Path nodes become partial (showing only on-path variation), rest become collapsed
    setCollapsedNodes(new Set(allKeys.filter(k => !pathKeys.has(k))));
    setPartialNodes(new Set(pathKeys));
  }

  function collectLineKeys(line: MoveNode[], prefix: string): string[] {
    const keys: string[] = [];
    for (let i = 0; i < line.length; i++) {
      const nodeKey = `${prefix}-${i}`;
      if (line[i].variations.length > 0) keys.push(nodeKey);
    }
    return keys;
  }

  // Find the path prefix for the active line by searching the tree
  function findLinePrefix(target: MoveNode[], line: MoveNode[], prefix: string): string | null {
    if (target === line) return prefix;
    for (let i = 0; i < line.length; i++) {
      for (let vi = 0; vi < line[i].variations.length; vi++) {
        const result = findLinePrefix(target, line[i].variations[vi], `${prefix}-${i}-v${vi}`);
        if (result) return result;
      }
    }
    return null;
  }

  function handleExpandSubVariations() {
    if (!annotatedGame) return;
    const prefix = findLinePrefix(activeLine, annotatedGame.mainLine, "m");
    if (!prefix) return;
    const keys = collectLineKeys(activeLine, prefix);
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
  }

  function handleCollapseSubVariations() {
    if (!annotatedGame) return;
    const prefix = findLinePrefix(activeLine, annotatedGame.mainLine, "m");
    if (!prefix) return;
    const keys = collectLineKeys(activeLine, prefix);
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
  }

  // Open variation choice modal for the move at activeLine[moveArrayIndex]
  function openVarChoiceForNext(currentActiveIndex: number) {
    const node = activeLine[currentActiveIndex]; // the move that has variations
    if (!node) return;

    function moveLabel(n: MoveNode): string {
      const num = getMoveNum(n);
      const prefix = n.color === "w" ? `${num}.` : `${num}...`;
      return prefix + n.san + (n.annotations.nag ?? "");
    }

    const choices: { label: string; line: MoveNode[]; index: number }[] = [
      { label: moveLabel(node), line: activeLine, index: currentActiveIndex + 1 },
    ];
    for (const variation of node.variations) {
      if (variation.length > 0) {
        choices.push({
          label: moveLabel(variation[0]),
          line: variation,
          index: 1,
        });
      }
    }
    setVarChoice({ choices, selected: 0 });
  }

  function confirmVarChoice() {
    if (!varChoice) return;
    const choice = varChoice.choices[varChoice.selected];
    if (choice.line !== activeLine) {
      handleNavigateToVariation(choice.line, choice.index);
    } else {
      setActiveIndex(choice.index);
    }
    setVarChoice(null);
  }

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Edit mode steals arrow keys for cursor navigation. Skip when an
      // overlay (gate / overwrite / promotion) is open so it can handle them.
      if (movesEditor.active && !movesEditor.needsClobberAck && !movesEditor.pendingOverwrite && !movesEditor.pendingPromotion) {
        // Ctrl/Cmd+Z = undo; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y = redo.
        if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
          if (movesEditor.canUndo) { e.preventDefault(); movesEditor.undo(); }
          return;
        }
        if ((e.ctrlKey || e.metaKey) && ((e.key === "z" || e.key === "Z") && e.shiftKey || e.key === "y" || e.key === "Y")) {
          if (movesEditor.canRedo) { e.preventDefault(); movesEditor.redo(); }
          return;
        }
        if (e.key === "ArrowLeft")  { e.preventDefault(); movesEditor.setCursor(Math.max(0, movesEditor.cursor - 1)); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); movesEditor.setCursor(Math.min(movesEditor.moves.length, movesEditor.cursor + 1)); return; }
        if (e.key === "ArrowUp")    { e.preventDefault(); movesEditor.setCursor(0); return; }
        if (e.key === "ArrowDown")  { e.preventDefault(); movesEditor.setCursor(movesEditor.moves.length); return; }
        if (e.key === "Escape")     { e.preventDefault(); movesEditor.cancel(); return; }
        return;
      }

      // Variation choice modal is open
      if (varChoice) {
        e.preventDefault();
        if (e.key === "ArrowUp") {
          setVarChoice({ ...varChoice, selected: Math.max(0, varChoice.selected - 1) });
        } else if (e.key === "ArrowDown") {
          setVarChoice({ ...varChoice, selected: Math.min(varChoice.choices.length - 1, varChoice.selected + 1) });
        } else if (e.key === "ArrowRight" || e.key === "Enter") {
          confirmVarChoice();
        } else if (e.key === "Escape" || e.key === "ArrowLeft") {
          setVarChoice(null);
        }
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (useAnnotated && effectiveIndex <= 1 && breadcrumbs.length > 0) {
          handleBackToMainLine();
        } else {
          goTo(effectiveIndex - 1);
        }
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        // Check if the next move has variations — if so, show choice modal before advancing
        if (useAnnotated && effectiveIndex < activeLine.length) {
          const nextNode = activeLine[effectiveIndex]; // the move about to be played
          if (nextNode.variations.length > 0) {
            // Present choice: nextNode (main) vs its variations
            openVarChoiceForNext(effectiveIndex);
            return;
          }
        }
        goTo(effectiveIndex + 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [effectiveIndex, goTo, varChoice, useAnnotated, activeLine, movesEditor.active, movesEditor.needsClobberAck, movesEditor.pendingOverwrite, movesEditor.pendingPromotion, movesEditor.cursor, movesEditor.moves.length, movesEditor.canUndo, movesEditor.canRedo]);

  // ── Board annotations ──────────────────────────────────────────────────

  const lastMoveSquares: Record<string, React.CSSProperties> = {};
  const prevNode = useAnnotated
    ? (activeIndex > 0 ? activeLine[activeIndex - 1] : null)
    : null;

  if (useAnnotated && prevNode) {
    // Get the FEN before this move
    const prevFen = activeIndex >= 2 ? activeLine[activeIndex - 2].fen : annotatedGame!.startFen;
    try {
      const chess = new Chess();
      chess.load(prevFen);
      const verbose = chess.moves({ verbose: true });
      const played = verbose.find((m) => m.san === prevNode.san);
      if (played) {
        const highlight: React.CSSProperties = { background: "rgba(100, 160, 255, 0.35)" };
        lastMoveSquares[played.from] = highlight;
        lastMoveSquares[played.to] = highlight;
      }
    } catch { /* ignore */ }
  } else if (!useAnnotated && currentIndex > 0 && moves[currentIndex - 1]) {
    const chess = new Chess();
    const prevFen = fens[currentIndex - 1];
    chess.load(prevFen);
    const verbose = chess.moves({ verbose: true });
    const played = verbose.find((m) => m.san === moves[currentIndex - 1].san);
    if (played) {
      const highlight: React.CSSProperties = { background: "rgba(100, 160, 255, 0.35)" };
      lastMoveSquares[played.from] = highlight;
      lastMoveSquares[played.to] = highlight;
    }
  }

  // Editor highlight: selected square + legal-destination dots. Using a
  // radial-gradient on empty squares mirrors the standard "legal-move" hint
  // (small dot in the centre); on occupied squares we use an inset ring so
  // capturable pieces stay visible.
  const editorSquareStyles: Record<string, React.CSSProperties> = useMemo(() => {
    if (!movesEditor.active || !movesEditor.selectedSquare) return {};
    const styles: Record<string, React.CSSProperties> = {
      [movesEditor.selectedSquare]: { background: "rgba(255, 215, 0, 0.45)" },
    };
    let board: Chess | null = null;
    try { board = new Chess(movesEditor.fen); } catch { board = null; }
    for (const sq of movesEditor.legalDestinations) {
      const occupied = board ? !!board.get(sq as never) : false;
      styles[sq] = occupied
        ? { boxShadow: "inset 0 0 0 4px rgba(0,0,0,0.45)" }
        : { background: "radial-gradient(circle, rgba(0,0,0,0.35) 18%, transparent 22%)" };
    }
    return styles;
  }, [movesEditor.active, movesEditor.selectedSquare, movesEditor.legalDestinations, movesEditor.fen]);


  // Arrows from annotations
  // Current annotation text for the panel
  const currentAnnotationText = useMemo(() => {
    if (!useAnnotated) return null;
    if (activeIndex === 0) return annotatedGame?.startComment ?? null;
    return currentMoveNode?.annotations.comment ?? null;
  }, [useAnnotated, activeIndex, annotatedGame, currentMoveNode]);

  const annotationArrows: CalArrow[] = useMemo(() => {
    const source = useAnnotated && activeIndex === 0
      ? annotatedGame?.startAnnotations?.arrows
      : currentMoveNode?.annotations.arrows;
    return source ?? [];
  }, [useAnnotated, activeIndex, currentMoveNode, annotatedGame]);

  const annotationCircles: CslCircle[] = useMemo(() => {
    const source = useAnnotated && activeIndex === 0
      ? annotatedGame?.startAnnotations?.circles
      : currentMoveNode?.annotations.circles;
    return source ?? [];
  }, [useAnnotated, activeIndex, currentMoveNode, annotatedGame]);

  // ── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md bg-surface">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-error text-body-md bg-surface">
        {error}
      </div>
    );
  }

  if (!detail) return null;

  return (
    <div className="flex flex-1 overflow-hidden bg-surface">
      {/* Board area */}
      <div className="flex flex-col flex-1 overflow-hidden p-3 gap-3">
        {/* Game header */}
        <div className="shrink-0">
          {onBackToPosition && (
            <button
              onClick={onBackToPosition}
              className="text-body-sm text-on-surface-variant hover:text-on-surface transition-colors duration-short3 ease-standard mb-1.5 flex items-center gap-1"
            >
              ←{" "}
              <span className="font-mono">
                {moveSequence && moveSequence.length > 0
                  ? formatMoveSequence(moveSequence)
                  : "Starting position"}
              </span>
              <span className="ml-1 text-outline font-sans">[Tab]</span>
            </button>
          )}
          <div className="text-title-md text-on-surface">
            {detail.white}{detail.white_elo ? ` (${detail.white_elo})` : ""}{" "}
            <span className="text-on-surface-variant">vs</span>{" "}
            {detail.black}{detail.black_elo ? ` (${detail.black_elo})` : ""}
          </div>
          <div className="text-body-sm text-on-surface-variant mt-0.5 flex gap-2 items-center">
            {detail.event && <span>{detail.event}</span>}
            {detail.date && <span>{detail.date.slice(0, 10)}</span>}
            {detail.result && <span className="text-on-surface">{detail.result === "1/2-1/2" ? "½-½" : detail.result}</span>}
          </div>
        </div>

        {/* Action toolbar — always visible (when not in moves-editor mode), so
            the user doesn't need to expand Details to access game actions. */}
        {!movesEditor.active && (
          <GameActionsBar
            detail={detail}
            onDetailChanged={() => { setDetailReloadKey((k) => k + 1); onGameMutated?.(); }}
            onStartEditMoves={() => {
              if (annotatedGame) movesEditor.start(annotatedGame.mainLine, activeIndex);
            }}
            detailsOpen={detailsOpen}
            onToggleDetails={() => setDetailsOpen((o) => !o)}
          />
        )}

        {/* Details panel — purely informational, collapsible. Renders the
            soft-deleted banner, badges, and the full tag grid. */}
        {detailsOpen && !movesEditor.active && (
          <DetailsPanel
            detail={detail}
            onClose={() => setDetailsOpen(false)}
            onDetailChanged={() => { setDetailReloadKey((k) => k + 1); onGameMutated?.(); }}
          />
        )}

        {/* Edit-mode banner — M3 prominent banner using primary-container */}
        {movesEditor.active && (
          <div className="shrink-0 flex items-center gap-3 px-4 py-3 rounded-md bg-primary-container text-on-primary-container text-body-sm">
            <span className="flex-1 min-w-0">
              <span className="font-medium">Editing moves.</span>{" "}
              <span className="opacity-80">
                Drag, or click source then destination, to play. Click a move in the side panel to position the cursor.
              </span>
            </span>
            {/* Text button on the container */}
            <button
              onClick={movesEditor.cancel}
              disabled={movesEditor.saving}
              className="h-8 px-3 inline-flex items-center rounded-full text-on-primary-container text-label-md hover:bg-on-primary-container/10 active:bg-on-primary-container/15 disabled:opacity-50 transition-colors duration-short3 ease-standard"
              title="Exit without saving"
            >
              Discard
            </button>
            {/* Filled button — primary on container */}
            <button
              onClick={movesEditor.save}
              disabled={movesEditor.saving}
              className="h-8 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard"
              title="Save and switch back to read-only"
            >
              {movesEditor.saving ? "Saving…" : "Done"}
            </button>
          </div>
        )}

        {/* Board */}
        <div ref={boardContainerRef} className="flex-1 min-h-0 min-w-0 overflow-hidden flex items-center justify-center relative">
          <div
            style={{ width: squareSize, height: squareSize, flexShrink: 0, position: "relative" }}
            onPointerDown={(e) => {
              if (!movesEditor.active) return;
              if (movesEditor.pendingOverwrite || movesEditor.pendingPromotion || movesEditor.needsClobberAck) return;
              const sq = resolveSquareFromPointer(e, flipped);
              if (!sq) return;
              if (!movesEditor.shouldHandleAsDestination(sq)) return;
              // Cheap legality check — pickSourceFor returns null when no
              // legal move at all lands on this square, regardless of DB.
              if (!movesEditor.pickSourceFor(sq)) return;
              movesEditor.requestPreview(sq);
              oneClickPressedRef.current = true;
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
              // Prevent the synthesised click that would otherwise fire onSquareClick
              // and select the destination square as a source after our commit.
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              // Only follow the cursor while the user is still pressing —
              // after release, the gesture may stay "active" (silent wait
              // for DB data) but the user is no longer aiming.
              if (!oneClickPressedRef.current) return;
              if (!movesEditor.gestureActive) return;
              const sq = resolveSquareFromPointer(e, flipped);
              if (!sq) { movesEditor.clearPreview(); return; }
              movesEditor.dragTo(sq);
            }}
            onPointerUp={(e) => {
              if (!oneClickPressedRef.current) return;
              oneClickPressedRef.current = false;
              if (!movesEditor.gestureActive) return;
              const sq = resolveSquareFromPointer(e, flipped);
              if (!sq) { movesEditor.clearPreview(); return; }
              movesEditor.commitPreview();
            }}
            onPointerCancel={() => { oneClickPressedRef.current = false; movesEditor.clearPreview(); }}
          >
            <Chessboard
              options={{
                position: currentFen,
                boardOrientation: flipped ? "black" : "white",
                allowDragging: movesEditor.active && !movesEditor.pendingOverwrite && !movesEditor.pendingPromotion && !movesEditor.needsClobberAck,
                squareStyles: movesEditor.active ? editorSquareStyles : lastMoveSquares,
                allowDrawingArrows: false,
                darkSquareStyle: { backgroundColor: "var(--color-board-game-dark)" },
                lightSquareStyle: { backgroundColor: "var(--color-board-game-light)" },
                boardStyle: { alignContent: "start" },
                onPieceDrop: movesEditor.active
                  ? ({ sourceSquare, targetSquare }) => {
                      if (!sourceSquare || !targetSquare) return false;
                      return movesEditor.tryMove(sourceSquare, targetSquare);
                    }
                  : undefined,
                onSquareClick: movesEditor.active
                  ? ({ square }) => movesEditor.clickSquare(square)
                  : undefined,
              }}
            />
            {/* Custom annotation overlay (arrows + circles) — hidden during edit */}
            {!movesEditor.active && (annotationArrows.length > 0 || annotationCircles.length > 0) && (
              <AnnotationOverlay
                arrows={annotationArrows}
                circles={annotationCircles}
                flipped={flipped}
                size={squareSize}
              />
            )}
            {/* One-click destination preview — shown while the pointer is held */}
            {movesEditor.active && movesEditor.previewMove && (
              <AnnotationOverlay
                arrows={[{
                  from: movesEditor.previewMove.from,
                  to: movesEditor.previewMove.to,
                  color: "rgba(56, 142, 60, 0.85)",
                }]}
                circles={[]}
                flipped={flipped}
                size={squareSize}
              />
            )}

            {/* Editor overlays */}
            {movesEditor.active && movesEditor.needsClobberAck && (
              <MovesEditorAnnotationGate
                onContinue={movesEditor.ackClobber}
                onCancel={movesEditor.cancel}
              />
            )}
            {movesEditor.active && movesEditor.pendingPromotion && (
              <MovesEditorPromotionChooser
                side={movesEditor.sideToMove}
                onPick={movesEditor.commitPromotion}
                onCancel={movesEditor.cancelPromotion}
              />
            )}
            {movesEditor.active && movesEditor.pendingOverwrite && (
              <MovesEditorOverwriteConfirm
                san={movesEditor.pendingOverwrite.san}
                droppedCount={movesEditor.moves.length - movesEditor.cursor}
                onConfirm={movesEditor.commitOverwrite}
                onCancel={movesEditor.cancelOverwrite}
              />
            )}
          </div>

          {/* Variation choice menu — M3 menu surface */}
          {varChoice && !movesEditor.active && (
            <div className="absolute inset-0 flex items-center justify-center z-20">
              <div className="bg-surface-container-high rounded-md shadow-xl py-2 min-w-40">
                {varChoice.choices.map((choice, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      const choice = varChoice.choices[i];
                      if (choice.line !== activeLine) {
                        handleNavigateToVariation(choice.line, choice.index);
                      } else {
                        setActiveIndex(choice.index);
                      }
                      setVarChoice(null);
                    }}
                    className={`w-full text-left px-4 py-2 text-body-md font-mono whitespace-nowrap transition-colors duration-short3 ease-standard ${
                      i === varChoice.selected
                        ? "bg-secondary-container text-on-secondary-container"
                        : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
                    }`}
                  >
                    {choice.label}
                    {i === 0 && <span className="text-label-sm text-on-surface-variant ml-2 font-sans">(main)</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Controls — swapped for editor toolbar when editing */}
        {movesEditor.active ? (
          <MovesEditorToolbar editor={movesEditor} />
        ) : (
          <div className="shrink-0 flex items-center justify-center gap-1">
            {/* M3 icon buttons — circular with state-layer */}
            {(() => {
              const navBtn = "w-10 h-10 inline-flex items-center justify-center rounded-full text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-25 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors duration-short3 ease-standard";
              return (
                <>
                  <button onClick={() => goTo(0)} disabled={effectiveIndex === 0} className={navBtn} title="First move (↑)"><IconFirst /></button>
                  <button onClick={() => goTo(effectiveIndex - 1)} disabled={effectiveIndex === 0} className={navBtn} title="Previous move (←)"><IconPrev /></button>
                  <span className="text-label-md text-on-surface-variant w-24 text-center select-none">
                    {effectiveIndex === 0 || !currentMoveNode
                      ? "Start"
                      : `Move ${getMoveNum(currentMoveNode)} ${currentMoveNode.color === "w" ? "(W)" : "(B)"}`}
                  </span>
                  <button onClick={() => goTo(effectiveIndex + 1)} disabled={effectiveIndex === maxIndex} className={navBtn} title="Next move (→)"><IconNext /></button>
                  <button onClick={() => goTo(maxIndex)} disabled={effectiveIndex === maxIndex} className={navBtn} title="Last move (↓)"><IconLast /></button>
                  <div className="w-px h-5 bg-outline-variant mx-2" />
                  <button onClick={() => setFlipped((f) => !f)} className={navBtn} title="Flip board"><IconFlip /></button>
                </>
              );
            })()}
          </div>
        )}

        {/* Annotation panel — hidden during edit */}
        {useAnnotated && !movesEditor.active && (
          annotationPanelCollapsed ? (
            <button
              onClick={() => setAnnotationPanelCollapsed(false)}
              className="shrink-0 h-7 flex items-center justify-center gap-2 bg-surface-container-low text-on-surface-variant hover:bg-on-surface/8 transition-colors duration-short3 ease-standard text-label-md"
              title="Show annotations"
            ><span>Annotations</span> <span>▼</span></button>
          ) : (
            <div className="shrink-0 flex flex-col bg-surface-container-low rounded-md relative" style={{ height: `${annotationPanelHeight}em` }}>
              {/* Drag handle */}
              <div
                onMouseDown={handlePanelDragStart}
                className="absolute left-0 right-0 top-0 h-1 cursor-row-resize hover:bg-primary/40 z-10 transition-colors duration-short3 ease-standard"
              />
              <div className="flex items-center justify-between px-3 shrink-0">
                <span className="text-label-sm text-on-surface-variant uppercase tracking-wider select-none">Annotations</span>
                <button
                  onClick={() => setAnnotationPanelCollapsed(true)}
                  className="w-6 h-6 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 transition-colors duration-short3 ease-standard text-label-sm"
                  title="Hide annotations"
                >▲</button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 pb-2 text-body-md text-on-surface">
                {currentAnnotationText ? (
                  <span>{currentAnnotationText}</span>
                ) : (
                  <span className="text-on-surface-variant italic">No annotation for this position</span>
                )}
              </div>
            </div>
          )
        )}
      </div>

      {/* Move list — sidebar, tonal step from board area */}
      <div
        className="shrink-0 flex flex-col bg-surface-container-low overflow-hidden py-2 relative"
        style={{ width: moveListWidth }}
      >
        {/* Drag handle */}
        <div
          onMouseDown={handleDragStart}
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/40 z-10 transition-colors duration-short3 ease-standard"
        />
        {movesEditor.active ? (
          <MovesEditorRightPanel editor={movesEditor} />
        ) : useAnnotated ? (
          <AnnotatedMoveList
            game={annotatedGame!}
            activeLine={activeLine}
            activeIndex={activeIndex}
            showAnnotations={showAnnotations}
            collapsedNodes={collapsedNodes}
            partialNodes={partialNodes}
            inSubVariation={breadcrumbs.length > 0}
            breadcrumbs={breadcrumbs}
            onNavigate={handleNavigateToVariation}
            onToggleCollapse={handleToggleCollapse}
            onExpandAll={handleExpandAll}
            onCollapseAll={handleCollapseAll}
            onExpandSubVariations={handleExpandSubVariations}
            onCollapseSubVariations={handleCollapseSubVariations}
            onToggleAnnotations={() => setShowAnnotations((v) => !v)}
          />
        ) : fens.length > 0 ? (
          <MoveList moves={moves} currentIndex={currentIndex} onSelect={goTo} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md px-4 text-center">
            No PGN available
          </div>
        )}
      </div>
    </div>
  );
}
