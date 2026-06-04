// Inline moves-editor used by GameBoard. The host renders the board and side
// panel; this module owns:
//   - the editor state machine: a working copy of the game's move tree
//     (AnnotatedGame) navigated with a path-aware cursor (activeLine +
//     activeIndex + breadcrumbs), shared with the read-only viewer's model.
//   - handlers (try-move, the divergence flow, delete-from-here, save).
//   - the small UI pieces that overlay the host (toolbar, move list, promotion
//     chooser, divergence chooser).
//
// Editing is lossless: variations, comments, NAGs and arrows on the loaded game
// are preserved (a deep clone is edited and serialised back to PGN movetext).

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnnotatedGame, MoveNode } from "../lib/parsePgnTree";
import {
  Breadcrumb,
  backToParent,
  collectAllKeys,
  collectLineKeys,
  collectPathKeys,
  fenAt,
  findLinePrefix,
  navigateTo,
  pathSteps,
  resolvePath,
} from "../lib/moveTreeNav";
import { serializeMovetext } from "../lib/serializeMovetext";
import { MoveStats } from "../types";
import AnnotatedMoveList from "./AnnotatedMoveList";

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface MovesEditor {
  /** True when editing — host swaps the board / panel into edit mode. */
  active: boolean;
  /** Working copy of the move tree under edit (null when inactive). */
  game: AnnotatedGame | null;
  /** Line currently being edited (main line or a variation array). */
  activeLine: MoveNode[];
  /** Half-move cursor 0..activeLine.length within `activeLine`. */
  activeIndex: number;
  /** Stack of parent lines from the main line down to `activeLine`. */
  breadcrumbs: Breadcrumb[];
  /** FEN at the cursor — used as the board's `position`. */
  fen: string;
  /** Side to move at cursor. */
  sideToMove: "w" | "b";
  /** Pending mid-line divergence awaiting the new-variation / new-main-line /
   *  overwrite choice. */
  pendingDivergence: { san: string; node: MoveNode } | null;
  /** Pending pawn promotion — board awaits piece choice. */
  pendingPromotion: { from: string; to: string } | null;
  saving: boolean;
  error: string | null;
  /** True once any edit has been made (used to gate autosave-on-switch). */
  dirty: boolean;
  /** Trailing comment of the move at the cursor ("" at a line start). */
  moveComment: string;
  /** Intro comment of the current line (game start comment / variation intro). */
  lineComment: string;
  /** Set (blank clears) the trailing comment of the move at the cursor. */
  setMoveComment(text: string): void;
  /** Set (blank clears) the current line's intro comment. */
  setLineComment(text: string): void;

  // ── Click-to-move state ──────────────────────────────────────────────────
  /** Square currently selected via click (null = none). */
  selectedSquare: string | null;
  /** Legal destination squares from `selectedSquare` (empty when none). */
  legalDestinations: string[];

  // ── One-click destination state ──────────────────────────────────────────
  /** Transient move shown as an arrow while the pointer is held over a
   *  destination square. Committed on release. */
  previewMove: { from: string; to: string } | null;
  /** True iff a mousedown on `square` should kick off the one-click flow
   *  (no source pre-selected; square is empty or holds an opponent piece). */
  shouldHandleAsDestination(square: string): boolean;
  /** Best-source heuristic for the given destination. */
  pickSourceFor(square: string): string | null;
  /** Begin a one-click gesture for `square`. */
  requestPreview(square: string): void;
  clearPreview(): void;
  /** End the gesture — plays immediately if an arrow is shown, else when the
   *  DB popularity data lands. */
  commitPreview(): void;
  /** True while a gesture is active (visible arrow OR silent wait). */
  gestureActive: boolean;
  /** Update the gesture as the pointer moves to `sq`. */
  dragTo(sq: string): void;
  /** Warm the position-moves cache for `fen` without touching editor state. */
  prefetchPositionMoves(fen: string): void;

  // ── Undo / Redo ──────────────────────────────────────────────────────────
  canUndo: boolean;
  canRedo: boolean;

  /** Begin editing the given game, positioned at (line, index, breadcrumbs).
   *  The game is deep-cloned so the viewer's tree is never mutated. */
  start(game: AnnotatedGame, line: MoveNode[], index: number, breadcrumbs: Breadcrumb[]): void;
  cancel(): void;
  /** Jump the cursor to (line, index), entering a variation if needed. */
  navigate(line: MoveNode[], index: number): void;
  /** Move the cursor up/down within the current line (clamped). */
  setCursor(i: number): void;
  /** Step back to the parent line (when inside a variation). */
  goBackToParent(): void;
  tryMove(from: string, to: string, promotion?: "q" | "r" | "b" | "n"): boolean;
  clickSquare(square: string): void;
  /** Resolve a pending divergence. */
  commitOverwrite(): void;
  commitNewVariation(): void;
  commitNewMainLine(): void;
  cancelDivergence(): void;
  commitPromotion(piece: "q" | "r" | "b" | "n"): void;
  cancelPromotion(): void;
  deleteFromHere(): void;
  undo(): void;
  redo(): void;
  save(): void;
}

/**
 * Run `chess-db games set-moves` through the Tauri sidecar, passing the full
 * PGN movetext (with any variations) over stdin so we don't hit Windows
 * command-line length limits or special-char escaping issues. Standalone so the
 * editor's "Done" button and the GameBoard's game-switch autosave share one
 * code path. Resolves the terminal event explicitly to avoid the listen/invoke
 * race.
 */
export async function saveMovetextViaSidecar(
  gameId: number,
  movetext: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const eventId = crypto.randomUUID();
  const eventName = `chess-db:${eventId}`;
  const errs: string[] = [];
  type Terminal = { type: "done" | "error"; message?: string };
  let resolveTerminal: ((t: Terminal | null) => void) | null = null;
  const terminalPromise = new Promise<Terminal | null>((r) => { resolveTerminal = r; });

  const unlisten = await listen<string>(eventName, (event) => {
    try {
      const data = JSON.parse(event.payload);
      if (data.type === "error" && data.message) errs.push(data.message);
      if (data.type === "done" || data.type === "error") {
        resolveTerminal?.(data);
        resolveTerminal = null;
      }
    } catch {/* ignore non-JSON */}
  });

  try {
    await invoke("run_chess_db", {
      args: ["games", "set-moves", String(gameId), "--moves-stdin"],
      eventId,
      stdin: movetext,
    });
    const terminal = await Promise.race([
      terminalPromise,
      new Promise<Terminal | null>((r) => setTimeout(() => r(null), 1000)),
    ]);
    if (terminal && terminal.type === "done" && errs.length === 0) {
      return { ok: true };
    }
    return { ok: false, error: errs.join("\n") || (terminal?.message ?? "Save failed (no terminal event)") };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    unlisten();
  }
}

interface UseMovesEditorOpts {
  gameId: number | null;
  /** Fires on successful save. `focusIndex` is the main-line ply the host
   *  should restore the read-only cursor to after reload. */
  onSaved?: (focusIndex: number) => void;
}

/** A new leaf move node built from a chess.js move result. */
function makeNode(result: { san: string; color: "w" | "b" }, fenAfter: string): MoveNode {
  return { san: result.san, color: result.color, fen: fenAfter, annotations: {}, variations: [] };
}

export function useMovesEditor({ gameId, onSaved }: UseMovesEditorOpts): MovesEditor {
  const [active, setActive] = useState(false);
  const [game, setGame] = useState<AnnotatedGame | null>(null);
  const [activeLine, setActiveLine] = useState<MoveNode[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [pendingDivergence, setPendingDivergence] = useState<{ san: string; node: MoveNode } | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: string; to: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Undo / redo: each snapshot is a deep clone of the working tree plus a
  // serialisable path to the cursor, so restoring never shares array
  // identities with the live tree.
  type Snapshot = { game: AnnotatedGame; path: ReturnType<typeof pathSteps>; activeIndex: number };
  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);

  const fen = useMemo(
    () => (active && game ? fenAt(game, breadcrumbs, activeLine, activeIndex) : ""),
    [active, game, breadcrumbs, activeLine, activeIndex],
  );
  const sideToMove = useMemo<"w" | "b">(() => {
    if (!active || !fen) return "w";
    try { return new Chess(fen).turn(); } catch { return "w"; }
  }, [active, fen]);

  const legalDestinations = useMemo<string[]>(() => {
    if (!active || !selectedSquare || !fen) return [];
    try {
      const c = new Chess(fen);
      return c.moves({ square: selectedSquare as never, verbose: true }).map((m) => m.to as string);
    } catch {
      return [];
    }
  }, [active, selectedSquare, fen]);

  // Two distinct comment slots for the current position:
  //  - moveComment: the trailing comment of the move at the cursor ("" at a line start).
  //  - lineComment: the current line's intro — the game's leading comment on the
  //    main line, or the variation's first-move preComment inside a variation.
  const moveComment = useMemo<string>(
    () => (active && activeIndex > 0 ? activeLine[activeIndex - 1]?.annotations.comment ?? "" : ""),
    [active, activeLine, activeIndex],
  );
  const lineComment = useMemo<string>(() => {
    if (!active || !game) return "";
    return breadcrumbs.length === 0 ? game.startComment ?? "" : activeLine[0]?.preComment ?? "";
  }, [active, game, activeLine, breadcrumbs]);

  // Selection / preview must not survive a position change.
  useEffect(() => { setSelectedSquare(null); }, [activeLine, activeIndex, breadcrumbs, pendingDivergence, pendingPromotion]);

  // ── One-click destination ───────────────────────────────────────────────
  const [previewMove, setPreviewMove] = useState<{ from: string; to: string } | null>(null);
  const [pendingDest, setPendingDest] = useState<{ sq: string; committed: boolean } | null>(null);
  const [positionMovesData, setPositionMovesData] = useState<{ fen: string; moves: MoveStats[] } | null>(null);
  const positionMovesCacheRef = useRef<Map<string, MoveStats[]>>(new Map());
  const positionMoves: MoveStats[] = positionMovesData?.fen === fen ? positionMovesData.moves : [];
  const positionMovesLoading = active && fen !== "" && positionMovesData?.fen !== fen;

  useEffect(() => {
    setPreviewMove(null);
    setPendingDest(null);
  }, [activeLine, activeIndex, breadcrumbs, pendingDivergence, pendingPromotion]);

  useEffect(() => {
    if (!active || !fen) return;
    const cached = positionMovesCacheRef.current.get(fen);
    if (cached) { setPositionMovesData({ fen, moves: cached }); return; }
    const ctrl = new AbortController();
    fetch(`/api/position/moves?fen=${encodeURIComponent(fen)}`, { signal: ctrl.signal })
      .then((r) => r.ok ? (r.json() as Promise<MoveStats[]>) : Promise.resolve([] as MoveStats[]))
      .then((data) => {
        positionMovesCacheRef.current.set(fen, data);
        setPositionMovesData({ fen, moves: data });
      })
      .catch(() => { /* abort or network — leave previous list, harmless */ });
    return () => ctrl.abort();
  }, [active, fen]);

  const prefetchInFlightRef = useRef<Set<string>>(new Set());
  function prefetchPositionMoves(fenStr: string) {
    if (!fenStr) return;
    if (positionMovesCacheRef.current.has(fenStr)) return;
    if (prefetchInFlightRef.current.has(fenStr)) return;
    prefetchInFlightRef.current.add(fenStr);
    fetch(`/api/position/moves?fen=${encodeURIComponent(fenStr)}`)
      .then((r) => r.ok ? (r.json() as Promise<MoveStats[]>) : null)
      .then((data) => {
        if (data) positionMovesCacheRef.current.set(fenStr, data);
      })
      .catch(() => { /* fire-and-forget — ignore */ })
      .finally(() => { prefetchInFlightRef.current.delete(fenStr); });
  }

  function shouldHandleAsDestination(square: string): boolean {
    if (!active) return false;
    if (selectedSquare !== null) return false;
    try {
      const c = new Chess(fen);
      const piece = c.get(square as never);
      if (!piece) return true;
      return piece.color !== c.turn();
    } catch { return false; }
  }

  function pickSourceFor(square: string): string | null {
    if (!active) return null;
    let candidates: { from: string; san: string }[];
    try {
      const c = new Chess(fen);
      candidates = c.moves({ verbose: true })
        .filter((m) => m.to === square)
        .map((m) => ({ from: m.from as string, san: m.san as string }));
    } catch { return null; }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].from;
    const popularity = new Map(positionMoves.map((s) => [s.mv, s.games]));
    candidates.sort((a, b) => {
      const popA = popularity.get(a.san) ?? -1;
      const popB = popularity.get(b.san) ?? -1;
      if (popA !== popB) return popB - popA;
      return a.from.localeCompare(b.from);
    });
    return candidates[0].from;
  }

  function countLegalSourcesFor(square: string): number {
    if (!active) return 0;
    try {
      const c = new Chess(fen);
      return c.moves({ verbose: true }).filter((m) => m.to === square).length;
    } catch { return 0; }
  }

  function isLegalSourceFor(src: string, dest: string): boolean {
    if (!active) return false;
    try {
      const c = new Chess(fen);
      return c.moves({ verbose: true }).some((m) => m.from === src && m.to === dest);
    } catch { return false; }
  }

  function dragTo(sq: string) {
    if (!active) return;
    const currentDest = previewMove?.to ?? pendingDest?.sq ?? null;
    if (!currentDest) return;
    if (sq === currentDest) return;
    if (sq === previewMove?.from) return;
    if (isLegalSourceFor(sq, currentDest)) {
      setPendingDest(null);
      setPreviewMove({ from: sq, to: currentDest });
      return;
    }
  }

  function requestPreview(square: string) {
    if (!active) return;
    const n = countLegalSourcesFor(square);
    if (n === 0) {
      setPreviewMove(null);
      setPendingDest(null);
      return;
    }
    if (n === 1 || !positionMovesLoading) {
      const src = pickSourceFor(square);
      setPendingDest(null);
      if (src) setPreviewMove({ from: src, to: square });
      else setPreviewMove(null);
      return;
    }
    setPreviewMove(null);
    setPendingDest({ sq: square, committed: false });
  }

  function commitPreview() {
    if (previewMove) {
      const { from, to } = previewMove;
      setPreviewMove(null);
      setPendingDest(null);
      tryMove(from, to);
      return;
    }
    if (pendingDest && !pendingDest.committed) {
      setPendingDest({ sq: pendingDest.sq, committed: true });
    }
  }

  useEffect(() => {
    if (positionMovesLoading) return;
    if (!pendingDest) return;
    const { sq, committed } = pendingDest;
    const src = pickSourceFor(sq);
    if (!src) { setPendingDest(null); return; }
    setPendingDest(null);
    if (committed) tryMove(src, sq);
    else setPreviewMove({ from: src, to: sq });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionMovesLoading, positionMovesData, pendingDest]);

  // ── Tree editing core ─────────────────────────────────────────────────────

  /** Apply a structural edit: snapshot the current tree for undo, deep-clone it,
   *  re-resolve the cursor path in the clone, run `fn` to mutate it, and commit
   *  the new state. `fn` receives the cloned line/index/breadcrumbs and returns
   *  the cursor position to land on. */
  function applyEdit(
    fn: (ctx: { game: AnnotatedGame; line: MoveNode[]; index: number; breadcrumbs: Breadcrumb[] }) =>
      { line: MoveNode[]; index: number; breadcrumbs: Breadcrumb[] },
  ) {
    if (!game) return;
    const steps = pathSteps(game.mainLine, activeLine) ?? [];
    const snap: Snapshot = { game: structuredClone(game), path: steps, activeIndex };
    setUndoStack((s) => [...s, snap]);
    setRedoStack([]);
    setDirty(true);

    const clone = structuredClone(game);
    const { line, breadcrumbs: bc } = resolvePath(clone.mainLine, steps);
    const result = fn({ game: clone, line, index: activeIndex, breadcrumbs: bc });
    setGame(clone);
    setActiveLine(result.line);
    setActiveIndex(result.index);
    setBreadcrumbs(result.breadcrumbs);
  }

  function reset() {
    setActive(false);
    setGame(null);
    setActiveLine([]);
    setActiveIndex(0);
    setBreadcrumbs([]);
    setPendingDivergence(null);
    setPendingPromotion(null);
    setSelectedSquare(null);
    setPreviewMove(null);
    setPendingDest(null);
    setUndoStack([]);
    setRedoStack([]);
    setDirty(false);
    setError(null);
    setSaving(false);
  }

  function start(g: AnnotatedGame, line: MoveNode[], at: number, _bc: Breadcrumb[]) {
    const clone = structuredClone(g);
    const steps = pathSteps(g.mainLine, line) ?? [];
    const { line: clonedLine, breadcrumbs: clonedBc } = resolvePath(clone.mainLine, steps);
    setGame(clone);
    setActiveLine(clonedLine);
    setActiveIndex(Math.max(0, Math.min(clonedLine.length, at)));
    setBreadcrumbs(clonedBc);
    setPendingDivergence(null);
    setPendingPromotion(null);
    setUndoStack([]);
    setRedoStack([]);
    setDirty(false);
    setError(null);
    setActive(true);
  }

  function cancel() { reset(); }

  function navigate(line: MoveNode[], index: number) {
    if (!game) return;
    const r = navigateTo(game.mainLine, line, index);
    setActiveLine(r.activeLine);
    setActiveIndex(r.activeIndex);
    setBreadcrumbs(r.breadcrumbs);
  }

  function setCursor(i: number) {
    setActiveIndex(Math.max(0, Math.min(activeLine.length, i)));
  }

  function goBackToParent() {
    const r = backToParent(breadcrumbs);
    if (r) {
      setActiveLine(r.activeLine);
      setActiveIndex(r.activeIndex);
      setBreadcrumbs(r.breadcrumbs);
    }
  }

  function tryMove(from: string, to: string, promotion?: "q" | "r" | "b" | "n"): boolean {
    let result: ReturnType<Chess["move"]> | null;
    let fenAfter = "";
    try {
      const c = new Chess(fen);
      result = c.move({ from, to, promotion });
      fenAfter = c.fen();
    } catch { result = null; }

    if (!result && !promotion) {
      // Maybe a promotion is required — surface the chooser if a queen promo is legal.
      try {
        const c2 = new Chess(fen);
        const promo = c2.move({ from, to, promotion: "q" });
        if (promo) {
          setPendingPromotion({ from, to });
          return true;
        }
      } catch {/* still illegal */}
      return false;
    }
    if (!result) return false;

    const node = makeNode({ san: result.san, color: result.color as "w" | "b" }, fenAfter);

    if (activeIndex < activeLine.length) {
      // Same move already recorded here — just advance.
      if (activeLine[activeIndex].san === node.san) {
        setActiveIndex((c) => c + 1);
        return true;
      }
      // Divergent move — let the user choose how to graft it in.
      setPendingDivergence({ san: node.san, node });
      return true;
    }

    // At the tip — extend the line.
    applyEdit(({ line, index, breadcrumbs: bc }) => {
      line.push(node);
      return { line, index: index + 1, breadcrumbs: bc };
    });
    return true;
  }

  function commitOverwrite() {
    const pd = pendingDivergence;
    if (!pd) return;
    setPendingDivergence(null);
    applyEdit(({ line, index, breadcrumbs: bc }) => {
      line.length = index;
      line.push(pd.node);
      return { line, index: index + 1, breadcrumbs: bc };
    });
  }

  function commitNewVariation() {
    const pd = pendingDivergence;
    if (!pd) return;
    setPendingDivergence(null);
    applyEdit(({ line, index, breadcrumbs: bc }) => {
      const target = line[index];
      const newVar = [pd.node];
      target.variations.push(newVar);
      return { line: newVar, index: 1, breadcrumbs: [...bc, { line, index }] };
    });
  }

  function commitNewMainLine() {
    const pd = pendingDivergence;
    if (!pd) return;
    setPendingDivergence(null);
    applyEdit(({ line, index, breadcrumbs: bc }) => {
      const tail = line.slice(index); // existing continuation, demoted
      line.length = index;
      pd.node.variations = [tail];
      line.push(pd.node);
      return { line, index: index + 1, breadcrumbs: bc };
    });
  }

  function cancelDivergence() { setPendingDivergence(null); }

  /** Set (blank clears) the trailing comment of the move at the cursor. */
  function setMoveComment(text: string) {
    if (!game) return;
    const value = text.trim() ? text : undefined;
    applyEdit(({ line, index, breadcrumbs: bc }) => {
      if (index > 0) {
        const node = line[index - 1];
        node.annotations = { ...node.annotations, comment: value };
      }
      return { line, index, breadcrumbs: bc };
    });
  }

  /** Set (blank clears) the current line's intro comment — the game start
   *  comment on the main line, or the variation's first-move preComment. */
  function setLineComment(text: string) {
    if (!game) return;
    const value = text.trim() ? text : undefined;
    applyEdit(({ game: g, line, index, breadcrumbs: bc }) => {
      if (bc.length === 0) g.startComment = value;
      else if (line[0]) line[0].preComment = value; // variation intro (line is non-empty)
      return { line, index, breadcrumbs: bc };
    });
  }

  function commitPromotion(piece: "q" | "r" | "b" | "n") {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    setPendingPromotion(null);
    tryMove(from, to, piece);
  }

  function deleteFromHere() {
    if (activeIndex >= activeLine.length) return;
    applyEdit(({ line, index, breadcrumbs: bc }) => {
      line.length = index;
      // Emptied a variation from its start → drop it and step up to the parent.
      if (line.length === 0 && bc.length > 0) {
        const parentBc = bc[bc.length - 1];
        const branchNode = parentBc.line[parentBc.index];
        branchNode.variations = branchNode.variations.filter((v) => v !== line);
        return { line: parentBc.line, index: parentBc.index, breadcrumbs: bc.slice(0, -1) };
      }
      return { line, index, breadcrumbs: bc };
    });
  }

  function undo() {
    if (undoStack.length === 0 || !game) return;
    const prev = undoStack[undoStack.length - 1];
    const cur: Snapshot = { game: structuredClone(game), path: pathSteps(game.mainLine, activeLine) ?? [], activeIndex };
    setRedoStack((r) => [...r, cur]);
    const clone = structuredClone(prev.game);
    const { line, breadcrumbs: bc } = resolvePath(clone.mainLine, prev.path ?? []);
    setGame(clone);
    setActiveLine(line);
    setActiveIndex(prev.activeIndex);
    setBreadcrumbs(bc);
    setSelectedSquare(null);
    setUndoStack((s) => s.slice(0, -1));
  }

  function redo() {
    if (redoStack.length === 0 || !game) return;
    const next = redoStack[redoStack.length - 1];
    const cur: Snapshot = { game: structuredClone(game), path: pathSteps(game.mainLine, activeLine) ?? [], activeIndex };
    setUndoStack((u) => [...u, cur]);
    const clone = structuredClone(next.game);
    const { line, breadcrumbs: bc } = resolvePath(clone.mainLine, next.path ?? []);
    setGame(clone);
    setActiveLine(line);
    setActiveIndex(next.activeIndex);
    setBreadcrumbs(bc);
    setSelectedSquare(null);
    setRedoStack((s) => s.slice(0, -1));
  }

  function clickSquare(square: string) {
    if (!active) return;
    if (pendingDivergence || pendingPromotion || saving) return;

    const board = new Chess(fen);
    const piece = board.get(square as never);
    const isOwnPiece = piece && piece.color === board.turn();

    if (selectedSquare === null) {
      if (isOwnPiece) setSelectedSquare(square);
      return;
    }
    if (selectedSquare === square) {
      setSelectedSquare(null);
      return;
    }
    const accepted = tryMove(selectedSquare, square);
    if (accepted) {
      setSelectedSquare(null);
      return;
    }
    setSelectedSquare(isOwnPiece ? square : null);
  }

  async function save() {
    if (saving || gameId === null || !game) return;
    setSaving(true);
    setError(null);
    const movetext = serializeMovetext(game);
    const result = await saveMovetextViaSidecar(gameId, movetext);
    if (result.ok) {
      const focusIndex = activeLine === game.mainLine ? activeIndex : game.mainLine.length;
      onSaved?.(focusIndex);
      reset();
    } else {
      setError(result.error);
      setSaving(false);
    }
  }

  return {
    active,
    game,
    activeLine,
    activeIndex,
    breadcrumbs,
    fen,
    sideToMove,
    pendingDivergence,
    pendingPromotion,
    saving,
    error,
    dirty,
    moveComment,
    lineComment,
    setMoveComment,
    setLineComment,
    selectedSquare,
    legalDestinations,
    previewMove,
    gestureActive: previewMove !== null || pendingDest !== null,
    shouldHandleAsDestination,
    pickSourceFor,
    requestPreview,
    dragTo,
    clearPreview: () => { setPreviewMove(null); setPendingDest(null); },
    commitPreview,
    prefetchPositionMoves,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    start,
    cancel,
    navigate,
    setCursor,
    goBackToParent,
    tryMove,
    clickSquare,
    commitOverwrite,
    commitNewVariation,
    commitNewMainLine,
    cancelDivergence,
    commitPromotion,
    cancelPromotion: () => setPendingPromotion(null),
    deleteFromHere,
    undo,
    redo,
    save,
  };
}

// ── UI: side panel (move list with variations) ───────────────────────────────

/** The editing move list: the same recursive variation renderer the viewer
 *  uses, fed by the editor's working tree. Owns its own collapse / annotation
 *  display state. */
export function MovesEditorMoveList({ editor }: { editor: MovesEditor }) {
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [partialNodes, setPartialNodes] = useState<Set<string>>(new Set());
  const [showAnnotations, setShowAnnotations] = useState(true);

  const game = editor.game;
  const inSubVariation = editor.breadcrumbs.length > 0;

  function handleToggleCollapse(key: string) {
    if (collapsedNodes.has(key)) {
      setCollapsedNodes((prev) => { const next = new Set(prev); next.delete(key); return next; });
      setPartialNodes((prev) => { const next = new Set(prev); next.delete(key); return next; });
    } else if (partialNodes.has(key)) {
      setPartialNodes((prev) => { const next = new Set(prev); next.delete(key); return next; });
    } else {
      setCollapsedNodes((prev) => { const next = new Set(prev); next.add(key); return next; });
      setPartialNodes((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  }

  function handleExpandAll() { setCollapsedNodes(new Set()); setPartialNodes(new Set()); }

  function handleCollapseAll() {
    if (!game) return;
    const allKeys = collectAllKeys(game.mainLine, "m");
    const pathKeys = new Set(collectPathKeys(editor.activeLine, game.mainLine, "m") ?? []);
    setCollapsedNodes(new Set(allKeys.filter((k) => !pathKeys.has(k))));
    setPartialNodes(new Set(pathKeys));
  }

  function handleExpandSubVariations() {
    if (!game) return;
    const prefix = findLinePrefix(editor.activeLine, game.mainLine, "m");
    if (!prefix) return;
    const keys = collectLineKeys(editor.activeLine, prefix);
    setCollapsedNodes((prev) => { const next = new Set(prev); for (const k of keys) next.delete(k); return next; });
  }

  function handleCollapseSubVariations() {
    if (!game) return;
    const prefix = findLinePrefix(editor.activeLine, game.mainLine, "m");
    if (!prefix) return;
    const keys = collectLineKeys(editor.activeLine, prefix);
    setCollapsedNodes((prev) => { const next = new Set(prev); for (const k of keys) next.add(k); return next; });
  }

  return (
    <div className="h-full flex flex-col">
      <div className="text-label-sm text-on-surface-variant uppercase tracking-wider px-3 pt-2 pb-1 shrink-0">Editing moves</div>
      <div className="flex-1 min-h-0 flex flex-col">
        {game && game.mainLine.length > 0 ? (
          <AnnotatedMoveList
            game={game}
            activeLine={editor.activeLine}
            activeIndex={editor.activeIndex}
            showAnnotations={showAnnotations}
            collapsedNodes={collapsedNodes}
            partialNodes={partialNodes}
            inSubVariation={inSubVariation}
            breadcrumbs={editor.breadcrumbs}
            onNavigate={(line, index) => editor.navigate(line, index)}
            onToggleCollapse={handleToggleCollapse}
            onExpandAll={handleExpandAll}
            onCollapseAll={handleCollapseAll}
            onExpandSubVariations={handleExpandSubVariations}
            onCollapseSubVariations={handleCollapseSubVariations}
            onToggleAnnotations={() => setShowAnnotations((s) => !s)}
          />
        ) : (
          <div className="flex-1 px-3 py-2 text-on-surface-variant italic font-mono text-body-sm">
            No moves yet — drag a piece on the board to start.
          </div>
        )}
      </div>
      {editor.error && (
        <div className="shrink-0 px-3 pb-2 text-body-sm text-error whitespace-pre-wrap break-words">{editor.error}</div>
      )}
    </div>
  );
}

// ── UI: bottom toolbar (replaces nav controls when editing) ──────────────────

export function MovesEditorToolbar({ editor }: { editor: MovesEditor }) {
  const cursorAtEnd = editor.activeIndex === editor.activeLine.length;
  const inSubVariation = editor.breadcrumbs.length > 0;
  const iconBtn = "w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-40 disabled:hover:bg-transparent transition-colors duration-short3 ease-standard";
  const textBtn = "h-8 px-3 inline-flex items-center gap-1 rounded-full text-primary text-label-md hover:bg-primary/8 active:bg-primary/12 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors duration-short3 ease-standard";
  return (
    <div className="shrink-0 flex items-center justify-center gap-1 flex-wrap">
      <button onClick={editor.goBackToParent} disabled={!inSubVariation} className={iconBtn} title="Back to parent line">↩</button>
      <button onClick={() => editor.setCursor(0)} disabled={editor.activeIndex === 0} className={iconBtn} title="Go to start">⟪</button>
      <button onClick={() => editor.setCursor(Math.max(0, editor.activeIndex - 1))} disabled={editor.activeIndex === 0} className={iconBtn} title="Previous move">‹</button>
      <span className="text-label-sm text-on-surface-variant mx-1 select-none">
        {editor.activeIndex} / {editor.activeLine.length}
      </span>
      <button onClick={() => editor.setCursor(Math.min(editor.activeLine.length, editor.activeIndex + 1))} disabled={cursorAtEnd} className={iconBtn} title="Next move">›</button>
      <button onClick={() => editor.setCursor(editor.activeLine.length)} disabled={cursorAtEnd} className={iconBtn} title="Go to end">⟫</button>
      <div className="w-px h-5 bg-outline-variant mx-2" />
      <button onClick={editor.undo} disabled={!editor.canUndo} className={textBtn} title="Undo last edit (Ctrl+Z)">↶ Undo</button>
      <button onClick={editor.redo} disabled={!editor.canRedo} className={textBtn} title="Redo (Ctrl+Y or Ctrl+Shift+Z)">↷ Redo</button>
      <button
        onClick={editor.deleteFromHere}
        disabled={cursorAtEnd}
        className="h-8 px-3 inline-flex items-center rounded-full bg-error-container text-on-error-container text-label-md hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard"
        title="Truncate from this position onwards"
      >Delete from here</button>
    </div>
  );
}

// ── UI: annotation editor (comment for the current position) ─────────────────

/** One labelled comment box. Holds a local draft and commits on blur, so
 *  typing produces one undo entry per edit session rather than one per
 *  keystroke. `resetKey` forces the draft to reload when the cursor moves. */
function CommentField({ label, value, resetKey, placeholder, onCommit }: {
  label: string;
  value: string;
  resetKey: string;
  placeholder: string;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, resetKey]);
  return (
    <div className="flex flex-col flex-1 min-h-[2.75em]">
      <span className="text-label-sm text-on-surface-variant select-none">{label}</span>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== value) onCommit(draft); }}
        placeholder={placeholder}
        className="flex-1 w-full resize-none bg-transparent outline-none text-body-md text-on-surface placeholder:text-on-surface-variant placeholder:italic"
      />
    </div>
  );
}

/** Annotation editor for the current position. On the first move of a line it
 *  shows BOTH the line's intro comment and the move's trailing comment; on
 *  later moves only the trailing comment; at a bare line start only the intro. */
export function MovesEditorAnnotation({ editor }: { editor: MovesEditor }) {
  const idx = editor.activeIndex;
  const inVariation = editor.breadcrumbs.length > 0;
  const resetKey = `${editor.breadcrumbs.length}:${idx}`;
  const introLabel = inVariation ? "Comment before this line" : "Initial game comment";

  const showIntro = idx <= 1;  // bare line start (0) or first move of the line (1)
  const showMove = idx > 0;    // any reached move

  return (
    <div className="h-full flex flex-col gap-2 overflow-y-auto">
      {showIntro && (
        <CommentField
          label={introLabel}
          value={editor.lineComment}
          resetKey={`intro-${resetKey}`}
          placeholder="Add a comment…"
          onCommit={editor.setLineComment}
        />
      )}
      {showIntro && showMove && <div className="border-t border-outline-variant shrink-0" />}
      {showMove && (
        <CommentField
          label="Comment after this move"
          value={editor.moveComment}
          resetKey={`move-${resetKey}`}
          placeholder="Add a comment…"
          onCommit={editor.setMoveComment}
        />
      )}
    </div>
  );
}

// ── UI: overlays ─────────────────────────────────────────────────────────────

export function MovesEditorPromotionChooser({
  side, onPick, onCancel,
}: {
  side: "w" | "b";
  onPick: (p: "q" | "r" | "b" | "n") => void;
  onCancel: () => void;
}) {
  const pieces: Array<{ key: "q" | "r" | "b" | "n"; label: string }> = [
    { key: "q", label: "Queen" },
    { key: "r", label: "Rook" },
    { key: "b", label: "Bishop" },
    { key: "n", label: "Knight" },
  ];
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-on-surface/40" onClick={onCancel}>
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl p-5 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-body-md text-on-surface">
          Promote {side === "w" ? "White" : "Black"} pawn to:
        </div>
        <div className="flex gap-2">
          {pieces.map((p) => (
            <button
              key={p.key}
              onClick={() => onPick(p.key)}
              className="h-9 px-4 rounded-full bg-secondary-container text-on-secondary-container text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Divergence chooser — shown when a played move differs from the move already
 *  recorded at the cursor. Lets the user branch instead of only overwriting. */
export function MovesEditorDivergenceChoice({
  san, droppedCount, onNewVariation, onNewMainLine, onOverwrite, onCancel,
}: {
  san: string;
  droppedCount: number;
  onNewVariation: () => void;
  onNewMainLine: () => void;
  onOverwrite: () => void;
  onCancel: () => void;
}) {
  // Keyboard: Esc cancels; 1/2/3 pick the options; Enter = new variation.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "1" || e.key === "Enter") { e.preventDefault(); onNewVariation(); }
      else if (e.key === "2") { e.preventDefault(); onNewMainLine(); }
      else if (e.key === "3") { e.preventDefault(); onOverwrite(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewVariation, onNewMainLine, onOverwrite, onCancel]);

  const optionBtn = "w-full text-left px-4 py-3 rounded-lg bg-surface-container-highest hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard flex flex-col gap-0.5";
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-on-surface/40" onClick={onCancel}>
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl p-6 w-[30rem] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-title-md text-on-surface mb-1">
          Play <span className="font-mono text-primary">{san}</span> as…
        </div>
        <p className="text-body-sm text-on-surface-variant mb-4">
          A different move is already recorded here. Choose how to add it.
        </p>
        <div className="flex flex-col gap-2 mb-4">
          <button onClick={onNewVariation} className={optionBtn} autoFocus>
            <span className="text-label-lg text-on-surface">New variation</span>
            <span className="text-body-sm text-on-surface-variant">Keep the current line; add {san} as an alternative branch.</span>
          </button>
          <button onClick={onNewMainLine} className={optionBtn}>
            <span className="text-label-lg text-on-surface">New main line</span>
            <span className="text-body-sm text-on-surface-variant">Make {san} the main move; demote the current continuation to a variation.</span>
          </button>
          <button onClick={onOverwrite} className={optionBtn}>
            <span className="text-label-lg text-on-surface">Overwrite</span>
            <span className="text-body-sm text-on-surface-variant">Discard {droppedCount} move(s) from here and replace with {san}.</span>
          </button>
        </div>
        <div className="flex justify-end">
          <button
            onClick={onCancel}
            className="h-9 px-4 rounded-full text-primary text-label-lg hover:bg-primary/8 active:bg-primary/12 transition-colors duration-short3 ease-standard"
          >Cancel</button>
        </div>
      </div>
    </div>
  );
}
