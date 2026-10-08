import { useState, useEffect, useRef, useCallback } from "react";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import ExternalLinkIcon from "./ExternalLinkIcon";
import { REPETITION_ABOVE_KEY, REPETITION_APART_KEY, repetitionSettings } from "../lib/repetition";
import { open as openDialog, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { clearCrashLog, formatCrashLog, readCrashLog, type CrashEntry } from "../lib/crashLog";
import { listen } from "@tauri-apps/api/event";
import { useJobProgress } from "../hooks/useJobProgress";
import { getRepertoireSettings, putRepertoireSettings, type OverviewGames, type RepertoireSettings, type TransposedGames } from "../lib/repertoire";
import {
  DEFAULT_BACKUP_DIR, DEFAULT_COLLECTION, backupCollection, backupFolder, rememberBackupCollection, rememberBackupFolder,
  saveBackup, useAutoBackup, whenAt, type BackupKind,
} from "../lib/backup";
import SourcesPanel from "./SourcesPanel";
import MergePlayersDialog from "./MergePlayersDialog";
import { StatusInfo, ScheduleInfo } from "../types";
import { apiUrl, serverUrl, serverToken, setServerSettings, DEFAULT_SERVER_URL, getSchedule, getJobs } from "../api";

interface Props {
  onRunWizard: () => void;
  status: StatusInfo | null;
  /** Fires when an action inside the panel mutates the database (purge, etc.).
   *  Host should refresh server status and any visible game lists. */
  onMutated?: () => void;
  /** Overall connection state from App's status poll. When not "connected",
   *  the tool panels are replaced by one clear message + the Server connection
   *  card — every panel failing with its own raw fetch error told the user
   *  nothing (#247 test finding). */
  connection?: "checking" | "connected" | "disconnected" | "unauthorized";
}

// ── Shared UI ─────────────────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="w-full bg-surface-container-highest rounded-full h-1.5 overflow-hidden mt-2">
      <div className="bg-primary h-1.5 rounded-full transition-all duration-short3 ease-standard" style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

function LogBox({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  if (lines.length === 0) return null;
  return (
    <div ref={ref} className="mt-2 bg-surface-container-lowest rounded-sm p-2 text-label-sm font-mono text-on-surface-variant max-h-24 overflow-y-auto space-y-0.5">
      {lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

/** Where the client looks for the server (#247). Lives on this page because it
 *  renders even while disconnected — which is exactly when it's needed. */
/** Concrete "where do I get the token" help, shown when the server rejected it.
 *
 *  A server that allows network access requires the token from EVERY client,
 *  including the app on its own machine — loopback is not exempt, since
 *  exempting it would hand any local user control of the database. That
 *  surprises people (#247 test round), so name the case and give the command.
 *
 *  Only for a local server can the platform be pinned down: this client's OS is
 *  then also the server's. For a remote address the server's OS is unknown, so
 *  all three locations are listed rather than guessing one.
 */
function AccessDeniedHint({ url }: { url: string }) {
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
  })();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua) ? "windows" : /Mac OS X|Macintosh/i.test(ua) ? "macos" : "linux";
  const localRead: Record<typeof os, string> = {
    windows: "Get-Content C:\\ProgramData\\LPDO\\access-token",
    linux: "sudo cat /var/lib/lpdo/.chess-db/access-token",
    macos: 'sudo cat "/Library/Application Support/LPDO/access-token"',
  };

  return (
    <div className="rounded-sm border border-warning/40 bg-warning-container/30 p-3 space-y-2">
      <div className="text-body-sm text-on-surface">
        The server is running but rejected the access token.
      </div>
      {isLocal ? (
        <>
          <p className="text-body-sm text-on-surface-variant">
            This machine's server was set up to allow other computers to connect, so it
            requires its token — from every client, including this app.
            {os === "windows" && " Read it in PowerShell started with \u201cRun as administrator\u201d:"}
            {os !== "windows" && " Read it with:"}
          </p>
          <pre className="text-body-sm font-mono text-on-surface bg-surface-container-low rounded-sm p-2 overflow-x-auto select-text">{localRead[os]}</pre>
        </>
      ) : (
        <>
          <p className="text-body-sm text-on-surface-variant">
            On the machine running the server, read its <span className="font-mono">access-token</span> file.
            It is readable only by administrators, so use an elevated PowerShell
            (Windows) or <span className="font-mono">sudo</span>:
          </p>
          <ul className="text-body-sm font-mono text-on-surface-variant space-y-0.5 select-text">
            <li>C:\ProgramData\LPDO\access-token</li>
            <li>/var/lib/lpdo/.chess-db/access-token</li>
            <li>/Library/Application Support/LPDO/access-token</li>
          </ul>
        </>
      )}
      <p className="text-body-sm text-on-surface-variant">
        The file is created as the server starts; if it isn't there yet, wait a moment and retry.
      </p>
    </div>
  );
}

function ServerConnectionSection({ status, connection = "connected" }: {
  status: StatusInfo | null;
  connection?: "checking" | "connected" | "disconnected" | "unauthorized";
}) {
  const [url, setUrl] = useState(serverUrl());
  const [token, setToken] = useState(serverToken());
  const [saved, setSaved] = useState(false);

  const dirty = url.trim().replace(/\/+$/, "") !== serverUrl() || token.trim() !== serverToken();

  function save() {
    setServerSettings(url, token);
    setSaved(true);
    // Everything reads these per call, but a reload is the honest way to drop
    // in-flight state (SSE streams, cached lists) tied to the previous server.
    setTimeout(() => window.location.reload(), 400);
  }

  // /status answers even with a bad token (it is deliberately open), so the
  // caption must come from the overall connection state — with a wrong token
  // this card used to say "Connected" (#247 test finding).
  const caption =
    connection === "connected" ? "Connected"
    : connection === "unauthorized" ? "Access denied"
    : connection === "checking" ? "Connecting…"
    : "Not connected";
  void status;
  return (
    <SectionCard title="Server connection" status={caption}>
      <p className="text-body-sm text-on-surface-variant">
        The database server normally runs on this machine. To use one on another computer,
        enter its address — and the access token from that server's data folder
        (<span className="font-mono">access-token</span>). A server on this machine needs a
        token only when it was set up to allow other computers to connect.
      </p>
      {connection === "unauthorized" && <AccessDeniedHint url={serverUrl()} />}
      <div>
        <div className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-1">Server address</div>
        <input
          type="text"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setSaved(false); }}
          placeholder={DEFAULT_SERVER_URL}
          spellCheck={false}
          className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
        />
      </div>
      <div>
        <div className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-1">Access token (required when the server allows network access)</div>
        <input
          type="password"
          value={token}
          onChange={(e) => { setToken(e.target.value); setSaved(false); }}
          placeholder="empty for a local-only server"
          spellCheck={false}
          className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
        />
      </div>
      <div className="flex items-center gap-2">
        <ActionButton onClick={save} disabled={!dirty}>Save and reconnect</ActionButton>
        {url.trim().replace(/\/+$/, "") !== DEFAULT_SERVER_URL && (
          <button
            onClick={() => { setUrl(DEFAULT_SERVER_URL); setToken(""); setSaved(false); }}
            className="h-8 px-3 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard"
          >
            Use this machine
          </button>
        )}
        {saved && <span className="text-success text-body-sm">Saved — reconnecting…</span>}
      </div>
    </SectionCard>
  );
}

/** Discreet "what am I running?" line at the bottom of the Maintenance page:
 *  GUI version (Tauri app), server version (from GET /status), API contract. */
function VersionFooter({ status }: { status: StatusInfo | null }) {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);
  // The server's engines (#309) and whether a newer release is out; only
  // those switched on. An older server has no /engine and shows none.
  type FooterEngine = { name: string | null; enabled?: boolean; update_available: boolean; latest: { version: string; url: string } | null };
  const [engines, setEngines] = useState<FooterEngine[]>([]);
  useEffect(() => {
    if (!status?.version) return;
    (async () => {
      const on = await fetch(apiUrl("/engines")).then((r) => (r.ok ? r.json() : { stockfish: true, lc0: false })).catch(() => ({ stockfish: true, lc0: false }));
      const kinds = (["stockfish", "lc0"] as const).filter((k) => on[k]);
      const got = await Promise.all(kinds.map((k) => fetch(apiUrl(`/engine?engine=${k}`)).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
      setEngines(got.filter((e): e is FooterEngine => !!e && !!e.name));
    })();
  }, [status?.version]);
  const server = status?.version
    ? `Server ${status.version}${status.api_version != null ? ` · API ${status.api_version}` : ""}`
    : "Server unreachable";
  return (
    <div className="pt-2 text-center text-label-md text-on-surface-variant select-text">
      LPDO {appVersion ?? "…"} · {server}
      {engines.map((engine) => (
        <span key={engine.name}>
          {" · "}{engine.name}
          {engine.update_available && engine.latest && (
            <>
              {" — "}
              <button
                onClick={() => void openUrl(engine.latest!.url)}
                className="text-primary hover:underline inline-flex items-center"
                title="A newer release is out. Install it on the server."
              >
                {engine.name?.split(" ")[0]} {engine.latest.version} is available<ExternalLinkIcon />
              </button>
            </>
          )}
        </span>
      ))}
    </div>
  );
}

/** How many lines an engine shows in the Engine panel, per device. Each
 *  extra line makes Stockfish search a little slower; Lc0 reports them from
 *  the same search, at no cost. */
function EngineLines({ kind }: { kind: "stockfish" | "lc0" }) {
  const key = kind === "stockfish" ? "stockfishLineCount" : "lc0LineCount";
  const read = () => { try { return localStorage.getItem(key) ?? (kind === "stockfish" ? localStorage.getItem("lichessLineCount") : null); } catch { return null; } };
  const [lines, setLines] = useState(() => { const n = parseInt(read() ?? "", 10); return String(Number.isFinite(n) && n > 0 ? Math.min(n, 20) : kind === "stockfish" ? 5 : 10); });
  const change = (v: string) => {
    setLines(v);
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 20) { try { localStorage.setItem(key, String(n)); } catch { /* per-device convenience only */ } }
  };
  return (
    <div className="flex items-center gap-3 text-body-sm text-on-surface flex-wrap"
      title={kind === "stockfish" ? "Each extra line makes Stockfish search a little slower" : "Lc0 reports its lines from the same search: more cost nothing"}>
      <label className="flex items-center gap-2">
        <span>Lines</span>
        <input type="number" min={1} max={20} value={lines} onChange={(e) => change(e.target.value)}
          className="w-20 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface tabular-nums" />
      </label>
      <span className="text-label-sm text-on-surface-variant">
        1–20, on this computer; takes effect when the Engine panel next opens
        {kind === "stockfish" ? " — as many helpers count all lines' replies at once" : ""}
      </span>
    </div>
  );
}

/** A field saves itself when it is left or Enter is pressed — no Save
 *  button. `commit` checks the value and saves it if it changed. */
function commitOn(commit: () => void) {
  return {
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); },
  };
}

/** Whether saving `patch` restarts the engine (or its helpers): what the
 *  processes are started with. Limits and thresholds apply at once. */
function restarts(patch: object): boolean {
  return ["path", "threads", "hash_mb", "weights", "backend", "smart_pruning", "enabled", "replies", "helper_threads", "helper_hash_mb"]
    .some((k) => k in patch && (patch as Record<string, unknown>)[k] !== undefined);
}

/** Stockfish's lines that lead to a repetition (#314): shown apart, below
 *  the principal lines, where the side to move is better by more than a
 *  set advantage. Per computer, as the lines are. */
function RepetitionSetting() {
  const [{ apart, aboveCp }, setState] = useState(repetitionSettings);
  const [pawns, setPawns] = useState((aboveCp / 100).toFixed(2));
  const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* per-computer convenience only */ } };
  return (
    <div className="space-y-1 text-body-sm text-on-surface">
      <label className="flex items-center gap-2 cursor-pointer" title="A move can rate better than a draw while its line comes back to a position already on the board — the moves just shuffle. Such lines go below the principal ones, under ⟲ Leading to a repetition.">
        <input type="checkbox" checked={apart} className="accent-primary"
          onChange={(e) => { setState((st) => ({ ...st, apart: e.target.checked })); store(REPETITION_APART_KEY, String(e.target.checked)); }} />
        <span>Show non-principal lines separately — those leading to a repetition</span>
      </label>
      {apart && (
        <label className="flex items-center gap-2 pl-6">
          <span>When better by more than</span>
          <input value={pawns} onChange={(e) => setPawns(e.target.value)} inputMode="decimal"
            {...commitOn(() => {
              const cp = Math.round(Number(pawns.replace(",", ".")) * 100);
              if (!Number.isFinite(cp) || cp < 0) return;
              setState((st) => ({ ...st, aboveCp: cp }));
              store(REPETITION_ABOVE_KEY, String(cp));
            })}
            className="w-20 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface tabular-nums" />
          <span className="text-on-surface-variant">pawns (0.00: any advantage)</span>
        </label>
      )}
      <p className="text-label-sm text-on-surface-variant pl-6">On this computer; takes effect when the Engine panel next opens.</p>
    </div>
  );
}

type ReplyPatch = { replies?: boolean; helper_threads?: number; helper_hash_mb?: number; helper_depth?: number; strong_cp?: number; helper_nodes?: number; strong_pct?: number; neutral_cp?: number; neutral_pct?: number };

/** Replies & Strong for a local engine: a helper process of the same engine
 *  counts, for each candidate, the opponent's replies and how many are close
 *  to the best. Stockfish's helper takes threads and hash from the server;
 *  Lc0's a second copy of the network on the graphics card. */
function RepliesSettings({ kind, settings, busy, onSave }: {
  kind: "stockfish" | "lc0";
  settings: { replies?: boolean; helper_threads?: number; helper_hash_mb?: number; helper_depth?: number; strong_cp?: number; helper_nodes?: number; strong_pct?: number; neutral_cp?: number; neutral_pct?: number };
  busy: boolean;
  onSave: (p: ReplyPatch) => void;
}) {
  const on = !!settings.replies;
  const [threads, setThreads] = useState(String(settings.helper_threads ?? 5));
  const [hash, setHash] = useState(String(settings.helper_hash_mb ?? 320));
  const [depth, setDepth] = useState(String(settings.helper_depth ?? 24));
  const [pawns, setPawns] = useState(((settings.strong_cp ?? 10) / 100).toFixed(2));
  const [nodes, setNodes] = useState(String(settings.helper_nodes ?? 50000));
  const [pct, setPct] = useState(String(settings.strong_pct ?? 1));
  const [neutralPawns, setNeutralPawns] = useState(((settings.neutral_cp ?? 30) / 100).toFixed(2));
  const [neutralPct, setNeutralPct] = useState(String(settings.neutral_pct ?? 3));
  const field = "w-20 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface tabular-nums";
  const num = (v: string) => { const n = Number(v.replace(",", ".")); return Number.isFinite(n) ? n : undefined; };
  // Each field saves itself when it is left (or on Enter), if it changed.
  const put = <K extends keyof ReplyPatch>(k: K, v: ReplyPatch[K] | undefined) => {
    if (v != null && v !== (settings as ReplyPatch)[k]) onSave({ [k]: v } as ReplyPatch);
  };
  const cp = (v: string) => { const n = num(v); return n == null ? undefined : Math.round(n * 100); };
  return (
    <div className="space-y-2 pt-2 border-t border-outline/40">
      <label className="flex items-start gap-2 text-body-sm text-on-surface cursor-pointer">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => onSave({ replies: e.target.checked })} className="accent-primary mt-1" />
        <span>
          Strong replies
          <span className="block text-label-sm text-on-surface-variant">
            {kind === "stockfish"
              ? "For each candidate move, a helper Stockfish counts how many of the opponent's replies are close to the best — low means forcing. Each helper takes one thread and counts one candidate; the main search keeps the other threads, and the helpers share the hash below."
              : "For each candidate move, a second Lc0 runs a short search and counts the replies it finds close to the best. It loads another copy of the network onto the graphics card."}
          </span>
        </span>
      </label>
      <div className="flex items-center gap-4 text-body-sm text-on-surface flex-wrap">
          {kind === "stockfish" ? (
            <>
              {on && <>
              <label className="flex items-center gap-2" title="Single-threaded helpers, each counting one candidate: as many as the lines counts them all at once"><span>Helpers</span><input type="number" min={1} max={64} value={threads} onChange={(e) => setThreads(e.target.value)} className={field} {...commitOn(() => put("helper_threads", num(threads)))} /></label>
              <label className="flex items-center gap-2"><span>Hash</span><input type="number" min={16} max={4096} step={64} value={hash} onChange={(e) => setHash(e.target.value)} className={field} {...commitOn(() => put("helper_hash_mb", num(hash)))} /><span className="text-on-surface-variant">MB</span></label>
              <label className="flex items-center gap-2" title="Each candidate's replies are searched to this depth"><span>Depth</span><input type="number" min={1} max={60} value={depth} onChange={(e) => setDepth(e.target.value)} className={field} {...commitOn(() => put("helper_depth", num(depth)))} /></label>
              </>}
              <label className="flex items-center gap-2" title="A move within this much of the best is strong: marked ! in the Engine panel, and counted among the strong replies (chessdb uses 0.05)"><span>Strong within</span><input value={pawns} onChange={(e) => setPawns(e.target.value)} inputMode="decimal" className={field} {...commitOn(() => put("strong_cp", cp(pawns)))} /><span className="text-on-surface-variant">pawns</span></label>
              <label className="flex items-center gap-2" title="A move further behind the best than strong, up to this far, is neutral and left unmarked; further still, it is marked ?"><span>Neutral within</span><input value={neutralPawns} onChange={(e) => setNeutralPawns(e.target.value)} inputMode="decimal" className={field} {...commitOn(() => put("neutral_cp", cp(neutralPawns)))} /><span className="text-on-surface-variant">pawns</span></label>
            </>
          ) : (
            <>
              {on && <label className="flex items-center gap-2" title="Nodes Lc0 spends on each candidate's replies"><span>Nodes per move</span><input value={nodes} onChange={(e) => setNodes(e.target.value)} inputMode="numeric" {...commitOn(() => put("helper_nodes", num(nodes.replace(/[\s,.]/g, ""))))} className="w-28 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface tabular-nums" /></label>}
              <label className="flex items-center gap-2" title="A move within this much expected score of the best is strong: marked ! in the Engine panel, and counted among the strong replies"><span>Strong within</span><input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" className={field} {...commitOn(() => put("strong_pct", num(pct)))} /><span className="text-on-surface-variant">% score</span></label>
              <label className="flex items-center gap-2" title="A move further behind the best than strong, up to this far, is neutral and left unmarked; further still, it is marked ?"><span>Neutral within</span><input value={neutralPct} onChange={(e) => setNeutralPct(e.target.value)} inputMode="decimal" className={field} {...commitOn(() => put("neutral_pct", num(neutralPct)))} /><span className="text-on-surface-variant">% score</span></label>
            </>
          )}
        </div>
    </div>
  );
}

/** Stockfish's or Lc0's setting: Auto — in use when installed on the server
 *  (the default) — or Off, and what that means now. */
function EngineMode({ kind, info, busy, onChange }: {
  kind: "stockfish" | "lc0";
  info: { enabled?: boolean; auto?: boolean; installed?: boolean };
  busy: boolean;
  onChange: (auto: boolean) => void;
}) {
  // An older server has only the switch.
  const auto = info.auto ?? info.enabled !== false;
  const installed = info.installed ?? true;
  const name = kind === "stockfish" ? "Stockfish" : "Lc0";
  const guide = `https://github.com/specure/lpdo/blob/main/docs/chess-engine.md${kind === "lc0" ? "#leela-chess-zero" : ""}`;
  return (
    <div className="space-y-1">
      <UseToggle label={`Use ${name}`} on={auto} onLabel="Auto" busy={busy} onChange={onChange} />
      <p className="text-label-sm text-on-surface-variant">
        {!auto
          ? `Off: the server does not use ${name}${kind === "lc0" ? " — it is not started and holds no graphics memory" : ""}.`
          : installed
            ? `On: ${name} is installed on the server${kind === "lc0" ? " with a network" : ""}.`
            : <>Off until {name} is installed on the server{kind === "lc0" ? " (the program and a network)" : ""}; it is used from then on.{" "}
                <button onClick={() => void openUrl(guide)} className="text-primary hover:underline inline-flex items-center">How to install<ExternalLinkIcon /></button>
              </>}
      </p>
    </div>
  );
}

/** "Use …" with a two-part choice — Auto / Off for the local engines, On / Off
 *  for the cloud ones. */
function UseToggle({ label, on, onLabel, busy, onChange }: {
  label: string; on: boolean; onLabel: string; busy?: boolean; onChange: (on: boolean) => void;
}) {
  const pill = (sel: boolean) => `h-8 px-4 text-label-lg ${sel ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface-variant hover:bg-on-surface/8"} disabled:opacity-60`;
  return (
    <div className="flex items-center gap-3 text-body-sm text-on-surface">
      <span>{label}</span>
      <div className="inline-flex rounded-full overflow-hidden border border-outline/40">
        <button className={pill(on)} disabled={busy} onClick={() => { if (!on) onChange(true); }}>{onLabel}</button>
        <button className={pill(!on)} disabled={busy} onClick={() => { if (on) onChange(false); }}>Off</button>
      </div>
    </div>
  );
}

/** An engine's on/off switch, at the top of its card: off, its tab leaves the
 *  Engine panel and the server neither runs nor asks it. */
function EngineSwitch({ label, on, busy, onChange }: { label: string; on: boolean; busy?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-body-sm text-on-surface cursor-pointer">
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => onChange(e.target.checked)} className="accent-primary" />
      <span>{label}</span>
    </label>
  );
}

// ── Chess engine (#309) ──────────────────────────────────────────────────────
// The engine on the server, for the Engine panel's "Local" analysis: which one
// of those installed runs, with how many threads and how much hash. Choosing is
// limited to engines the server found in the standard locations; another path
// goes in engine.json on the server (see engine.rs for why).
interface EngineInfo {
  enabled?: boolean;
  auto?: boolean;
  installed?: boolean;
  available: boolean;
  path: string | null;
  name: string | null;
  error: string | null;
  settings: { path: string | null; threads: number; hash_mb: number; max_depth: number; replies?: boolean; helper_threads?: number; helper_hash_mb?: number; helper_depth?: number; strong_cp?: number; helper_nodes?: number; strong_pct?: number };
  found: string[];
  settings_file: string;
  latest: { version: string; url: string } | null;
  update_available: boolean;
  cores: number;
  physical_cores: number;
  memory_mb: number | null;
  budget_mb: number;
  database_mb: number;
  max_hash_mb: number;
}

function gb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

function EngineSection() {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [threads, setThreads] = useState("");
  const [hash, setHash] = useState("");
  const [depth, setDepth] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function take(d: EngineInfo) {
    setInfo(d);
    setThreads(String(d.settings.threads));
    setHash(String(d.settings.hash_mb));
    setDepth(d.settings.max_depth == null ? "" : String(d.settings.max_depth));
  }
  useEffect(() => {
    fetch(apiUrl("/engine"))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(take)
      .catch((e) => setError(String(e)));
  }, []);

  async function save(patch: { path?: string; threads?: number; hash_mb?: number; max_depth?: number; enabled?: boolean } & ReplyPatch) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await fetch(apiUrl("/engine"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error((await r.text()) || `${r.status}`);
      take((await r.json()) as EngineInfo);
      setNote(restarts(patch) ? "Saved — the engine restarted with the new settings." : "Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const t = parseInt(threads, 10);
  const h = parseInt(hash, 10);
  const dp = parseInt(depth, 10);
  const field = "w-20 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface tabular-nums";

  return (
    <SectionCard title="Stockfish" status={info ? (info.auto === false ? "off" : info.installed === false ? "not installed" : info.enabled === false ? "switched off" : info.available ? info.name ?? "running" : "not started") : undefined}>
      <p className="text-body-sm text-on-surface-variant">
        The engine behind the Engine panel's <em>Stockfish</em> tab, running on the server — the
        strongest free engine, measured in centipawns. LPDO uses one you install; any UCI engine works.
      </p>
      {info && (
        <EngineMode kind="stockfish" info={info} busy={busy} onChange={(auto) => void save({ enabled: auto })} />
      )}
      {info && info.enabled !== false && !info.available && (
        <p className="text-body-sm text-on-surface-variant">
          The engine is installed but did not start{info.error ? `: ${info.error}` : "."}
        </p>
      )}
      {info && info.found.length > 0 && (
        <label className="flex items-center gap-2 text-body-sm text-on-surface">
          <span className="w-16 shrink-0">Engine</span>
          <select
            value={info.path ?? ""}
            onChange={(e) => void save({ path: e.target.value })}
            disabled={busy}
            className="flex-1 min-w-0 h-8 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface font-mono"
          >
            {info.found.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      )}
      {info && (
        <div className="flex items-center gap-4 text-body-sm text-on-surface flex-wrap">
          <label className="flex items-center gap-2">
            <span className="w-16 shrink-0">Threads</span>
            <input type="number" min={1} max={256} value={threads} onChange={(e) => setThreads(e.target.value)} className={field}
              {...commitOn(() => { if (Number.isFinite(t) && t !== info.settings.threads) void save({ threads: t }); })} />
          </label>
          <label className="flex items-center gap-2">
            <span>Hash</span>
            <input type="number" min={16} max={info.max_hash_mb} step={256} value={hash} onChange={(e) => setHash(e.target.value)} className={field}
              {...commitOn(() => { if (Number.isFinite(h) && h !== info.settings.hash_mb) void save({ hash_mb: h }); })} />
            <span className="text-on-surface-variant">MB</span>
          </label>
          <label className="flex items-center gap-2" title="The search stops at this depth, or when you move on or close the panel; ⟳ in the Engine panel then searches further">
            <span>Stop at depth</span>
            <input type="number" min={1} max={245} value={depth} onChange={(e) => setDepth(e.target.value)} className={field}
              {...commitOn(() => { if (Number.isFinite(dp) && dp >= 1 && dp !== info.settings.max_depth) void save({ max_depth: dp }); })} />
          </label>
        </div>
      )}
      {info && <EngineLines kind="stockfish" />}
      {info && <RepetitionSetting />}
      {info && <RepliesSettings kind="stockfish" settings={info.settings} busy={busy} onSave={(p) => void save(p)} />}
      {info && (() => {
        // The memory budget, split as typed: the engine's hash, the database the rest.
        const hashNow = Number.isFinite(h) ? Math.min(Math.max(h, 16), info.max_hash_mb) : info.settings.hash_mb;
        const dbNow = Math.max(info.budget_mb - hashNow, Math.min(2048, info.budget_mb));
        const pct = (mb: number) => `${Math.round((mb / info.budget_mb) * 100)}%`;
        return (
          <div className="space-y-1">
            <div className="text-body-sm text-on-surface">
              Memory: the server may use {gb(info.budget_mb)}{info.memory_mb ? ` of the machine's ${gb(info.memory_mb)}` : ""} —
              engine hash {gb(hashNow)}, database {gb(dbNow)}.
            </div>
            <div className="h-2 rounded-full overflow-hidden flex bg-surface-container" title="The server's memory budget: engine hash and database">
              <div className="bg-primary" style={{ width: pct(hashNow) }} />
              <div className="bg-tertiary/60" style={{ width: pct(dbNow) }} />
            </div>
          </div>
        );
      })()}
      {info && (
        <p className="text-label-sm text-on-surface-variant">
          Threads default to one per physical core ({info.physical_cores} of {info.cores} logical here) less the five helpers,
          since the server also answers everyone's queries. The hash comes out of the same memory budget as the
          database — it defaults to an eighth of the memory, at most 4 GB, and the database keeps at least
          2 GB. More hash keeps more of an analysis when you move on and come back; less leaves the
          database more room for large jobs such as removing duplicates. To use an engine outside the
          standard locations, name it in <span className="font-mono">{info.settings_file}</span> on the server.
        </p>
      )}
      {info?.update_available && info.latest && (
        <p className="text-body-sm text-on-surface">
          Stockfish {info.latest.version} is available.{" "}
          <button onClick={() => void openUrl(info.latest!.url)} className="text-primary hover:underline inline-flex items-center">
            Download<ExternalLinkIcon />
          </button>
        </p>
      )}
      {note && <p className="text-body-sm text-success">{note}</p>}
      {error && <p className="text-body-sm text-error">{error}</p>}
      {info?.available && info.name?.startsWith("Stockfish") && (
        <EngineBench
          engine={info.name}
          physicalCores={info.physical_cores}
          threads={Number.isFinite(t) ? t : info.settings.threads}
          hash={Number.isFinite(h) ? h : info.settings.hash_mb}
          onUse={(threads, hash_mb) => void save({ threads, hash_mb })}
        />
      )}
    </SectionCard>
  );
}

// ── Lc0 (#309) ───────────────────────────────────────────────────────────────
// The second local engine, optional because it wants a graphics card. Its
// program, network file and backend; the network and program are chosen among
// those the server found, like Stockfish's.
const LC0_BACKENDS = [
  { value: "", label: "Automatic" },
  { value: "cuda-fp16", label: "cuda-fp16 — NVIDIA, fastest" },
  { value: "cuda", label: "cuda — NVIDIA, full precision" },
  { value: "onnx-dml", label: "onnx-dml — any GPU on Windows" },
  { value: "metal", label: "metal — Apple" },
  { value: "opencl", label: "opencl — older networks only" },
  { value: "eigen", label: "eigen — processor, slow" },
];

interface Lc0Info {
  enabled?: boolean;
  auto?: boolean;
  installed?: boolean;
  version?: string | null;
  latest?: { version: string; url: string } | null;
  update_available?: boolean;
  os?: string;
  available: boolean;
  path: string | null;
  name: string | null;
  error: string | null;
  settings: { path: string | null; threads: number; weights: string | null; backend: string | null; max_nodes: number; smart_pruning: boolean; replies?: boolean; helper_threads?: number; helper_hash_mb?: number; helper_depth?: number; strong_cp?: number; helper_nodes?: number; strong_pct?: number };
  found: string[];
  networks: string[];
  weights: string | null;
  settings_file: string;
}

function Lc0Section() {
  const [info, setInfo] = useState<Lc0Info | null>(null);
  const [threads, setThreads] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState("");
  function take(d: Lc0Info) { setInfo(d); setThreads(String(d.settings.threads)); setNodes(d.settings.max_nodes == null ? "" : String(d.settings.max_nodes)); }
  useEffect(() => {
    fetch(apiUrl("/engine?engine=lc0"))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(take)
      .catch((e) => setError(String(e)));
  }, []);
  async function save(patch: { path?: string; weights?: string; backend?: string; threads?: number; max_nodes?: number; smart_pruning?: boolean; enabled?: boolean } & ReplyPatch) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await fetch(apiUrl("/engine?engine=lc0"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error((await r.text()) || `${r.status}`);
      take((await r.json()) as Lc0Info);
      setNote(restarts(patch) ? "Saved — Lc0 restarted with the new settings." : "Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const t = parseInt(threads, 10);
  const n = parseInt(nodes.replace(/[\s,.]/g, ""), 10);
  const select = "flex-1 min-w-0 h-8 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface";
  const name = (p: string) => p.split(/[\\/]/).pop();
  return (
    <SectionCard title="Lc0" status={info ? (info.auto === false ? "off" : info.installed === false ? "not installed" : info.enabled === false ? "switched off" : info.available ? info.name ?? "running" : "not started") : undefined}>
      <p className="text-body-sm text-on-surface-variant">
        Leela Chess Zero, the second engine on the server: a neural network that gives its chances as win,
        draw and loss. Optional — it needs a graphics card to be fast.
      </p>
      {info && (
        <EngineMode kind="lc0" info={info} busy={busy} onChange={(auto) => void save({ enabled: auto })} />
      )}
      {info?.update_available && info.latest && (
        <p className="text-body-sm text-on-surface">
          Lc0 {info.latest.version} is available — this server runs {info.version}.{" "}
          <button onClick={() => void openUrl(info.latest!.url)} className="text-primary hover:underline inline-flex items-center">
            Download<ExternalLinkIcon />
          </button>
          {info.os === "linux" && (
            <> On Linux it is built from source:{" "}
              <button onClick={() => void openUrl("https://github.com/specure/lpdo/blob/main/docs/chess-engine.md#the-program")} className="text-primary hover:underline inline-flex items-center">
                the build steps<ExternalLinkIcon />
              </button>.
            </>
          )}
        </p>
      )}
      {info && info.enabled !== false && !info.available && (
        <p className="text-body-sm text-on-surface-variant">
          Lc0 is installed but did not start{info.error ? `: ${info.error}` : "."}
        </p>
      )}
      {info && info.found.length > 0 && (
        <label className="flex items-center gap-2 text-body-sm text-on-surface">
          <span className="w-16 shrink-0">Program</span>
          <select value={info.path ?? ""} onChange={(e) => void save({ path: e.target.value })} disabled={busy} className={`${select} font-mono`}>
            {info.found.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      )}
      {info && (
        <label className="flex items-center gap-2 text-body-sm text-on-surface">
          <span className="w-16 shrink-0">Network</span>
          {info.networks.length > 0 ? (
            <select value={info.weights ?? ""} onChange={(e) => void save({ weights: e.target.value })} disabled={busy} className={`${select} font-mono`}>
              {info.networks.map((p) => <option key={p} value={p} title={p}>{name(p)}</option>)}
            </select>
          ) : (
            <span className="text-on-surface-variant">none found — put a .pb.gz file in the server's networks folder</span>
          )}
        </label>
      )}
      {info && (
        <div className="flex items-center gap-4 text-body-sm text-on-surface flex-wrap">
          <label className="flex items-center gap-2 flex-1 min-w-60">
            <span className="w-16 shrink-0">Backend</span>
            <select value={info.settings.backend ?? ""} onChange={(e) => void save({ backend: e.target.value })} disabled={busy} className={select}>
              {LC0_BACKENDS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span>Threads</span>
            <input type="number" min={0} max={64} value={threads} onChange={(e) => setThreads(e.target.value)}
              {...commitOn(() => { if (Number.isFinite(t) && t !== info.settings.threads) void save({ threads: t }); })}
              className="w-16 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface tabular-nums" />
          </label>
          <label className="flex items-center gap-2" title="The search stops after this many nodes (at least 1,000), or when you move on or close the panel; ⟳ in the Engine panel then searches further">
            <span>Stop at</span>
            <input value={nodes} onChange={(e) => setNodes(e.target.value)} inputMode="numeric"
              {...commitOn(() => { if (Number.isFinite(n) && n >= 1000 && n !== info.settings.max_nodes) void save({ max_nodes: n }); })}
              className="w-28 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface tabular-nums" />
            <span className="text-on-surface-variant">nodes</span>
          </label>
        </div>
      )}
      {info && <EngineLines kind="lc0" />}
      {info && <RepliesSettings kind="lc0" settings={info.settings} busy={busy} onSave={(p) => void save(p)} />}
      {info && (
        <label className="flex items-start gap-2 text-body-sm text-on-surface cursor-pointer">
          <input type="checkbox" checked={info.settings.smart_pruning} disabled={busy}
            onChange={(e) => void save({ smart_pruning: e.target.checked })} className="accent-primary mt-1" />
          <span>
            Stop early once the best move is settled (smart pruning)
            <span className="block text-label-sm text-on-surface-variant">
              Recommended off: the Engine panel shows several lines, and with it on the second and third stop
              improving as soon as the first is certain. On suits wanting only the best move, or sparing the
              graphics card — a search then often ends well before the node limit.
            </span>
          </span>
        </label>
      )}
      <p className="text-label-sm text-on-surface-variant">
        Threads 0 lets Lc0 choose: its work is on the graphics card, so a few search threads suffice.
        Lc0 is limited by nodes, not depth — its "depth" is only the average length of the lines it
        explores; 2 million nodes (the default) take about a minute on a fast card.
        
        Networks are found in the data directory's networks folder and beside the program; another file
        can be named in {info ? <span className="font-mono">{info.settings_file}</span> : "lc0.json"} on the server.
      </p>
      {note && <p className="text-body-sm text-success">{note}</p>}
      {error && <p className="text-body-sm text-error">{error}</p>}
      {info?.error && !info.available && <p className="text-body-sm text-error">{info.error}</p>}
      {info?.available && info.networks.length > 0 && (
        <Lc0Bench network={info.weights ? name(info.weights) ?? info.weights : "?"} backend={info.settings.backend || "automatic"} />
      )}
    </SectionCard>
  );
}

// Lc0's standard benchmark (`lc0 benchmark`: 34 positions, 10 s each) with the
// program, network and backend set above. Only the standard run gives figures
// comparable between machines: Lc0's speed grows as each search goes on.
interface Lc0BenchRow { at: number; network: string; backend: string; nps: number; nodes: number; ms: number }
const LC0_BENCH_KEY = "lc0BenchResults";

function Lc0Bench({ network, backend }: { network: string; backend: string }) {
  const [rows, setRows] = useState<Lc0BenchRow[]>(() => {
    try { return JSON.parse(localStorage.getItem(LC0_BENCH_KEY) ?? "[]") as Lc0BenchRow[]; } catch { return []; }
  });
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  async function run() {
    setError(null);
    setRunning(true);
    try {
      const r = await fetch(apiUrl("/engine/bench?engine=lc0"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error((await r.text()) || `${r.status}`);
      const b = (await r.json()) as { nps: number; nodes: number; ms: number };
      setRows((prev) => {
        const next = [{ at: Date.now(), network, backend, nps: b.nps, nodes: b.nodes, ms: b.ms }, ...prev].slice(0, 40);
        try { localStorage.setItem(LC0_BENCH_KEY, JSON.stringify(next)); } catch { /* per-device convenience only */ }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return (
    <div className="space-y-2 pt-2 border-t border-outline/40">
      <div className="flex items-center gap-2">
        <span className="text-title-sm">Benchmark</span>
        <div className="flex-1" />
        <ActionButton onClick={() => void run()} disabled={running}>Run the standard benchmark (about 6 min)</ActionButton>
      </div>
      <p className="text-label-sm text-on-surface-variant">
        Lc0's own benchmark: 34 positions, ten seconds each — about six minutes, during which Lc0 does not
        analyse. Only this full run gives figures comparable with other machines: Lc0 gets faster as each
        search goes on.
      </p>
      {running && (
        <p className="text-body-sm text-on-surface flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          Running with {network}, backend {backend} — {mmss(elapsed)} of about 5:45
        </p>
      )}
      {error && <p className="text-body-sm text-error">{error}</p>}
      {rows.length > 0 && (
        <table className="w-full text-body-sm tabular-nums">
          <thead className="text-label-sm text-on-surface-variant">
            <tr className="text-right">
              <th className="text-left font-normal py-1">When</th>
              <th className="text-left font-normal">Network</th>
              <th className="text-left font-normal">Backend</th>
              <th className="font-normal">Speed</th>
              <th className="font-normal">Nodes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="text-right border-t border-outline/20">
                <td className="text-left py-0.5 whitespace-nowrap">{fmtWhen(r.at)}</td>
                <td className="text-left font-mono truncate max-w-40" title={r.network}>{r.network}</td>
                <td className="text-left">{r.backend}</td>
                <td className="font-semibold">{r.nps >= 1000 ? `${(r.nps / 1000).toFixed(1)}k n/s` : `${r.nps} n/s`}</td>
                <td>{(r.nodes / 1e6).toFixed(1)}M</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Lichess's Replies & Strong columns: chessdb-style counts from the
 *  positions after each move, a few extra requests per move. Per device. */
function LichessStats() {
  // Off unless switched on: its extra request per move soon runs into
  // Lichess's rate limit (429).
  const [on, setOn] = useState(() => { try { return localStorage.getItem("lichessShowStats") === "true"; } catch { return false; } });
  return (
    <EngineSwitch
      label="Replies & Strong columns (an extra request per move — Lichess soon limits them)"
      on={on}
      onChange={(v) => { setOn(v); try { localStorage.setItem("lichessShowStats", String(v)); } catch { /* per-device convenience only */ } }}
    />
  );
}

// ── Cloud engines ─────────────────────────────────────────────────────────────
// How far into a game chessdb.cn and Lichess are asked. A lookup sends the
// position there (and chessdb keeps what it is asked), so past the opening the
// server keeps positions to itself; the local engine analyses those.
/** The repertoire's settings (#327): which of one's own games count in a
 *  chapter's practice figures, and which an overview chapter lists. */
const OVERVIEW_GAMES: { value: OverviewGames; label: string; hint: string }[] = [
  { value: "none", label: "None", hint: "games that reached no other chapter count as having left the book" },
  { value: "unclaimed", label: "Unclaimed games only", hint: "games that went through it and reached no other chapter (default)" },
  { value: "every", label: "Every game that passes the filter", hint: "every game through its moves, the other chapters' games too" },
];

const TRANSPOSED_GAMES: { value: TransposedGames; label: string; hint: string }[] = [
  { value: "target", label: "Only show the game in the target chapter", hint: "the chapter it went into (default)" },
  { value: "show", label: "Show the transposition in the respective chapter", hint: "both list it; the one it left says where it went" },
];

function RepertoireSection() {
  const [settings, setSettings] = useState<RepertoireSettings | null>(null);
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getRepertoireSettings()
      .then((s) => { setSettings(s); setValue(String(s.own_games_months)); })
      .catch((e) => setError(String(e)));
  }, []);
  const months = settings?.own_games_months ?? null;
  const n = parseInt(value, 10);
  // The whole settings sent each time: one left out goes back to its default.
  async function save(patch: Partial<RepertoireSettings>) {
    if (!settings) return;
    setError(null);
    setNote(null);
    try {
      const s = await putRepertoireSettings({ ...settings, ...patch });
      if ((patch.overview_games && s.overview_games === undefined) || (patch.transposed_games && s.transposed_games === undefined)) {
        throw new Error("The server cannot set this yet. Update the server.");
      }
      setSettings(s);
      setValue(String(s.own_games_months));
      setNote("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const status = months == null ? undefined : months === 0 ? "all your games" : `last ${months} months`;
  return (
    <SectionCard title="Your games in practice" status={status}>
      {settings && months != null && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-body-sm text-on-surface flex-wrap">
            <span>Count your games from the last</span>
            <input
              type="number" min={0} max={600} value={value} onChange={(e) => setValue(e.target.value)}
              {...commitOn(() => { if (Number.isFinite(n) && n >= 0 && n !== months) void save({ own_games_months: n }); })}
              className="w-20 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface tabular-nums"
            />
            <span>months</span>
            {months !== 0 && <button onClick={() => void save({ own_games_months: 0 })} className="h-7 px-2 rounded-full text-label-md text-primary hover:bg-primary/8">All</button>}
          </div>
          <p className="text-label-sm text-on-surface-variant">
            How you have done in a chapter's positions — your games, wins, draws and losses, and what you played —
            counts your games with the book's colour from this period: a Black repertoire, your games as Black.
            0 counts all of them; the default is 12. Your player is the one set on the Home page; your games are
            looked up each time, so a game added counts at once.
          </p>
          {settings.overview_games !== undefined && (
            <fieldset className="space-y-1 pt-1">
              <legend className="text-body-sm text-on-surface pb-1">An overview chapter lists</legend>
              {OVERVIEW_GAMES.map((o) => (
                <label key={o.value} className="flex items-start gap-2 text-body-sm text-on-surface cursor-pointer">
                  <input type="radio" name="overview-games" className="accent-primary mt-1 shrink-0"
                    checked={settings.overview_games === o.value}
                    onChange={() => void save({ overview_games: o.value })} />
                  <span>{o.label} <span className="text-label-sm text-on-surface-variant">— {o.hint}</span></span>
                </label>
              ))}
              <p className="text-label-sm text-on-surface-variant pt-1">
                An overview chapter — an introduction, a quickstarter, an overview — goes over moves the other
                chapters have. It never takes a game from them: a game counts for the chapter it reaches, as if the
                overview were not there. A chapter is an overview when its name says so (Overview, Introduction,
                Quickstarter, Summary…), shown in italics; set it either way in the chapters' menu.
              </p>
            </fieldset>
          )}
          {settings.transposed_games !== undefined && (
            <fieldset className="space-y-1 pt-1">
              <legend className="text-body-sm text-on-surface pb-1">When a game transposes to another chapter</legend>
              {TRANSPOSED_GAMES.map((o) => (
                <label key={o.value} className="flex items-start gap-2 text-body-sm text-on-surface cursor-pointer">
                  <input type="radio" name="transposed-games" className="accent-primary mt-1 shrink-0"
                    checked={settings.transposed_games === o.value}
                    onChange={() => void save({ transposed_games: o.value })} />
                  <span>{o.label} <span className="text-label-sm text-on-surface-variant">— {o.hint}</span></span>
                </label>
              ))}
              <p className="text-label-sm text-on-surface-variant pt-1">
                A game can pass through a position only one chapter has and go on into another chapter's — 1.Nf3 Nf6
                2.g3 c5 3.c4 through a 1.Nf3 chapter into a 1.c4 c5 one. It went into the chapter it reached last.
              </p>
            </fieldset>
          )}
          {note && <p className="text-body-sm text-success">{note}</p>}
        </div>
      )}
      {error && <p className="text-body-sm text-error">{error}</p>}
    </SectionCard>
  );
}

function CloudEnginesSection() {
  const [maxMove, setMaxMove] = useState<number | null>(null);
  // Each service on or off; an older server has no switches and asks both.
  const [services, setServices] = useState<{ chessdb: boolean; lichess: boolean }>({ chessdb: true, lichess: true });
  const [value, setValue] = useState("");
  // Lichess's threshold for strong moves, in centipawns; shown in pawns.
  const [strongCp, setStrongCp] = useState(5);
  const [pawns, setPawns] = useState("0.05");
  const [neutralCp, setNeutralCp] = useState(15);
  const [neutralPawns, setNeutralPawns] = useState("0.15");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  type Settings = { max_move: number; chessdb?: boolean; lichess?: boolean; lichess_strong_cp?: number; lichess_neutral_cp?: number };
  function show(d: Settings) {
    setMaxMove(d.max_move); setValue(String(d.max_move));
    setServices({ chessdb: d.chessdb !== false, lichess: d.lichess !== false });
    const cp = d.lichess_strong_cp ?? 5;
    setStrongCp(cp); setPawns((cp / 100).toFixed(2));
    const ncp = d.lichess_neutral_cp ?? 15;
    setNeutralCp(ncp); setNeutralPawns((ncp / 100).toFixed(2));
  }
  useEffect(() => {
    fetch(apiUrl("/cloud-eval/settings"))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(show)
      .catch((e) => setError(String(e)));
  }, []);
  const n = parseInt(value, 10);
  const pawnsCp = Math.round(Number(pawns.replace(",", ".")) * 100);
  const neutralPawnsCp = Math.round(Number(neutralPawns.replace(",", ".")) * 100);
  async function save(patch: Partial<Settings> = {}) {
    setError(null);
    setNote(null);
    try {
      const r = await fetch(apiUrl("/cloud-eval/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // The whole settings each time: the server takes what is left out as
        // its default.
        body: JSON.stringify({ max_move: maxMove ?? 20, ...services, lichess_strong_cp: strongCp, lichess_neutral_cp: neutralCp, ...(Number.isFinite(n) ? { max_move: n } : {}), ...patch }),
      });
      if (!r.ok) throw new Error((await r.text()) || `${r.status}`);
      show((await r.json()) as Settings);
      setNote("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  // The move cap is one setting for both services; each card shows it, and
  // a save's result shows in the card it was made in.
  const [from, setFrom] = useState<"chessdb" | "lichess">("chessdb");
  const status = maxMove == null ? undefined : maxMove === 0 ? "every move" : `up to move ${maxMove}`;
  const cap = (which: "chessdb" | "lichess") => maxMove != null && (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-body-sm text-on-surface">
        <span>Ask up to move</span>
        <input
          type="number" min={0} max={500} value={value} onChange={(e) => setValue(e.target.value)}
          {...commitOn(() => { if (Number.isFinite(n) && n >= 0 && n !== maxMove) { setFrom(which); void save({ max_move: n }); } })}
          className="w-20 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface tabular-nums"
        />
      </div>
      <p className="text-label-sm text-on-surface-variant">
        For both cloud engines; 0 asks about every move, the default is 20. Stockfish and Lc0 on the server analyse everything after it.
      </p>
    </div>
  );
  const result = (which: "chessdb" | "lichess") => from === which && (
    <>
      {note && <p className="text-body-sm text-success">{note}</p>}
      {error && <p className="text-body-sm text-error">{error}</p>}
    </>
  );
  const field = "w-20 h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface tabular-nums";
  return (
    <>
      <SectionCard title="chessdb.cn" status={status}>
        <p className="text-body-sm text-on-surface-variant">
          A community database of engine evaluations: it lists every move it knows, with its replies and
          strong replies, and marks the moves by its own rule. Looking a position up sends it there, and
          chessdb keeps what it is asked — past the opening, the positions of the games you study, often
          your own.
        </p>
        {maxMove != null && (
          <UseToggle label="Use chessdb.cn" onLabel="On" on={services.chessdb} onChange={(on) => { setFrom("chessdb"); void save({ chessdb: on }); }} />
        )}
        {cap("chessdb")}
        {result("chessdb")}
      </SectionCard>
      <SectionCard title="Lichess" status={status}>
        <p className="text-body-sm text-on-surface-variant">
          Stockfish evaluations cached in Lichess's cloud — popular positions only; every cached line is
          shown. Looking a position up sends it to Lichess.
        </p>
        {maxMove != null && (
          <>
            <UseToggle label="Use Lichess" onLabel="On" on={services.lichess} onChange={(on) => { setFrom("lichess"); void save({ lichess: on }); }} />
            <LichessStats />
            <div className="flex items-center gap-4 text-body-sm text-on-surface flex-wrap">
              <label className="flex items-center gap-2" title="A move within this much of the best is strong: marked ! in the Engine panel, and counted among the strong replies">
                <span>Strong within</span>
                <input value={pawns} onChange={(e) => setPawns(e.target.value)} inputMode="decimal" className={field}
                  {...commitOn(() => { if (Number.isFinite(pawnsCp) && pawnsCp >= 0 && pawnsCp !== strongCp) { setFrom("lichess"); void save({ lichess_strong_cp: pawnsCp }); } })} />
                <span className="text-on-surface-variant">pawns</span>
              </label>
              <label className="flex items-center gap-2" title="A move further behind the best than strong, up to this far, is neutral and left unmarked; further still, it is marked ?">
                <span>Neutral within</span>
                <input value={neutralPawns} onChange={(e) => setNeutralPawns(e.target.value)} inputMode="decimal" className={field}
                  {...commitOn(() => { if (Number.isFinite(neutralPawnsCp) && neutralPawnsCp >= 0 && neutralPawnsCp !== neutralCp) { setFrom("lichess"); void save({ lichess_neutral_cp: neutralPawnsCp }); } })} />
                <span className="text-on-surface-variant">pawns</span>
              </label>
            </div>
          </>
        )}
        {cap("lichess")}
        {result("lichess")}
      </SectionCard>
    </>
  );
}

// ── Kept engine results ──────────────────────────────────────────────────────
// Stockfish's and Lc0's results, one per position, kept in the database so a
// restart loses nothing — per engine version, as Stockfish 19 and 20 (or Lc0
// with another network) differ. Another version's result shows, labelled,
// until the engine in use has its own; old versions can be deleted here.
interface StoredEngine { engine: string; kind: string; positions: number; bytes: number; updated: number | null }

function EngineResultsSection() {
  const [rows, setRows] = useState<StoredEngine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The local engines' results and the cloud engines' answers, one list.
  const load = () => {
    Promise.all([
      fetch(apiUrl("/engine/results")).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))),
      fetch(apiUrl("/cloud-eval/kept")).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ])
      .then(([engines, cloud]: [StoredEngine[], { service: string; positions: number; bytes: number; updated: number | null }[]]) => {
        setRows([
          ...engines,
          ...cloud.map((c) => ({ engine: c.service === "lichess" ? "Lichess" : "chessdb.cn", kind: `cloud:${c.service}`, positions: c.positions, bytes: c.bytes, updated: c.updated })),
        ]);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(load, []);
  async function remove(row: StoredEngine) {
    setBusy(true);
    try {
      const url = row.kind.startsWith("cloud:")
        ? `/cloud-eval/kept?service=${row.kind.slice(6)}`
        : `/engine/results?engine=${encodeURIComponent(row.engine)}`;
      const r = await fetch(apiUrl(url), { method: "DELETE" });
      if (!r.ok) throw new Error((await r.text()) || `${r.status}`);
      setConfirm(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const size = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);
  const total = rows?.reduce((n, r) => n + r.positions, 0) ?? 0;
  return (
    <SectionCard title="Kept engine results" status={rows ? `${total.toLocaleString()} position${total === 1 ? "" : "s"}` : undefined}>
      <p className="text-body-sm text-on-surface-variant">
        Stockfish's and Lc0's furthest result for each position they analysed, kept in the database so a
        restart loses nothing — per engine version. After an upgrade the older version's result shows,
        greyed and labelled, until the new one has its own; delete an old version's results here when they
        are no longer wanted. chessdb.cn's and Lichess's answers are kept too, so a position is not asked
        again: trusted for a week (chessdb) or a month (Lichess), then shown with their date while fetched
        afresh.
      </p>
      {rows && rows.length === 0 && <p className="text-body-sm text-on-surface-variant">None yet.</p>}
      {rows && rows.length > 0 && (
        <table className="w-full text-body-sm text-on-surface">
          <thead>
            <tr className="text-label-sm text-on-surface-variant text-left">
              <th className="font-normal py-1">Engine</th>
              <th className="font-normal py-1 text-right">Positions</th>
              <th className="font-normal py-1 text-right">Size</th>
              <th className="font-normal py-1 text-right">Last kept</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.engine} className="border-t border-outline/30">
                <td className="py-1 pr-2 break-all">{r.engine}</td>
                <td className="py-1 text-right tabular-nums">{r.positions.toLocaleString()}</td>
                <td className="py-1 text-right tabular-nums">{size(r.bytes)}</td>
                <td className="py-1 text-right tabular-nums">{r.updated ? new Date(r.updated * 1000).toLocaleDateString() : "—"}</td>
                <td className="py-1 pl-2 text-right whitespace-nowrap">
                  {confirm === r.engine ? (
                    <>
                      <button onClick={() => void remove(r)} disabled={busy} className="h-7 px-3 rounded-full text-label-md text-error hover:bg-error/8 disabled:opacity-50">Delete {r.positions.toLocaleString()}</button>
                      <button onClick={() => setConfirm(null)} className="h-7 px-3 rounded-full text-label-md text-on-surface-variant hover:bg-on-surface/8">Cancel</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirm(r.engine)} className="h-7 px-3 rounded-full text-label-md text-primary hover:bg-primary/8">Delete…</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <p className="text-body-sm text-error">{error}</p>}
    </SectionCard>
  );
}

// ── Engine benchmark ──────────────────────────────────────────────────────────
// Stockfish's `bench` on the server: a fixed set of positions searched to a
// fixed depth, reporting nodes per second and the time taken, with the threads
// and hash in the fields above. Results collect in a table so configurations
// can be compared; the defaults come from rules, not from a benchmark.
interface BenchResult { engine: string; threads: number; hash_mb: number; depth: number; nodes: number; nps: number; ms: number; at?: number }
const BENCH_KEY = "engineBenchResults";
/** One length: depth 16 takes some ten seconds on a 16-thread machine. */
const BENCH_DEPTH = 16;

async function runBench(threads: number, hash_mb: number, depth: number): Promise<BenchResult> {
  const r = await fetch(apiUrl("/engine/bench"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threads, hash_mb, depth }),
  });
  if (!r.ok) throw new Error((await r.text()) || `${r.status}`);
  return (await r.json()) as BenchResult;
}

function EngineBench({ engine, physicalCores, threads, hash, onUse }: {
  engine: string | null; physicalCores: number; threads: number; hash: number; onUse: (threads: number, hash_mb: number) => void;
}) {
  const [results, setResults] = useState<BenchResult[]>(() => {
    try { return JSON.parse(localStorage.getItem(BENCH_KEY) ?? "[]") as BenchResult[]; } catch { return []; }
  });
  const [running, setRunning] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  const [error, setError] = useState<string | null>(null);

  function keep(r: BenchResult) {
    setResults((prev) => {
      const next = [r, ...prev].slice(0, 40);
      try { localStorage.setItem(BENCH_KEY, JSON.stringify(next)); } catch { /* per-device convenience only */ }
      return next;
    });
  }

  async function once() {
    setError(null);
    setRunning(`Running with ${threads} threads and ${hash} MB hash`);
    try { keep({ ...(await runBench(threads, hash, BENCH_DEPTH)), at: Date.now() }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRunning(null); }
  }

  const btn = "h-8 px-3 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 active:bg-primary/12 disabled:opacity-40 transition-colors duration-short3 ease-standard";
  return (
    <div className="space-y-2 pt-2 border-t border-outline/40">
      <div className="flex items-center gap-2 flex-wrap text-body-sm text-on-surface">
        <span className="text-title-sm">Benchmark</span>
        <div className="flex-1" />
        <ActionButton onClick={() => void once()} disabled={running !== null}>Run with these settings</ActionButton>
      </div>
      <p className="text-label-sm text-on-surface-variant">
        Stockfish's own benchmark with the threads and hash above: a fixed set of positions searched to
        depth {BENCH_DEPTH}. Compare the <b>speed</b> — it shows what more threads bring. The time varies
        from run to run with several threads, and the hash hardly shows in a benchmark; it pays off in
        long analyses. The engine does not analyse while this runs.
      </p>
      {running && (
        <p className="text-body-sm text-on-surface flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          {running} — {elapsed} s
        </p>
      )}
      {error && <p className="text-body-sm text-error">{error}</p>}
      {results.length > 0 && (() => {
        // The recommended run with the engine in use: at most one thread per
        // physical core — a core's second hardware thread adds a noisy 20-45%
        // and leaves the server nothing for its queries — and of those, the
        // fewest threads that reach 80% of the fastest. Ties go to the most
        // recent run.
        const own = results.filter((r) => r.engine === engine && r.threads <= physicalCores);
        const fastest = own.length ? Math.max(...own.map((r) => r.nps)) : 0;
        const top = own
          .filter((r) => r.nps >= 0.8 * fastest)
          .reduce<BenchResult | null>((best, r) => (!best || r.threads < best.threads ? r : best), null);
        return (
        <div className="overflow-x-auto">
          <table className="w-full text-body-sm tabular-nums">
            <thead className="text-label-sm text-on-surface-variant">
              <tr className="text-right">
                <th className="text-left font-normal py-1">When</th>
                <th className="text-left font-normal">Engine</th>
                <th className="font-normal">Threads</th>
                <th className="font-normal">Hash</th>
                <th className="font-normal">Speed</th>
                <th className="font-normal">Time</th>
                <th className="font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className={`text-right border-t border-outline/20 ${r === top ? "bg-secondary-container/60" : ""}`}>
                  <td className="text-left py-0.5 whitespace-nowrap">{r.at ? fmtWhen(r.at) : "—"}</td>
                  <td className="text-left">{r.engine}</td>
                  <td>{r.threads}</td>
                  <td>{r.hash_mb} MB</td>
                  <td className="font-semibold">
                    {r === top && (
                      <span
                        className="mr-1 text-label-sm font-normal text-on-secondary-container cursor-help"
                        title={`At most one thread per physical core (${physicalCores} here), and of those the fewest that reach 80% of the fastest: more add little, and take processor time the server needs for queries.`}
                      >
                        recommended
                      </span>
                    )}
                    {fmtNps(r.nps)}
                  </td>
                  <td>{(r.ms / 1000).toFixed(1)} s</td>
                  <td className="pl-2">
                    {r === top && !(r.threads === threads && r.hash_mb === hash) && (
                      <button
                        onClick={() => onUse(r.threads, r.hash_mb)}
                        className="h-6 px-2 rounded-full text-label-sm text-primary hover:bg-primary/8 active:bg-primary/12"
                        title={`Set ${r.threads} threads and ${r.hash_mb} MB hash`}
                      >
                        Use
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => { setResults([]); try { localStorage.removeItem(BENCH_KEY); } catch { /* ignore */ } }} className={`${btn} mt-1`}>
            Clear results
          </button>
        </div>
        );
      })()}
    </div>
  );
}

/** "18:42" today, "26 Sep 18:42" before. */
function fmtWhen(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

function fmtNps(nps: number): string {
  return nps >= 1e6 ? `${(nps / 1e6).toFixed(1)} Mn/s` : `${Math.round(nps / 1e3)} kn/s`;
}

// Diagnostics — the crash log, readable after the reload that follows a crash.
// A blank window used to be the whole report; this is where the reason lives.
function DiagnosticsSection() {
  const [entries, setEntries] = useState<CrashEntry[]>(() => readCrashLog());
  const [note, setNote] = useState<string | null>(null);
  const report = formatCrashLog(entries);

  async function saveToFile() {
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const path = await save({ defaultPath: `lpdo-diagnostics-${stamp}.txt`, filters: [{ name: "Text", extensions: ["txt"] }] });
      if (!path) return;
      // Generic "write this text there" command (named for its first caller).
      await invoke("write_pgn_file", { path, content: report });
      setNote(`Saved to ${path}`);
    } catch (e) {
      setNote(`Could not save: ${e}`);
    }
  }

  function emailReport() {
    // Never sends anything by itself: this opens a draft for you to review,
    // address and send. Mail clients cap the body, so the file goes as an
    // attachment you add — the draft says so.
    const last = entries[0];
    const summary = last ? `${last.at} · ${last.kind}\n${last.message}` : "No crashes recorded.";
    const body = `LPDO diagnostics\n\n${summary}\n\n(Please attach the diagnostics file saved from Maintenance → Others → Diagnostics.)`;
    void openUrl(`mailto:?subject=${encodeURIComponent("LPDO crash report")}&body=${encodeURIComponent(body)}`);
  }

  return (
    <SectionCard title="Diagnostics" status={entries.length ? `${entries.length} recorded` : "none recorded"}>
      <p className="text-body-md text-on-surface-variant">
        Errors the app could not recover from, with the time, the screen you were on and whether the
        server was local or over the network. Nothing leaves this machine unless you send it.
      </p>
      {entries.length > 0 && (
        <pre className="max-h-64 overflow-auto rounded-md bg-surface-container p-3 text-body-sm text-on-surface whitespace-pre-wrap break-words">{report}</pre>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => { void saveToFile(); }}
          disabled={entries.length === 0}
          className="h-9 px-4 rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 disabled:opacity-40 transition-all duration-short3 ease-standard"
        >Save to file…</button>
        <button
          onClick={() => { void navigator.clipboard?.writeText(report); setNote("Copied to the clipboard"); }}
          disabled={entries.length === 0}
          className="h-9 px-4 rounded-full border border-outline text-on-surface text-label-md hover:bg-on-surface/8 disabled:opacity-40 transition-colors duration-short3 ease-standard"
        >Copy</button>
        <button
          onClick={emailReport}
          disabled={entries.length === 0}
          className="h-9 px-4 rounded-full border border-outline text-on-surface text-label-md hover:bg-on-surface/8 disabled:opacity-40 transition-colors duration-short3 ease-standard"
        >Email report…</button>
        <button
          onClick={() => { clearCrashLog(); setEntries([]); setNote("Cleared"); }}
          disabled={entries.length === 0}
          className="h-9 px-4 rounded-full text-error text-label-md hover:bg-error/8 disabled:opacity-40 transition-colors duration-short3 ease-standard"
        >Clear</button>
      </div>
      {note && <div className="text-label-md text-on-surface-variant">{note}</div>}
    </SectionCard>
  );
}

function SectionCard({ title, status, children }: {
  title: string; status?: string; children: React.ReactNode;
}) {
  // M3 Expressive box — matches the home screen's tonal containers: large 32px
  // corners, generous padding, sitting on the bg-surface base.
  return (
    <div className="bg-surface-container-highest rounded-2xl p-6 space-y-3 h-full">
      <div className="flex items-center justify-between">
        <h3 className="text-title-md text-on-surface">{title}</h3>
        {status && <span className="text-label-md text-on-surface-variant">{status}</span>}
      </div>
      {children}
    </div>
  );
}

function ActionButton({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  // M3 filled tonal button
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-8 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 transition-all duration-short3 ease-standard"
    >
      {children}
    </button>
  );
}

function ProgressSection({ progress, label, extra, quiet }: {
  progress: ReturnType<typeof useJobProgress>;
  label: string;
  /** Optional action rendered alongside Dismiss in the done row (e.g. "Reveal"). */
  extra?: React.ReactNode;
  /** Hide the scrolling per-line log and hold a stable label instead of the
   *  fast-changing live message — for jobs that emit a line per item (dedup can
   *  delete thousands). The Activity panel carries the live detail. */
  quiet?: boolean;
}) {
  return (
    <>
      <div className="flex justify-between gap-2 text-label-md text-on-surface-variant">
        <span className="truncate">{progress.done ? "Complete" : quiet ? label : progress.message || label}</span>
        <span className="shrink-0">{Math.round(progress.percent)}%</span>
      </div>
      <ProgressBar value={progress.percent} />
      {!quiet && <LogBox lines={progress.log} />}
      {progress.done && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-success text-body-sm">✓ {progress.doneMessage}</p>
          <div className="flex items-center gap-1 shrink-0">
            {extra}
            <button onClick={progress.reset} className="h-7 px-3 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard">Dismiss</button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Database info ─────────────────────────────────────────────────────────────

function DatabaseInfo({ status }: { status: StatusInfo | null }) {
  const [copied, setCopied] = useState(false);
  // The connected server reports its real DB path (e.g. /var/lib/lpdo/.chess-db/
  // chess.db for the system daemon). Older servers omit it.
  const dbPath = status?.db_path ?? "";

  function copy() {
    if (!dbPath) return;
    void navigator.clipboard.writeText(dbPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function fmt(n: number) { return n.toLocaleString(); }

  return (
    <SectionCard title="Database">
      <div className="flex items-center gap-2 mb-3">
        <span className="font-mono text-body-sm text-on-surface-variant flex-1 truncate">{dbPath || "—"}</span>
        {dbPath && (
          <button
            onClick={copy}
            className="h-7 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 transition-all duration-short3 ease-standard shrink-0"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {status ? (
        // Database-wide totals. Per-source metrics live in each source's card on
        // the Sources tab now (#197), not an aggregated block here.
        <div className="grid grid-cols-2 gap-2">
          {([
            ["Games",         fmt(status.games)],
            ["Players",       fmt(status.players)],
            ["Positions",     fmt(status.positions)],
            ["Local imports", fmt(status.local_imports ?? 0)],
          ] as [string, string][]).map(([label, value]) => (
            <div key={label} className="bg-surface-container rounded-sm px-3 py-2">
              <div className="text-label-sm text-on-surface-variant uppercase tracking-wider">{label}</div>
              <div className="text-body-md font-mono text-on-surface mt-0.5">{value}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-body-sm text-on-surface-variant">Server offline — statistics unavailable.</p>
      )}
    </SectionCard>
  );
}

// ── Players section ───────────────────────────────────────────────────────────

// Small outline button for the file/folder pickers (matches AddGameDialog).
const pickerBtn =
  "h-9 px-3 inline-flex items-center rounded-sm border border-outline text-on-surface-variant text-label-md hover:bg-on-surface/8 transition-colors duration-short3 ease-standard shrink-0";

// Where player-reference exports are written by default. Mirrors the backup
// folder; the chosen path is remembered across sessions.
const PLAYERS_EXPORT_DIR = "~/lpdo/backup";
const PLAYERS_EXPORT_DIR_KEY = "playersExportDir";

function PlayersSection() {
  const [path, setPath] = useState("");
  const [exportDir, setExportDir] = useState(
    () => localStorage.getItem(PLAYERS_EXPORT_DIR_KEY) || PLAYERS_EXPORT_DIR,
  );
  const importProgress = useJobProgress("maint-players-import");
  const exportProgress = useJobProgress("maint-players-export");

  // Remember the export folder whenever the user edits or picks a new one.
  useEffect(() => { localStorage.setItem(PLAYERS_EXPORT_DIR_KEY, exportDir); }, [exportDir]);

  function runImport() {
    void importProgress.run(["players", "import", path]);
  }

  function runExport() {
    void exportProgress.run(["players", "export", "--dir", exportDir.trim() || PLAYERS_EXPORT_DIR]);
  }

  async function pickFile() {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof picked === "string") setPath(picked);
  }

  async function pickFolder() {
    const picked = await openDialog({ multiple: false, directory: true });
    if (typeof picked === "string") setExportDir(picked);
  }

  return (
    <SectionCard title="Player reference file">
      <p className="text-body-sm text-on-surface-variant">
        Import a player reference file (FIDE-canonical names), or export your normalised players to a
        timestamped CSV — e.g.{" "}
        <span className="font-mono text-on-surface-variant">20260621-players.csv</span>.
      </p>

      <div className="space-y-3">
        {/* Import */}
        <div className="space-y-1">
          <div className="text-label-md text-on-surface">Import</div>
          {!importProgress.running && !importProgress.done && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/path/to/players.csv"
                  className="flex-1 h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
                />
                <button onClick={pickFile} className={pickerBtn}>File…</button>
              </div>
              <ActionButton onClick={runImport} disabled={!path.trim()}>Import file…</ActionButton>
            </div>
          )}
          {(importProgress.running || importProgress.done) && (
            <ProgressSection progress={importProgress} label="Importing…" />
          )}
        </div>

        {/* Export */}
        <div className="space-y-1 pt-3">
          <div className="text-label-md text-on-surface">Export</div>
          {!exportProgress.running && !exportProgress.done && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={exportDir}
                  onChange={(e) => setExportDir(e.target.value)}
                  placeholder={PLAYERS_EXPORT_DIR}
                  className="flex-1 h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
                />
                <button onClick={pickFolder} className={pickerBtn}>Folder…</button>
              </div>
              <ActionButton onClick={runExport}>Export to a file</ActionButton>
            </div>
          )}
          {(exportProgress.running || exportProgress.done) && (
            <ProgressSection
              progress={exportProgress}
              label="Exporting…"
              extra={exportProgress.donePath && (
                <button
                  onClick={() => { void revealItemInDir(exportProgress.donePath!); }}
                  className="h-7 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 transition-all duration-short3 ease-standard"
                >
                  Reveal in file manager
                </button>
              )}
            />
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ── Fetch missing FIDE IDs (reverse resolution) ───────────────────────────────

function ResolveFideSection({ onMutated }: { onMutated?: () => void }) {
  const progress = useJobProgress("maint-resolve-fide");
  useEffect(() => { if (progress.done) onMutated?.(); }, [progress.done]);
  return (
    <SectionCard title="Fetch missing FIDE IDs">
      <p className="text-body-sm text-on-surface-variant">
        Assign FIDE IDs to players that lack one by matching their name against the local FIDE list
        — useful for FIDE-less sources (e.g. Ajedrez). Only a single exact match is used; ambiguous
        names are left as-is.
      </p>
      {!progress.running && !progress.done && (
        <ActionButton onClick={() => void progress.run(["players", "resolve-fide"])}>
          Fetch FIDE IDs
        </ActionButton>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection progress={progress} label="Matching names…" />
      )}
    </SectionCard>
  );
}

// ── Prepare database (the whole pipeline, on demand) ──────────────────────────

/** Runs the same coalesced pass that follows an import — the one the activity
 *  panel has always called "Prepare database", while being reachable only as a
 *  side effect of importing. The cards below remain for running a single step.
 *
 *  Progress belongs to the activity panel: this enqueues six jobs, and each has
 *  its own row there, so duplicating a bar here would only ever show one of them.
 */
function PrepareDatabaseSection({ onMutated }: { onMutated?: () => void }) {
  const [state, setState] = useState<"idle" | "starting" | "started" | "deferred" | "failed">("idle");

  async function run() {
    setState("starting");
    try {
      const r = await fetch("/api/maintenance/run", { method: "POST" });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      const { started } = (await r.json()) as { started: boolean };
      setState(started ? "started" : "deferred");
      onMutated?.();
    } catch {
      setState("failed");
    }
  }

  return (
    <SectionCard title="Prepare database">
      <p className="text-body-sm text-on-surface-variant">
        Runs every maintenance step in the right order: fetch FIDE IDs, normalise names, merge
        duplicate players (all on the Players tab), remove duplicate games, rebuild the position
        index. This is what runs by itself after an import — start it here if a run was
        interrupted, or after restoring a database.
      </p>
      <div className="flex items-center gap-2">
        <ActionButton onClick={() => void run()} disabled={state === "starting"}>
          {state === "starting" ? "Starting…" : "Run all steps"}
        </ActionButton>
        {state === "started" && (
          <span className="text-body-sm text-on-surface-variant">
            Started — follow it in the activity panel.
          </span>
        )}
        {state === "deferred" && (
          <span className="text-body-sm text-on-surface-variant">
            Queued — it starts when the current work finishes.
          </span>
        )}
        {state === "failed" && (
          <span className="text-body-sm text-error">Could not start — is the server reachable?</span>
        )}
      </div>
    </SectionCard>
  );
}

// ── Merge duplicate players, automatically (same FIDE ID or same name) ────────

function DedupPlayersSection({ onMutated }: { onMutated?: () => void }) {
  const progress = useJobProgress("maint-dedup-players");
  // Which of the two buttons is running, so the progress row doesn't claim to be
  // merging while it is only previewing.
  const [preview, setPreview] = useState(false);
  useEffect(() => { if (progress.done) onMutated?.(); }, [progress.done]);
  return (
    <SectionCard title="Merge duplicate players — automatic">
      <p className="text-body-sm text-on-surface-variant">
        Searches the whole database for records that are one person — they share a FIDE ID, or
        they share a name once capitals, commas and spacing are ignored — and merges each set
        into one, moving all their games with them. Two records with <em>different</em> FIDE IDs
        under one name are left alone: FIDE says they are different people. Running “Fetch
        missing FIDE IDs” first links more of them. Duplicates spelled differently with no FIDE
        ID on either side still need “Merge two players”.
      </p>
      {!progress.running && !progress.done && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Preview first: merging cannot be undone, so the safe action is
                the one offered alongside, not buried behind a checkbox. */}
            <ActionButton onClick={() => { setPreview(true); void progress.run(["players", "dedup", "--dry-run"]); }}>
              Preview
            </ActionButton>
            <ActionButton onClick={() => { setPreview(false); void progress.run(["players", "dedup"]); }}>
              Find and merge duplicates
            </ActionButton>
          </div>
          <p className="text-label-sm text-on-surface-variant">
            Preview lists every merge it would make and changes nothing. Merging cannot be undone.
          </p>
        </div>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection
          progress={progress}
          label={preview ? "Checking for duplicates…" : "Merging duplicate players…"}
        />
      )}
    </SectionCard>
  );
}

// ── Update the local FIDE player list ─────────────────────────────────────────

function FideRefreshSection() {
  const progress = useJobProgress("maint-fide-refresh");
  // Last-refreshed + due status (#194): the FIDE list is scheduled housekeeping
  // like the feeds, so surface when it last updated and whether one's due.
  const [sched, setSched] = useState<ScheduleInfo | null>(null);
  const loadSched = useCallback(() => { getSchedule().then(setSched).catch(() => {}); }, []);
  // Refetch on mount and when a MANUAL refresh (submitted by this panel) finishes.
  useEffect(() => { loadSched(); }, [loadSched, progress.done]);
  // Also pick up BACKGROUND refreshes — the monthly scheduler run and the
  // post-sync maintenance pipeline run `fide_refresh` as a daemon job, which this
  // panel's own `progress` hook never sees. Poll the job list and re-load the
  // schedule whenever a fide_refresh job finishes, so "last refreshed / update
  // due" reflects it without a manual page reload.
  useEffect(() => {
    let stop = false;
    let prevActive = false;
    const check = () =>
      getJobs()
        .then((js) => {
          if (stop) return;
          const active = js.some(
            (j) => j.type === "fide_refresh" && (j.status === "running" || j.status === "queued"),
          );
          if (prevActive && !active) loadSched(); // one just finished
          prevActive = active;
        })
        .catch(() => { /* offline — leave last known */ });
    check();
    const id = setInterval(check, 3000);
    return () => { stop = true; clearInterval(id); };
  }, [loadSched]);
  const lastRefreshed = sched?.fide_last_refreshed?.slice(0, 10) ?? null;

  return (
    <SectionCard title="FIDE player list">
      <p className="text-body-sm text-on-surface-variant">
        Download the latest official FIDE player list. It also refreshes automatically about once a
        month; use this to update it now (it powers name normalisation and FIDE-ID matching).
      </p>
      {sched && (
        <p className="text-label-sm text-on-surface-variant">
          {lastRefreshed ? `Last refreshed ${lastRefreshed}` : "Never refreshed"}
          {sched.fide_due && <span className="text-warning"> · update due</span>}
        </p>
      )}
      {!progress.running && !progress.done && (
        <ActionButton onClick={() => void progress.run(["fide", "refresh"])}>
          Update FIDE list
        </ActionButton>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection progress={progress} label="Downloading FIDE list…" />
      )}
    </SectionCard>
  );
}

// ── Remove duplicate games ────────────────────────────────────────────────────

function DedupGamesSection({ onMutated }: { onMutated?: () => void }) {
  const progress = useJobProgress("maint-dedup");
  // Full re-checks every game (cleans duplicates an earlier pass missed, e.g. the
  // same game across TWIC and a Lichess broadcast); incremental only checks games
  // added since the last pass — the same cheap sweep the automatic post-sync
  // maintenance runs. Default to full: a manual run is usually a deliberate clean.
  const [mode, setMode] = useState<"incremental" | "full">("full");

  function run() {
    void progress.run(mode === "full" ? ["games", "dedup", "--full"] : ["games", "dedup"]);
  }

  // Dedup removes duplicate game rows — refresh server status + game list
  // when it finishes so the UI reflects the new totals immediately.
  useEffect(() => {
    if (progress.done) onMutated?.();
  }, [progress.done]);

  return (
    <SectionCard title="Remove duplicate games">
      <p className="text-body-sm text-on-surface-variant">
        Finds games stored more than once — the same game from two overlapping sources, or a PGN
        imported twice — and keeps the most complete copy. Two games only match when they name the
        same two <em>player records</em>, so merge duplicate players (Players tab) first.
      </p>
      {!progress.running && !progress.done && (
        <>
          <div className="inline-flex items-center gap-1 p-1 bg-surface-container rounded-full w-fit">
            {(["incremental", "full"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`h-7 px-3 rounded-full text-label-md capitalize transition-colors duration-short3 ease-standard ${
                  mode === m
                    ? "bg-secondary-container text-on-secondary-container"
                    : "text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <p className="text-label-sm text-on-surface-variant">
            {mode === "full"
              ? "Full — re-checks every game (slower). Cleans duplicates an earlier pass missed."
              : "Incremental — only games added since the last pass (fast); same as the automatic sweep."}
          </p>
          <ActionButton onClick={run}>Remove duplicate games</ActionButton>
        </>
      )}
      {(progress.running || progress.done) && (
        // Quiet: a full dedup deletes thousands of rows, one log line each — the
        // Activity panel shows the live detail; here just a calm bar + summary.
        <ProgressSection progress={progress} label="Removing duplicates…" quiet />
      )}
    </SectionCard>
  );
}

// ── Position index section ────────────────────────────────────────────────────

function IndexSection() {
  const progress = useJobProgress("maint-index");
  const [rebuild, setRebuild] = useState(false);

  function run() {
    if (
      rebuild &&
      !window.confirm(
        "Rebuild the entire position index from scratch? This wipes the positions " +
          "table and reprocesses every game — on a multi-million-game database " +
          "that takes several minutes. You can cancel it; the index is then " +
          "completed by the next \"Update index\" run.",
      )
    ) {
      return;
    }
    // Full rebuild uses --fast (appender), the same path the setup wizard uses
    // for the initial index — orders of magnitude faster than the transactional
    // path on a multi-million-game database (measured ~170x). Both modes are
    // cancellable: the fill checks between windows and chunks, committing whole
    // games, so a cancelled run is simply finished by the next incremental one.
    void progress.run(
      rebuild ? ["index-positions", "--rebuild", "--fast"] : ["index-positions"],
    );
  }

  return (
    <SectionCard title="Position index">
      <p className="text-body-sm text-on-surface-variant">
        Index positions for newly imported games. Required for the move explorer to include recent games.
      </p>
      {!progress.running && !progress.done && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-body-sm text-on-surface-variant cursor-pointer select-none">
            <input
              type="checkbox"
              checked={rebuild}
              onChange={(e) => setRebuild(e.target.checked)}
              className="cursor-pointer accent-primary w-4 h-4"
            />
            <span>Rebuild from scratch — reprocess every game</span>
          </label>
          <ActionButton onClick={run}>{rebuild ? "Rebuild index" : "Update index"}</ActionButton>
        </div>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection progress={progress} label="Indexing…" />
      )}
    </SectionCard>
  );
}

// ── Player name normalisation section ─────────────────────────────────────────

function NormaliseSection({ onMutated }: { onMutated?: () => void }) {
  const progress = useJobProgress("maint-normalise");

  // Player names change here, so refresh server status + any open game lists
  // once it finishes (so renamed players show their canonical form).
  useEffect(() => { if (progress.done) onMutated?.(); }, [progress.done]);

  function run() {
    void progress.run(["players", "normalise"]);
  }

  return (
    <SectionCard title="Normalise player names">
      <p className="text-body-sm text-on-surface-variant">
        Update player names to their FIDE-canonical form using the locally-stored FIDE list.
        This runs instantly — no online lookups. If names don't change, update the FIDE list
        first (“FIDE player list”, at the top of this tab).
      </p>
      {!progress.running && !progress.done && (
        <ActionButton onClick={run}>Normalise names</ActionButton>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection progress={progress} label="Normalising player names…" />
      )}
    </SectionCard>
  );
}

// ── Backup tab ────────────────────────────────────────────────────────────────
// Saving and the daily automatic backup live in lib/backup.ts; here are the
// folder, the cards and their switches.

interface Collection { id: number; name: string; game_count: number }

/** Everything that can be backed up, side by side, saved to one folder, each
 *  with its daily automatic backup. */
function BackupTab() {
  const [folder, setFolder] = useState<string>(backupFolder);

  async function browse() {
    const picked = await openDialog({ multiple: false, directory: true });
    if (typeof picked === "string") setFolder(rememberBackupFolder(picked));
  }

  return (
    <div className="space-y-4">
      <TabLead>
        What you made yourself, saved as zip-compressed PGN files in one folder: a collection, and your repertoire
        books. Each backup is named by date and what it holds. A daily backup is made by the app while it is open —
        when it starts, then hourly — and only when something has changed since the last one.
      </TabLead>
      <div className={grid}>
        <div className="md:col-span-2">
          <SectionCard title="Backup folder">
            <div className="flex gap-2">
              <input
                type="text"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                onBlur={() => rememberBackupFolder(folder)}
                placeholder={DEFAULT_BACKUP_DIR}
                spellCheck={false}
                className="flex-1 min-w-0 h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
              />
              <button
                onClick={() => { void browse(); }}
                className="h-9 px-3 shrink-0 inline-flex items-center rounded-sm border border-outline text-on-surface text-label-md hover:bg-on-surface/8 transition-colors duration-short3 ease-standard"
              >
                Browse…
              </button>
            </div>
          </SectionCard>
        </div>
        <CollectionBackupSection folder={folder} />
        <RepertoireBackupSection folder={folder} />
      </div>
    </div>
  );
}

/** A backup written: where, a way to it, and back to the start. */
function BackupSaved({ path, again, onAgain }: { path: string | null; again: string; onAgain: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-body-sm text-success">✓ Backup saved.</p>
      {path && <p className="text-label-sm text-on-surface-variant break-all font-mono">{path}</p>}
      <div className="flex gap-2">
        {path && (
          <button
            onClick={() => { void revealItemInDir(path); }}
            className="h-7 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 transition-all duration-short3 ease-standard"
          >
            Reveal in file manager
          </button>
        )}
        <button
          onClick={onAgain}
          className="h-7 px-3 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard"
        >
          {again}
        </button>
      </div>
    </div>
  );
}

/** The daily backup's switch, and what it last did. */
function DailyBackupToggle({ kind, label }: { kind: BackupKind; label: string }) {
  const [auto, setOn] = useAutoBackup(kind);
  const day = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local
  // When it last saved, and — on a day with nothing new — when it looked.
  // (Backups made before the time was kept show only their day.)
  const saved = auto.savedAt ? whenAt(auto.savedAt) : auto.savedOn === day ? "today" : auto.savedOn;
  const lookedToday = auto.checkedOn === day && auto.savedOn !== day;
  const last = !auto.on ? null
    : auto.error ? <span className="text-error">Last try failed: {auto.error}</span>
    : auto.savedOn ? <>Last saved {saved}{lookedToday ? ` · no changes when checked ${auto.checkedAt ? whenAt(auto.checkedAt) : "today"}` : ""}</>
    : "Not saved yet";
  return (
    <div className="space-y-1 pt-1">
      <label className="flex items-center gap-2 text-body-sm text-on-surface cursor-pointer">
        <input type="checkbox" checked={auto.on} onChange={(e) => setOn(e.target.checked)} className="accent-primary" />
        {label}
      </label>
      {last && <p className="text-label-sm text-on-surface-variant break-words pl-6" title={auto.path}>{last}</p>}
    </div>
  );
}

function CollectionBackupSection({ folder }: { folder: string }) {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [collection, setCollection] = useState(backupCollection);
  const [phase, setPhase] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [pct, setPct] = useState<number | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/collections")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Collection[]) => {
        if (cancelled) return;
        setCollections(list);
        setCollection((cur) =>
          list.some((c) => c.name === cur)
            ? cur
            : list.find((c) => c.name === DEFAULT_COLLECTION)?.name ?? list[0]?.name ?? cur,
        );
      })
      .catch(() => { if (!cancelled) setCollections([]); });
    return () => { cancelled = true; };
  }, []);

  function pick(name: string) {
    setCollection(name);
    rememberBackupCollection(name);
  }

  async function run() {
    setError(null);
    const dir = rememberBackupFolder(folder);
    if (!dir) return;
    setPhase("saving");
    setPct(null);
    const un = await listen<{ received: number; total: number }>("backup-download-progress", (e) => {
      const { received, total } = e.payload;
      setPct(total > 0 ? Math.min(100, (received / total) * 100) : null);
    });
    try {
      setSavedPath(await saveBackup("collection", dir, collection));
      setPhase("done");
    } catch (e: unknown) {
      setError(String(e));
      setPhase("error");
    } finally {
      un();
    }
  }

  const hasCollections = collections === null || collections.length > 0;

  return (
    <SectionCard title="Collections">
      <p className="text-body-sm text-on-surface-variant">
        One collection's games, oldest first. Restore by importing the file into a collection.
      </p>

      {phase === "idle" && (
        hasCollections ? (
          <div className="space-y-2">
            <select
              value={collection}
              onChange={(e) => pick(e.target.value)}
              disabled={collections === null}
              className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard disabled:opacity-40"
            >
              {collections === null ? (
                <option>Loading…</option>
              ) : (
                collections.map((c) => (
                  <option key={c.id} value={c.name} className="bg-surface-container-highest text-on-surface">
                    {c.name} ({c.game_count.toLocaleString()})
                  </option>
                ))
              )}
            </select>
            <ActionButton onClick={() => { void run(); }} disabled={collections === null || !collection || !folder.trim()}>
              Back up
            </ActionButton>
          </div>
        ) : (
          <p className="text-body-sm text-on-surface-variant">No collections to back up yet.</p>
        )
      )}

      {phase === "saving" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-label-sm text-on-surface-variant">
            <span>Preparing &amp; saving backup…</span>
            {pct != null && <span>{Math.round(pct)}%</span>}
          </div>
          <div className="relative w-full bg-surface-container-highest rounded-full h-1.5 overflow-hidden">
            {pct != null ? (
              <div className="bg-primary h-1.5 rounded-full transition-all duration-short3 ease-standard" style={{ width: `${pct}%` }} />
            ) : (
              <div className="lpdo-indeterminate bg-primary" />
            )}
          </div>
        </div>
      )}

      {phase === "done" && (
        <BackupSaved path={savedPath} again="Back up another" onAgain={() => { setPhase("idle"); setSavedPath(null); }} />
      )}

      {phase === "error" && (
        <div className="space-y-2">
          <p className="text-label-sm text-error break-words">Backup failed: {error}</p>
          <ActionButton onClick={() => { void run(); }}>Try again</ActionButton>
        </div>
      )}

      {hasCollections && <DailyBackupToggle kind="collection" label="Back up the selected collection daily, when it has changed" />}
    </SectionCard>
  );
}

/** The repertoire's backup: every book in one zipped PGN, with each book's
 *  name, colour, author, link, notes and switches — "Import…" in the Repertoire
 *  page's Books panel makes them all again, on this server or another. */
function RepertoireBackupSection({ folder }: { folder: string }) {
  const [phase, setPhase] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    const dir = rememberBackupFolder(folder);
    if (!dir) return;
    setPhase("saving");
    try {
      setSavedPath(await saveBackup("repertoire", dir, ""));
      setPhase("done");
    } catch (e: unknown) {
      setError(String(e));
      setPhase("error");
    }
  }

  return (
    <SectionCard title="Repertoire books">
      <p className="text-body-sm text-on-surface-variant">
        Every book — its name, colour, author, link and notes, its chapters with their lines, comments and switches.
        Restore, on this server or another, with Repertoire → Books → Import…, which makes each book again as a new one.
      </p>
      {(phase === "idle" || phase === "saving") && (
        <ActionButton onClick={() => { void run(); }} disabled={phase === "saving" || !folder.trim()}>
          {phase === "saving" ? "Saving…" : "Back up all books"}
        </ActionButton>
      )}
      {phase === "done" && (
        <BackupSaved path={savedPath} again="Back up again" onAgain={() => { setPhase("idle"); setSavedPath(null); }} />
      )}
      {phase === "error" && (
        <div className="space-y-2">
          <p className="text-label-sm text-error break-words">Backup failed: {error}</p>
          <ActionButton onClick={() => { void run(); }}>Try again</ActionButton>
        </div>
      )}
      <DailyBackupToggle kind="repertoire" label="Back up all books daily, when they have changed" />
    </SectionCard>
  );
}

// ── Purge soft-deleted section ────────────────────────────────────────────────

function PurgeSection({ status, onMutated }: { status: StatusInfo | null; onMutated?: () => void }) {
  const progress = useJobProgress();
  const [confirming, setConfirming] = useState(false);
  const count = status?.deleted_games ?? 0;

  function run() {
    setConfirming(false);
    void progress.run(["games", "purge"]);
  }

  // Notify the host once the purge subprocess finishes — App refreshes
  // server status (so the count drops to 0) and any open game list (so
  // the just-purged rows disappear).
  useEffect(() => {
    if (progress.done) onMutated?.();
  }, [progress.done]);

  return (
    <SectionCard title="Soft-deleted games" status={count > 0 ? `${count.toLocaleString()} pending` : undefined}>
      <p className="text-body-sm text-on-surface-variant">
        Permanently removes every soft-deleted game from the database, along with its
        position-index rows and collection memberships. This is not reversible.
      </p>
      {!progress.running && !progress.done && count === 0 && (
        <p className="text-body-sm text-on-surface-variant">No soft-deleted games to purge.</p>
      )}
      {!progress.running && !progress.done && !confirming && count > 0 && (
        <ActionButton onClick={() => setConfirming(true)}>Purge {count.toLocaleString()} games…</ActionButton>
      )}
      {confirming && (
        <div className="bg-error-container text-on-error-container rounded-md p-3 text-body-sm space-y-2">
          <div>
            About to permanently delete {count.toLocaleString()} game(s). This cannot be undone — restoring is no longer possible after purge.
          </div>
          <div className="flex gap-2">
            {/* Filled error — irreversible destructive action */}
            <button
              onClick={run}
              className="h-8 px-3 inline-flex items-center rounded-full bg-error text-on-error text-label-md hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
            >
              Yes, purge permanently
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="h-8 px-3 inline-flex items-center rounded-full text-on-error-container text-label-md hover:bg-on-error-container/10 transition-colors duration-short3 ease-standard"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection progress={progress} label="Purging…" />
      )}
    </SectionCard>
  );
}

// ── Panel shell ───────────────────────────────────────────────────────────────

// ── Merge two players, by hand ────────────────────────────────────────────────

function MergePlayersSection({ onMutated }: { onMutated?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <SectionCard title="Merge two players — manual">
      <p className="text-body-sm text-on-surface-variant">
        Pick two records yourself and combine them — e.g. a full name (“Karpov, Anatoly”) and a
        surname-only entry (“Karpov”) for the same person. All games move to the record you keep.
        This is the way to fix duplicates the automatic merge cannot see: the two spellings differ,
        and neither record carries a FIDE ID to link them.
      </p>
      <ActionButton onClick={() => setOpen(true)}>Choose two players…</ActionButton>
      {open && (
        <MergePlayersDialog onClose={() => setOpen(false)} onMerged={() => onMutated?.()} />
      )}
    </SectionCard>
  );
}


// ── Tabs ──────────────────────────────────────────────────────────────────────

/** A tab's cards: two columns where there is room. */
const grid = "grid grid-cols-1 md:grid-cols-2 gap-4 items-start";

const TABS = [
  { id: "sources", label: "Sources" },
  { id: "databases", label: "Database" },
  { id: "players", label: "Players" },
  { id: "engines", label: "Engines" },
  { id: "repertoire", label: "Repertoire" },
  { id: "backup", label: "Backup" },
  { id: "others", label: "Others" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** One sentence above a tab's cards saying what the tab is for and in which
 *  order its steps belong — the grouping alone never conveyed that, and the
 *  Players/Database split only makes sense once you know duplicate games are
 *  matched through their player records. */
function TabLead({ children }: { children: React.ReactNode }) {
  return <p className="text-body-md text-on-surface-variant max-w-3xl">{children}</p>;
}

function TabBar({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  // M3 primary tabs — a row of text labels with an active underline indicator.
  return (
    <div className="flex gap-1 border-b border-outline-variant">
      {TABS.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`relative h-12 px-4 text-label-lg transition-colors duration-short3 ease-standard ${
              selected ? "text-primary" : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {t.label}
            {selected && (
              <span className="absolute left-2 right-2 bottom-0 h-0.5 rounded-full bg-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function MaintenancePanel({ onRunWizard, status, onMutated, connection = "connected" }: Props) {
  // Full-screen, non-modal view (driven by App's `mode` state). Mirrors the home
  // screen's layout: a centred max-width column on the bg-surface base. The tools
  // are grouped by what they act on — Sources (where games come from), Database
  // (the games), Players (who played them), Others (the app itself) — to keep
  // each view uncluttered; the database overview stays pinned above the tabs.
  const [tab, setTab] = useState<TabId>("sources");

  // Inactive tabs are hidden, not unmounted, so a long-running job (e.g. a TWIC
  // import) keeps its live progress when you switch away and back.

  return (
    <div className="flex-1 overflow-y-auto bg-surface">
      <div className="max-w-6xl mx-auto px-8 py-10 space-y-8">

        {/* Header — title + setup-wizard entry point */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-display-sm text-on-surface">Maintenance</h1>
            <p className="text-body-lg text-on-surface-variant">
              Import data, keep your database tidy, and rebuild indexes.
            </p>
          </div>
          <button
            onClick={onRunWizard}
            className="shrink-0 h-11 px-5 rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
          >
            Run setup wizard
          </button>
        </div>

        {/* Database overview — full-width box, shared across tabs */}
        <DatabaseInfo status={status} />

        {/* Not connected: the tools below would each fail with their own raw
            fetch error, which is noise once we know the server state. Show one
            explanation and the card that fixes it. */}
        {connection !== "connected" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            <SectionCard title={connection === "unauthorized" ? "Access denied" : "Server not reachable"}>
              <p className="text-body-sm text-on-surface-variant">
                {connection === "unauthorized"
                  ? "The server is reachable but rejected the access token. Enter the value from the server's access-token file in the Server connection card."
                  : "The maintenance tools need a running server. Check the address below, that the server machine is up with network access enabled, and that its firewall allows the port."}
              </p>
              <ActionButton onClick={() => { void openUrl("https://github.com/specure/lpdo/blob/main/docs/remote-server.md"); }}>
                How to set up a remote server
              </ActionButton>
            </SectionCard>
            <ServerConnectionSection status={status} connection={connection} />
          </div>
        ) : (
        <div className="space-y-6">
          <TabBar active={tab} onChange={setTab} />

          <div className={tab === "sources" ? "" : "hidden"}>
            <SourcesPanel onMutated={onMutated} />
          </div>

          {/* Database — what happens to the games themselves. "Prepare database"
              runs every step of the maintenance pipeline, here and on the Players
              tab, in the right order; the cards are the individual steps. */}
          <div className={tab === "databases" ? "space-y-4" : "hidden"}>
            <TabLead>
              Work on the stored games: run the whole maintenance pipeline, remove copies of the
              same game, rebuild the position index, and empty the recycle bin. Player records are
              cleaned up on the Players tab — do that first, since duplicate games are recognised
              by their two players.
            </TabLead>
            <div className={grid}>
              <PrepareDatabaseSection onMutated={onMutated} />
              <DedupGamesSection onMutated={onMutated} />
              <IndexSection />
              <PurgeSection status={status} onMutated={onMutated} />
            </div>
          </div>

          {/* Players — everything that decides WHO a game was played by. In the
              order the automatic pipeline runs them, with the manual merge next
              to the automatic one it complements. */}
          <div className={tab === "players" ? "space-y-4" : "hidden"}>
            <TabLead>
              One person can arrive from several sources under several spellings, leaving one
              player record per spelling — and that also hides duplicate games, which are matched
              by their two players. These steps identify players and fold the duplicates together,
              in the order shown.
            </TabLead>
            {/* Two columns, in pipeline order: the FIDE list feeds the ID lookup
                (row 1), the canonical-name pair renames from it (row 2), and the
                merges come last — a rename can itself create a duplicate — with
                automatic and manual side by side so the pair reads at a glance
                (row 3). */}
            <div className={grid}>
              <FideRefreshSection />
              <ResolveFideSection onMutated={onMutated} />
              <NormaliseSection onMutated={onMutated} />
              <PlayersSection />
              <DedupPlayersSection onMutated={onMutated} />
              <MergePlayersSection onMutated={onMutated} />
            </div>
          </div>

          {/* Engines — the two on the server side by side, then the cloud ones. */}
          <div className={tab === "engines" ? "space-y-4" : "hidden"}>
            <TabLead>
              The engines behind the Engine panel. Stockfish and Lc0 run on this server, each with its own
              settings and benchmark; chessdb.cn and Lichess are cloud services, asked only in the opening.
            </TabLead>
            <div className={grid}>
              <EngineSection />
              <Lc0Section />
              <CloudEnginesSection />
              <div className="md:col-span-2"><EngineResultsSection /></div>
            </div>
          </div>

          <div className={tab === "repertoire" ? "space-y-4" : "hidden"}>
            <TabLead>
              The opening repertoire's practice: what a chapter's figures count. Chapters are analysed from the
              Repertoire page.
            </TabLead>
            <div className={grid}>
              <RepertoireSection />
            </div>
          </div>

          <div className={tab === "backup" ? "" : "hidden"}>
            <BackupTab />
          </div>

          <div className={`${grid} ${tab === "others" ? "" : "hidden"}`}>
            <ServerConnectionSection status={status} connection={connection} />
            <DiagnosticsSection />
          </div>
        </div>

        )}

        {/* Version footer — which build am I actually running? GUI and server
            are separate binaries (separate .debs on Linux), so show both: a
            mismatch is the classic "updated but didn't restart the daemon". */}
        <VersionFooter status={status} />
      </div>
    </div>
  );
}
