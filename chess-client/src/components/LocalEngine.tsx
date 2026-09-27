import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { apiUrl, engineAnalyseUrl, type EngineHistory, type EngineKind } from "../api";
import ExternalLinkIcon from "./ExternalLinkIcon";
import { PvLine, pvToSan, fmtLichess, moverScore, moveMark, evalColor } from "./CloudEngine";

// The server's own engine (#309): Stockfish or any UCI engine installed on
// the machine the server runs on. LPDO does not ship one, so when none is
// found this panel says how to install it — on the server, which is where it
// runs, not necessarily this computer.

interface EngineStatus {
  available: boolean;
  path: string | null;
  name: string | null;
  error: string | null;
  settings: { path: string | null; threads: number; hash_mb: number; max_depth?: number; max_nodes?: number; replies?: boolean; strong_cp?: number; strong_pct?: number; neutral_cp?: number; neutral_pct?: number };
  found: string[];
  searched: string[];
  settings_file: string;
  os: string;
  networks: string[];
  weights: string | null;
  version: string | null;
  latest: { version: string; url: string } | null;
  update_available: boolean;
}

/** One line: `wdl` is White's win, the draw, Black's win, in permille. */
interface EngineLine { multipv: number; eval_cp: number | null; mate: number | null; pv_uci: string[]; wdl?: [number, number, number] | null }

interface Snapshot {
  gen: number;
  depth: number;
  nodes: number;
  nps: number;
  lines: EngineLine[];
  done: boolean;
  /** Remembered from an earlier search of this position. */
  cached?: boolean;
}

export default function LocalEngine({
  kind = "stockfish",
  fen,
  history,
  lineCount,
  onPlayLine,
  paused = false,
  onTogglePause,
}: {
  /** Which of the server's engines: Stockfish, or Lc0 (shown as win/draw/loss). */
  kind?: EngineKind;
  fen: string;
  /** How the position arose — lets the engine see repetitions. */
  history?: EngineHistory;
  lineCount: number;
  onPlayLine?: (sans: string[]) => void;
  /** Paused from the Engine panel's tab: no search runs. */
  paused?: boolean;
  onTogglePause?: () => void;
}) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // What is shown: a remembered result first, then the live search once it
  // is deeper — the evaluation on screen never gets shallower.
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [running, setRunning] = useState(true);
  // "Search further" once the search reached its limit: the depth or node
  // count to search to now.
  const [target, setTarget] = useState<number | null>(null);
  // The search under way, while a deeper remembered result stays on screen.
  const [live, setLive] = useState<{ depth: number; nodes: number } | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  async function loadStatus() {
    setChecking(true);
    setStatusError(null);
    try {
      const res = await fetch(apiUrl(`/engine?engine=${kind}`));
      if (!res.ok) throw new Error((await res.text()) || `${res.status}`);
      setStatus((await res.json()) as EngineStatus);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => { setStatus(null); void loadStatus(); }, [kind]);

  // Analyse the position on the board: a new stream per position, a moment
  // after the board settles. Closing the stream stops the search on the
  // server, so moving through a game does not leave searches running.
  const historyKey = history ? `${history.startFen}|${history.sans.join(",")}` : "";
  const historyRef = useRef(history);
  historyRef.current = history;
  // What the lines on screen belong to: a pause keeps them, a new position
  // (or line count, or engine) clears them.
  const snapFor = `${kind}|${fen}|${historyKey}|${lineCount}`;
  const snapForRef = useRef<string | null>(null);
  useEffect(() => {
    esRef.current?.close();
    esRef.current = null;
    setStreamError(null);
    const fresh = snapForRef.current !== snapFor;
    if (fresh) { setSnap(null); snapForRef.current = snapFor; }
    if (!status?.available) return;
    // Paused on a new position: show what the server remembers for it, if
    // anything — never a search.
    if (paused) {
      if (!fresh) return;
      const ctrl = new AbortController();
      fetch(apiUrl(`/engine/remembered?engine=${kind}&fen=${encodeURIComponent(fen)}`), { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((s: Snapshot | null) => { if (s) setSnap({ ...s, cached: true, done: true }); })
        .catch(() => {});
      return () => ctrl.abort();
    }
    if (!running) return;
    // Running again on the same position: the lines stay until the new
    // search is deeper, as a remembered result does.
    setSnap((prev) => (prev ? { ...prev, cached: true } : prev));
    const t = window.setTimeout(() => {
      const es = new EventSource(engineAnalyseUrl(fen, lineCount, historyRef.current, kind, target ?? undefined));
      esRef.current = es;
      es.onmessage = (ev) => {
        const s = JSON.parse(ev.data) as Snapshot;
        if (!s.cached) setLive({ depth: s.depth, nodes: s.nodes });
        // A remembered result stays until the new search goes further (or
        // it is the same search, continued).
        setSnap((prev) => (prev?.cached && !s.cached && !deeper(kind, s, prev) && !(s.depth === prev.depth && s.nodes === prev.nodes) ? prev : s));
        if (s.done && !s.cached) { es.close(); setRunning(false); }
      };
      es.onerror = () => {
        // An EventSource retries by itself; a stream that fails before any
        // update is the server refusing, so stop and say so.
        if (es.readyState === EventSource.CLOSED || !esRef.current) return;
        es.close();
        setStreamError("The engine stopped answering.");
      };
    }, 250);
    return () => {
      window.clearTimeout(t);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [fen, historyKey, lineCount, status?.available, running, kind, paused, target]);

  // While the panel is open, tell the server now and then: a search nobody
  // watches any more is stopped a few minutes after the last word — also one
  // frozen at its depth, which is kept for "search further" until then.
  const searching = running && !paused && !!status?.available;
  const open = !paused && !!status?.available;
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => {
      fetch(apiUrl(`/engine/alive?engine=${kind}`), { method: "POST" }).catch(() => {});
    }, 15_000);
    return () => window.clearInterval(t);
  }, [open, kind]);

  // Replies & Strong (when switched on for this engine). The replies are the
  // legal moves, counted here at once; the strong ones the server's helpers
  // count once the search has settled, several candidates at a time. The
  // panel asks for all candidates and asks again, twice a second, for the
  // progress until every count for the position is done.
  const repliesOn = !!status?.settings.replies;
  const [replyStates, setReplyStates] = useState<Record<string, ReplyState>>({});
  const settled = !!snap && (kind === "lc0" ? snap.nodes >= 100_000 : snap.depth >= 16);
  const candidates = (snap?.lines ?? []).slice(0, lineCount).map((l) => l.pv_uci[0]).filter(Boolean);
  const candidateKey = candidates.join(",");
  useEffect(() => {
    // Asked also with Replies & Strong off: the server then only says what
    // it knows — the deeper analyses of the positions after the moves.
    if (!settled) return;
    const children = candidates.map((uci) => childFen(fen, uci)).filter((f): f is string => !!f);
    if (children.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    const ask = async () => {
      try {
        // Paused: only counts made before — no helper is started.
        const r = await fetch(apiUrl(`/engine/replies?engine=${kind}&fen=${encodeURIComponent(fen)}&fens=${encodeURIComponent(children.join("|"))}${paused ? "&cached_only=true" : ""}`), { signal: ctrl.signal });
        if (!r.ok) return;
        const { lines: got, pending } = (await r.json()) as { lines: ReplyState[]; pending: number };
        setReplyStates((prev) => {
          const next = { ...prev };
          got.forEach((g, i) => { next[children[i]] = g; });
          return next;
        });
        // Asked again while any count for this position runs or waits — also
        // for moves that have left the list: the server keeps those while the
        // panel asks, so a move that comes back has its count.
        if (pending > 0 || got.some((g) => g.state === "waiting" || g.state === "counting")) timer = setTimeout(ask, 500);
      } catch { /* aborted, or the server went away */ }
    };
    void ask();
    return () => { ctrl.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repliesOn, settled, candidateKey, fen, kind, paused]);

  // A new position starts a new search, even if the last one was stopped.
  useEffect(() => { setRunning(true); setTarget(null); setLive(null); }, [fen]);

  if (statusError) {
    return <div className="p-3 text-center text-error text-body-sm">{statusError}</div>;
  }
  if (!status) {
    return <div className="p-3 text-center text-on-surface-variant text-body-sm">Looking for an engine…</div>;
  }
  if (kind === "lc0" && (!status.available || status.networks.length === 0)) {
    return <Lc0Guide status={status} checking={checking} onCheck={() => void loadStatus()} />;
  }
  if (!status.available) {
    return <InstallGuide status={status} checking={checking} onCheck={() => void loadStatus()} />;
  }

  const white = fen.split(" ")[1] !== "b";
  // A move whose position was analysed deeper (it was played, and the panel
  // analysed it) takes that analysis's evaluation and line; the moves are
  // then ordered again, and marked, by what is known best.
  const lines = (snap?.lines ?? []).slice(0, lineCount).map((l) => {
    const child = childFen(fen, l.pv_uci[0]);
    const rs = child ? replyStates[child] : undefined;
    const deeper = !!rs?.line && !!snap && (kind === "lc0" ? (rs.line_nodes ?? 0) >= snap.nodes : (rs.line_depth ?? 0) + 1 > snap.depth);
    if (!deeper || !rs?.line) return { ...l, child, rs, deepDepth: undefined as number | undefined, deepNodes: undefined as number | undefined };
    return {
      ...l, child, rs,
      eval_cp: rs.line.eval_cp, mate: rs.line.mate, wdl: rs.line.wdl,
      pv_uci: [l.pv_uci[0], ...rs.line.pv_uci],
      deepDepth: rs.line_depth, deepNodes: rs.line_nodes,
    };
  });
  const orderScore = (l: (typeof lines)[number]) => {
    if (kind === "lc0" && l.wdl) { const [w, d, b] = l.wdl; return ((white ? w : b) + d / 2) / 1000; }
    return moverScore(l.eval_cp, l.mate, white);
  };
  lines.sort((a, b) => orderScore(b) - orderScore(a));
  const scores = lines.map((l) => moverScore(l.eval_cp, l.mate, white));
  // Marks by the engine's threshold for strong moves, the one its helpers
  // count the strong replies by: Stockfish in centipawns, Lc0 in expected
  // score (win plus half the draws, for the side to move).
  const byWdl = kind === "lc0" && lines.length > 0 && lines.every((l) => l.wdl);
  const markScores = byWdl
    ? lines.map((l) => { const [w, d, b] = l.wdl!; return ((white ? w : b) + d / 2) / 1000; })
    : scores;
  const markBest = markScores.length ? Math.max(...markScores) : 0;
  const markThreshold = byWdl ? (status.settings.strong_pct ?? 1) / 100 : kind === "lc0" ? 10 : (status.settings.strong_cp ?? 10);
  const neutralThreshold = byWdl ? (status.settings.neutral_pct ?? 3) / 100 : kind === "lc0" ? 30 : (status.settings.neutral_cp ?? 30);
  // Why a search ended by itself: its threshold, or the time cap.
  const limit = kind === "lc0" ? status.settings.max_nodes ?? 0 : status.settings.max_depth ?? 0;
  const reached = !!snap && (kind === "lc0" ? snap.nodes >= (target ?? limit) : snap.depth >= (target ?? limit));
  const stopReason = reached ? "limit reached" : "done";
  // "Search further": five more plies for Stockfish, as many nodes again for
  // Lc0 — beyond the target while the search runs, beyond where it got once
  // it has stopped. Stockfish (frozen at its depth) goes on from there.
  const goal = target ?? limit;
  const further = !snap ? null : kind === "lc0"
    ? (running ? goal : Math.max(snap.nodes, goal)) + Math.max(limit, 1_000_000)
    : Math.min((running ? goal : Math.max(snap.depth, goal)) + 5, 245);
  // Stockfish counts in millions a second, Lc0 in thousands.
  const speed = !snap?.nps ? "" : snap.nps >= 1e6 ? `${(snap.nps / 1e6).toFixed(snap.nps >= 1e7 ? 0 : 1)} Mn/s` : `${Math.round(snap.nps / 1e3)}k n/s`;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-1 shrink-0 flex items-center justify-between gap-2 text-label-sm text-on-surface-variant border-b border-outline/40">
        <span className="min-w-0 truncate" title={status.path ?? undefined}>
          {status.name ?? "Engine"}
          {snap ? (kind === "lc0" ? ` · ${fmtNodes(snap.nodes)} nodes` : ` · depth ${snap.depth}`) : ""}
          {snap?.done && !snap.cached ? ` · ${stopReason}` : ""}
          {snap?.cached
            ? <span title={paused ? "Remembered from an earlier search" : "Remembered from an earlier search; the engine is deepening it"}> (cached)</span>
            : speed ? ` · ${speed}` : ""}
          {snap?.cached && searching && live && (
            <span title="The search under way; its lines replace the remembered ones once it is deeper">
              {" · searching: "}{kind === "lc0" ? `${fmtNodes(live.nodes)} nodes` : `depth ${live.depth}`}
            </span>
          )}
        </span>
        <span className="shrink-0 flex items-center gap-1">
          {/* Search this position further — past the limit, by a step — while
              it runs or once it has stopped, as the cloud tabs ask again. */}
          {!paused && (
            <button
              onClick={() => { if (further) setTarget(further); setRunning(true); }}
              className="w-6 h-6 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
              title={further ? `Search further: to ${kind === "lc0" ? `${fmtNodes(further)} nodes` : `depth ${further}`}` : "Search again"}
            >⟳</button>
          )}
          {/* Run and pause are the engine's tab's own button (onTogglePause);
              without one, a plain Stop. */}
          {!onTogglePause && running && (
            <button
              onClick={() => setRunning(false)}
              className="h-6 px-2 rounded-full text-label-sm text-primary hover:bg-primary/8 active:bg-primary/12 transition-colors duration-short3 ease-standard"
              title="Stop the search"
            >
              Stop
            </button>
          )}
        </span>
      </div>
      {status.update_available && status.latest && (
        <div className="px-3 py-1 text-label-sm text-on-surface-variant border-b border-outline/40">
          Stockfish {status.latest.version} is out — this server runs {status.version}.{" "}
          <button onClick={() => void openUrl(status.latest!.url)} className="text-primary hover:underline inline-flex items-center">
            Download<ExternalLinkIcon />
          </button>
          {status.os === "linux" ? " and install it as /usr/local/bin/stockfish on the server." : " and install it on the server."}
        </div>
      )}
      {streamError && <div className="px-3 py-1 text-error text-body-sm">{streamError}</div>}
      <div className="flex-1 overflow-y-auto p-2">
        {lines.length === 0 ? (
          <div className="p-2 text-center text-on-surface-variant text-body-sm">
            {paused ? "Paused." : running ? "Analysing…" : "Stopped."}
          </div>
        ) : <>
        {repliesOn && (
          <div className="flex items-baseline gap-2 text-label-sm text-on-surface-variant px-2 mb-1 select-none">
            <span className="flex-1 min-w-0"></span>
            <span className="w-12 text-right cursor-help underline decoration-dotted underline-offset-2" title="The opponent's legal replies after this move.">Replies</span>
            <span className="w-12 text-right cursor-help underline decoration-dotted underline-offset-2" title="Replies close to the opponent's best (the threshold is set under Maintenance → Engines). Low ⇒ forcing.">Strong</span>
            <span className={kind === "lc0" ? "w-32" : "w-14"}></span>
          </div>
        )}
        {lines.map((l, i) => {
          const { child, rs: rc } = l;
          const deepTitle = l.deepDepth != null
            ? `From the analysis of the position after this move: ${kind === "lc0" ? `${fmtNodes(l.deepNodes ?? 0)} nodes` : `depth ${l.deepDepth}`}`
            : undefined;
          return (
          <div key={l.multipv} className="w-full flex items-baseline gap-2 px-2 py-1 rounded-sm hover:bg-on-surface/8 transition-colors duration-short3 ease-standard">
            <div className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-body-sm text-on-surface-variant">
              <PvLine startFen={fen} sans={pvToSan(fen, l.pv_uci)} onPick={onPlayLine} mark={moveMark(markBest, markScores[i], markThreshold, neutralThreshold)} />
            </div>
            {repliesOn && (
              <>
                <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface-variant">{child ? legalReplies(child) : "—"}</span>
                <StrongCell rc={rc} waiting={!paused} />
              </>
            )}
            {kind === "lc0" && l.wdl
              ? <span title={deepTitle}><WdlCell wdl={l.wdl} /></span>
              : (
                <span title={deepTitle} className={`shrink-0 w-14 text-right tabular-nums font-mono text-body-sm ${evalColor(scores[i])}`}>
                  {fmtLichess({ evalCp: l.eval_cp, mate: l.mate, pvUci: l.pv_uci })}
                </span>
              )}
          </div>
          );
        })}
        </>}
      </div>
    </div>
  );
}

/** Whether `next` goes further than `prev` — the server's rule for what it
 *  remembers: Lc0 by nodes (its "depth" is only the average length of its
 *  lines, and can fall as the search grows), Stockfish by depth and then by
 *  nodes; never with fewer lines. */
function deeper(kind: EngineKind, next: Snapshot, prev: Snapshot): boolean {
  if (next.lines.length < prev.lines.length) return false;
  if (kind === "lc0") return next.nodes > prev.nodes;
  return next.depth > prev.depth || (next.depth === prev.depth && next.nodes > prev.nodes);
}

/** The position after `uci` is played from `fen`, or null. */
function childFen(fen: string, uci: string | undefined): string | null {
  if (!uci) return null;
  try {
    const c = new Chess(fen);
    c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    return c.fen();
  } catch {
    return null;
  }
}

/** Where the server's count of strong replies stands for one candidate. */
interface ReplyState {
  state: "done" | "counting" | "waiting" | "failed" | "none";
  count?: { replies: number; strong: number; depth: number; nodes: number };
  pct?: number;
  error?: string;
  /** The position analysed deeper than the helpers count: its best line
   *  (White-relative) and how deep. */
  line?: EngineLine;
  line_depth?: number;
  line_nodes?: number;
  /** The count is a lower bound: every line of the deeper analysis is strong. */
  at_least?: boolean;
}

/** The opponent's legal replies in `fen`. */
function legalReplies(fen: string): number {
  try { return new Chess(fen).moves().length; } catch { return 0; }
}

/** The Strong column: the count; while counting, how far it has got; "…"
 *  while waiting for a helper (or for the search to settle); "—" when there is
 *  no count — paused before one was made, or it failed. */
function StrongCell({ rc, waiting }: { rc: ReplyState | undefined; waiting: boolean }) {
  const cls = "shrink-0 w-12 text-right tabular-nums text-body-sm";
  if (rc?.state === "done" && rc.count) {
    return (
      <span className={`${cls} text-on-surface`} title={rc.at_least ? "At least: every line of the deeper analysis is strong" : undefined}>
        {rc.count.strong}{rc.at_least ? "+" : ""}
      </span>
    );
  }
  if (rc?.state === "counting") return <span className={`${cls} text-on-surface-variant`} title="Being counted">{rc.pct ?? 0}%</span>;
  if (rc?.state === "waiting" || (waiting && !rc)) {
    return <span className={`${cls} text-on-surface-variant/60`} title={rc ? "Waiting for a free helper" : "Counted once the search has settled"}>…</span>;
  }
  return <span className={`${cls} text-on-surface-variant`} title={rc?.state === "failed" ? rc.error : "Not counted"}>—</span>;
}

/** "956k", "10.0M": Lc0 is measured in nodes. */
function fmtNodes(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

/** Lc0's view of a line: White wins, draw, Black wins, as percentages, with a
 *  bar in the board's colours — its evaluation is a probability, not pawns. */
function WdlCell({ wdl }: { wdl: [number, number, number] }) {
  const [w, d, b] = wdl.map((v) => Math.round(v / 10));
  return (
    <span
      className="shrink-0 w-32 flex items-center gap-1.5 justify-end tabular-nums font-mono text-body-sm text-on-surface"
      title={`White wins ${w}%, draw ${d}%, Black wins ${b}%`}
    >
      <span>{w}·{d}·{b}</span>
      <span className="w-10 h-2 flex rounded-sm overflow-hidden border border-outline/60">
        <span className="bg-white" style={{ width: `${wdl[0] / 10}%` }} />
        <span className="bg-outline/60" style={{ width: `${wdl[1] / 10}%` }} />
        <span className="bg-neutral-900" style={{ width: `${wdl[2] / 10}%` }} />
      </span>
    </span>
  );
}

/** No Lc0, or no network for it: what it needs, and where things go. */
function Lc0Guide({ status, checking, onCheck }: { status: EngineStatus; checking: boolean; onCheck: () => void }) {
  const code = "block font-mono text-label-md bg-surface-container rounded-sm px-2 py-1 mt-1 select-all";
  const netDir = status.settings_file.replace(/lc0\.json$/, "networks");
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3 text-body-sm text-on-surface">
      <div>
        <div className="text-title-sm">{status.available ? "Lc0 has no network" : "No Lc0 on the server"}</div>
        <p className="text-on-surface-variant mt-1">
          Lc0 (Leela Chess Zero) judges a position with a neural network and gives its chances as win, draw
          and loss. It is optional: it needs a graphics card to be fast — with an NVIDIA card it analyses
          tens of thousands of positions a second, on a processor a few hundred.
        </p>
      </div>
      {!status.available && (
        <div>
          <div className="text-label-lg">Install Lc0 on the server</div>
          {status.os === "windows" && (
            <p className="text-on-surface-variant mt-1">
              Download it from lczero.org — the CUDA build for an NVIDIA card, the onnx-dml build for any
              other — and put lc0.exe in C:\Program Files\Lc0.
            </p>
          )}
          {status.os === "macos" && <code className={code}>brew install lc0</code>}
          {status.os === "linux" && (
            <p className="text-on-surface-variant mt-1">
              Lc0 publishes no Linux download; it is built from source, with the backend for the graphics
              card, and installed as /usr/local/bin/lc0. The guide has the steps.
            </p>
          )}
        </div>
      )}
      <div>
        <div className="text-label-lg">A network</div>
        <p className="text-on-surface-variant mt-1">
          Download one from lczero.org (Play → Networks) — a medium network such as t3-512x15x16h suits a
          modern card — and put the .pb.gz file on the server in
        </p>
        <code className={code}>{netDir}</code>
      </div>
      {status.error && status.path && <p className="text-error">{status.error}</p>}
      <button
        onClick={() => void openUrl("https://github.com/specure/lpdo/blob/main/docs/chess-engine.md#leela-chess-zero")}
        className="text-primary hover:underline inline-flex items-center text-body-sm"
      >
        The guide: installing Lc0<ExternalLinkIcon />
      </button>
      <div />
      <button
        onClick={onCheck}
        disabled={checking}
        className="h-8 px-3 rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 disabled:opacity-50 transition-all duration-short3 ease-standard"
      >
        {checking ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

/** What to do when the server has no engine: install one where the server
 *  runs, then check again. */
function InstallGuide({ status, checking, onCheck }: { status: EngineStatus; checking: boolean; onCheck: () => void }) {
  const code = "block font-mono text-label-md bg-surface-container rounded-sm px-2 py-1 mt-1 select-all";
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3 text-body-sm text-on-surface">
      <div>
        <div className="text-title-sm">No chess engine on the server</div>
        <p className="text-on-surface-variant mt-1">
          LPDO uses an engine you install, the way ChessBase lets you add Stockfish beside Fritz. It
          runs on the machine the LPDO server runs on
          {status.os ? ` (${status.os === "macos" ? "macOS" : status.os === "windows" ? "Windows" : "Linux"})` : ""}.
          Stockfish is free and among the strongest.
        </p>
      </div>
      {status.os === "linux" && (
        <div>
          <div className="text-label-lg">Install Stockfish</div>
          <div className="text-on-surface-variant mt-1">Debian, Ubuntu, Mint:</div>
          <code className={code}>sudo apt install stockfish</code>
          <div className="text-on-surface-variant mt-2">Fedora:</div>
          <code className={code}>sudo dnf install stockfish</code>
          <div className="text-on-surface-variant mt-2">Arch:</div>
          <code className={code}>sudo pacman -S stockfish</code>
          <p className="text-on-surface-variant mt-2">
            A distribution's package can be a few versions old (Ubuntu 24.04 has Stockfish 16). For the
            newest, download the Linux build from stockfishchess.org and install it as
            /usr/local/bin/stockfish; the server prefers it to the package.
          </p>
        </div>
      )}
      {status.os === "macos" && (
        <div>
          <div className="text-label-lg">Install Stockfish</div>
          <div className="text-on-surface-variant mt-1">With Homebrew:</div>
          <code className={code}>brew install stockfish</code>
        </div>
      )}
      {status.os !== "linux" && status.os !== "macos" && (
        <div>
          <div className="text-label-lg">Install Stockfish</div>
          <p className="text-on-surface-variant mt-1">
            Download the Windows build from stockfishchess.org, unpack it, and copy the program to
            this path, renamed to stockfish.exe (it takes an administrator account):
          </p>
          <code className={code}>C:\Program Files\Stockfish\stockfish.exe</code>
        </div>
      )}
      <div>
        <div className="text-label-lg">Another engine, or another place</div>
        <p className="text-on-surface-variant mt-1">
          Any UCI engine works. If it is not in a standard location, name it on the server in the
          file below. On Linux the server cannot see home directories, so keep the engine elsewhere,
          such as /usr/local/bin or /opt.
        </p>
        <code className={code}>{status.settings_file}</code>
        <code className={code}>{`{ "path": "/path/to/engine" }`}</code>
      </div>
      {status.error && status.path && (
        <p className="text-error">{status.error}</p>
      )}
      <button
        onClick={() => void openUrl("https://github.com/specure/lpdo/blob/main/docs/chess-engine.md")}
        className="text-primary hover:underline inline-flex items-center text-body-sm"
      >
        The full guide, for every system<ExternalLinkIcon />
      </button>
      <div />
      <button
        onClick={onCheck}
        disabled={checking}
        className="h-8 px-3 rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 disabled:opacity-50 transition-all duration-short3 ease-standard"
      >
        {checking ? "Checking…" : "Check again"}
      </button>
      <details className="text-on-surface-variant">
        <summary className="cursor-pointer text-label-md">Where the server looked</summary>
        <ul className="mt-1 font-mono text-label-sm space-y-0.5">
          {status.searched.map((p) => <li key={p}>{p}</li>)}
        </ul>
      </details>
    </div>
  );
}
