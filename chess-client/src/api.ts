// Central helpers for talking to the chess-db server over HTTP.
//
// fetch() calls use the relative "/api" prefix: in dev the Vite proxy forwards
// "/api/*" to the sidecar (stripping "/api"); in a packaged app the fetch
// override in main.tsx rewrites it to http://127.0.0.1:7777. EventSource is NOT
// covered by that override, so SSE URLs are built explicitly here.

const SIDECAR = "http://127.0.0.1:7777";

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
