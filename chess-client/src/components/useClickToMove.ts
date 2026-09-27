// Click-to-move on a board, the same in the game editor and on the Analysis
// board: click a piece, then its destination — or click only the destination,
// and the piece that can go there moves. Where several can, the move is:
//   1. the one played most often from the position in the database;
//   2. without games, the one Stockfish's evaluation of the position rates
//      higher (the server's remembered or kept result);
//   3. without one, the one Stockfish rates higher at first sight (a shallow
//      search on a helper);
//   4. else the smaller piece.
// All three are asked for as soon as the position is shown, so they are
// normally there by the click; a move is not held up by a slow database
// when Stockfish's order is at hand (see DB_GRACE_MS).
// Holding the pointer down on the destination shows the move as an arrow
// first; dragging to another piece that can reach the square picks that one
// instead; releasing plays it.

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { MoveStats } from "../types";

export interface ClickToMove {
  /** Click-to-move is on: the board takes moves this way. */
  active: boolean;
  /** Moves are held back for now (a promotion or divergence to answer, a save). */
  blocked: boolean;
  /** Square currently selected via click (null = none). */
  selectedSquare: string | null;
  /** Legal destination squares from `selectedSquare` (empty when none). */
  legalDestinations: string[];
  /** A click on `square`: select a piece of the side to move, or play the
   *  selected piece to it. */
  clickSquare(square: string): void;
  clearSelection(): void;

  // ── One-click destination ────────────────────────────────────────────────
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
  /** Warm the position-moves cache for `fen` without touching the state. */
  prefetchPositionMoves(fen: string): void;
}

/** How long a one-click move waits for the database when Stockfish's order
 *  of the moves is at hand, and when it is not. */
const DB_GRACE_MS = 250;
const DB_WAIT_MS = 1500;

/** Pieces by worth, for the last resort: Nf3 before Qf3. */
const WORTH: Record<string, number> = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

export function useClickToMove({ active, fen, blocked, tryMove, resetKey }: {
  active: boolean;
  /** The position moves are played from. */
  fen: string;
  blocked: boolean;
  /** Play `from`–`to` (asking for the piece of a promotion); false if illegal. */
  tryMove: (from: string, to: string) => boolean;
  /** A change of any of these (the position, a pending question) drops the
   *  selection and any gesture. */
  resetKey: readonly unknown[];
}): ClickToMove {
  const tryMoveRef = useRef(tryMove);
  tryMoveRef.current = tryMove;
  const play = (from: string, to: string) => tryMoveRef.current(from, to);

  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const legalDestinations = useMemo<string[]>(() => {
    if (!active || !selectedSquare || !fen) return [];
    try {
      const c = new Chess(fen);
      return c.moves({ square: selectedSquare as never, verbose: true }).map((m) => m.to as string);
    } catch {
      return [];
    }
  }, [active, selectedSquare, fen]);

  // Selection / preview must not survive a position change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSelectedSquare(null); }, resetKey);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetKey);

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

  // Stockfish's order of the moves in this position: from its evaluation (the
  // server's remembered or kept result — its lines' first moves) and from a
  // first-sight search of every move. Asked for with the position.
  const [engineOrder, setEngineOrder] = useState<{ fen: string; deep: string[] | null; quick: string[] | null } | null>(null);
  useEffect(() => {
    if (!active || !fen) return;
    const q = encodeURIComponent(fen);
    const ctrl = new AbortController();
    setEngineOrder({ fen, deep: null, quick: null });
    fetch(`/api/engine/remembered?engine=stockfish&fen=${q}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ lines?: { pv_uci: string[] }[] } | null>) : null))
      .then((snap) => {
        const deep = (snap?.lines ?? []).map((l) => l.pv_uci[0]).filter(Boolean);
        setEngineOrder((o) => (o?.fen === fen ? { ...o, deep } : o));
      })
      .catch(() => {});
    fetch(`/api/engine/quick?fen=${q}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ moves: string[] }>) : null))
      .then((d) => { if (d) setEngineOrder((o) => (o?.fen === fen ? { ...o, quick: d.moves } : o)); })
      .catch(() => {});
    return () => ctrl.abort();
  }, [active, fen]);
  const order = engineOrder?.fen === fen ? engineOrder : null;

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

  /** The pieces that can go to `square` (one per piece: a promotion's four
   *  moves are one), with their SAN and worth. */
  function candidatesFor(square: string): { from: string; san: string; worth: number }[] {
    try {
      const c = new Chess(fen);
      const seen = new Map<string, { from: string; san: string; worth: number }>();
      for (const m of c.moves({ verbose: true })) {
        if (m.to === square && !seen.has(m.from)) seen.set(m.from, { from: m.from, san: m.san, worth: WORTH[m.piece] ?? 9 });
      }
      return [...seen.values()];
    } catch { return []; }
  }

  /** Stockfish's rank of `from`→`square`: its evaluation's lines first, then
   *  its first-sight order; null when it has said nothing about it. */
  function engineRank(from: string, square: string): number | null {
    const uci = from + square;
    const d = order?.deep?.findIndex((m) => m.startsWith(uci)) ?? -1;
    if (d >= 0) return d;
    const q = order?.quick?.findIndex((m) => m.startsWith(uci)) ?? -1;
    return q >= 0 ? 100 + q : null;
  }

  /** The piece a one-click move to `square` plays (see the top of the file). */
  function pickSourceFor(square: string): string | null {
    if (!active) return null;
    const candidates = candidatesFor(square);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].from;
    const popularity = new Map(positionMoves.map((s) => [s.mv, s.games]));
    const played = candidates.filter((c) => (popularity.get(c.san) ?? 0) > 0);
    if (played.length > 0) {
      played.sort((a, b) => (popularity.get(b.san) ?? 0) - (popularity.get(a.san) ?? 0) || a.from.localeCompare(b.from));
      return played[0].from;
    }
    candidates.sort((a, b) =>
      (engineRank(a.from, square) ?? 1000 + a.worth) - (engineRank(b.from, square) ?? 1000 + b.worth)
      || a.from.localeCompare(b.from));
    return candidates[0].from;
  }

  /** Stockfish has ranked some move to `square`: the database need not be
   *  waited for long. */
  function engineKnows(square: string): boolean {
    return candidatesFor(square).some((c) => engineRank(c.from, square) !== null);
  }

  function countLegalSourcesFor(square: string): number {
    if (!active) return 0;
    return candidatesFor(square).length;
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
      play(from, to);
      return;
    }
    if (pendingDest && !pendingDest.committed) {
      setPendingDest({ sq: pendingDest.sq, committed: true });
    }
  }

  // A gesture waiting for the database goes ahead once the database answers
  // — or, when it is slow, after DB_GRACE_MS if Stockfish has ranked the
  // moves (DB_WAIT_MS if not), with what is known by then.
  const [dbGaveUp, setDbGaveUp] = useState(false);
  useEffect(() => {
    setDbGaveUp(false);
    if (!pendingDest) return;
    const t = window.setTimeout(() => setDbGaveUp(true), engineKnows(pendingDest.sq) ? DB_GRACE_MS : DB_WAIT_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDest, order]);
  useEffect(() => {
    if (positionMovesLoading && !dbGaveUp) return;
    if (!pendingDest) return;
    const { sq, committed } = pendingDest;
    const src = pickSourceFor(sq);
    if (!src) { setPendingDest(null); return; }
    setPendingDest(null);
    if (committed) play(src, sq);
    else setPreviewMove({ from: src, to: sq });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionMovesLoading, positionMovesData, pendingDest, dbGaveUp]);

  function clickSquare(square: string) {
    if (!active || blocked) return;
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
    if (play(selectedSquare, square)) {
      setSelectedSquare(null);
      return;
    }
    setSelectedSquare(isOwnPiece ? square : null);
  }

  return {
    active,
    blocked,
    selectedSquare,
    legalDestinations,
    clickSquare,
    clearSelection: () => setSelectedSquare(null),
    previewMove,
    shouldHandleAsDestination,
    pickSourceFor,
    requestPreview,
    clearPreview: () => { setPreviewMove(null); setPendingDest(null); },
    commitPreview,
    gestureActive: previewMove !== null || pendingDest !== null,
    dragTo,
    prefetchPositionMoves,
  };
}

/** Convert a pointer event on the sized board container to an algebraic
 *  square ("e4"), or null if the pointer is outside — kept geometric (no DOM
 *  coupling) so it works regardless of react-chessboard internals. */
export function resolveSquareFromPointer(
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

/** The pointer side of the one-click move, for the element wrapping a board:
 *  press on a destination shows the move, moving to another piece that can go
 *  there picks it, release plays it. `pressed` remembers a press across the
 *  handlers (a ref of the board's). */
export function oneClickPointer(ctm: ClickToMove, flipped: boolean, pressed: { current: boolean }) {
  return {
    onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
      if (!ctm.active || ctm.blocked) return;
      const sq = resolveSquareFromPointer(e, flipped);
      if (!sq) return;
      if (!ctm.shouldHandleAsDestination(sq)) return;
      // Cheap legality check — pickSourceFor returns null when no legal move
      // at all lands on this square, whatever the database says.
      if (!ctm.pickSourceFor(sq)) return;
      ctm.requestPreview(sq);
      pressed.current = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
      // Prevent the synthesised click that would otherwise fire onSquareClick
      // and select the destination square as a source after the commit.
      e.preventDefault();
    },
    onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
      // Only follow the cursor while the user is still pressing — after
      // release, the gesture may stay "active" (a silent wait for the
      // database) but the user is no longer aiming.
      if (!pressed.current) return;
      if (!ctm.gestureActive) return;
      const sq = resolveSquareFromPointer(e, flipped);
      if (!sq) { ctm.clearPreview(); return; }
      ctm.dragTo(sq);
    },
    onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
      if (!pressed.current) return;
      pressed.current = false;
      if (!ctm.gestureActive) return;
      const sq = resolveSquareFromPointer(e, flipped);
      if (!sq) { ctm.clearPreview(); return; }
      ctm.commitPreview();
    },
    onPointerCancel() {
      pressed.current = false;
      ctm.clearPreview();
    },
  };
}
