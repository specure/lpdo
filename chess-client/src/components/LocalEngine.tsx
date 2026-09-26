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
  settings: { path: string | null; threads: number; hash_mb: number; replies?: boolean };
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

interface Snapshot {
  gen: number;
  depth: number;
  nodes: number;
  nps: number;
  /** `wdl`: White's win, the draw, Black's win, in permille. */
  lines: { multipv: number; eval_cp: number | null; mate: number | null; pv_uci: string[]; wdl?: [number, number, number] | null }[];
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
    if (snapForRef.current !== snapFor) { setSnap(null); snapForRef.current = snapFor; }
    if (!status?.available || !running || paused) return;
    // Running again on the same position: the lines stay until the new
    // search is deeper, as a remembered result does.
    setSnap((prev) => (prev ? { ...prev, cached: true } : prev));
    const t = window.setTimeout(() => {
      const es = new EventSource(engineAnalyseUrl(fen, lineCount, historyRef.current, kind));
      esRef.current = es;
      es.onmessage = (ev) => {
        const s = JSON.parse(ev.data) as Snapshot;
        setSnap((prev) => (prev?.cached && !s.cached && s.depth <= prev.depth ? prev : s));
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
  }, [fen, historyKey, lineCount, status?.available, running, kind, paused]);

  // Replies & Strong (when switched on for this engine): for each candidate,
  // the server's helper counts the opponent's replies and the strong ones.
  // Asked once the search has settled, one candidate after another; each
  // position is asked once and remembered.
  const repliesOn = !!status?.settings.replies;
  const [replyCounts, setReplyCounts] = useState<Record<string, { replies: number; strong: number } | "pending">>({});
  const askedRef = useRef<Set<string>>(new Set());
  const settled = !!snap && (kind === "lc0" ? snap.nodes >= 100_000 : snap.depth >= 16);
  const candidates = (snap?.lines ?? []).slice(0, lineCount).map((l) => l.pv_uci[0]).filter(Boolean);
  const candidateKey = candidates.join(",");
  useEffect(() => {
    if (!repliesOn || !settled) return;
    const todo = candidates
      .map((uci) => childFen(fen, uci))
      .filter((f): f is string => !!f && !askedRef.current.has(f));
    if (todo.length === 0) return;
    const ctrl = new AbortController();
    (async () => {
      for (const child of todo) {
        if (ctrl.signal.aborted) return;
        askedRef.current.add(child);
        setReplyCounts((prev) => ({ ...prev, [child]: "pending" }));
        try {
          const r = await fetch(apiUrl(`/engine/replies?engine=${kind}&fen=${encodeURIComponent(child)}`), { signal: ctrl.signal });
          if (!r.ok) throw new Error();
          const c = (await r.json()) as { replies: number; strong: number };
          setReplyCounts((prev) => ({ ...prev, [child]: c }));
        } catch {
          askedRef.current.delete(child);
          setReplyCounts((prev) => { const next = { ...prev }; delete next[child]; return next; });
          if (ctrl.signal.aborted) return;
        }
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repliesOn, settled, candidateKey, fen, kind]);

  // A new position starts a new search, even if the last one was stopped.
  useEffect(() => { setRunning(true); }, [fen]);

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
  const lines = snap?.lines ?? [];
  const scores = lines.map((l) => moverScore(l.eval_cp, l.mate, white));
  const best = scores.length ? Math.max(...scores) : 0;
  // Stockfish counts in millions a second, Lc0 in thousands.
  const speed = !snap?.nps ? "" : snap.nps >= 1e6 ? `${(snap.nps / 1e6).toFixed(snap.nps >= 1e7 ? 0 : 1)} Mn/s` : `${Math.round(snap.nps / 1e3)}k n/s`;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-1 shrink-0 flex items-center justify-between gap-2 text-label-sm text-on-surface-variant border-b border-outline/40">
        <span className="min-w-0 truncate" title={status.path ?? undefined}>
          {status.name ?? "Engine"}
          {snap ? (kind === "lc0" ? ` · ${fmtNodes(snap.nodes)} nodes` : ` · depth ${snap.depth}`) : ""}
          {snap?.done && !snap.cached ? " · done" : ""}
          {snap?.cached
            ? <span title="Remembered from an earlier search; the engine is deepening it"> (cached)</span>
            : speed ? ` · ${speed}` : ""}
        </span>
        <button
          onClick={() => {
            if (paused) onTogglePause?.();
            else if (!running) setRunning(true);
            else if (onTogglePause) onTogglePause();
            else setRunning(false);
          }}
          className="h-6 px-2 shrink-0 rounded-full text-label-sm text-primary hover:bg-primary/8 active:bg-primary/12 transition-colors duration-short3 ease-standard"
          title={paused ? "Run the engine" : running ? "Pause the engine" : "Analyse this position again"}
        >
          {paused ? "Run" : running ? "Pause" : "Analyse"}
        </button>
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
        {lines.slice(0, lineCount).map((l, i) => {
          const child = childFen(fen, l.pv_uci[0]);
          const rc = child ? replyCounts[child] : undefined;
          return (
          <div key={l.multipv} className="w-full flex items-baseline gap-2 px-2 py-1 rounded-sm hover:bg-on-surface/8 transition-colors duration-short3 ease-standard">
            <div className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-body-sm text-on-surface-variant">
              <PvLine startFen={fen} sans={pvToSan(fen, l.pv_uci)} onPick={onPlayLine} mark={moveMark(best, scores[i]) || undefined} />
            </div>
            {repliesOn && (
              <>
                <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface-variant">{rc === "pending" ? "…" : rc ? rc.replies : "—"}</span>
                <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface">{rc === "pending" ? "…" : rc ? rc.strong : "—"}</span>
              </>
            )}
            {kind === "lc0" && l.wdl
              ? <WdlCell wdl={l.wdl} />
              : (
                <span className={`shrink-0 w-14 text-right tabular-nums font-mono text-body-sm ${evalColor(scores[i])}`}>
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
