// Central helpers for talking to the chess-db server over HTTP.
//
// fetch() calls use the relative "/api" prefix: in dev the Vite proxy forwards
// "/api/*" to the sidecar (stripping "/api"); in a packaged app the fetch
// override in main.tsx rewrites it to http://127.0.0.1:7777. EventSource is NOT
// covered by that override, so SSE URLs are built explicitly here.

// The daemon's real origin. `apiUrl` fetches go through the "/api" proxy/override,
// but native (Tauri) HTTP calls — e.g. the streamed import upload (#154) — must
// hit the server directly, so expose it.
export const SIDECAR = "http://127.0.0.1:7777";

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
 *  fetch override, so it needs the real sidecar URL in a packaged app). */
export function jobEventsUrl(jobId: string): string {
  const path = `/jobs/${encodeURIComponent(jobId)}/events`;
  return import.meta.env.DEV ? "/api" + path : SIDECAR + path;
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

/** The daemon's whole job pipeline (active + queued + finished), newest last —
 *  what the global Activity view reads. */
export function getJobs(): Promise<Job[]> {
  return apiGet<Job[]>("/jobs");
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
): Promise<void> {
  await postJson(`/sources/${encodeURIComponent(key)}/enabled`, {
    enabled,
    credit_acked: creditAcked,
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
