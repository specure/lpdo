// Shared navigation helpers for the variation tree (`MoveNode[]` lines).
//
// The PGN viewer (GameBoard) and the moves editor both need to address a
// position that may live inside a nested variation. They use the same
// path-aware cursor model: an `activeLine` (a reference to the main line or a
// variation array) + an `activeIndex` (0 = start of the line, 1 = after its
// first move) + a `breadcrumbs` stack recording the parent lines and the index
// of the branching move in each. These pure helpers operate on that model so
// both call sites share one implementation.

import type { AnnotatedGame, MoveNode } from "./parsePgnTree";

export interface Breadcrumb {
  line: MoveNode[];
  /** Index of the branching move in `line` (the move that owns the variation
   *  we descended into). The branching move itself is NOT on the descended
   *  path — the variation is an alternative to it. */
  index: number;
}

/** Full-move number to display for a node, derived from its FEN. */
export function getMoveNum(node: MoveNode): number {
  const fullmove = parseInt(node.fen.split(" ")[5], 10);
  return node.color === "w" ? fullmove : fullmove - 1;
}

/** Path of breadcrumbs from `root` down to `target` (a variation line), or null
 *  if `target` isn't reachable. `[]` when `target === root`. */
export function findPathToLine(root: MoveNode[], target: MoveNode[]): Breadcrumb[] | null {
  if (root === target) return [];
  for (let i = 0; i < root.length; i++) {
    for (const variation of root[i].variations) {
      if (variation === target) {
        return [{ line: root, index: i }];
      }
      const deeper = findPathToLine(variation, target);
      if (deeper) {
        return [{ line: root, index: i }, ...deeper];
      }
    }
  }
  return null;
}

/** Resolve a navigation to (line, index) into the full path-aware cursor. */
export function navigateTo(
  root: MoveNode[],
  line: MoveNode[],
  index: number,
): { activeLine: MoveNode[]; activeIndex: number; breadcrumbs: Breadcrumb[] } {
  return {
    activeLine: line,
    activeIndex: index,
    breadcrumbs: findPathToLine(root, line) ?? [],
  };
}

/** A serializable descent path from a root line to a target line: at each step,
 *  the index of the branching node and which of its variations to enter. Unlike
 *  `Breadcrumb` (which holds live array references), this survives a deep clone
 *  of the tree and can be re-resolved against the clone — used for undo/redo. */
export interface PathStep {
  node: number;
  varIdx: number;
}

/** Descent steps from `root` to `target`, or null if unreachable. `[]` when
 *  `target === root`. */
export function pathSteps(root: MoveNode[], target: MoveNode[]): PathStep[] | null {
  if (root === target) return [];
  for (let i = 0; i < root.length; i++) {
    for (let v = 0; v < root[i].variations.length; v++) {
      const variation = root[i].variations[v];
      if (variation === target) return [{ node: i, varIdx: v }];
      const deeper = pathSteps(variation, target);
      if (deeper) return [{ node: i, varIdx: v }, ...deeper];
    }
  }
  return null;
}

/** Walk `steps` from `root`, returning the target line and the breadcrumb stack
 *  along the way. Inverse of `pathSteps`; safe to run against a freshly cloned
 *  tree to re-resolve identities. */
export function resolvePath(
  root: MoveNode[],
  steps: PathStep[],
): { line: MoveNode[]; breadcrumbs: Breadcrumb[] } {
  let line = root;
  const breadcrumbs: Breadcrumb[] = [];
  for (const s of steps) {
    breadcrumbs.push({ line, index: s.node });
    line = line[s.node].variations[s.varIdx];
  }
  return { line, breadcrumbs };
}

/** Pop one breadcrumb — moves the cursor back to the parent line at the
 *  branching move. Returns null when already on the main line. */
export function backToParent(
  breadcrumbs: Breadcrumb[],
): { activeLine: MoveNode[]; activeIndex: number; breadcrumbs: Breadcrumb[] } | null {
  if (breadcrumbs.length === 0) return null;
  const bc = breadcrumbs[breadcrumbs.length - 1];
  return { activeLine: bc.line, activeIndex: bc.index, breadcrumbs: breadcrumbs.slice(0, -1) };
}

/** FEN at position `index` of `line` (the position *after* `index` half-moves
 *  of the line). `index === 0` yields the line's starting position: the game
 *  start FEN on the main line, or — inside a variation — the position before
 *  the branching move it replaces. */
export function fenAt(
  game: AnnotatedGame,
  breadcrumbs: Breadcrumb[],
  line: MoveNode[],
  index: number,
): string {
  if (index > 0) return line[index - 1]?.fen ?? game.startFen;
  if (breadcrumbs.length === 0) return game.startFen;
  const bc = breadcrumbs[breadcrumbs.length - 1];
  return bc.line[bc.index - 1]?.fen ?? game.startFen;
}

// ── Collapse-state key helpers (variation expand/collapse) ────────────────────

/** Keys of every node that owns at least one variation, recursing into them. */
export function collectAllKeys(line: MoveNode[], prefix: string): string[] {
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

/** Node keys that must stay expanded to keep `target` visible, or null. */
export function collectPathKeys(target: MoveNode[], line: MoveNode[], prefix: string): string[] | null {
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

/** Keys of the variation-owning nodes directly on `line` (non-recursive). */
export function collectLineKeys(line: MoveNode[], prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i].variations.length > 0) keys.push(`${prefix}-${i}`);
  }
  return keys;
}

/** Find the collapse-key prefix for `target` by searching the tree. */
export function findLinePrefix(target: MoveNode[], line: MoveNode[], prefix: string): string | null {
  if (target === line) return prefix;
  for (let i = 0; i < line.length; i++) {
    for (let vi = 0; vi < line[i].variations.length; vi++) {
      const result = findLinePrefix(target, line[i].variations[vi], `${prefix}-${i}-v${vi}`);
      if (result) return result;
    }
  }
  return null;
}
