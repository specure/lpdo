import { useState, useEffect, useRef, useCallback } from "react";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { useJobProgress } from "../hooks/useJobProgress";
import SourcesPanel from "./SourcesPanel";
import MergePlayersDialog from "./MergePlayersDialog";
import { StatusInfo, ScheduleInfo } from "../types";
import { serverUrl, serverToken, setServerSettings, DEFAULT_SERVER_URL, getSchedule, getJobs } from "../api";

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
        enter its address — and the access token shown in that server's data folder
        (<span className="font-mono">access-token</span>). A server on this machine needs no token.
      </p>
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
        <div className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-1">Access token (only for a server on another machine)</div>
        <input
          type="password"
          value={token}
          onChange={(e) => { setToken(e.target.value); setSaved(false); }}
          placeholder="empty for a local server"
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
  const server = status?.version
    ? `Server ${status.version}${status.api_version != null ? ` · API ${status.api_version}` : ""}`
    : "Server unreachable";
  return (
    <div className="pt-2 text-center text-label-md text-on-surface-variant select-text">
      LPDO {appVersion ?? "…"} · {server}
    </div>
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

// ── Merge duplicate players (same FIDE ID) ────────────────────────────────────

function DedupPlayersSection({ onMutated }: { onMutated?: () => void }) {
  const progress = useJobProgress("maint-dedup-players");
  useEffect(() => { if (progress.done) onMutated?.(); }, [progress.done]);
  return (
    <SectionCard title="Merge duplicate players">
      <p className="text-body-sm text-on-surface-variant">
        Merge player records that share the same FIDE ID (e.g. name variants across sources),
        reassigning their games to a single row. Run after fetching FIDE IDs.
      </p>
      {!progress.running && !progress.done && (
        <ActionButton onClick={() => void progress.run(["players", "dedup"])}>
          Merge duplicates
        </ActionButton>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection progress={progress} label="Merging duplicate players…" />
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

// ── Deduplication section ─────────────────────────────────────────────────────

function DeduplicationSection({ onMutated }: { onMutated?: () => void }) {
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
    <SectionCard title="Deduplication">
      <p className="text-body-sm text-on-surface-variant">
        Detects and removes duplicate games resulting from overlapping collections.
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
          <ActionButton onClick={run}>Run deduplication</ActionButton>
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
        first (FIDE player list, above).
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

// ── Backup section ────────────────────────────────────────────────────────────

// Pre-selected when present — the private collection the wizard/AddGame flow
// writes to. Falls back to the first available collection otherwise.
const DEFAULT_COLLECTION = "My games";

interface Collection { id: number; name: string; game_count: number }

// Save a collection's backup where the USER chooses (#121). The hardened daemon
// can't write to the user's home, so it builds the .pgn.zip and streams it here
// via `download_backup`; the GUI writes it to a folder the user picks. The folder
// is remembered (localStorage) so repeat backups don't re-prompt — the user can
// type a path or pick one with Browse, and the filename is generated per backup.
const BACKUP_DIR_KEY = "lpdo.backupDir";
const DEFAULT_BACKUP_DIR = "~/lpdo/backup";

function BackupSection() {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [collection, setCollection] = useState(DEFAULT_COLLECTION);
  const [folder, setFolder] = useState<string>(
    () => localStorage.getItem(BACKUP_DIR_KEY) || DEFAULT_BACKUP_DIR,
  );
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

  async function browse() {
    const picked = await openDialog({ multiple: false, directory: true });
    if (typeof picked === "string") {
      setFolder(picked);
      localStorage.setItem(BACKUP_DIR_KEY, picked);
    }
  }

  async function run() {
    setError(null);
    const dir = folder.trim().replace(/\/+$/, "");
    if (!dir) return;
    localStorage.setItem(BACKUP_DIR_KEY, dir);
    const date = new Date().toISOString().slice(0, 10);
    const safe = collection.replace(/[^\w.-]+/g, "_");
    const dest = `${dir}/${date}-${safe}.pgn.zip`;
    setPhase("saving");
    setPct(null);
    const un = await listen<{ received: number; total: number }>("backup-download-progress", (e) => {
      const { received, total } = e.payload;
      setPct(total > 0 ? Math.min(100, (received / total) * 100) : null);
    });
    try {
      // download_backup returns the resolved absolute path (leading `~/`
      // expanded) — use it for Reveal, which needs a real path, not `~/…`.
      const resolved = await invoke<string>("download_backup", { baseUrl: serverUrl(), token: serverToken(), collection, destPath: dest });
      setSavedPath(resolved || dest);
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
    <SectionCard title="Backup">
      <p className="text-body-sm text-on-surface-variant">
        Save a collection to a zip-compressed PGN file in the folder you choose. The folder is
        remembered for next time; each backup is named by date and collection.
      </p>

      {phase === "idle" && (
        hasCollections ? (
          <div className="space-y-2">
            <select
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
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
            <div className="flex gap-2">
              <input
                type="text"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
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
        <div className="space-y-2">
          <p className="text-body-sm text-success">✓ Backup saved.</p>
          {savedPath && <p className="text-label-sm text-on-surface-variant break-all font-mono">{savedPath}</p>}
          <div className="flex gap-2">
            {savedPath && (
              <button
                onClick={() => { void revealItemInDir(savedPath); }}
                className="h-7 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 transition-all duration-short3 ease-standard"
              >
                Reveal in file manager
              </button>
            )}
            <button
              onClick={() => { setPhase("idle"); setSavedPath(null); }}
              className="h-7 px-3 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard"
            >
              Back up another
            </button>
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="space-y-2">
          <p className="text-label-sm text-error break-words">Backup failed: {error}</p>
          <ActionButton onClick={() => { void run(); }}>Try again</ActionButton>
        </div>
      )}
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

// ── Merge players section ─────────────────────────────────────────────────────

function MergePlayersSection({ onMutated }: { onMutated?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <SectionCard title="Merge players">
      <p className="text-body-sm text-on-surface-variant">
        Combine duplicate player records — e.g. a full name (“Karpov, Anatoly”) and a surname-only
        entry (“Karpov”) for the same person — into one. All games move to the player you keep.
      </p>
      <ActionButton onClick={() => setOpen(true)}>Merge players…</ActionButton>
      {open && (
        <MergePlayersDialog onClose={() => setOpen(false)} onMerged={() => onMutated?.()} />
      )}
    </SectionCard>
  );
}


// ── Tabs ──────────────────────────────────────────────────────────────────────

const TABS = [
  { id: "sources", label: "Sources" },
  { id: "databases", label: "Databases" },
  { id: "players", label: "Players" },
  { id: "others", label: "Others" },
] as const;
type TabId = (typeof TABS)[number]["id"];

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
  // are grouped into tabs (Databases / Players / Others) to keep each view
  // uncluttered; the database overview stays pinned above the tabs.
  const [tab, setTab] = useState<TabId>("sources");

  // Inactive tabs are hidden, not unmounted, so a long-running job (e.g. a TWIC
  // import) keeps its live progress when you switch away and back.
  const grid = "grid grid-cols-1 md:grid-cols-2 gap-4 items-start";

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

          {/* Maintenance tasks in recommended run order — the same identity-first
              pipeline the background maintenance runs automatically after imports. */}
          <div className={`${grid} ${tab === "databases" ? "" : "hidden"}`}>
            <ResolveFideSection onMutated={onMutated} />
            <DedupPlayersSection onMutated={onMutated} />
            <NormaliseSection onMutated={onMutated} />
            <DeduplicationSection onMutated={onMutated} />
            <IndexSection />
            <FideRefreshSection />
          </div>

          <div className={`${grid} ${tab === "players" ? "" : "hidden"}`}>
            <PlayersSection />
            <MergePlayersSection onMutated={onMutated} />
          </div>

          <div className={`${grid} ${tab === "others" ? "" : "hidden"}`}>
            <ServerConnectionSection status={status} connection={connection} />
            <BackupSection />
            <PurgeSection status={status} onMutated={onMutated} />
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
