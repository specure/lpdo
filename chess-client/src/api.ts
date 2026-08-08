// Central helpers for talking to the chess-db server over HTTP.
//
// fetch() calls use the relative "/api" prefix: in dev the Vite proxy forwards
// "/api/*" to the server (stripping "/api"); in a packaged app the fetch
// override in main.tsx rewrites it to the configured server. EventSource is NOT
// covered by that override, so SSE URLs are built explicitly here.
//
// The server may run on another machine (#247). Its address and access token are
// user settings, read live (not captured at module load) so changing them takes
// effect without restarting the app.

const DEFAULT_SERVER_URL = "http://127.0.0.1:7777";
const SERVER_URL_KEY = "serverUrl";
const SERVER_TOKEN_KEY = "serverToken";

/** The daemon's origin. Native (Tauri) HTTP calls — the streamed import upload
 *  (#154), backup download (#121) — must hit the server directly, so they take
 *  this rather than relying on the webview fetch override. */
export function serverUrl(): string {
  try {
    const v = localStorage.getItem(SERVER_URL_KEY)?.trim();
    return v ? v.replace(/\/+$/, "") : DEFAULT_SERVER_URL;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

/** Shared access token; empty for a loopback server, which requires none. */
export function serverToken(): string {
  try {
    return localStorage.getItem(SERVER_TOKEN_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setServerSettings(url: string, token: string): void {
  const clean = url.trim().replace(/\/+$/, "");
  if (clean && clean !== DEFAULT_SERVER_URL) localStorage.setItem(SERVER_URL_KEY, clean);
  else localStorage.removeItem(SERVER_URL_KEY);
  if (token.trim()) localStorage.setItem(SERVER_TOKEN_KEY, token.trim());
  else localStorage.removeItem(SERVER_TOKEN_KEY);
}

export function isDefaultServer(): boolean {
  return serverUrl() === DEFAULT_SERVER_URL;
}

export { DEFAULT_SERVER_URL };

/** Header name the server expects the token in (auth.rs TOKEN_HEADER). */
export const TOKEN_HEADER = "x-lpdo-token";

export function apiUrl(path: string): string {
  return "/api" + path;
}

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return res;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await ensureOk(await fetch(apiUrl(path)));
  return res.json() as Promise<T>;
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await ensureOk(
    await fetch(apiUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  // Some mutation endpoints return 204 No Content.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Absolute SSE URL for a job's event stream (EventSource bypasses the
 *  fetch override, so it needs the real server URL in a packaged app). */
export function jobEventsUrl(jobId: string): string {
  const path = `/jobs/${encodeURIComponent(jobId)}/events`;
  const base = import.meta.env.DEV ? "/api" + path : serverUrl() + path;
  // EventSource cannot set headers, so an authenticated server takes the token
  // as a query parameter here (see the middleware in serve.rs).
  const token = serverToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export interface JobRequest {
  type: string;
  params?: Record<string, unknown>;
}

export async function submitJob(req: JobRequest): Promise<string> {
  const { job_id } = await postJson<{ job_id: string }>("/jobs", req);
  return job_id;
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetch(apiUrl(`/jobs/${encodeURIComponent(jobId)}/cancel`), { method: "POST" });
}

/** Retry a job paused waiting for the network right now, instead of waiting out
 *  its retry timer (#206). */
export async function retryJob(jobId: string): Promise<void> {
  await fetch(apiUrl(`/jobs/${encodeURIComponent(jobId)}/retry`), { method: "POST" });
}

/** The daemon's whole job pipeline (active + queued + finished), newest last —
 *  what the global Activity view reads. */
export function getJobs(): Promise<Job[]> {
  return apiGet<Job[]>("/jobs");
}

// ── Deepen watches (chessdb depth, #221) ──────────────────────────────────────

/** A background poller that notifies when chessdb revises a position's evaluations. */
export interface CloudWatch {
  zobrist: number;
  fen: string;
  label: string;
  status: "watching" | "updated";
  /** Seconds from starting the watch to the evaluation changing (set once updated). */
  elapsed_secs: number | null;
}

/** Start watching a position for deeper chessdb analysis (also queues it). */
export async function addCloudWatch(fen: string, label: string): Promise<CloudWatch> {
  return postJson<CloudWatch>(`/cloud-eval/watch?fen=${encodeURIComponent(fen)}&label=${encodeURIComponent(label)}`);
}

/** Active + landed deepen watches. */
export function getCloudWatches(): Promise<CloudWatch[]> {
  return apiGet<CloudWatch[]>("/cloud-eval/watches");
}

/** Dismiss a deepen watch. */
export async function deleteCloudWatch(fen: string): Promise<void> {
  await fetch(apiUrl(`/cloud-eval/watch?fen=${encodeURIComponent(fen)}`), { method: "DELETE" });
}

// ── Sources (multi-source import catalog, #40) ────────────────────────────────

import type { SourceStatus, Job, StatusInfo, ScheduleInfo } from "./types";

/** The curated source catalog + this database's state for each. */
export function getSources(): Promise<SourceStatus[]> {
  return apiGet<SourceStatus[]>("/sources");
}

/** The update-check schedule + FIDE-list refresh status (#194). */
export function getSchedule(): Promise<ScheduleInfo> {
  return apiGet<ScheduleInfo>("/schedule");
}

/** Set the daily update-check time (minutes past local midnight). */
export async function setScheduleTime(dailyMinute: number): Promise<void> {
  await postJson("/schedule", { daily_minute: dailyMinute });
}

/** Server status, including `setup_status` (the first-run readiness state). */
export function getStatus(): Promise<StatusInfo> {
  return apiGet<StatusInfo>("/status");
}

/** Start the wizard's first-run setup pipeline on the daemon (#40 C4): it
 *  enqueues download→import→dedup→index→normalise for the enabled sources. */
export async function startSetup(): Promise<void> {
  await postJson("/setup/start");
}

/** Reset to a fresh empty database — clean recovery from an interrupted/failed
 *  first-run setup (#40 C4). The user re-runs the wizard afterwards. */
export async function resetSetup(): Promise<void> {
  await postJson("/setup/reset");
}

/** Enable/disable a source. Synchronous quick mutation (#191) — not a queued job,
 *  so it doesn't pile up "Disable X" cards in the activity panel and applies the
 *  moment the writer is free. Disabling also cancels that source's in-flight sync.
 *  When enabling for the first time, pass `creditAcked` to record the attribution
 *  acknowledgment in the same step. */
export async function setSourceEnabled(
  key: string,
  enabled: boolean,
  creditAcked = false,
  /** Kick off an immediate download+import for a feed on enable (#195). The
   *  wizard passes false — its own first-run pipeline handles the initial load. */
  sync = true,
): Promise<void> {
  await postJson(`/sources/${encodeURIComponent(key)}/enabled`, {
    enabled,
    credit_acked: creditAcked,
    sync,
  });
}

/** Set a source's game-date window. `from`/`to` of null clear that bound. */
export async function setSourceWindow(
  key: string,
  from: string | null,
  to: string | null,
  excludeUndated: boolean,
): Promise<void> {
  await submitJob({
    type: "sources_set_window",
    params: { source: key, from, to, exclude_undated: excludeUndated },
  });
}
