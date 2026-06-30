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
    case "sources_set_enabled":return `Update ${src || "source"}`;
    case "sources_set_window": return `Window ${src || "source"}`;
    case "update":             return "Scheduled update";
    case "index_positions":    return "Build position index";
    case "dedup_games":        return "Deduplicate games";
    case "cleanup":            return "Clean up games";
    case "normalise":          return "Normalise player names";
    case "import":             return "Import";
    case "import_pgn":         return p.collection ? `Import PGN → ${p.collection}` : "Import PGN";
    case "players_import":     return "Import players";
    case "players_export":     return "Export players";
    case "backup":             return p.collection ? `Backup ${p.collection}` : "Backup";
    default:                   return j.type;
  }
}

function pct(j: Job): number {
  return j.total > 0 ? Math.min(100, (j.value / j.total) * 100) : 0;
}

function ActiveRow({ job, onCancel }: { job: Job; onCancel: (id: string) => void }) {
  const queued = job.status === "queued";
  const known = job.total > 0;
  return (
    <div className="px-4 py-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-body-sm text-on-surface truncate">{jobLabel(job)}</span>
        {/* Cancel only running, interruptible jobs — an appender (fast) write
            can corrupt the DB if killed mid-flight, so it isn't cancelable. */}
        {job.status === "running" && job.interruptible && (
          <button
            onClick={() => onCancel(job.id)}
            className="shrink-0 h-6 px-2 inline-flex items-center rounded-full text-error border border-outline text-label-sm hover:bg-error/8 transition-colors duration-short3 ease-standard"
          >
            Cancel
          </button>
        )}
      </div>
      {queued ? (
        <div className="text-label-sm text-on-surface-variant">Queued</div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-label-sm text-on-surface-variant">
            <span className="truncate">{job.message || "Working…"}</span>
            {known && <span className="shrink-0">{Math.round(pct(job))}%</span>}
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
  return (
    <div className="px-4 py-2 flex items-start gap-2">
      <span className={`text-base leading-5 shrink-0 ${ok ? "text-success" : "text-error"}`}>{ok ? "✓" : "✕"}</span>
      <div className="min-w-0">
        <div className="text-body-sm text-on-surface truncate">{jobLabel(job)}</div>
        {!ok && job.error && <div className="text-label-sm text-error break-words">{job.error}</div>}
        {ok && job.message && <div className="text-label-sm text-on-surface-variant truncate">{job.message}</div>}
      </div>
    </div>
  );
}

export default function ActivityIndicator() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Poll the pipeline. It's a cheap local read, and the daemon keeps working
  // even when this view is closed, so a steady poll keeps the badge honest.
  useEffect(() => {
    let stop = false;
    const poll = () => { getJobs().then((j) => { if (!stop) setJobs(j); }).catch(() => { /* offline — leave last known */ }); };
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
  const recent = all.filter((j) => j.status === "done" || j.status === "error").slice(-8).reverse();
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
                  {active.map((j) => <ActiveRow key={j.id} job={j} onCancel={handleCancel} />)}
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
