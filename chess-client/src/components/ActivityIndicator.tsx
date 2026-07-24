import { useState, useEffect, useRef } from "react";
import { getJobs, cancelJob } from "../api";
import type { Job } from "../types";

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
    case "import":             return "Import";
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

function ActiveRow({ job, eta, onCancel }: { job: Job; eta?: string; onCancel: (id: string) => void }) {
  const queued = job.status === "queued";
  const known = job.total > 0;
  return (
    <div className="px-4 py-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-body-sm text-on-surface truncate">{jobLabel(job)}</span>
        {/* Queued jobs can always be cancelled (they haven't started). A running
            job is cancellable when interruptible — an appender (fast) write can
            corrupt the DB if killed mid-flight, so those aren't. (#161) */}
        {(queued || (job.status === "running" && job.interruptible)) && (
          <button
            onClick={() => onCancel(job.id)}
            className="shrink-0 h-6 px-2 inline-flex items-center rounded-full text-error border border-outline text-label-sm hover:bg-error/8 transition-colors duration-short3 ease-standard"
          >
            Cancel
          </button>
        )}
      </div>
      {queued ? (
        <div className="text-label-sm text-on-surface-variant">{job.message ? `Queued · ${job.message}` : "Queued"}</div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-label-sm text-on-surface-variant">
            <span className="truncate">{job.message || "Working…"}</span>
            {known && <span className="shrink-0">{Math.round(pct(job))}%{eta ? ` · ${eta}` : ""}</span>}
          </div>
          <div className="w-full bg-surface-container-highest rounded-full h-1.5 overflow-hidden">
            <div
              className={`bg-primary h-1.5 rounded-full ${known ? "transition-all duration-short3 ease-standard" : "w-1/3 animate-pulse"}`}
              style={known ? { width: `${pct(job)}%` } : undefined}
            />
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
        <div className="text-body-sm text-on-surface truncate">{jobLabel(job)}</div>
        {job.status === "error" && job.error && <div className="text-label-sm text-error break-words">{job.error}</div>}
        {(ok || cancelled) && job.message && <div className="text-label-sm text-on-surface-variant truncate">{job.message}</div>}
      </div>
    </div>
  );
}

export default function ActivityIndicator() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [etas, setEtas] = useState<Map<string, string>>(new Map());
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Per-job {time, value} anchor for a cumulative-rate ETA. Cumulative (since the
  // job was first seen running) is stable for a monotonic byte counter, and the
  // anchor resets if the value ever goes backwards (a new job reusing an id).
  const anchorRef = useRef<Map<string, { t0: number; v0: number }>>(new Map());

  // Poll the pipeline. It's a cheap local read, and the daemon keeps working
  // even when this view is closed, so a steady poll keeps the badge honest.
  useEffect(() => {
    let stop = false;
    const poll = () => {
      getJobs().then((j) => {
        if (stop) return;
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
  // recent newest-first so the latest finish is on top.
  const active = all.filter((j) => j.status === "running" || j.status === "queued");
  const recent = all
    .filter((j) => j.status === "done" || j.status === "error" || j.status === "cancelled")
    .slice(-8)
    .reverse();
  const busy = active.length > 0;

  function handleCancel(id: string) {
    void cancelJob(id);
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
            {active.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[22rem] max-h-[28rem] overflow-y-auto z-50 rounded-2xl border border-outline-variant bg-surface-container-high shadow-lg">
          <div className="px-4 py-3 border-b border-outline-variant flex items-center justify-between">
            <span className="text-title-sm text-on-surface">Activity</span>
            <span className="text-label-sm text-on-surface-variant">
              {busy ? `${active.length} active` : "Idle"}
            </span>
          </div>

          {jobs === null ? (
            <div className="px-4 py-6 text-body-sm text-on-surface-variant">Loading…</div>
          ) : active.length === 0 && recent.length === 0 ? (
            <div className="px-4 py-6 text-body-sm text-on-surface-variant">No background activity.</div>
          ) : (
            <>
              {active.length > 0 && (
                <div className="divide-y divide-outline-variant">
                  {active.map((j) => <ActiveRow key={j.id} job={j} eta={etas.get(j.id)} onCancel={handleCancel} />)}
                </div>
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
