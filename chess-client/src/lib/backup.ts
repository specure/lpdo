import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { apiUrl, serverToken, serverUrl } from "../api";

// Backups are saved where the USER chooses (#121). The hardened daemon can't
// write to the user's home, so it builds each .pgn.zip and streams it here; the
// GUI writes it to the folder the user picks — one folder for every backup,
// remembered (localStorage) so repeat backups don't re-prompt.
//
// The daily automatic backup lives here too, run by the app rather than the
// server for the same reason: only the app can write to that folder. It runs
// while the app is open — when it starts and then hourly, each kind at most
// once a calendar day — and writes a file only when the server's signature of
// the content differs from the one last saved. Every backup, by hand or
// automatic, is also logged as a local job for the Activity panel.

export const BACKUP_DIR_KEY = "lpdo.backupDir";
export const DEFAULT_BACKUP_DIR = "~/lpdo/backup";
const COLLECTION_KEY = "lpdo.backupCollection";
// Pre-selected when present — the private collection the wizard/AddGame flow
// writes to. Falls back to the first available collection otherwise.
export const DEFAULT_COLLECTION = "My games";

export type BackupKind = "collection" | "repertoire";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* not kept */ }
}

export const backupFolder = () => read(BACKUP_DIR_KEY) || DEFAULT_BACKUP_DIR;
/** The folder as typed, without trailing slashes — and kept for next time. */
export function rememberBackupFolder(folder: string): string {
  const dir = folder.trim().replace(/\/+$/, "");
  if (dir) write(BACKUP_DIR_KEY, dir);
  return dir;
}
/** The collection picked in the Backup tab — the one the daily backup saves. */
export const backupCollection = () => read(COLLECTION_KEY) || DEFAULT_COLLECTION;
export const rememberBackupCollection = (name: string) => write(COLLECTION_KEY, name);

// ── Local jobs: this session's backups, for the Activity panel ───────────────

export interface LocalJob {
  id: number;
  label: string;
  status: "running" | "done" | "unchanged" | "error";
  /** Where it was saved, why it was not, or what went wrong. */
  message?: string;
  started_at: number;
  ended_at?: number;
}

const LOCAL_JOBS_EVENT = "lpdo:local-jobs";
let localJobs: LocalJob[] = [];
let nextJobId = 1;

function publish() { window.dispatchEvent(new Event(LOCAL_JOBS_EVENT)); }

function startJob(label: string): number {
  const id = nextJobId++;
  localJobs = [...localJobs, { id, label, status: "running", started_at: Date.now() }];
  publish();
  return id;
}
function endJob(id: number, status: LocalJob["status"], message?: string) {
  localJobs = localJobs.map((j) => (j.id === id ? { ...j, status, message, ended_at: Date.now() } : j));
  publish();
}

/** This session's local jobs, oldest first, kept current. */
export function useLocalJobs(): LocalJob[] {
  const [jobs, setJobs] = useState(localJobs);
  useEffect(() => {
    const on = () => setJobs(localJobs);
    window.addEventListener(LOCAL_JOBS_EVENT, on);
    on();
    return () => window.removeEventListener(LOCAL_JOBS_EVENT, on);
  }, []);
  return jobs;
}

// ── Saving a backup ───────────────────────────────────────────────────────────

/** Save a backup of `kind` into `dir` by hand, logged as a local job; returns
 *  the path written (a leading `~/` expanded, as Reveal needs). */
export async function saveBackup(kind: BackupKind, dir: string, collection: string): Promise<string> {
  const id = startJob(`Backup: ${kind === "repertoire" ? "repertoire books" : collection}`);
  try {
    const path = await download(kind, dir, collection, false);
    endJob(id, "done", path);
    return path;
  } catch (e) {
    endJob(id, "error", String(e));
    throw e;
  }
}

async function download(kind: BackupKind, dir: string, collection: string, quiet: boolean): Promise<string> {
  const base = { baseUrl: serverUrl(), token: serverToken() };
  if (kind === "repertoire") {
    try {
      return await invoke<string>("download_repertoire_backup", { ...base, destPath: `${dir}/${today()}-repertoire.pgn.zip` });
    } catch (e) {
      throw String(e).includes("(404") ? "The server cannot back up the repertoire as a zip yet. Update the server." : e;
    }
  }
  const dest = `${dir}/${today()}-${collection.replace(/[^\w.-]+/g, "_")}.pgn.zip`;
  return (await invoke<string>("download_backup", { ...base, collection, destPath: dest, quiet })) || dest;
}

// ── The daily automatic backup ────────────────────────────────────────────────

export interface AutoBackup {
  on: boolean;
  /** The day it last looked, whether or not it saved. */
  checkedOn?: string;
  /** The day it last saved, the content's signature then, and where. */
  savedOn?: string;
  signature?: string;
  path?: string;
  /** The collection that signature is of — another one picked is a change. */
  collection?: string;
  /** Why the last attempt failed; it is tried again within the hour. */
  error?: string;
}

const AUTO_EVENT = "lpdo:auto-backup";
const autoKey = (kind: BackupKind) => `lpdo.autoBackup.${kind}`;

export function autoBackup(kind: BackupKind): AutoBackup {
  try { return { on: false, ...JSON.parse(read(autoKey(kind)) ?? "{}") }; } catch { return { on: false }; }
}
function setAutoBackup(kind: BackupKind, patch: Partial<AutoBackup>) {
  write(autoKey(kind), JSON.stringify({ ...autoBackup(kind), ...patch }));
  window.dispatchEvent(new Event(AUTO_EVENT));
}

/** The daily backup of `kind`, kept current, and a switch for it. Switching
 *  it on looks at once rather than waiting for the hour. */
export function useAutoBackup(kind: BackupKind): [AutoBackup, (on: boolean) => void] {
  const [state, setState] = useState(() => autoBackup(kind));
  useEffect(() => {
    const on = () => setState(autoBackup(kind));
    window.addEventListener(AUTO_EVENT, on);
    return () => window.removeEventListener(AUTO_EVENT, on);
  }, [kind]);
  const toggle = (on: boolean) => {
    setAutoBackup(kind, on ? { on, checkedOn: undefined, error: undefined } : { on });
    if (on) void runAutoBackups();
  };
  return [state, toggle];
}

async function signature(kind: BackupKind, collection: string): Promise<string> {
  const path = kind === "repertoire" ? "/repertoire/backup/signature" : `/backup/signature?collection=${encodeURIComponent(collection)}`;
  const r = await fetch(apiUrl(path));
  if (r.status === 404 || r.status === 405) throw new Error("The server cannot tell changes yet. Update the server.");
  if (!r.ok) throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
  return ((await r.json()) as { signature: string }).signature;
}

let running: Promise<void> | null = null;

/** Each daily backup switched on and not yet looked at today: saved when its
 *  content has changed since the last one, else only noted as looked at. */
export function runAutoBackups(): Promise<void> {
  running ??= (async () => {
    try {
      for (const kind of ["collection", "repertoire"] as const) await runOne(kind);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function runOne(kind: BackupKind) {
  const state = autoBackup(kind);
  const day = today();
  if (!state.on || state.checkedOn === day) return;
  const dir = backupFolder().replace(/\/+$/, "");
  const collection = backupCollection();
  const id = startJob(`Daily backup: ${kind === "repertoire" ? "repertoire books" : collection}`);
  try {
    const sig = await signature(kind, collection);
    // A collection without games has nothing to save (the server refuses an
    // empty backup) — noted like a day without changes, not tried hourly.
    if (kind === "collection" && sig.startsWith("0:")) {
      endJob(id, "unchanged", "No games to back up");
      setAutoBackup(kind, { checkedOn: day, error: undefined });
      return;
    }
    if (sig === state.signature && (kind === "repertoire" || collection === state.collection)) {
      endJob(id, "unchanged", state.savedOn ? `No changes since ${state.savedOn}` : "No changes");
      setAutoBackup(kind, { checkedOn: day, error: undefined });
      return;
    }
    const path = await download(kind, dir, collection, true);
    endJob(id, "done", path);
    setAutoBackup(kind, { checkedOn: day, savedOn: day, signature: sig, path, collection, error: undefined });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    endJob(id, "error", error);
    setAutoBackup(kind, { error });
  }
}

const HOUR = 60 * 60 * 1000;

/** Run the daily backups while the app is open and the server answers: now,
 *  and every hour after (each kind still at most once a day). */
export function useDailyBackups(connected: boolean) {
  useEffect(() => {
    if (!connected) return;
    void runAutoBackups();
    const id = setInterval(() => void runAutoBackups(), HOUR);
    return () => clearInterval(id);
  }, [connected]);
}
