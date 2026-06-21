import { useState, useEffect, useRef } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { TwicCredit, useTwicAck } from "./TwicCredit";
import { useSidecarProgress } from "../hooks/useSidecarProgress";
import { getSchedule, updateSchedule, type ScheduleInfo } from "../api";
import MergePlayersDialog from "./MergePlayersDialog";
import { StatusInfo } from "../types";

interface Props {
  onRunWizard: () => void;
  status: StatusInfo | null;
  /** Fires when an action inside the panel mutates the database (purge, etc.).
   *  Host should refresh server status and any visible game lists. */
  onMutated?: () => void;
}

const TWIC_DIR = "~/.chess-db/twic";

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

function ProgressSection({ progress, label, extra }: {
  progress: ReturnType<typeof useSidecarProgress>;
  label: string;
  /** Optional action rendered alongside Dismiss in the done row (e.g. "Reveal"). */
  extra?: React.ReactNode;
}) {
  return (
    <>
      <div className="flex justify-between gap-2 text-label-md text-on-surface-variant">
        <span className="truncate">{progress.done ? "Complete" : progress.message || label}</span>
        <span className="shrink-0">{Math.round(progress.percent)}%</span>
      </div>
      <ProgressBar value={progress.percent} />
      <LogBox lines={progress.log} />
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

const DB_PATH = "~/.chess-db/chess.db";

function DatabaseInfo({ status }: { status: StatusInfo | null }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(DB_PATH);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function fmt(n: number) { return n.toLocaleString(); }

  return (
    <SectionCard title="Database">
      <div className="flex items-center gap-2 mb-3">
        <span className="font-mono text-body-sm text-on-surface-variant flex-1 truncate">{DB_PATH}</span>
        <button
          onClick={copy}
          className="h-7 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 transition-all duration-short3 ease-standard shrink-0"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {status ? (
        <div className="grid grid-cols-3 gap-2">
          {([
            ["Games",       fmt(status.games)],
            ["Players",     fmt(status.players)],
            ["Positions",   fmt(status.positions)],
            ["TWIC issues", fmt(status.issues)],
            ["Downloaded",  fmt(status.downloaded)],
            ["Imported",    fmt(status.imported)],
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

function PlayersSection() {
  const [path, setPath] = useState("");
  const progress = useSidecarProgress("maint-players-import");

  function run() {
    void progress.run(["players", "import", path]);
  }

  return (
    <SectionCard title="Player reference file">
      <p className="text-body-sm text-on-surface-variant">Re-import or update the player reference file with a newer version.</p>
      {!progress.running && !progress.done && (
        <div className="space-y-2">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/players.csv"
            className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
          />
          <ActionButton onClick={run} disabled={!path.trim()}>Import file…</ActionButton>
        </div>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection progress={progress} label="Importing…" />
      )}
    </SectionCard>
  );
}

// ── Additional databases section ──────────────────────────────────────────────

function DatabasesSection() {
  const [folder, setFolder] = useState("");
  const progress = useSidecarProgress("maint-import-pgn");

  function run() {
    void progress.run(["import-pgn", folder]);
  }

  return (
    <SectionCard title="Additional databases">
      <p className="text-body-sm text-on-surface-variant">
        Scan a folder for new PGN files and import them. Already-imported files are skipped.
      </p>
      {!progress.running && !progress.done && (
        <div className="space-y-2">
          <input
            type="text"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="/path/to/pgn/folder"
            className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
          />
          <ActionButton onClick={run} disabled={!folder.trim()}>Import new files</ActionButton>
        </div>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection progress={progress} label="Importing…" />
      )}
    </SectionCard>
  );
}

// ── TWIC section ──────────────────────────────────────────────────────────────

function TwicSection() {
  const download = useSidecarProgress("maint-twic-download");
  const importProgress = useSidecarProgress("maint-twic-import");
  const [twicAck, setTwicAck] = useTwicAck();

  function runDownload() {
    void download.run(["download", "--dir", TWIC_DIR]);
  }

  function runImport() {
    // --fast = appender-based bulk inserts (much quicker; not interruptible).
    void importProgress.run(["import", "--fast", "--dir", TWIC_DIR]);
  }

  return (
    <SectionCard title="TWIC — The Week in Chess">
      <TwicCredit acknowledged={twicAck} onAcknowledgeChange={setTwicAck} />

      <div className="flex items-center gap-2 mb-1">
        <span className="text-label-md text-on-surface-variant shrink-0">Folder</span>
        <span className="font-mono text-body-sm text-on-surface-variant truncate">{TWIC_DIR}</span>
      </div>

      <div className="space-y-3">
        {/* Download */}
        <div className="space-y-1">
          <div className="text-label-md text-on-surface">Download</div>
          {!download.running && !download.done && (
            twicAck
              ? <ActionButton onClick={runDownload} disabled={false}>Download new issues</ActionButton>
              : <p className="text-label-sm text-on-surface-variant">Tick “I've read this” above to enable downloading.</p>
          )}
          {(download.running || download.done) && (
            <ProgressSection progress={download} label="Downloading…" />
          )}
        </div>

        {/* Import — tonal step substitutes for the divider */}
        <div className="space-y-1 pt-3">
          <div className="text-label-md text-on-surface">Import into database</div>
          {!importProgress.running && !importProgress.done && (
            <ActionButton onClick={runImport} disabled={false}>Import new issues</ActionButton>
          )}
          {(importProgress.running || importProgress.done) && (
            <ProgressSection progress={importProgress} label="Importing…" />
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ── Deduplication section ─────────────────────────────────────────────────────

function DeduplicationSection({ onMutated }: { onMutated?: () => void }) {
  const progress = useSidecarProgress("maint-dedup");

  function run() {
    void progress.run(["games", "dedup"]);
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
        <ActionButton onClick={run}>Run deduplication</ActionButton>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection progress={progress} label="Scanning…" />
      )}
    </SectionCard>
  );
}

// ── Position index section ────────────────────────────────────────────────────

function IndexSection() {
  const progress = useSidecarProgress("maint-index");
  const [rebuild, setRebuild] = useState(false);

  function run() {
    if (
      rebuild &&
      !window.confirm(
        "Rebuild the entire position index from scratch? This wipes the positions " +
          "table and reprocesses every game. It uses the fast (appender) path and " +
          "cannot be cancelled once started — let it run to completion.",
      )
    ) {
      return;
    }
    // Full rebuild uses --fast (appender), the same path the setup wizard uses
    // for the initial index — orders of magnitude faster than the transactional
    // path on a multi-million-game database. The incremental update stays
    // transactional (small, safe, cancellable).
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
            <span>Rebuild from scratch — reprocess every game (can't be cancelled)</span>
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

const NORMALISE_LIMIT_DEFAULT = 500;

function NormaliseSection({ onMutated }: { onMutated?: () => void }) {
  const [limit, setLimit] = useState(String(NORMALISE_LIMIT_DEFAULT));
  const progress = useSidecarProgress("maint-normalise");

  // Player names change here, so refresh server status + any open game lists
  // once it finishes (so renamed players show their canonical form).
  useEffect(() => { if (progress.done) onMutated?.(); }, [progress.done]);

  function run() {
    const parsed = parseInt(limit, 10);
    const n = Number.isFinite(parsed) ? Math.max(0, parsed) : NORMALISE_LIMIT_DEFAULT;
    // --stop-on-errors: abort on 10 consecutive FIDE errors instead of pausing
    // for hours, so the panel never appears to hang. n === 0 → no limit (omit
    // --limit, which the CLI treats as "process all pending players").
    const args = ["players", "normalise", "--stop-on-errors"];
    if (n > 0) args.push("--limit", String(n));
    void progress.run(args);
  }

  return (
    <SectionCard title="Normalise player names">
      <p className="text-body-sm text-on-surface-variant">
        Update player names to their FIDE-canonical form. Names in our shared cache are resolved
        instantly in one request; the rest need a slow online FIDE lookup each, so only those are
        capped — raise the limit to cover more in one run.
      </p>
      {!progress.running && !progress.done && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-body-sm text-on-surface-variant">
            <span>Max FIDE lookups</span>
            <input
              type="number"
              min={0}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="w-28 h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
            />
            <span className="text-label-sm text-on-surface-variant">0 = no limit</span>
          </label>
          <ActionButton onClick={run}>Normalise names</ActionButton>
        </div>
      )}
      {(progress.running || progress.done) && (
        <ProgressSection progress={progress} label="Looking up FIDE names…" />
      )}
    </SectionCard>
  );
}

// ── Backup section ────────────────────────────────────────────────────────────

const BACKUP_DIR = "~/lpdo/backup";
// Persist the chosen backup folder so a custom path survives reloads.
const BACKUP_DIR_KEY = "backupDir";
// Pre-selected when present — the private collection the wizard/AddGame flow
// writes to. Falls back to the first available collection otherwise.
const DEFAULT_COLLECTION = "My games";

interface Collection { id: number; name: string; game_count: number }

function BackupSection() {
  const [folder, setFolder] = useState(() => localStorage.getItem(BACKUP_DIR_KEY) || BACKUP_DIR);
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [collection, setCollection] = useState(DEFAULT_COLLECTION);
  const progress = useSidecarProgress("maint-backup");

  // Remember the folder across sessions whenever the user edits it.
  useEffect(() => { localStorage.setItem(BACKUP_DIR_KEY, folder); }, [folder]);

  // Load the collection list so the user can back up any collection, not just
  // "My games". Pick "My games" when present, else the largest collection.
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

  function run() {
    // The folder is created server-side if missing; the filename gets a
    // timestamp prefix derived from the selected collection name.
    void progress.run(["backup", "--collection", collection, "--dir", folder.trim() || BACKUP_DIR]);
  }

  const hasCollections = collections === null || collections.length > 0;

  return (
    <SectionCard title="Backup">
      <p className="text-body-sm text-on-surface-variant">
        Save a collection to a timestamped PGN file — e.g.{" "}
        <span className="font-mono text-on-surface-variant">20260603-084231-My_games.pgn</span>.
        The folder is created if it doesn’t exist.
      </p>
      {!progress.running && !progress.done && (
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
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={BACKUP_DIR}
              className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
            />
            <ActionButton onClick={run} disabled={collections === null || !collection}>Back up now</ActionButton>
          </div>
        ) : (
          <p className="text-body-sm text-on-surface-variant">No collections to back up yet.</p>
        )
      )}
      {(progress.running || progress.done) && (
        <ProgressSection
          progress={progress}
          label="Backing up…"
          extra={progress.donePath && (
            <button
              onClick={() => { void revealItemInDir(progress.donePath!); }}
              className="h-7 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 transition-all duration-short3 ease-standard"
            >
              Reveal in file manager
            </button>
          )}
        />
      )}
    </SectionCard>
  );
}

// ── Purge soft-deleted section ────────────────────────────────────────────────

function PurgeSection({ status, onMutated }: { status: StatusInfo | null; onMutated?: () => void }) {
  const progress = useSidecarProgress();
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
        Combine duplicate player records — e.g. a full name (“Krejcar, Walter”) and a surname-only
        entry (“Krejcar”) for the same person — into one. All games move to the player you keep.
      </p>
      <ActionButton onClick={() => setOpen(true)}>Merge players…</ActionButton>
      {open && (
        <MergePlayersDialog onClose={() => setOpen(false)} onMerged={() => onMutated?.()} />
      )}
    </SectionCard>
  );
}

// ── Automatic updates section ─────────────────────────────────────────────────

function AutoUpdateSection() {
  const [sched, setSched] = useState<ScheduleInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setSched(await getSchedule());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function toggle(enabled: boolean) {
    setSaving(true);
    try {
      await updateSchedule({ enabled });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const lastRun = sched?.last_run ? sched.last_run.slice(0, 16) : null;
  const status = sched?.last_status;

  return (
    <SectionCard title="Automatic updates">
      <p className="text-body-sm text-on-surface-variant">
        Let the server check daily and pull new TWIC issues in the background, so the database is
        current whenever you open the app. Runs even while the app is closed if the server is
        installed as a background service.
      </p>
      {sched ? (
        <>
          <label className="flex items-center gap-2 text-body-md text-on-surface cursor-pointer select-none">
            <input
              type="checkbox"
              checked={sched.enabled}
              disabled={saving}
              onChange={(e) => void toggle(e.target.checked)}
              className="cursor-pointer accent-primary w-4 h-4"
            />
            <span>Keep the database up to date</span>
          </label>
          <div className="text-label-md text-on-surface-variant space-y-0.5">
            {lastRun ? (
              <div>
                Last run: {lastRun}{" "}
                {status === "ok" && <span className="text-success">✓</span>}
                {status === "running" && <span>(running…)</span>}
                {status && status !== "ok" && status !== "running" && (
                  <span className="text-error">⚠ {status}</span>
                )}
              </div>
            ) : (
              <div>No automatic update has run yet.</div>
            )}
            {sched.enabled && sched.next_due && <div>Next check: {sched.next_due.slice(0, 16)}</div>}
          </div>
        </>
      ) : (
        <p className="text-body-sm text-on-surface-variant">{error ?? "Loading…"}</p>
      )}
      {sched && error && <p className="text-error text-body-sm">{error}</p>}
    </SectionCard>
  );
}

export default function MaintenancePanel({ onRunWizard, status, onMutated }: Props) {
  // Full-screen, non-modal view (driven by App's `mode` state). Mirrors the home
  // screen's layout: a centred max-width column on the bg-surface base, with the
  // tools laid out as independent tonal boxes in a responsive grid.
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

        {/* Database overview — full-width box */}
        <DatabaseInfo status={status} />

        {/* Tools — each in its own box, two-up on wider screens */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          <AutoUpdateSection />
          <PlayersSection />
          <DatabasesSection />
          <TwicSection />
          <DeduplicationSection onMutated={onMutated} />
          <IndexSection />
          <NormaliseSection onMutated={onMutated} />
          <MergePlayersSection onMutated={onMutated} />
          <BackupSection />
          <PurgeSection status={status} onMutated={onMutated} />
        </div>
      </div>
    </div>
  );
}
