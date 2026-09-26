import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { apiUrl, engineAnalyseUrl, type EngineHistory } from "../api";
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
  settings: { path: string | null; threads: number; hash_mb: number };
  found: string[];
  searched: string[];
  settings_file: string;
  os: string;
  version: string | null;
  latest: { version: string; url: string } | null;
  update_available: boolean;
}

interface Snapshot {
  gen: number;
  depth: number;
  nodes: number;
  nps: number;
  lines: { multipv: number; eval_cp: number | null; mate: number | null; pv_uci: string[] }[];
  done: boolean;
  /** Remembered from an earlier search of this position. */
  cached?: boolean;
}

export default function LocalEngine({
  fen,
  history,
  lineCount,
  onPlayLine,
}: {
  fen: string;
  /** How the position arose — lets the engine see repetitions. */
  history?: EngineHistory;
  lineCount: number;
  onPlayLine?: (sans: string[]) => void;
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
      const res = await fetch(apiUrl("/engine"));
      if (!res.ok) throw new Error((await res.text()) || `${res.status}`);
      setStatus((await res.json()) as EngineStatus);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => { void loadStatus(); }, []);

  // Analyse the position on the board: a new stream per position, a moment
  // after the board settles. Closing the stream stops the search on the
  // server, so moving through a game does not leave searches running.
  const historyKey = history ? `${history.startFen}|${history.sans.join(",")}` : "";
  const historyRef = useRef(history);
  historyRef.current = history;
  useEffect(() => {
    esRef.current?.close();
    esRef.current = null;
    setSnap(null);
    setStreamError(null);
    if (!status?.available || !running) return;
    const t = window.setTimeout(() => {
      const es = new EventSource(engineAnalyseUrl(fen, lineCount, historyRef.current));
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
  }, [fen, historyKey, lineCount, status?.available, running]);

  // A new position starts a new search, even if the last one was stopped.
  useEffect(() => { setRunning(true); }, [fen]);

  if (statusError) {
    return <div className="p-3 text-center text-error text-body-sm">{statusError}</div>;
  }
  if (!status) {
    return <div className="p-3 text-center text-on-surface-variant text-body-sm">Looking for an engine…</div>;
  }
  if (!status.available) {
    return <InstallGuide status={status} checking={checking} onCheck={() => void loadStatus()} />;
  }

  const white = fen.split(" ")[1] !== "b";
  const lines = snap?.lines ?? [];
  const scores = lines.map((l) => moverScore(l.eval_cp, l.mate, white));
  const best = scores.length ? Math.max(...scores) : 0;
  const speed = snap?.nps ? `${(snap.nps / 1e6).toFixed(snap.nps >= 1e7 ? 0 : 1)} Mn/s` : "";

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-1 shrink-0 flex items-center justify-between gap-2 text-label-sm text-on-surface-variant border-b border-outline/40">
        <span className="min-w-0 truncate" title={status.path ?? undefined}>
          {status.name ?? "Engine"}{snap ? ` · depth ${snap.depth}` : ""}
          {snap?.cached
            ? <span title="Remembered from an earlier search; the engine is deepening it"> · remembered</span>
            : speed ? ` · ${speed}` : ""}
        </span>
        <button
          onClick={() => setRunning((r) => !r)}
          className="h-6 px-2 shrink-0 rounded-full text-label-sm text-primary hover:bg-primary/8 active:bg-primary/12 transition-colors duration-short3 ease-standard"
          title={running ? "Stop the engine" : "Analyse this position again"}
        >
          {running ? "Stop" : "Analyse"}
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
            {running ? "Analysing…" : "Stopped."}
          </div>
        ) : lines.slice(0, lineCount).map((l, i) => (
          <div key={l.multipv} className="w-full flex items-baseline gap-2 px-2 py-1 rounded-sm hover:bg-on-surface/8 transition-colors duration-short3 ease-standard">
            <div className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-body-sm text-on-surface-variant">
              <PvLine startFen={fen} sans={pvToSan(fen, l.pv_uci)} onPick={onPlayLine} mark={moveMark(best, scores[i]) || undefined} />
            </div>
            <span className={`shrink-0 w-14 text-right tabular-nums font-mono text-body-sm ${evalColor(scores[i])}`}>
              {fmtLichess({ evalCp: l.eval_cp, mate: l.mate, pvUci: l.pv_uci })}
            </span>
          </div>
        ))}
      </div>
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
            Download it from stockfishchess.org, unpack it, and name the program in the settings file
            below.
          </p>
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
