import React, { useEffect, useMemo, useRef } from "react";
import { AnnotatedGame, MoveNode } from "../lib/parsePgnTree";
import { Breadcrumb, getMoveNum } from "../lib/moveTreeNav";
import { nagsToString } from "../lib/parseAnnotations";

// Recursive move-list renderer with full variation / comment / NAG / graphics
// display. Purely presentational: all cursor and collapse state lives in the
// host, which passes it in and receives `onNavigate` / toggle callbacks. Shared
// by the read-only PGN viewer (GameBoard) and the moves editor.

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
  /** A repertoire chapter (#327): moves switched off (their `off`, or one
   *  above them) are greyed, and a move with alternatives gets a mark. */
  offAware?: boolean;
  /** Switch the move at `index` (1-based) of `line` off or on — offered on
   *  the current move. */
  onToggleOff?: (line: MoveNode[], index: number, off: boolean) => void;
  /** The game's result, shown on its own line after the moves; nothing for
   *  "*" (unfinished or unknown) or none. */
  result?: string | null;
}

export default function AnnotatedMoveList({
  game, activeLine, activeIndex, showAnnotations, collapsedNodes, partialNodes, inSubVariation,
  breadcrumbs, onNavigate, onToggleCollapse, onExpandAll, onCollapseAll,
  onExpandSubVariations, onCollapseSubVariations, onToggleAnnotations, offAware, onToggleOff, result,
}: AnnotatedMoveListProps) {
  const activeRef = useRef<HTMLSpanElement>(null);
  // The current move's off-switch state, found while the moves are drawn; the
  // switch itself is in the toolbar.
  const found: { off: { line: MoveNode[]; index: number; own: boolean; before: boolean } | null } = { off: null };

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

  function renderLine(line: MoveNode[], pathPrefix: string, depth: number, inheritedOff = false) {
    const isActive = line === activeLine;
    const pathMaxIndex = pathMap.get(line); // undefined if not on path
    const elements: React.ReactNode[] = [];
    let needsBlackNumber = false;
    // The off-switch (#327) covers everything below a move; a variation of a
    // move inherits the state as it was before that move.
    let offNow = inheritedOff;

    for (let i = 0; i < line.length; i++) {
      const node = line[i];
      const offBefore = offNow;
      const ownOff = !!node.annotations.off;
      const nodeOff = !!offAware && (offNow || ownOff);
      if (ownOff) offNow = true;
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

      // Leading comment (line intro) — rendered before the move.
      if (node.preComment) {
        if (showAnnotations) {
          elements.push(
            <span key={`pc-${i}`} className={`italic text-body-sm font-sans ${isOnPath ? "text-primary/70" : "text-on-surface-variant"}`}>
              {node.preComment}{" "}
            </span>
          );
        } else {
          elements.push(
            <span key={`pc-${i}`} className="text-xs opacity-30 annotation-hint" title={node.preComment}>💬</span>
          );
        }
      }

      // A move with alternatives, shown (collapsed ones have the [+]).
      if (offAware && hasVariations && !isCollapsed) {
        elements.push(
          <span key={`b-${i}`} className="text-outline select-none mr-0.5" style={{ fontSize: "0.7em" }} title="Alternatives branch off here">⋔</span>
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
          // A scratch move is only on the board, not in the game (see
          // lib/scratchLine.ts), so it is drawn as a dashed, tentative thing.
          className={`cursor-pointer rounded-sm transition-colors duration-short3 ease-standard ${
            node.scratch ? "italic underline decoration-dashed underline-offset-2 " : ""
          }${nodeOff ? "opacity-45 " : ""}${
            isCurrentMove
              ? "bg-primary-container text-on-primary-container px-0.5"
              : isOnPath
              ? "text-primary"
              : "text-on-surface hover:bg-on-surface/8"
          }`}
          title={node.scratch ? "Played on the board only — not saved in the game" : nodeOff ? (ownOff ? "Switched off: not in the active repertoire from here" : "Not in the active repertoire — a move above is switched off") : undefined}
        >
          {numPrefix}{node.san}{nagsToString(node.annotations.nags)}
        </span>
      );
      if (isCurrentMove && !node.scratch) found.off = { line, index: moveIdx, own: !!ownOff, before: !!offBefore };

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
          const isShort = variation.length <= 3 && variation.every(n => n.variations.length === 0 && !n.annotations.comment && !n.preComment);

          if (isShort) {
            shortVars.push(
              <span key={`v-${i}-${vi}`} className="text-on-surface-variant text-body-sm">
                {"( "}
                {renderLine(variation, varPath, depth + 1, offBefore)}
                {") "}
              </span>
            );
          } else {
            blockVars.push(
              <div key={`v-${i}-${vi}`} className="text-body-sm text-on-surface-variant leading-normal">
                {renderLine(variation, varPath, depth + 1, offBefore)}
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
          const toggleLabel = isPartial ? "…" : "−"; // … or −
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
        {result && result !== "*" && (
          <div className="mt-1 text-on-surface">{result === "1/2-1/2" ? "½-½" : result}</div>
        )}
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
        {onToggleOff && (() => {
          // The off-switch for the current move: its own, or "On" to undo it.
          // A move off through one above it has its switch there.
          const t = found.off;
          const usable = !!t && (t.own || !t.before);
          return (
            <button
              onClick={() => t && usable && onToggleOff(t.line, t.index, !t.own)}
              disabled={!usable}
              className={`${miniBtn} ml-auto`}
              title={!t ? "Go to a move to switch it off"
                : t.own ? "Switch this move back on"
                : t.before ? "Off already — a move above is switched off; switch it on there"
                : "Switch off: not in my repertoire from here"}
            >{t?.own ? "On" : "Off"}</button>
          );
        })()}
      </div>
    </div>
  );
}
