// Crash diagnostics for a desktop app with no console.
//
// A render error unmounts the tree and leaves a blank window; a rejected promise
// or a stray exception leaves no trace at all. Both used to be unreportable —
// by the time anyone looked, the evidence was gone. Every one is now appended
// here with a timestamp and whatever context we have, and read back under
// Maintenance → Others → Diagnostics, so a crash can be reported rather than
// reconstructed from memory.
//
// localStorage rather than a file: it survives the reload that follows a crash,
// needs no Tauri permissions, and is readable in the browser build too.

const KEY = "crashLog";
const MAX = 25;          // newest first; older entries fall off the end
const MAX_STACK = 4000;  // keep an entry readable and the quota safe

export interface CrashEntry {
  at: string;            // ISO timestamp
  kind: "render" | "error" | "rejection";
  message: string;
  stack?: string;
  componentStack?: string;
  /** Which screen was open, and anything else the app volunteered. */
  context?: Record<string, string>;
  appVersion?: string;
  userAgent?: string;
}

/** Breadcrumbs the app keeps current, attached to whatever fails next. */
let context: Record<string, string> = {};
export function setCrashContext(patch: Record<string, string>) {
  context = { ...context, ...patch };
}

let appVersion: string | undefined;
export function setAppVersion(v: string) { appVersion = v; }

export function readCrashLog(): CrashEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as CrashEntry[]) : [];
  } catch { return []; }
}

export function clearCrashLog() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function recordCrash(
  kind: CrashEntry["kind"],
  error: unknown,
  extra?: { componentStack?: string },
) {
  try {
    const err = error instanceof Error ? error : null;
    const entry: CrashEntry = {
      at: new Date().toISOString(),
      kind,
      message: err ? `${err.name}: ${err.message}` : String(error),
      stack: err?.stack?.slice(0, MAX_STACK),
      componentStack: extra?.componentStack?.slice(0, MAX_STACK),
      context: Object.keys(context).length ? { ...context } : undefined,
      appVersion,
      userAgent: navigator.userAgent,
    };
    const next = [entry, ...readCrashLog()].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Diagnostics must never become the thing that breaks the app.
  }
}

/** One report to paste into an issue. */
export function formatCrashLog(entries: CrashEntry[] = readCrashLog()): string {
  if (entries.length === 0) return "No crashes recorded.";
  return entries.map((e) => [
    `── ${e.at} · ${e.kind}${e.appVersion ? ` · v${e.appVersion}` : ""}`,
    e.context ? `context: ${Object.entries(e.context).map(([k, v]) => `${k}=${v}`).join(" ")}` : null,
    e.message,
    e.stack,
    e.componentStack ? `component stack:${e.componentStack}` : null,
  ].filter(Boolean).join("\n")).join("\n\n");
}

/** Catch what React's error boundary cannot: stray exceptions and rejected
 *  promises. Installed once, from the entry point. */
export function installCrashHandlers() {
  window.addEventListener("error", (e) => {
    // Resource load failures (img/script) also fire this with no error object;
    // they are not crashes and would drown the useful entries.
    if (e.error) recordCrash("error", e.error);
  });
  window.addEventListener("unhandledrejection", (e) => {
    recordCrash("rejection", e.reason);
  });
}
