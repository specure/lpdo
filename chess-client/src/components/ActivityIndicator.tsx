import { useState, useEffect, useRef } from "react";
import { getJobs, cancelJob, retryJob, getCloudWatches, deleteCloudWatch } from "../api";
import type { Job } from "../types";
import type { CloudWatch } from "../api";

// ── Global background-activity view (#40 Phase C3) ────────────────────────────
//
// A header indicator that expands into a panel showing the daemon's whole job
// pipeline — the active job, the queue behind it, and recent finishes — across
// every job type (source syncs, the scheduled update, manual maintenance like
// dedup/index/backup). Background work runs serially on the daemon and even
// continues with the GUI closed, so it deserves one always-visible home.
// Source cards keep their own inline per-source progress (C1); this is the
// global view that also covers the non-source and post-import jobs.

const POLL_MS = 1500;

// Catalog source keys → display names, so a sync job reads as the source name.
const SOURCE_NAMES: Record<string, string> = {
  "twic": "The Week in Chess",
  "lichess-broadcasts": "Lichess Broadcasts",
  "ajedrez-otb": "Ajedrez Data — OTB",
};

/** A human label for a job, derived from its type + params. */
function jobLabel(j: Job): string {
  const p = (j.params ?? {}) as Record<string, string>;
  const src = p.source ? SOURCE_NAMES[p.source] ?? p.source : "";
  switch (j.type) {
    case "sources_sync":       return `Sync ${src}`;
    case "sources_set_enabled": {
      const enabled = (j.params as Record<string, unknown> | undefined)?.enabled;
      return `${enabled === false ? "Disable" : "Enable"} ${src || "source"}`;
    }
    case "sources_set_window": return `Set date range · ${src || "source"}`;
    case "update":             return "Scheduled update";
    case "fide_refresh":       return "Update FIDE player list";
    case "index_positions":    return "Build position index";
    case "dedup_games":        return "Deduplicate games";
    case "dedup_players":      return "Merge duplicate players";
    case "cleanup":            return "Clean up games";
    case "normalise":          return "Normalise player names";
    case "resolve_fide":       return "Fetch missing FIDE IDs";
    case "download":           return src ? `Download ${src}` : "Download";
    case "import":             return src ? `Import ${src}` : "Import";
    case "import_pgn": {
      // Prefer the original filename (what's importing); the collection (where it
      // lands) is the fallback for content/paste imports that have no file.
      const f = p.filename;
      const c = p.collection;
      if (f) return c ? `Import ${f} → ${c}` : `Import ${f}`;
      return c ? `Import PGN → ${c}` : "Import PGN";
    }
    case "maintenance_pending": return "Prepare database — resolve · dedup · normalise · index";
    case "players_import":     return "Import players";
    case "players_export":     return "Export players";
    case "backup":             return p.collection ? `Backup ${p.collection}` : "Backup";
    default:                   return j.type;
  }
}

function pct(j: Job): number {
  return j.total > 0 ? Math.min(100, (j.value / j.total) * 100) : 0;
}

/** "~45s left" / "~12 min left" / "~1h 20m left" from a seconds estimate. */
function formatEta(sec: number): string {
  if (sec < 60) return `~${Math.round(sec)}s left`;
  const min = Math.round(sec / 60);
  if (min < 60) return `~${min} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `~${h}h ${m}m left` : `~${h}h left`;
}

/** "just now" / "5 min ago" / "2h ago" / "3d ago" from an epoch-ms timestamp. */
function formatAgo(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** "30s" / "2 min" / "1h 5m" from a duration in ms (how long a job ran). */
function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return s ? `${min}m ${s}s` : `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "~45s" / "~14 min" until a future epoch-ms timestamp (offline retry, #206). */
function formatUntil(ms: number): string {
  const sec = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (sec < 60) return `~${sec}s`;
  return `~${Math.round(sec / 60)} min`;
}

function ActiveRow({ job, eta, cancelling, onCancel, onRetry }: { job: Job; eta?: string; cancelling: boolean; onCancel: (id: string) => void; onRetry: (id: string) => void }) {
  const queued = job.status === "queued";
  const waiting = job.status === "waiting";
  const known = job.total > 0;
  return (
    <div className="px-4 py-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-body-sm text-on-surface line-clamp-2 break-words">{jobLabel(job)}</span>
        <div className="flex items-center gap-1 shrink-0">
          {/* A network job paused offline (#206) can be retried immediately. */}
          {waiting && (
            <button
              onClick={() => onRetry(job.id)}
              className="h-6 px-2 inline-flex items-center rounded-full text-primary border border-outline text-label-sm hover:bg-primary/8 transition-colors duration-short3 ease-standard"
            >
              Retry now
            </button>
          )}
          {/* Queued/waiting jobs can always be cancelled (they haven't started /
              are paused). A running job shows Cancel when it honours cooperative
              cancellation (#157/#161). Cancellation is cooperative, so once
              requested the button shows "Cancelling…" until the job stops. */}
          {(queued || waiting || (job.status === "running" && job.cancellable)) && (
            <button
              onClick={() => onCancel(job.id)}
              disabled={cancelling}
              className="h-6 px-2 inline-flex items-center rounded-full text-error border border-outline text-label-sm hover:bg-error/8 transition-colors duration-short3 ease-standard disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent"
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </div>
      </div>
      {queued ? (
        <div className="text-label-sm text-on-surface-variant break-words">{job.message ? `Queued · ${job.message}` : "Queued"}</div>
      ) : waiting ? (
        <div className="text-label-sm text-warning break-words">
          {job.message || "Offline — waiting for a connection"}
          {job.retry_at ? ` · retry ${formatUntil(job.retry_at)}` : ""}
        </div>
      ) : (
        <>
          {/* The live progress line updates ~1×/s; keep it single-line so it
              doesn't reflow/jitter as the message and % change. */}
          <div className="flex items-center justify-between gap-2 text-label-sm text-on-surface-variant">
            <span className="truncate">{job.message || "Working…"}</span>
            {known ? (
              <span className="shrink-0">{Math.round(pct(job))}%{eta ? ` · ${eta}` : ""}</span>
            ) : (
              // Unmeasured running job: no % to show, so surface elapsed time (#170).
              job.status === "running" && job.started_at != null && (
                <span className="shrink-0">{formatDuration(Date.now() - job.started_at)}</span>
              )
            )}
          </div>
          <div className="relative w-full bg-surface-container-highest rounded-full h-1.5 overflow-hidden">
            {known ? (
              <div
                className="bg-primary h-1.5 rounded-full transition-all duration-short3 ease-standard"
                style={{ width: `${pct(job)}%` }}
              />
            ) : (
              // Unmeasured step (total unknown): a sweeping segment that clearly
              // reads as "working", not a bar stuck at some percentage.
              <div className="lpdo-indeterminate bg-primary" />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RecentRow({ job }: { job: Job }) {
  const ok = job.status === "done";
  const cancelled = job.status === "cancelled";
  // ✓ done (green) · ⊘ cancelled (muted) · ✕ error (red)
  const { icon, color } = ok
    ? { icon: "✓", color: "text-success" }
    : cancelled
    ? { icon: "⊘", color: "text-on-surface-variant" }
    : { icon: "✕", color: "text-error" };
  return (
    <div className="px-4 py-2 flex items-start gap-2">
      <span className={`text-base leading-5 shrink-0 ${color}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-body-sm text-on-surface line-clamp-2 break-words">{jobLabel(job)}</div>
        {job.status === "error" && job.error && <div className="text-label-sm text-error break-words">{job.error}</div>}
        {(ok || cancelled) && job.message && <div className="text-label-sm text-on-surface-variant line-clamp-2 break-words">{job.message}</div>}
        {/* When it finished and, for a job that actually ran, how long it took
            (#170). Live-session only — timestamps reset on daemon restart. */}
        {job.ended_at && (
          <div className="text-label-sm text-on-surface-variant">
            {formatAgo(job.ended_at)}
            {job.started_at ? ` · took ${formatDuration(job.ended_at - job.started_at)}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

/** Window event dispatched when a deepen watch lands (depth grew). The Games
 *  engine panel listens for it to auto-refresh if it's on that position. */
export const CLOUD_WATCH_LANDED = "lpdo:cloud-watch-landed";

function WatchRow({ w, onDismiss }: { w: CloudWatch; onDismiss: (fen: string) => void }) {
  const landed = w.status === "landed";
  return (
    <div className="px-4 py-2 flex items-start gap-2">
      <span className={`text-base leading-5 shrink-0 ${landed ? "text-success" : "text-on-surface-variant"}`}>
        {landed ? "✓" : "⌁"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-body-sm text-on-surface line-clamp-2 break-words">
          {landed ? "Deeper analysis ready" : "Watching for deeper analysis"}
        </div>
        {w.label && <div className="text-label-sm text-on-surface-variant line-clamp-1 break-words">{w.label}</div>}
        <div className="text-label-sm text-on-surface-variant">
          chessdb depth {landed ? `${w.baseline_depth} → ${w.current_depth}` : `${w.current_depth} (from ${w.baseline_depth})`}
        </div>
      </div>
      <button
        onClick={() => onDismiss(w.fen)}
        className="shrink-0 text-label-sm text-on-surface-variant hover:text-on-surface transition-colors duration-short3 ease-standard"
        title={landed ? "Dismiss" : "Stop watching"}
      >
        {landed ? "Dismiss" : "Stop"}
      </button>
    </div>
  );
}

// `onSettled` fires once each time a job newly reaches a terminal state
// (done/error/cancelled). The host uses it to refresh views that a background
// job may have changed — notably the collection list, which imports populate
// long after the app first loaded it (#—: player-filter dropdown showed a stale
// "TWIC 0" while imports built three collections in the background).
export default function ActivityIndicator({ onSettled }: { onSettled?: () => void } = {}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [etas, setEtas] = useState<Map<string, string>>(new Map());
  // Ids the user has asked to cancel — the job keeps running until it reaches a
  // committed boundary (cooperative cancel), so the button shows "Cancelling…"
  // meanwhile. Cleared once the job is no longer active (see the poll below).
  const [cancelling, setCancelling] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const [watches, setWatches] = useState<CloudWatch[]>([]);
  // Zobrist keys already seen "landed", so a landing fires its notification once.
  // Seeded on first poll so pre-existing landed watches don't fire on mount.
  const landedSeenRef = useRef<Set<number> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Per-job {time, value} anchor for a cumulative-rate ETA. Cumulative (since the
  // job was first seen running) is stable for a monotonic byte counter, and the
  // anchor resets if the value ever goes backwards (a new job reusing an id).
  const anchorRef = useRef<Map<string, { t0: number; v0: number }>>(new Map());
  // Latest onSettled, held in a ref so the poll effect (mounted once) always
  // calls the current closure without re-subscribing.
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  // Ids already observed in a terminal state, so each completion fires onSettled
  // exactly once. Seeded on the first poll (below) so pre-existing history from
  // before mount doesn't fire a spurious refresh.
  const settledRef = useRef<Set<string> | null>(null);

  // Poll the pipeline. It's a cheap local read, and the daemon keeps working
  // even when this view is closed, so a steady poll keeps the badge honest.
  useEffect(() => {
    let stop = false;
    const poll = () => {
      getJobs().then((j) => {
        if (stop) return;
        // Detect jobs that newly reached a terminal state and notify the host
        // once each (imports create/populate collections in the background).
        const terminalNow = j
          .filter((x) => x.status === "done" || x.status === "error" || x.status === "cancelled")
          .map((x) => x.id);
        if (settledRef.current === null) {
          settledRef.current = new Set(terminalNow); // seed: don't fire for old history
        } else {
          const seen = settledRef.current;
          let fresh = false;
          for (const id of terminalNow) if (!seen.has(id)) { seen.add(id); fresh = true; }
          if (fresh) onSettledRef.current?.();
        }
        const now = Date.now();
        const anchors = anchorRef.current;
        const live = new Set(j.map((x) => x.id));
        for (const id of anchors.keys()) if (!live.has(id)) anchors.delete(id);
        const nextEtas = new Map<string, string>();
        for (const job of j) {
          if (job.status !== "running" || !(job.total > 0)) continue;
          let a = anchors.get(job.id);
          if (!a || job.value < a.v0) { a = { t0: now, v0: job.value }; anchors.set(job.id, a); }
          const dv = job.value - a.v0;
          const dt = (now - a.t0) / 1000;
          if (dv > 0 && dt >= 2) {
            const remaining = ((job.total - job.value) / dv) * dt; // (total-value)/rate
            if (isFinite(remaining) && remaining >= 0) nextEtas.set(job.id, formatEta(remaining));
          }
        }
        setJobs(j);
        setEtas(nextEtas);
        // Drop "Cancelling…" markers for jobs that have left the active set
        // (finished/cancelled), so a reused id can't stay stuck disabled.
        setCancelling((prev) => {
          if (prev.size === 0) return prev;
          const stillActive = new Set(
            j.filter((x) => x.status === "queued" || x.status === "running" || x.status === "waiting").map((x) => x.id),
          );
          let changed = false;
          const next = new Set<string>();
          for (const id of prev) { if (stillActive.has(id)) next.add(id); else changed = true; }
          return changed ? next : prev;
        });
      }).catch(() => { /* offline — leave last known */ });
      // Deepen watches (chessdb): poll alongside jobs; fire once per landing.
      getCloudWatches().then((w) => {
        if (stop) return;
        const landedNow = w.filter((x) => x.status === "landed");
        if (landedSeenRef.current === null) {
          landedSeenRef.current = new Set(landedNow.map((x) => x.zobrist)); // seed
        } else {
          const seen = landedSeenRef.current;
          for (const x of landedNow) {
            if (!seen.has(x.zobrist)) {
              seen.add(x.zobrist);
              window.dispatchEvent(new CustomEvent(CLOUD_WATCH_LANDED, { detail: { fen: x.fen, zobrist: x.zobrist } }));
              onSettledRef.current?.();
            }
          }
        }
        setWatches(w);
      }).catch(() => { /* offline — leave last known */ });
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { stop = true; clearInterval(id); };
  }, []);

  // Dismiss the panel on an outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const all = jobs ?? [];
  // Submission order (oldest→newest); active oldest-first reads as the pipeline,
  // recent newest-first so the latest finish is on top. "waiting" (offline-
  // paused, #206) is active — it's still in the pipeline, just retrying.
  const active = all.filter((j) => j.status === "running" || j.status === "queued" || j.status === "waiting");
  const recent = all
    .filter((j) => j.status === "done" || j.status === "error" || j.status === "cancelled")
    .slice(-8)
    .reverse();
  const watching = watches.filter((w) => w.status === "watching");
  const landed = watches.filter((w) => w.status === "landed");
  // Watches count toward "busy" so the badge reflects the whole pipeline.
  const activeCount = active.length + watching.length;
  const busy = activeCount > 0;

  function handleCancel(id: string) {
    setCancelling((s) => new Set(s).add(id));
    void cancelJob(id);
  }

  function handleRetry(id: string) {
    void retryJob(id);
  }

  function handleDismissWatch(fen: string) {
    setWatches((prev) => prev.filter((w) => w.fen !== fen));
    void deleteCloudWatch(fen);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Background activity"
        aria-label="Background activity"
        className={`relative w-9 h-9 inline-flex items-center justify-center rounded-full text-label-md transition-colors duration-short3 ease-standard ${
          open ? "bg-on-surface/12" : "text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12"
        }`}
      >
        <span className={busy ? "inline-block animate-spin" : "inline-block"}>⟳</span>
        {busy && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[1rem] h-4 px-1 inline-flex items-center justify-center rounded-full bg-primary text-on-primary text-[0.625rem] font-bold leading-none">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[26rem] max-h-[28rem] overflow-y-auto z-50 rounded-2xl border border-outline-variant bg-surface-container-high shadow-lg">
          <div className="px-4 py-3 border-b border-outline-variant flex items-center justify-between">
            <span className="text-title-sm text-on-surface">Activity</span>
            <span className="text-label-sm text-on-surface-variant">
              {busy ? `${activeCount} active` : "Idle"}
            </span>
          </div>

          {jobs === null ? (
            <div className="px-4 py-6 text-body-sm text-on-surface-variant">Loading…</div>
          ) : active.length === 0 && recent.length === 0 && watches.length === 0 ? (
            <div className="px-4 py-6 text-body-sm text-on-surface-variant">No background activity.</div>
          ) : (
            <>
              {active.length > 0 && (
                <div className="divide-y divide-outline-variant">
                  {active.map((j) => <ActiveRow key={j.id} job={j} eta={etas.get(j.id)} cancelling={cancelling.has(j.id)} onCancel={handleCancel} onRetry={handleRetry} />)}
                </div>
              )}
              {(landed.length > 0 || watching.length > 0) && (
                <>
                  <div className="px-4 pt-3 pb-1 text-label-sm text-on-surface-variant uppercase tracking-wider">Deepen watches</div>
                  <div className="divide-y divide-outline-variant">
                    {landed.map((w) => <WatchRow key={w.zobrist} w={w} onDismiss={handleDismissWatch} />)}
                    {watching.map((w) => <WatchRow key={w.zobrist} w={w} onDismiss={handleDismissWatch} />)}
                  </div>
                </>
              )}
              {recent.length > 0 && (
                <>
                  <div className="px-4 pt-3 pb-1 text-label-sm text-on-surface-variant uppercase tracking-wider">Recent</div>
                  <div className="pb-2">
                    {recent.map((j) => <RecentRow key={j.id} job={j} />)}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
