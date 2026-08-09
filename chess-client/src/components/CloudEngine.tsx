import { useEffect, useRef, useState, type ReactNode } from "react";
import { Chess } from "chess.js";
import { addCloudWatch, getCloudWatches } from "../api";
import { CLOUD_WATCH_REMOVED, CLOUD_WATCH_UPDATED } from "./ActivityIndicator";

// Cloud engine evaluation of one position (#221), from chessdb.cn or Lichess
// (Stockfish) through the daemon, which caches by position. Lifted out of the
// Games page so the Analysis board can show the same panel — it owns the source
// toggle, the fetching, the power-move stats and the deepen-watch wiring, and
// takes only the position to evaluate.
//
// It fetches while mounted, so hosts that hide it (a collapsed panel, an
// inactive tab) should unmount it rather than hide it — no evaluations are then
// requested for a position nobody is looking at. Remounting refetches, which is
// a daemon-cache round trip.

// One candidate move + its score.
interface CloudMove { san: string; uci: string; scoreCp: number; mate: number | null; winrate: number | null; rank: number; note: string; }

/** chessdb note "! (20-04)" → { mark:"!", opp:"20", oppStrong:"04" }; null for mate/odd notes. */
function parseNote(note: string): { mark: string; opp: string; oppStrong: string } | null {
  const m = note.match(/^\s*(\S*)\s*\((\d+)-(\d+)\)/);
  return m ? { mark: m[1], opp: m[2], oppStrong: m[3] } : null;
}

type EngineSource = "chessdb" | "lichess";
type EngineStatus = "loading" | "ok" | "unknown" | "offline";

// Lichess (Stockfish) cloud eval — a few deep PV lines, White-relative eval + depth.
interface LichessLine { evalCp: number | null; mate: number | null; pvUci: string[]; }
interface LichessEval { status: EngineStatus; depth: number; knodes: number; lines: LichessLine[]; }

/** Convert a UCI principal variation to SAN by replaying it from `fen`. */
function pvToSan(fen: string, pvUci: string[]): string[] {
  const chess = new Chess(fen);
  const sans: string[] = [];
  for (const uci of pvUci) {
    try {
      const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: (uci.slice(4, 5) || undefined) as ("q" | "r" | "b" | "n" | undefined) });
      if (!mv) break;
      sans.push(mv.san);
    } catch { break; }
  }
  return sans;
}

/** Render a SAN line with move numbers starting from `fen`'s move/side. */
export function pvString(fen: string, sans: string[]): string {
  const parts = fen.split(" ");
  let n = parseInt(parts[5] || "1", 10);
  let white = parts[1] !== "b";
  const toks: string[] = [];
  sans.forEach((s, i) => {
    if (white) toks.push(`${n}.${s}`);
    else { toks.push(i === 0 ? `${n}...${s}` : s); n += 1; }
    white = !white;
  });
  return toks.join(" ");
}

/** A numbered SAN line. With `onPick` each move is clickable — picking one jumps
 *  to the position after it; without it the line is read-only (the Analysis board
 *  has no notion of "play this line" that isn't an edit). Rendered on a single
 *  line by the parent (overflow-hidden), so the tail truncates to fit. */
function PvLine({ startFen, sans, onPick, mark }: { startFen: string; sans: string[]; onPick?: (prefix: string[]) => void; mark?: string }) {
  const parts = startFen.split(" ");
  let n = parseInt(parts[5] || "1", 10);
  let white = parts[1] !== "b";
  const toks: ReactNode[] = [];
  sans.forEach((s, i) => {
    const label = white ? `${n}.` : i === 0 ? `${n}…` : "";
    toks.push(
      <span key={i} className="whitespace-nowrap">
        {label && <span className="text-outline select-none">{label}</span>}
        {/* The first move is the candidate — accent it, and hang its mark off it. */}
        <span
          className={`${onPick ? "cursor-pointer hover:text-primary" : ""} ${i === 0 ? "font-semibold text-on-surface" : ""}`}
          onClick={onPick ? (e) => { e.stopPropagation(); onPick(sans.slice(0, i + 1)); } : undefined}
        >{s}</span>
        {i === 0 && mark && <span className={`font-semibold ${mark === "?" ? "text-error" : "text-primary"}`}>{mark}</span>}{" "}
      </span>,
    );
    if (!white) n += 1;
    white = !white;
  });
  return <>{toks}</>;
}

/** Lichess eval (White-relative): "+0.14", "-2.36", "M1" / "-M1". */
function fmtLichess(l: LichessLine): string {
  if (l.mate !== null) return l.mate > 0 ? `M${l.mate}` : `-M${-l.mate}`;
  const p = (l.evalCp ?? 0) / 100;
  return (p > 0 ? "+" : "") + p.toFixed(2);
}

// Bringing chessdb's "power move" lens to Stockfish (#221). Reverse-engineered
// from chessdb: a move within ~0.05 of the best is "strong" (chessdb marks the
// best "!" and treats anything >0.05 worse as "?"), AND — crucially — once the
// position itself is lost (best move worse than ~-0.7, i.e. win% under ~45%),
// chessdb marks *everything* "?": no point flagging the opponent's "good" replies
// when you're already lost. These constants match that behaviour.
const STRONG_MARK_CP = 1; // within 0.01 of best ⇒ "!" (chessdb marks equal-best near-ties too)
const STRONG_CP = 5;      // ≤0.05 behind best = normal; >0.05 = weak (?). Measured boundary.
const LOST_CP = -70;      // best move worse than -0.70 ⇒ position lost, all moves "?"

/** Eval from the side-to-move's perspective, in centipawns (mate ⇒ ±huge, nearer
 *  mates ranked higher). Lichess evals are White-relative, so flip for Black. */
function moverScore(evalCp: number | null, mate: number | null, whiteToMove: boolean): number {
  if (mate != null && mate !== 0) {
    const m = whiteToMove ? mate : -mate;
    return m > 0 ? 100000 - m : -100000 - m;
  }
  const cp = evalCp ?? 0;
  return whiteToMove ? cp : -cp;
}

/** chessdb-style quality mark for a line, given the position's best score:
 *  "!" = best (tied for top), "" = normal (within 0.05 of best), "?" = weak
 *  (>0.05 behind). Everything is "?" in a lost position (best worse than LOST_CP). */
function moveMark(best: number, score: number): string {
  if (best < LOST_CP) return "?";
  const drop = best - score;
  return drop <= STRONG_MARK_CP ? "!" : drop <= STRONG_CP ? "" : "?";
}

/** Score from the side-to-move's perspective, e.g. "+0.30", "-1.15", "M3". */
function fmtEval(m: CloudMove): string {
  if (m.mate !== null) return m.mate > 0 ? `M${m.mate}` : `-M${-m.mate}`;
  const p = m.scoreCp / 100;
  return (p > 0 ? "+" : "") + p.toFixed(2);
}
function evalColor(m: CloudMove): string {
  const v = m.mate !== null ? m.mate : m.scoreCp;
  return v > 0 ? "text-success" : v < 0 ? "text-error" : "text-on-surface-variant";
}

interface Props {
  /** The position to evaluate. */
  fen: string;
  /** Name for a deepen watch, shown in the activity panel. */
  watchLabel?: string;
  /** Play a PV prefix on the host's board. Omitted ⇒ the lines are read-only. */
  onPlayLine?: (sans: string[]) => void;
}

/** Renders as the contents of a panel (header row + body) — the host supplies the
 *  panel chrome, so it fits both the Games mosaic and the Analysis tab column. */
export default function CloudEngine({ fen, watchLabel, onPlayLine }: Props) {
  // Default to Lichess (Stockfish) — deep, real evals for popular positions. A
  // versioned key so flipping the default from chessdb actually takes effect on
  // existing installs (the old key was auto-written on every load). An explicit
  // toggle to chessdb still persists.
  const [engineSource, setEngineSource] = useState<EngineSource>(() => (localStorage.getItem("engineSourceV2") === "chessdb" ? "chessdb" : "lichess"));
  useEffect(() => { localStorage.setItem("engineSourceV2", engineSource); }, [engineSource]);
  const [engineMoves, setEngineMoves] = useState<CloudMove[]>([]);          // chessdb
  const [engineLines, setEngineLines] = useState<Record<string, string[]>>({}); // uci → continuation SAN (lazy)
  const [lichessEval, setLichessEval] = useState<LichessEval | null>(null); // lichess
  const [lichessStats, setLichessStats] = useState<Record<string, { replies: number; strong: number }>>({}); // uci → power-move stats (lazy)
  // Lichess analysis settings (persisted): chessdb-style Replies/Strong (extra
  // per-move requests) vs plain lines, and how many lines to show/analyse.
  const [lichessShowStats, setLichessShowStats] = useState(() => localStorage.getItem("lichessShowStats") !== "false");
  const [lichessLineCount, setLichessLineCount] = useState(() => {
    const n = parseInt(localStorage.getItem("lichessLineCount") ?? "", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 5;
  });
  const [lichessSettingsOpen, setLichessSettingsOpen] = useState(false);
  const lichessSettingsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { localStorage.setItem("lichessShowStats", String(lichessShowStats)); }, [lichessShowStats]);
  useEffect(() => { localStorage.setItem("lichessLineCount", String(lichessLineCount)); }, [lichessLineCount]);
  useEffect(() => {
    if (!lichessSettingsOpen) return;
    function onDown(e: MouseEvent) { if (lichessSettingsRef.current && !lichessSettingsRef.current.contains(e.target as Node)) setLichessSettingsOpen(false); }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [lichessSettingsOpen]);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("ok");
  const [engineQueuing, setEngineQueuing] = useState(false);
  // FENs with an active deepen watch — keep Deepen disabled for them so a second
  // click can't restart the watch (which would reset its baseline). Seeded from
  // the daemon on mount, then kept live via the landed/removed window events.
  const [watchedFens, setWatchedFens] = useState<Set<string>>(() => new Set());
  const engineAbort = useRef<AbortController | null>(null);
  // Reload button: bump the tick to re-run the engine fetch with refresh=true,
  // which bypasses the daemon's (24h) cache and re-queries the source.
  const [engineRefreshTick, setEngineRefreshTick] = useState(0);
  const engineRefreshingRef = useRef(false);
  function reloadEngine() { engineRefreshingRef.current = true; setEngineRefreshTick((t) => t + 1); }

  // Evaluation for the current position (debounced — hits the free chessdb.cn /
  // Lichess services through the daemon).
  useEffect(() => {
    engineAbort.current?.abort();
    const ctrl = new AbortController();
    engineAbort.current = ctrl;
    setEngineStatus("loading");
    const rq = engineRefreshingRef.current ? "&refresh=true" : ""; // reload bypasses cache
    engineRefreshingRef.current = false;
    const t = setTimeout(() => {
      if (engineSource === "chessdb") {
        setEngineLines({}); // clear stale continuation lines
        fetch(`/api/cloud-eval?fen=${encodeURIComponent(fen)}${rq}`, { signal: ctrl.signal })
          .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<{ status: EngineStatus; moves: CloudMove[] }>; })
          .then((d) => {
            setEngineMoves(d.moves ?? []); setEngineStatus(d.moves?.length ? "ok" : (d.status ?? "unknown"));
            // Lazy second pass: fetch the continuation lines (several querypv calls)
            // once the move table is on screen.
            if (d.moves?.length) {
              fetch(`/api/cloud-eval/lines?fen=${encodeURIComponent(fen)}${rq}`, { signal: ctrl.signal })
                .then((r) => (r.ok ? r.json() as Promise<{ uci: string; pvSan: string[] }[]> : []))
                .then((ls) => { const map: Record<string, string[]> = {}; for (const l of ls) map[l.uci] = l.pvSan; setEngineLines(map); })
                .catch(() => {});
            }
          })
          .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) { setEngineMoves([]); setEngineStatus("offline"); } });
      } else {
        fetch(`/api/lichess-eval?fen=${encodeURIComponent(fen)}${rq}`, { signal: ctrl.signal })
          .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<LichessEval>; })
          .then((d) => { setLichessEval(d); setEngineStatus(d.lines?.length ? "ok" : (d.status ?? "unknown")); })
          .catch((e) => { if (!(e instanceof DOMException && e.name === "AbortError")) { setLichessEval(null); setEngineStatus("offline"); } });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [fen, engineSource, engineRefreshTick]);

  // Power-move stats for Lichess (async, after the lines are on screen): for each
  // top line, fetch the child position's cloud eval and count the opponent's
  // replies + how many are "strong" (within STRONG_CP of the best). Sparse — only
  // where Lichess has the child position cached.
  useEffect(() => {
    if (engineSource !== "lichess" || !lichessShowStats || !lichessEval?.lines.length) { setLichessStats({}); return; }
    const oppWhite = fen.split(" ")[1] === "b"; // opponent (after our move) is White iff we're Black
    const ctrl = new AbortController();
    setLichessStats({});
    for (const l of lichessEval.lines.slice(0, lichessLineCount)) {
      const uci = l.pvUci[0];
      if (!uci) continue;
      let childFen: string;
      try {
        const c = new Chess(fen);
        c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
        childFen = c.fen();
      } catch { continue; }
      fetch(`/api/lichess-eval?fen=${encodeURIComponent(childFen)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<LichessEval>) : null))
        .then((ce) => {
          if (!ce || ce.status !== "ok" || !ce.lines.length) return;
          const scores = ce.lines.map((x) => moverScore(x.evalCp, x.mate, oppWhite));
          const best = Math.max(...scores);
          // If the opponent is lost after this move, none of their replies are
          // "strong" — don't imply they have good options.
          const strong = best < LOST_CP ? 0 : scores.filter((s) => best - s <= STRONG_CP).length;
          setLichessStats((prev) => ({ ...prev, [uci]: { replies: ce.lines.length, strong } }));
        })
        .catch(() => {});
    }
    return () => ctrl.abort();
  }, [fen, engineSource, lichessEval, lichessShowStats, lichessLineCount]);

  // Seed the set of actively-watched positions on mount (a watch may still be
  // running from before this panel was last shown).
  useEffect(() => {
    let stop = false;
    getCloudWatches()
      .then((ws) => { if (!stop) setWatchedFens(new Set(ws.filter((w) => w.status === "watching").map((w) => w.fen))); })
      .catch(() => {});
    return () => { stop = true; };
  }, []);

  // When a watch fires (chessdb revised the evals) for the position on screen,
  // silently refresh the move table so it reflects the update; and re-enable Deepen
  // (dropping the position from the watched set) on either a fire or a cancel.
  useEffect(() => {
    const drop = (f?: string) => {
      if (!f) return;
      setWatchedFens((prev) => { if (!prev.has(f)) return prev; const next = new Set(prev); next.delete(f); return next; });
    };
    function onUpdated(e: Event) {
      const f = (e as CustomEvent<{ fen: string }>).detail?.fen;
      drop(f); // watch fired — allow deepening again
      if (!f || f !== fen || engineSource !== "chessdb") return;
      fetch(`/api/cloud-eval?fen=${encodeURIComponent(f)}`)
        .then((r) => r.json() as Promise<{ status: EngineStatus; moves: CloudMove[] }>)
        .then((d) => {
          // Don't let a transient degraded response blank the panel; keep what's shown.
          if (d.status === "offline" || !d.moves?.length) return;
          setEngineMoves(d.moves); setEngineStatus("ok");
        })
        .catch(() => {});
    }
    function onRemoved(e: Event) {
      drop((e as CustomEvent<{ fen: string }>).detail?.fen); // cancelled — re-enable Deepen
    }
    window.addEventListener(CLOUD_WATCH_UPDATED, onUpdated);
    window.addEventListener(CLOUD_WATCH_REMOVED, onRemoved);
    return () => {
      window.removeEventListener(CLOUD_WATCH_UPDATED, onUpdated);
      window.removeEventListener(CLOUD_WATCH_REMOVED, onRemoved);
    };
  }, [fen, engineSource]);

  // Deepen: queue the position for deeper chessdb analysis *and* start a watch,
  // so the activity panel notifies when its evaluation changes (and this panel refetches
  // if it's still on screen). A quick refetch also picks up any immediate gain.
  function requestAnalysis() {
    setEngineQueuing(true);
    setWatchedFens((prev) => new Set(prev).add(fen)); // keep Deepen disabled until it lands/cancels
    addCloudWatch(fen, watchLabel || "Position") // add_watch queues the position and captures the baseline
      .then(() => new Promise((res) => setTimeout(res, 2500)))
      .then(() => fetch(`/api/cloud-eval?fen=${encodeURIComponent(fen)}`))
      .then((r) => r.json() as Promise<{ status: EngineStatus; moves: CloudMove[] }>)
      .then((d) => { setEngineMoves(d.moves ?? []); setEngineStatus(d.moves?.length ? "ok" : (d.status ?? "unknown")); })
      .catch(() => {})
      .finally(() => setEngineQueuing(false));
  }

  return (
    <>
      <div className="px-3 py-2 shrink-0 flex items-center justify-between border-b border-outline/40">
        <div className="flex gap-0.5">
          {(["chessdb", "lichess"] as EngineSource[]).map((src) => (
            <button
              key={src}
              onClick={() => setEngineSource(src)}
              className={`h-6 px-2 rounded-full text-label-sm transition-colors duration-short3 ease-standard ${engineSource === src ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-on-surface/8"}`}
            >
              {src === "chessdb" ? "chessdb" : "Lichess"}
            </button>
          ))}
        </div>
        <span
          className="text-label-sm text-on-surface-variant/70 cursor-help"
          title={engineSource === "chessdb" ? "Free cloud analysis from the community database chessdb.cn" : "Cloud Stockfish evaluations from lichess.org — only popular positions are cached"}
        >
          via {engineSource === "chessdb" ? "chessdb.cn" : "lichess.org"}
        </span>
      </div>
      {engineStatus === "loading" ? (
        <div className="p-3 text-center text-on-surface-variant text-body-sm">Analysing…</div>
      ) : engineStatus === "offline" ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center text-on-surface-variant text-body-sm px-3">
          <span>Engine unavailable — the free service may be busy or rate-limited.</span>
          <button onClick={reloadEngine} className="h-8 px-3 rounded-full text-label-md text-primary hover:bg-primary/8 active:bg-primary/12 transition-colors duration-short3 ease-standard">Reload</button>
        </div>
      ) : engineSource === "chessdb" ? (
        engineStatus === "unknown" || engineMoves.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 p-3 text-center">
            <span className="text-on-surface-variant text-body-sm">Not in the cloud database yet.</span>
            <button onClick={requestAnalysis} disabled={engineQueuing} className="h-8 px-3 rounded-full text-label-md text-primary hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard">
              {engineQueuing ? "Requested — analysing…" : "Request analysis"}
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-3 py-1 shrink-0 flex items-center justify-between text-label-sm text-on-surface-variant border-b border-outline/40">
              <span>chessdb</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={reloadEngine}
                  className="w-6 h-6 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
                  title="Discard the cached result and re-query chessdb.cn"
                >⟳</button>
                <button
                  onClick={requestAnalysis}
                  disabled={engineQueuing || watchedFens.has(fen)}
                  className="h-6 px-2 rounded-full text-primary hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard"
                  title="Ask chessdb.cn to analyse this position more deeply and watch for the result — the activity panel notifies you when its evaluation changes"
                >
                  {engineQueuing ? "Requested…" : watchedFens.has(fen) ? "Watching…" : "Deepen"}
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              <div className="flex items-baseline gap-2 text-label-sm text-on-surface-variant px-2 mb-1 select-none">
                <span className="flex-1 min-w-0"></span>
                <span className="w-12 text-right cursor-help underline decoration-dotted underline-offset-2" title="Opponent's total legal moves after this move.">Replies</span>
                <span className="w-12 text-right cursor-help underline decoration-dotted underline-offset-2" title="Opponent's strong ('power') replies after this move — a low number means a forcing line.">Strong</span>
                <span className="w-14 text-right">Eval</span>
              </div>
              {engineMoves.map((m) => {
                const nn = parseNote(m.note);
                const sans = [m.san, ...(engineLines[m.uci] ?? [])]; // move + continuation (lazy)
                return (
                  <div key={m.uci || m.san} className="w-full flex items-baseline gap-2 px-2 py-1 rounded-sm hover:bg-on-surface/8 transition-colors duration-short3 ease-standard">
                    <div className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-body-sm text-on-surface-variant">
                      <PvLine startFen={fen} sans={sans} onPick={onPlayLine} mark={nn && nn.mark && nn.mark !== "*" ? nn.mark : undefined} />
                    </div>
                    <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface-variant">{nn ? Number(nn.opp) : "—"}</span>
                    <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface">{nn ? Number(nn.oppStrong) : "—"}</span>
                    <span className={`shrink-0 w-14 text-right tabular-nums text-body-sm ${evalColor(m)}`}>{fmtEval(m)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )
      ) : (
        engineStatus === "unknown" || !lichessEval?.lines.length ? (
          <div className="flex-1 flex items-center justify-center text-center text-on-surface-variant text-body-sm px-3">Not in Lichess's cloud (only popular positions are cached).</div>
        ) : (() => {
          // Power-move marks (from the current position's own eval spread).
          const lmWhite = fen.split(" ")[1] !== "b";
          const lmScores = lichessEval.lines.map((l) => moverScore(l.evalCp, l.mate, lmWhite));
          const lmBest = lmScores.length ? Math.max(...lmScores) : 0;
          return (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="px-3 py-1 shrink-0 flex items-center justify-between text-label-sm text-on-surface-variant border-b border-outline/40">
                <span>Stockfish · depth {lichessEval.depth}</span>
                <div className="flex items-center gap-1">
                  <div className="relative" ref={lichessSettingsRef}>
                    <button
                      onClick={() => setLichessSettingsOpen((o) => !o)}
                      className={`w-6 h-6 inline-flex items-center justify-center rounded-full hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard ${lichessSettingsOpen ? "bg-on-surface/12" : ""}`}
                      title="Lichess analysis settings"
                    >⚙</button>
                    {lichessSettingsOpen && (
                      <div className="absolute right-0 top-7 z-20 w-60 rounded-xl border border-outline-variant bg-surface-container-high shadow-lg p-3 text-body-sm text-on-surface">
                        <div className="flex items-center justify-between gap-2">
                          <span>Replies &amp; Strong</span>
                          <button
                            onClick={() => setLichessShowStats((v) => !v)}
                            className={`px-2.5 h-6 rounded-full text-label-sm ${lichessShowStats ? "bg-primary text-on-primary" : "bg-on-surface/8 text-on-surface-variant"}`}
                          >{lichessShowStats ? "On" : "Off"}</button>
                        </div>
                        <div className="text-label-sm text-on-surface-variant mt-1">chessdb-style power-move columns — a few extra requests per move.</div>
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <span>Lines</span>
                          <div className="flex items-center gap-1">
                            {[3, 5, 8, 12].map((n) => (
                              <button
                                key={n}
                                onClick={() => setLichessLineCount(n)}
                                className={`w-7 h-6 rounded-md text-label-sm ${lichessLineCount === n ? "bg-primary text-on-primary" : "hover:bg-on-surface/8 text-on-surface-variant"}`}
                              >{n}</button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={reloadEngine}
                    className="w-6 h-6 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
                    title="Discard the cached result and re-query Lichess"
                  >⟳</button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {lichessShowStats && (
                  <div className="flex items-baseline gap-2 text-label-sm text-on-surface-variant px-2 mb-1 select-none">
                    <span className="flex-1 min-w-0"></span>
                    <span className="w-12 text-right cursor-help underline decoration-dotted underline-offset-2" title="Opponent's replies Lichess has cached after this move.">Replies</span>
                    <span className="w-12 text-right cursor-help underline decoration-dotted underline-offset-2" title="Opponent's strong replies — within 0.05 of their best. Low ⇒ forcing.">Strong</span>
                    <span className="w-14 text-right">Eval</span>
                  </div>
                )}
                {lichessEval.lines.slice(0, lichessLineCount).map((l, i) => {
                  const sans = pvToSan(fen, l.pvUci);
                  const st = lichessStats[l.pvUci[0]];
                  return (
                    <div key={i} className="w-full flex items-baseline gap-2 px-2 py-1 rounded-sm hover:bg-on-surface/8 transition-colors duration-short3 ease-standard">
                      <div className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-body-sm text-on-surface-variant">
                        <PvLine startFen={fen} sans={sans} onPick={onPlayLine} mark={moveMark(lmBest, lmScores[i]) || undefined} />
                      </div>
                      {lichessShowStats && <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface-variant">{st ? st.replies : "—"}</span>}
                      {lichessShowStats && <span className="shrink-0 w-12 text-right tabular-nums text-body-sm text-on-surface">{st ? st.strong : "—"}</span>}
                      <span className="shrink-0 w-14 text-right tabular-nums font-mono text-body-sm text-on-surface">{fmtLichess(l)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()
      )}
    </>
  );
}
