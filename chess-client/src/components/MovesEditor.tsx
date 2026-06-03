// Inline moves-editor used by GameBoard. The host renders the board and side
// panel; this module owns:
//   - the editor state machine (moves, cursor, overwrite/promotion pending)
//   - handlers (try-move, delete-from-here, save via sidecar)
//   - the small UI pieces that overlay the host (toolbar, side panel,
//     promotion chooser, overwrite confirm, annotated-game gate).

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MoveNode } from "../lib/parsePgnTree";
import { MoveStats } from "../types";

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface MovesEditor {
  /** True when editing — host swaps the board / panel into edit mode. */
  active: boolean;
  /** True when initial main-line had annotations and the user hasn't yet OK'd dropping them. */
  needsClobberAck: boolean;
  /** Current SAN list under edit. */
  moves: string[];
  /** Half-move cursor 0..moves.length. */
  cursor: number;
  /** FEN at cursor — used as the board's `position`. */
  fen: string;
  /** Side to move at cursor. */
  sideToMove: "w" | "b";
  /** Pending mid-line overwrite waiting on user confirm. */
  pendingOverwrite: { san: string } | null;
  /** Pending promotion — board awaits piece choice. */
  pendingPromotion: { from: string; to: string } | null;
  saving: boolean;
  error: string | null;

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
  /** Best-source heuristic for the given destination. Returns null if no
   *  legal move lands on `square`. Ranks ambiguous candidates by DB
   *  popularity, then from-square lexicographic. */
  pickSourceFor(square: string): string | null;
  /** Begin a one-click gesture for `square`:
   *   - single legal source: arrow is shown immediately.
   *   - multiple legal sources + DB data loaded: arrow with most-popular
   *     candidate (or lex fallback when this position isn't in the DB).
   *   - multiple legal sources + DB data still in flight: NO arrow yet;
   *     materialises when the fetch lands. */
  requestPreview(square: string): void;
  clearPreview(): void;
  /** End the gesture. If an arrow is shown, the move is played immediately.
   *  If we were still waiting for DB data (silent gesture), the move is
   *  played as soon as the fetch lands. */
  commitPreview(): void;
  /** True while a gesture is active (visible arrow OR silent wait). Hosts
   *  use this to keep tracking pointer move/up after a silent press. */
  gestureActive: boolean;
  /** Update the gesture as the pointer moves to `sq`. The press locks the
   *  destination square; subsequent slides only let the user pick the source
   *  piece. If `sq` is a legal source for the locked destination, the
   *  arrow's `from` snaps to `sq` and silent-wait is cancelled. Any other
   *  cursor square (own pieces that can't reach the dest, empty squares,
   *  etc.) leaves the gesture untouched so the user can move freely without
   *  cancelling. To target a different destination, release and re-press. */
  dragTo(sq: string): void;
  /** Warm the position-moves cache for `fen` without touching the editor's
   *  state. Hosts call this while just *viewing* a game so that the moment
   *  edit mode is entered (or a new ply navigated to) the one-click
   *  heuristic already has the popularity data. No-op for cached fens. */
  prefetchPositionMoves(fen: string): void;

  // ── Undo / Redo ──────────────────────────────────────────────────────────
  /** True when there's at least one snapshot on the undo stack. */
  canUndo: boolean;
  /** True when there's at least one snapshot on the redo stack. */
  canRedo: boolean;

  /** Begin editing from the given main line, positioned at `cursor` half-moves. */
  start(mainLine: MoveNode[], cursor: number): void;
  cancel(): void;
  ackClobber(): void;
  setCursor(i: number): void;
  /** Try to play a move from the board. Returns true if the move was accepted
   *  (it may be deferred via the overwrite or promotion flows). */
  tryMove(from: string, to: string, promotion?: "q" | "r" | "b" | "n"): boolean;
  /** Handle a click on a square (click-to-move flow):
   *   - no selection + own piece → select.
   *   - same square clicked again → deselect.
   *   - legal destination → play (or surface promotion / overwrite).
   *   - own piece on a non-legal square → switch selection.
   *   - empty / opponent piece → clear selection. */
  clickSquare(square: string): void;
  commitOverwrite(): void;
  cancelOverwrite(): void;
  commitPromotion(piece: "q" | "r" | "b" | "n"): void;
  cancelPromotion(): void;
  deleteFromHere(): void;
  /** Undo the most recent edit (move add, mid-line overwrite, or
   *  delete-from-here). Restores both the SAN list and the cursor position
   *  to their pre-edit state. No-op when the stack is empty. */
  undo(): void;
  /** Re-apply the most recently undone edit. No-op when the redo stack is
   *  empty (which it is right after a fresh edit). */
  redo(): void;
  save(): void;
}

/**
 * Run `chess-db games set-moves` through the Tauri sidecar. Standalone so
 * the editor's "Done" button and the GameBoard's game-switch autosave can
 * share the same code path. Resolves the terminal event explicitly to
 * avoid the listen/invoke race.
 */
export async function saveMovesViaSidecar(
  gameId: number,
  moves: string[],
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
      args: ["games", "set-moves", String(gameId), "--moves", moves.join(" ")],
      eventId,
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
  /** Fires on successful save. `focusIndex` is the half-move ply the host
   *  should restore the read-only cursor to (defaults to the end of the
   *  newly-saved line so the user keeps looking at the last move). */
  onSaved?: (focusIndex: number) => void;
}

/** Detect annotations on the main line (variations, comments, NAGs, arrows, circles). */
export function isMainLineAnnotated(mainLine: MoveNode[]): boolean {
  for (const n of mainLine) {
    if (n.variations.length > 0) return true;
    const a = n.annotations;
    if (a.comment || a.nag || (a.arrows && a.arrows.length) || (a.circles && a.circles.length)) return true;
  }
  return false;
}

/** Replay `moves[0..ply]` and return the resulting FEN. Stops on first
 *  illegal move (shouldn't happen — we validate on add). */
function fenAtPly(moves: string[], ply: number): string {
  const c = new Chess();
  for (let i = 0; i < ply; i++) {
    try { c.move(moves[i]); } catch { break; }
  }
  return c.fen();
}

function turnAtPly(moves: string[], ply: number): "w" | "b" {
  const c = new Chess();
  for (let i = 0; i < ply; i++) {
    try { c.move(moves[i]); } catch { break; }
  }
  return c.turn();
}

export function useMovesEditor({ gameId, onSaved }: UseMovesEditorOpts): MovesEditor {
  const [active, setActive] = useState(false);
  const [needsClobberAck, setNeedsClobberAck] = useState(false);
  const [moves, setMoves] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [pendingOverwrite, setPendingOverwrite] = useState<{ san: string } | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: string; to: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  // Undo / redo history of (moves, cursor) snapshots. New edits push to undo
  // and clear redo (standard editor semantics — the redo branch is invalid
  // once you diverge from it).
  type Snapshot = { moves: string[]; cursor: number };
  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);

  /** Snapshot the current (moves, cursor) onto the undo stack and clear
   *  redo. Call BEFORE applying an edit. */
  function pushUndo() {
    setUndoStack((s) => [...s, { moves: moves.slice(), cursor }]);
    setRedoStack([]);
  }

  const fen = useMemo(() => active ? fenAtPly(moves, cursor) : "", [active, moves, cursor]);
  const sideToMove = useMemo<"w" | "b">(
    () => active ? turnAtPly(moves, cursor) : "w",
    [active, moves, cursor],
  );

  /** Legal destinations from the currently selected square — used by the host
   *  to render move-hint dots. Empty when nothing is selected. */
  const legalDestinations = useMemo<string[]>(() => {
    if (!active || !selectedSquare) return [];
    try {
      const c = new Chess(fenAtPly(moves, cursor));
      return c.moves({ square: selectedSquare as never, verbose: true }).map((m) => m.to as string);
    } catch {
      return [];
    }
  }, [active, selectedSquare, moves, cursor]);

  // Selection should not survive cursor jumps or modal toggles — those change
  // the position context and the highlighted square would be stale.
  useEffect(() => { setSelectedSquare(null); }, [cursor, pendingOverwrite, pendingPromotion, needsClobberAck]);

  // ── One-click destination ───────────────────────────────────────────────
  const [previewMove, setPreviewMove] = useState<{ from: string; to: string } | null>(null);
  // Destination square in a "silent" gesture state — the user has pressed
  // (or released) on a square that has multiple legal sources, but the
  // popularity fetch hasn't landed yet, so we don't know which one to draw.
  // `committed=false` means "still pressing, materialise an arrow when data
  // arrives". `committed=true` means "user already released, just play the
  // most-popular move once data arrives".
  const [pendingDest, setPendingDest] = useState<{ sq: string; committed: boolean } | null>(null);
  // Tagged with the fen the data is for. The slice is only used when the tag
  // matches the current fen; mismatches (initial empty, in-flight fetch, or
  // leftover from a previous cursor) are treated as "not yet loaded".
  const [positionMovesData, setPositionMovesData] = useState<{ fen: string; moves: MoveStats[] } | null>(null);
  const positionMovesCacheRef = useRef<Map<string, MoveStats[]>>(new Map());
  const positionMoves: MoveStats[] = positionMovesData?.fen === fen ? positionMovesData.moves : [];
  const positionMovesLoading = active && fen !== "" && positionMovesData?.fen !== fen;

  // Same guard as `selectedSquare` above — stale preview after the position changes.
  useEffect(() => {
    setPreviewMove(null);
    setPendingDest(null);
  }, [cursor, pendingOverwrite, pendingPromotion, needsClobberAck]);

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

  // Tracks in-flight prefetches so we don't fire duplicates for the same fen
  // (e.g. when the host re-renders rapidly while navigating plies).
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

  /** Count legal moves landing on `square` without consulting the DB. Used by
   *  `requestPreview` to decide between immediate-arrow and silent-wait. */
  function countLegalSourcesFor(square: string): number {
    if (!active) return 0;
    try {
      const c = new Chess(fen);
      return c.moves({ verbose: true }).filter((m) => m.to === square).length;
    } catch { return 0; }
  }

  /** Is there a legal move from `src` landing on `dest`? */
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
    if (sq === previewMove?.from) return; // already showing this source
    // Reverse drag: user is picking the source piece for the locked dest.
    if (isLegalSourceFor(sq, currentDest)) {
      setPendingDest(null);
      setPreviewMove({ from: sq, to: currentDest });
      return;
    }
    // Anything else — passing over an empty square, an own piece that can't
    // reach the dest, an opponent piece — leaves the current arrow alone.
    // The press locks the destination; to retarget, the user releases and
    // presses again.
  }

  function requestPreview(square: string) {
    if (!active) return;
    const n = countLegalSourcesFor(square);
    if (n === 0) {
      setPreviewMove(null);
      setPendingDest(null);
      return;
    }
    // Unambiguous, or popularity data is already loaded for this position
    // (even if the position itself has no DB games, the load is complete
    // and the lex tiebreak gives the "best guess" fallback the user agreed
    // to in that case): pick now and show the arrow.
    if (n === 1 || !positionMovesLoading) {
      const src = pickSourceFor(square);
      setPendingDest(null);
      if (src) setPreviewMove({ from: src, to: square });
      else setPreviewMove(null);
      return;
    }
    // Ambiguous + data still loading: wait silently — no arrow, no fallback.
    setPreviewMove(null);
    setPendingDest({ sq: square, committed: false });
  }

  function commitPreview() {
    // Arrow visible → user has seen and agreed; commit immediately.
    if (previewMove) {
      const { from, to } = previewMove;
      setPreviewMove(null);
      setPendingDest(null);
      tryMove(from, to);
      return;
    }
    // Silent gesture → mark it for deferred commit. The resolution effect
    // below will play the most-popular move once data lands.
    if (pendingDest && !pendingDest.committed) {
      setPendingDest({ sq: pendingDest.sq, committed: true });
    }
  }

  // Resolve a pending silent gesture once popularity data lands: either
  // promote it to a visible arrow (if user is still pressing) or play the
  // move (if they've already released).
  useEffect(() => {
    if (positionMovesLoading) return;
    if (!pendingDest) return;
    const { sq, committed } = pendingDest;
    const src = pickSourceFor(sq);
    if (!src) { setPendingDest(null); return; }
    setPendingDest(null);
    if (committed) tryMove(src, sq);
    else setPreviewMove({ from: src, to: sq });
    // pickSourceFor / tryMove close over the latest state already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionMovesLoading, positionMovesData, pendingDest]);

  function reset() {
    setActive(false);
    setNeedsClobberAck(false);
    setMoves([]);
    setCursor(0);
    setPendingOverwrite(null);
    setPendingPromotion(null);
    setSelectedSquare(null);
    setPreviewMove(null);
    setPendingDest(null);
    setUndoStack([]);
    setRedoStack([]);
    setError(null);
    setSaving(false);
  }

  function start(mainLine: MoveNode[], at: number) {
    setMoves(mainLine.map((n) => n.san));
    setCursor(Math.max(0, Math.min(mainLine.length, at)));
    setNeedsClobberAck(isMainLineAnnotated(mainLine));
    setPendingOverwrite(null);
    setPendingPromotion(null);
    setUndoStack([]);
    setRedoStack([]);
    setError(null);
    setActive(true);
  }

  function cancel() { reset(); }
  function ackClobber() { setNeedsClobberAck(false); }

  function tryMove(from: string, to: string, promotion?: "q" | "r" | "b" | "n"): boolean {
    let result;
    try {
      const c = new Chess(fenAtPly(moves, cursor));
      result = c.move({ from, to, promotion });
    } catch { result = null; }

    if (!result && !promotion) {
      // Maybe a promotion is required. If a queen-promotion would succeed,
      // surface the chooser instead of treating it as illegal.
      try {
        const c2 = new Chess(fenAtPly(moves, cursor));
        const promo = c2.move({ from, to, promotion: "q" });
        if (promo) {
          setPendingPromotion({ from, to });
          return true;
        }
      } catch {/* still illegal */}
      return false;
    }
    if (!result) return false;

    const san = result.san;
    if (cursor < moves.length) {
      // Same move as the one already recorded at this ply — just advance the
      // cursor; nothing to discard, no confirm needed.
      if (moves[cursor] === san) {
        setCursor((c) => c + 1);
        return true;
      }
      setPendingOverwrite({ san });
      return true;
    }
    pushUndo();
    setMoves((m) => [...m.slice(0, cursor), san]);
    setCursor((c) => c + 1);
    return true;
  }

  function commitOverwrite() {
    if (!pendingOverwrite) return;
    pushUndo();
    setMoves((m) => [...m.slice(0, cursor), pendingOverwrite.san]);
    setCursor((c) => c + 1);
    setPendingOverwrite(null);
  }

  function commitPromotion(piece: "q" | "r" | "b" | "n") {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    setPendingPromotion(null);
    tryMove(from, to, piece);
  }

  function deleteFromHere() {
    if (cursor === moves.length) return;
    pushUndo();
    setMoves((m) => m.slice(0, cursor));
  }

  function undo() {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack;
      const prev = stack[stack.length - 1];
      setRedoStack((r) => [...r, { moves: moves.slice(), cursor }]);
      setMoves(prev.moves);
      setCursor(prev.cursor);
      setSelectedSquare(null);
      return stack.slice(0, -1);
    });
  }

  function redo() {
    setRedoStack((stack) => {
      if (stack.length === 0) return stack;
      const next = stack[stack.length - 1];
      setUndoStack((u) => [...u, { moves: moves.slice(), cursor }]);
      setMoves(next.moves);
      setCursor(next.cursor);
      setSelectedSquare(null);
      return stack.slice(0, -1);
    });
  }

  function clickSquare(square: string) {
    if (!active) return;
    if (pendingOverwrite || pendingPromotion || needsClobberAck || saving) return;

    const board = new Chess(fenAtPly(moves, cursor));
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
    // Move was illegal. If the new square holds our own piece, switch selection;
    // otherwise clear it.
    setSelectedSquare(isOwnPiece ? square : null);
  }

  async function save() {
    if (saving || gameId === null) return;
    setSaving(true);
    setError(null);
    const result = await saveMovesViaSidecar(gameId, moves);
    if (result.ok) {
      const focusIndex = moves.length;
      onSaved?.(focusIndex);
      reset();
    } else {
      setError(result.error);
      setSaving(false);
    }
  }

  return {
    active,
    needsClobberAck,
    moves,
    cursor,
    fen,
    sideToMove,
    pendingOverwrite,
    pendingPromotion,
    saving,
    error,
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
    ackClobber,
    setCursor,
    tryMove,
    clickSquare,
    commitOverwrite,
    cancelOverwrite: () => setPendingOverwrite(null),
    commitPromotion,
    cancelPromotion: () => setPendingPromotion(null),
    deleteFromHere,
    undo,
    redo,
    save,
  };
}

// ── UI: side panel (right column replacement) ────────────────────────────────

export function MovesEditorRightPanel({ editor }: { editor: MovesEditor }) {
  const cursorAtEnd = editor.cursor === editor.moves.length;
  const pairs: Array<{ moveNo: number; white: string; black: string | null }> = [];
  for (let i = 0; i < editor.moves.length; i += 2) {
    pairs.push({
      moveNo: Math.floor(i / 2) + 1,
      white: editor.moves[i],
      black: editor.moves[i + 1] ?? null,
    });
  }

  return (
    <div className="h-full flex flex-col gap-2 px-2 py-2">
      <div className="text-label-sm text-on-surface-variant uppercase tracking-wider px-1">Editing moves</div>
      <div className="flex-1 min-h-0 overflow-y-auto bg-surface-container-lowest rounded-md p-3 font-mono text-body-sm">
        {pairs.length === 0 && (
          <div className="text-on-surface-variant italic">
            No moves yet — drag a piece on the board to start.
          </div>
        )}
        {pairs.map(({ moveNo, white, black }, pairIdx) => {
          const whitePly = pairIdx * 2 + 1;
          const blackPly = pairIdx * 2 + 2;
          return (
            <span key={pairIdx} className="inline-flex items-baseline mr-2">
              <span className="text-on-surface-variant mr-1">{moveNo}.</span>
              <PlyButton san={white} active={editor.cursor === whitePly} onClick={() => editor.setCursor(whitePly)} />
              {black && (
                <>
                  {" "}
                  <PlyButton san={black} active={editor.cursor === blackPly} onClick={() => editor.setCursor(blackPly)} />
                </>
              )}
            </span>
          );
        })}
      </div>

      <div className="text-label-sm text-on-surface-variant px-1">
        {cursorAtEnd
          ? "Drag a piece to add the next move."
          : `Cursor mid-line. Dragging a piece will overwrite ${editor.moves.length - editor.cursor} move(s).`}
      </div>

      {editor.error && (
        <div className="text-body-sm text-error whitespace-pre-wrap break-words px-1">{editor.error}</div>
      )}
    </div>
  );
}

function PlyButton({ san, active, onClick }: { san: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-1.5 rounded-sm transition-colors duration-short3 ease-standard ${
        active
          ? "bg-secondary-container text-on-secondary-container"
          : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
      }`}
    >
      {san}
    </button>
  );
}

// ── UI: bottom toolbar (replaces nav controls when editing) ──────────────────

export function MovesEditorToolbar({ editor }: { editor: MovesEditor }) {
  const cursorAtEnd = editor.cursor === editor.moves.length;
  // M3 icon button — circular, state-layer overlay
  const iconBtn = "w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-40 disabled:hover:bg-transparent transition-colors duration-short3 ease-standard";
  // M3 text button — pill, primary text
  const textBtn = "h-8 px-3 inline-flex items-center gap-1 rounded-full text-primary text-label-md hover:bg-primary/8 active:bg-primary/12 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors duration-short3 ease-standard";
  return (
    <div className="shrink-0 flex items-center justify-center gap-1 flex-wrap">
      <button onClick={() => editor.setCursor(0)} disabled={editor.cursor === 0} className={iconBtn} title="Go to start">⟪</button>
      <button onClick={() => editor.setCursor(Math.max(0, editor.cursor - 1))} disabled={editor.cursor === 0} className={iconBtn} title="Previous move">‹</button>
      <span className="text-label-sm text-on-surface-variant mx-1 select-none">
        {editor.cursor} / {editor.moves.length}
      </span>
      <button onClick={() => editor.setCursor(Math.min(editor.moves.length, editor.cursor + 1))} disabled={cursorAtEnd} className={iconBtn} title="Next move">›</button>
      <button onClick={() => editor.setCursor(editor.moves.length)} disabled={cursorAtEnd} className={iconBtn} title="Go to end">⟫</button>
      <div className="w-px h-5 bg-outline-variant mx-2" />
      <button onClick={editor.undo} disabled={!editor.canUndo} className={textBtn} title="Undo last edit (Ctrl+Z)">↶ Undo</button>
      <button onClick={editor.redo} disabled={!editor.canRedo} className={textBtn} title="Redo (Ctrl+Y or Ctrl+Shift+Z)">↷ Redo</button>
      {/* Tonal error button — destructive but reversible */}
      <button
        onClick={editor.deleteFromHere}
        disabled={cursorAtEnd}
        className="h-8 px-3 inline-flex items-center rounded-full bg-error-container text-on-error-container text-label-md hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard"
        title="Truncate from this position onwards"
      >Delete from here</button>
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

export function MovesEditorOverwriteConfirm({
  san, droppedCount, onConfirm, onCancel,
}: {
  san: string;
  droppedCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-on-surface/40" onClick={onCancel}>
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl p-6 w-[26rem] max-w-[88vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-title-md text-on-surface mb-2">Overwrite future moves?</div>
        <p className="text-body-md text-on-surface-variant mb-5">
          This will discard {droppedCount} move(s) from here onwards and replace them with{" "}
          <span className="text-on-surface font-mono">{san}</span>.
        </p>
        <div className="flex justify-end gap-2">
          {/* Text button — cancel */}
          <button
            onClick={onCancel}
            className="h-9 px-4 rounded-full text-primary text-label-lg hover:bg-primary/8 active:bg-primary/12 transition-colors duration-short3 ease-standard"
          >Cancel</button>
          {/* Filled tonal warning — destructive but reversible */}
          <button
            onClick={onConfirm}
            className="h-9 px-4 rounded-full bg-warning-container text-on-warning-container text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
          >Discard and replace</button>
        </div>
      </div>
    </div>
  );
}

export function MovesEditorAnnotationGate({
  onContinue, onCancel,
}: {
  onContinue: () => void;
  onCancel: () => void;
}) {
  // Esc cancels.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-on-surface/40" onClick={onCancel}>
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl p-6 w-[28rem] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-title-md text-on-surface mb-2">Edit moves</h2>
        <p className="text-body-md text-on-surface mb-3">
          This game has <span className="text-warning">annotations</span> (variations,
          comments, NAGs, or arrows). Phase 1 of the moves editor only supports linear
          main-line edits — saving will{" "}
          <span className="text-warning">drop all annotations</span> from this game.
        </p>
        <p className="text-body-md text-on-surface-variant mb-5">
          A future update will preserve them. Continue anyway?
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="h-9 px-4 rounded-full text-primary text-label-lg hover:bg-primary/8 active:bg-primary/12 transition-colors duration-short3 ease-standard"
          >Cancel</button>
          <button
            onClick={onContinue}
            className="h-9 px-4 rounded-full bg-warning-container text-on-warning-container text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
          >Continue, drop annotations</button>
        </div>
      </div>
    </div>
  );
}
