import { useState, useEffect, useRef } from "react";
import { submitJob, cancelJob, jobEventsUrl, postJson, apiGet } from "../api";

// Job ids of in-flight operations, keyed by the caller-supplied `key`. Lives at
// module scope so it survives a component unmounting (e.g. navigating away from
// the Maintenance panel) — on remount the hook reconnects to the job.
const activeJobs = new Map<string, string>();

interface JobSnapshot {
  id: string;
  status: "queued" | "running" | "done" | "error";
  value: number;
  total: number;
  message: string;
  path?: string;
}

// Progress events streamed by the server's job runner (same shape the CLI
// emitted in --json mode).
interface ChessDbEvent {
  type: "log" | "progress" | "done" | "error";
  message?: string;
  value?: number;
  total?: number;
  /** Absolute path to a file the operation produced (e.g. a backup PGN),
   *  carried on the terminal "done" event so the UI can reveal it. */
  path?: string;
}

export interface SidecarProgress {
  percent: number;
  running: boolean;
  done: boolean;
  doneMessage: string;
  /** Result file path from the "done" event, when the command emitted one. */
  donePath: string | null;
  /** The latest status line (updated in place by progress events). Use this for
   *  a live "Indexed N / M games" readout instead of accumulating log lines. */
  message: string;
  /** Discrete log lines (milestones, warnings, errors) — NOT the rolling
   *  progress counter, which would flood this. */
  log: string[];
  /** A terminal failure: the args couldn't be translated, the submit request
   *  failed (e.g. the daemon is unreachable), or the job emitted an "error"
   *  event. Set with running=false so callers can surface it even though no job
   *  is running or done — otherwise a failed submit looks like nothing happened.
   *  Cleared by reset() and at the start of the next run(). */
  error: string | null;
  /** Run an operation. Accepts the legacy CLI-style argument array; it is
   *  translated to an HTTP job or a quick mutation against the server. */
  run: (args: string[]) => void;
  /** Stream progress from a job started elsewhere. `submit` performs the request
   *  that creates the job (e.g. a dedicated endpoint) and resolves to its id. */
  runJob: (submit: () => Promise<string>) => void;
  reset: () => void;
  /** Cancel the in-flight job. No-op when nothing is running. */
  cancel: () => void;
}

// ── CLI-args → server request translation ─────────────────────────────────────
//
// Call sites still pass the historical CLI argument arrays (e.g.
// ["download","--from","1649","--dir","…"]). We translate them here so the
// many components that call `run([...])` need no changes. Long operations map
// to /jobs (streamed via SSE); fast single-game edits map to direct mutation
// endpoints (a single synchronous response).

type Plan =
  | { kind: "job"; type: string; params: Record<string, unknown> }
  | { kind: "mutation"; path: string; body?: unknown };

function flagVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function planFromArgs(args: string[]): Plan {
  const [a0, a1] = args;
  switch (a0) {
    case "download": {
      const params: Record<string, unknown> = {};
      const from = flagVal(args, "--from");
      if (from) params.from = Number(from);
      const dir = flagVal(args, "--dir");
      if (dir) params.dir = dir;
      return { kind: "job", type: "download", params };
    }
    case "import": {
      const params: Record<string, unknown> = { fast: hasFlag(args, "--fast") };
      const dir = flagVal(args, "--dir");
      if (dir) params.dir = dir;
      return { kind: "job", type: "import", params };
    }
    case "import-pgn": {
      // #121: the GUI sends the PGN *content* (read client-side, so it works for
      // files under the user's home that the sandboxed daemon can't reach); a
      // bare positional path is still accepted for daemon-local files.
      const content = flagVal(args, "--content");
      const params: Record<string, unknown> =
        content !== undefined ? { content } : { path: a1 };
      const collection = flagVal(args, "--collection");
      if (collection) params.collection = collection;
      const onDup = flagVal(args, "--on-duplicate");
      if (onDup) params.on_duplicate = onDup;
      if (hasFlag(args, "--fast")) params.fast = true;
      if (hasFlag(args, "--private")) params.private = true;
      return { kind: "job", type: "import_pgn", params };
    }
    case "index-positions":
      return {
        kind: "job",
        type: "index_positions",
        params: { fast: hasFlag(args, "--fast"), rebuild: hasFlag(args, "--rebuild") },
      };
    case "backup": {
      const params: Record<string, unknown> = {};
      const c = flagVal(args, "--collection");
      if (c) params.collection = c;
      const d = flagVal(args, "--dir");
      if (d) params.dir = d;
      return { kind: "job", type: "backup", params };
    }
    case "players": {
      if (a1 === "import") return { kind: "job", type: "players_import", params: { path: args[2] } };
      if (a1 === "export") {
        const params: Record<string, unknown> = {};
        const d = flagVal(args, "--dir");
        if (d) params.dir = d;
        return { kind: "job", type: "players_export", params };
      }
      if (a1 === "normalise") {
        const params: Record<string, unknown> = {};
        const limit = flagVal(args, "--limit");
        if (limit) params.limit = Number(limit);
        if (hasFlag(args, "--stop-on-errors")) params.stop_on_errors = true;
        return { kind: "job", type: "normalise", params };
      }
      break;
    }
    case "games": {
      switch (a1) {
        case "dedup":
          return { kind: "job", type: "dedup_games", params: {} };
        case "purge":
          return { kind: "mutation", path: "/purge" };
        case "soft-delete":
          return { kind: "mutation", path: `/games/${args[2]}/soft-delete` };
        case "restore":
          return { kind: "mutation", path: `/games/${args[2]}/restore` };
        case "set-visibility":
          return { kind: "mutation", path: `/games/${args[2]}/visibility`, body: { visibility: args[3] } };
        case "add-collection":
          return { kind: "mutation", path: `/games/${args[2]}/collections`, body: { name: args[3] } };
        case "remove-collection":
          return { kind: "mutation", path: `/games/${args[2]}/collections/remove`, body: { name: args[3] } };
      }
      break;
    }
  }
  throw new Error(`Unsupported operation: ${args.join(" ")}`);
}

/**
 * Track a server operation's progress.
 *
 * Pass a stable `key` for long operations so progress survives the component
 * unmounting and remounting (e.g. leaving and returning to the Maintenance
 * panel): the running job id is remembered at module scope and the hook
 * reconnects to it on mount. Without a key, progress is purely local.
 */
export function useSidecarProgress(key?: string): SidecarProgress {
  const [percent, setPercent] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [doneMessage, setDoneMessage] = useState("");
  const [donePath, setDonePath] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const jobIdRef = useRef<string | null>(null);

  function closeStream() {
    esRef.current?.close();
    esRef.current = null;
  }

  function reset() {
    closeStream();
    if (key) activeJobs.delete(key);
    jobIdRef.current = null;
    setPercent(0);
    setRunning(false);
    setDone(false);
    setLog([]);
    setMessage("");
    setDoneMessage("");
    setDonePath(null);
    setError(null);
  }

  function cancel() {
    const id = jobIdRef.current;
    if (id) void cancelJob(id);
  }

  function handleEvent(data: ChessDbEvent) {
    if (data.type === "log") {
      // Discrete milestone — keep it in the log and as the current status.
      if (data.message) {
        setLog((l) => [...l, data.message!]);
        setMessage(data.message);
      }
    } else if (data.type === "progress") {
      // Rolling counter — update percent + the single status line, do NOT
      // append (that's what flooded the log box).
      if (data.total && data.total > 0) {
        setPercent(Math.min(99, ((data.value ?? 0) / data.total) * 100));
      }
      if (data.message) setMessage(data.message);
    } else if (data.type === "done") {
      setPercent(100);
      setRunning(false);
      setDone(true);
      if (data.message) {
        setDoneMessage(data.message);
        setMessage(data.message);
      }
      if (data.path) setDonePath(data.path);
      if (key) activeJobs.delete(key);
      closeStream();
    } else if (data.type === "error") {
      // Errors are worth keeping in the log.
      if (data.message) {
        setLog((l) => [...l, `⚠ ${data.message}`]);
        setMessage(data.message);
      }
      setError(data.message || "The operation failed.");
      setRunning(false);
      if (key) activeJobs.delete(key);
      closeStream();
    }
  }

  // Open (or re-open) the SSE stream for a job id and route its events.
  function openStream(jobId: string) {
    closeStream();
    jobIdRef.current = jobId;
    const es = new EventSource(jobEventsUrl(jobId));
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        handleEvent(JSON.parse(ev.data) as ChessDbEvent);
      } catch {
        /* ignore parse errors */
      }
    };
    es.onerror = () => {
      // The browser auto-reconnects; if the job already finished we have closed
      // the stream, so this only fires on genuine transport drops.
    };
  }

  function run(args: string[]) {
    reset();
    setRunning(true);

    let plan: Plan;
    try {
      plan = planFromArgs(args);
    } catch (e) {
      failRun(String(e));
      return;
    }

    if (plan.kind === "mutation") {
      // Fast single-game edit: one synchronous request, surfaced as a "done".
      postJson<{ message?: string }>(plan.path, plan.body)
        .then((res) => handleEvent({ type: "done", message: res.message ?? "Done" }))
        .catch((e: unknown) => handleEvent({ type: "error", message: String(e) }));
      return;
    }

    // Long job: submit, then stream progress over SSE.
    submitJob({ type: plan.type, params: plan.params })
      .then((jobId) => {
        if (key) activeJobs.set(key, jobId);
        openStream(jobId);
      })
      .catch((e: unknown) => failRun(String(e)));
  }

  // A submit/translation failure never reaches the "error" event path (no job
  // was created), so surface it here — otherwise the caller flips back to its
  // idle state with the failure buried in the log, and the click looks inert.
  function failRun(msg: string) {
    setRunning(false);
    setLog((l) => [...l, `Error: ${msg}`]);
    setError(msg);
  }

  // Stream a job created by an arbitrary request (e.g. POST /schedule/run),
  // rather than the generic /jobs submit. Mirrors the long-job branch of run().
  function runJob(submit: () => Promise<string>) {
    reset();
    setRunning(true);
    submit()
      .then((jobId) => {
        if (key) activeJobs.set(key, jobId);
        openStream(jobId);
      })
      .catch((e: unknown) => failRun(String(e)));
  }

  // On mount, reconnect to a job left running under this key (e.g. the user
  // navigated away mid-operation and came back).
  useEffect(() => {
    if (!key) return;
    const jobId = activeJobs.get(key);
    if (!jobId) return;
    let cancelled = false;
    apiGet<JobSnapshot>(`/jobs/${jobId}`)
      .then((snap) => {
        if (cancelled) return;
        if (snap.status === "queued" || snap.status === "running") {
          setRunning(true);
          if (snap.total > 0) setPercent(Math.min(99, (snap.value / snap.total) * 100));
          if (snap.message) setMessage(snap.message);
          openStream(jobId); // replays buffered events, then streams live
        } else if (snap.status === "done") {
          setDone(true);
          setPercent(100);
          setDoneMessage(snap.message || "Done");
          if (snap.path) setDonePath(snap.path);
          activeJobs.delete(key);
        } else {
          activeJobs.delete(key); // error — let the user start fresh
        }
      })
      .catch(() => {
        // Job unknown (e.g. server restarted) — drop the stale reference.
        activeJobs.delete(key);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => () => closeStream(), []);

  return { percent, running, done, doneMessage, donePath, message, log, error, run, runJob, reset, cancel };
}
