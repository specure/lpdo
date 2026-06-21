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
  log: string[];
  /** Run an operation. Accepts the legacy CLI-style argument array; it is
   *  translated to an HTTP job or a quick mutation against the server. */
  run: (args: string[]) => void;
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
      const params: Record<string, unknown> = { path: a1 };
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
  const [log, setLog] = useState<string[]>([]);
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
    setDoneMessage("");
    setDonePath(null);
  }

  function cancel() {
    const id = jobIdRef.current;
    if (id) void cancelJob(id);
  }

  function handleEvent(data: ChessDbEvent) {
    if (data.type === "log") {
      if (data.message) setLog((l) => [...l, data.message!]);
    } else if (data.type === "progress") {
      if (data.total && data.total > 0) {
        setPercent(Math.min(99, ((data.value ?? 0) / data.total) * 100));
      }
      if (data.message) setLog((l) => [...l, data.message!]);
    } else if (data.type === "done") {
      setPercent(100);
      setRunning(false);
      setDone(true);
      if (data.message) {
        setDoneMessage(data.message);
        setLog((l) => [...l, data.message!]);
      }
      if (data.path) setDonePath(data.path);
      if (key) activeJobs.delete(key);
      closeStream();
    } else if (data.type === "error") {
      if (data.message) setLog((l) => [...l, `⚠ ${data.message}`]);
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
      setRunning(false);
      setLog((l) => [...l, `Error: ${String(e)}`]);
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
      .catch((e: unknown) => {
        setRunning(false);
        setLog((l) => [...l, `Error: ${String(e)}`]);
      });
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
          // The SSE buffer replay (in openStream) repopulates the log, so don't
          // also seed a line here — that would duplicate it.
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

  return { percent, running, done, doneMessage, donePath, log, run, reset, cancel };
}
