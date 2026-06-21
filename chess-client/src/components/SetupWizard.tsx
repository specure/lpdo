import { useState, useEffect } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useSidecarProgress } from "../hooks/useSidecarProgress";
import AddGameDialog from "./AddGameDialog";
import { ProfileSetupForm, loadMyPlayer, saveMyPlayer } from "./MyStatsWidget";
import { TwicCredit, useTwicAck } from "./TwicCredit";
import { getTwicFrom, setTwicFrom } from "../twicPrefs";
import { PlayerInfo } from "../types";

interface Props {
  onClose: () => void;
  /** Called by the Finish button on the last step. Falls back to onClose.
   *  The host uses this to navigate Home after setup completes. */
  onFinish?: () => void;
}

const DB_PATH = "~/.chess-db/chess.db";
const TWIC_DIR = "~/.chess-db/twic";

type Step = "welcome" | "players" | "databases" | "twic" | "dedup" | "normalise" | "index" | "profile" | "done";

const STEPS: Step[] = ["welcome", "players", "databases", "twic", "dedup", "normalise", "index", "profile", "done"];
const STEP_LABELS: Record<Step, string> = {
  welcome:   "Welcome",
  players:   "Players",
  databases: "Databases",
  twic:      "TWIC",
  dedup:     "Dedup",
  normalise: "Names",
  index:     "Index",
  profile:   "Profile",
  done:      "Summary",
};

const OPTIONAL_STEPS: Step[] = ["players", "databases", "twic", "dedup", "normalise", "index", "profile"];
const STORAGE_KEY = "chess-setup-state";

interface PersistedState {
  stepIndex: number;
  completedSteps: Step[];
  skippedSteps: Step[];
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { stepIndex: 0, completedSteps: [], skippedSteps: [] };
}

function saveState(state: PersistedState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ── Shared UI ─────────────────────────────────────────────────────────────────

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="w-full bg-surface-container-highest rounded-full h-2 overflow-hidden">
      <div className="bg-primary h-2 rounded-full transition-all duration-medium2 ease-standard" style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

function FolderInput({ value, onChange, placeholder, disabled, directory = false, extensions }: {
  value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
  /** Pick a folder instead of a file. */
  directory?: boolean;
  /** Restrict the file picker to these extensions (ignored when directory). */
  extensions?: string[];
}) {
  async function browse() {
    try {
      const picked = await openDialog({
        multiple: false,
        directory,
        filters: !directory && extensions ? [{ name: extensions.map((e) => e.toUpperCase()).join("/"), extensions }] : undefined,
      });
      // Returns a string path (or null if cancelled); never an array here.
      if (typeof picked === "string") onChange(picked);
    } catch {
      /* user cancelled / dialog unavailable — leave the field unchanged */
    }
  }

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 h-10 px-3 rounded-sm bg-transparent text-on-surface text-body-md font-mono border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant disabled:opacity-50 transition-colors duration-short3 ease-standard"
      />
      {/* M3 outlined button */}
      <button
        type="button"
        onClick={() => { void browse(); }}
        disabled={disabled}
        className="h-10 px-4 rounded-full border border-outline text-on-surface text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-50 transition-colors duration-short3 ease-standard shrink-0"
      >
        Browse…
      </button>
    </div>
  );
}

function OptionalBadge() {
  /* M3 assist chip */
  return <span className="text-label-sm text-on-surface-variant border border-outline px-2 h-5 inline-flex items-center rounded-full">Optional</span>;
}

function CompletedBanner({ summary, onRerun }: { summary: string; onRerun: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 bg-success-container text-on-success-container rounded-md px-4 py-3">
        <span className="text-base">✓</span>
        <span className="text-body-md">{summary}</span>
      </div>
      <button
        onClick={onRerun}
        className="h-7 px-3 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard"
      >
        Re-run this step
      </button>
    </div>
  );
}

// ── Step: Welcome ─────────────────────────────────────────────────────────────

function WelcomeStep({ onExpress, onAdvanced }: {
  onExpress: () => void;
  onAdvanced: () => void;
}) {
  return (
    <div className="space-y-5">
      <p className="text-on-surface text-body-md leading-relaxed">
        This wizard will guide you through setting up your chess database.
        You can stop at any time and continue later — completed steps are remembered.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Express — recommended; primary-tinted to draw the eye. */}
        <button
          onClick={onExpress}
          className="text-left flex flex-col gap-2 p-5 rounded-2xl bg-primary-container text-on-primary-container hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
        >
          <span className="text-title-md">Express setup</span>
          <span className="text-body-sm opacity-90">
            Just the essentials: download and import TWIC, deduplicate, and build the
            position index. Skips the optional player-reference and existing-database
            steps.
          </span>
          <span className="text-label-lg mt-1">Recommended →</span>
        </button>

        {/* Advanced — every step, including the optional imports. */}
        <button
          onClick={onAdvanced}
          className="text-left flex flex-col gap-2 p-5 rounded-2xl bg-surface-container-highest text-on-surface hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
        >
          <span className="text-title-md">Advanced setup</span>
          <span className="text-body-sm text-on-surface-variant">
            Every step, including importing a player reference file and your existing
            PGN collections.
          </span>
          <span className="text-label-lg text-primary mt-1">Configure everything →</span>
        </button>
      </div>

      <ul className="space-y-1.5 text-body-md text-on-surface-variant">
        {[
          "Import a player reference file",
          "Import your existing game collections",
          "Download and import TWIC issues",
          "Deduplicate the database",
          "Build the position index",
        ].map((text, i) => (
          <li key={i} className="flex gap-3">
            <span className="text-outline shrink-0">{i + 1}.</span>
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Step: Import players file ─────────────────────────────────────────────────

function PlayersStep({ completed, onComplete, onRunningChange }: { completed: boolean; onComplete: () => void; onRunningChange: (r: boolean) => void }) {
  const [path, setPath] = useState("");
  const [rerunning, setRerunning] = useState(false);
  const progress = useSidecarProgress();

  useEffect(() => { if (progress.done) onComplete(); }, [progress.done]);
  useEffect(() => { onRunningChange(progress.running); }, [progress.running]);

  function run() {
    void progress.run(["players", "import", path]);
  }

  if (completed && !rerunning) {
    return <CompletedBanner summary="Players imported" onRerun={() => setRerunning(true)} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-on-surface-variant text-body-md">
          Import a pre-built player reference file containing canonical names and FIDE IDs.
          This significantly improves player search and name consistency.
        </p>
        <OptionalBadge />
      </div>
      <div>
        <div className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-2">Player reference file</div>
        <FolderInput value={path} onChange={setPath} placeholder="/path/to/players.csv" extensions={["csv"]} disabled={progress.running || progress.done} />
      </div>
      {path && !progress.running && !progress.done && (
        <button onClick={run} className="w-full h-10 rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard">
          Import Players
        </button>
      )}
      {(progress.running || progress.done) && (
        <div className="space-y-2">
          <div className="flex justify-between text-label-md text-on-surface-variant">
            <span>{progress.done ? "Complete" : "Importing…"}</span>
            <span>{Math.round(progress.percent)}%</span>
          </div>
          <ProgressBar value={progress.percent} />
          {progress.done && <p className="text-success text-body-sm">✓ {progress.doneMessage}</p>}
          {progress.running && !progress.done && (
            <div className="flex justify-end">
              <button
                onClick={progress.cancel}
                className="h-8 px-4 inline-flex items-center rounded-full text-error border border-outline text-label-md hover:bg-error/8 transition-colors duration-short3 ease-standard"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Step: Import pre-owned databases ─────────────────────────────────────────

function DatabasesStep({ completed, onComplete, onRunningChange }: { completed: boolean; onComplete: () => void; onRunningChange: (r: boolean) => void }) {
  const [rerunning, setRerunning] = useState(false);

  if (completed && !rerunning) {
    return <CompletedBanner summary="PGN files imported" onRerun={() => setRerunning(true)} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-on-surface-variant text-body-md">
          Import any PGN files you already have — your own games, a tournament you follow, a repertoire.
          Pick a preset to get started.
        </p>
        <OptionalBadge />
      </div>
      <AddGameDialog
        embedded
        initialMode="file"
        allowedModes={["file"]}
        bulk
        onClose={() => { /* no-op: wizard handles step navigation */ }}
        onImported={onComplete}
        onRunningChange={onRunningChange}
      />
    </div>
  );
}

// ── Step: TWIC (download + import) ────────────────────────────────────────────

/** Download/import progress block, shared by the two TWIC operations.
 *  `cancellable` is false for the fast (appender) import, which must not be
 *  interrupted — doing so can corrupt the database. */
function StepProgress({ progress, label, cancellable = true }: { progress: ReturnType<typeof useSidecarProgress>; label: string; cancellable?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-label-md text-on-surface-variant">
        <span>{progress.done ? "Complete" : label}</span>
        <span>{Math.round(progress.percent)}%</span>
      </div>
      <ProgressBar value={progress.percent} />
      {progress.done && <p className="text-success text-body-sm">✓ {progress.doneMessage}</p>}
      {progress.running && !progress.done && cancellable && (
        <div className="flex justify-end">
          <button
            onClick={progress.cancel}
            className="h-8 px-4 inline-flex items-center rounded-full text-error border border-outline text-label-md hover:bg-error/8 transition-colors duration-short3 ease-standard"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// Download and import TWIC in a single step (mirrors the Maintenance TWIC box).
// The step counts as complete once issues are imported into the database.
function TwicStep({ completed, onComplete, onRunningChange }: { completed: boolean; onComplete: () => void; onRunningChange: (r: boolean) => void }) {
  // Shared with the Maintenance panel so the starting issue stays in sync.
  const [fromIssue, setFromIssue] = useState(getTwicFrom());
  const [rerunning, setRerunning] = useState(false);
  const [twicAck, setTwicAck] = useTwicAck();
  const download = useSidecarProgress();
  const importProgress = useSidecarProgress();

  useEffect(() => { if (importProgress.done) onComplete(); }, [importProgress.done]);
  useEffect(() => { onRunningChange(download.running || importProgress.running); }, [download.running, importProgress.running]);

  function runDownload() {
    void download.run(["download", "--from", fromIssue, "--dir", TWIC_DIR]);
  }
  function runImport() {
    // --fast = appender-based bulk inserts (much quicker). It must not be
    // interrupted, so the import progress below is rendered non-cancelable.
    void importProgress.run(["import", "--fast", "--dir", TWIC_DIR]);
  }

  if (completed && !rerunning) {
    return <CompletedBanner summary="TWIC issues downloaded and imported" onRerun={() => setRerunning(true)} />;
  }

  const filledBtn = "w-full h-10 rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard";

  return (
    <div className="space-y-4">
      <p className="text-on-surface-variant text-body-md">
        Download TWIC (The Week in Chess) issues and import them into your database, in one place. Issues already present or imported are skipped automatically.
      </p>
      <TwicCredit acknowledged={twicAck} onAcknowledgeChange={setTwicAck} />

      <div className="flex items-center gap-2">
        <span className="text-label-md text-on-surface-variant shrink-0">Folder</span>
        <span className="font-mono text-body-sm text-on-surface-variant truncate">{TWIC_DIR}</span>
      </div>

      {/* Download */}
      <div className="space-y-2">
        <div className="text-label-md text-on-surface">Download</div>
        <div>
          <div className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-2">Download from issue</div>
          <input
            type="number"
            value={fromIssue}
            onChange={(e) => { setFromIssue(e.target.value); setTwicFrom(e.target.value); }}
            disabled={download.running || download.done}
            className="w-32 h-10 px-3 rounded-sm bg-transparent text-on-surface text-body-md font-mono border border-outline focus:outline-none focus:border-primary disabled:opacity-50 transition-colors duration-short3 ease-standard"
          />
          <p className="text-label-sm text-on-surface-variant mt-1">Issues are available from 920 onwards.</p>
        </div>
        {!download.running && !download.done && (
          twicAck ? (
            <button onClick={runDownload} className={filledBtn}>Download TWIC Issues</button>
          ) : (
            <p className="text-label-sm text-on-surface-variant">Tick “I've read this” above to enable the download.</p>
          )
        )}
        {(download.running || download.done) && <StepProgress progress={download} label="Downloading…" />}
      </div>

      {/* Import */}
      <div className="space-y-2 pt-2">
        <div className="text-label-md text-on-surface">Import into database</div>
        {!importProgress.running && !importProgress.done && (
          download.done ? (
            <button onClick={runImport} className={filledBtn}>Import Downloaded Issues</button>
          ) : (
            <p className="text-body-sm text-on-surface-variant">Download issues first to enable the import.</p>
          )
        )}
        {(importProgress.running || importProgress.done) && <StepProgress progress={importProgress} label="Importing…" cancellable={false} />}
      </div>
    </div>
  );
}

// ── Step: Deduplicate ─────────────────────────────────────────────────────────

function DedupStep({ completed, onComplete, onRunningChange }: { completed: boolean; onComplete: () => void; onRunningChange: (r: boolean) => void }) {
  const [rerunning, setRerunning] = useState(false);
  const progress = useSidecarProgress();

  useEffect(() => { if (progress.done) onComplete(); }, [progress.done]);
  useEffect(() => { onRunningChange(progress.running); }, [progress.running]);

  function run() {
    void progress.run(["games", "dedup"]);
  }

  if (completed && !rerunning) {
    return <CompletedBanner summary="Deduplication complete" onRerun={() => setRerunning(true)} />;
  }

  return (
    <div className="space-y-4">
      <p className="text-on-surface-variant text-body-md">
        Detect and remove duplicate games that may result from overlapping collections.
      </p>
      {!progress.running && !progress.done && (
        <button onClick={run} className="w-full h-10 rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard">
          Run Deduplication
        </button>
      )}
      {(progress.running || progress.done) && (
        <div className="space-y-2">
          <div className="flex justify-between text-label-md text-on-surface-variant">
            <span>{progress.done ? "Complete" : "Scanning…"}</span>
            <span>{Math.round(progress.percent)}%</span>
          </div>
          <ProgressBar value={progress.percent} />
          {progress.done && <p className="text-success text-body-sm">✓ {progress.doneMessage}</p>}
          {progress.running && !progress.done && (
            <div className="flex justify-end">
              <button
                onClick={progress.cancel}
                className="h-8 px-4 inline-flex items-center rounded-full text-error border border-outline text-label-md hover:bg-error/8 transition-colors duration-short3 ease-standard"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Step: Normalise player names ──────────────────────────────────────────────

const NORMALISE_LIMIT = 500;

function NormaliseStep({ completed, onComplete, onRunningChange }: { completed: boolean; onComplete: () => void; onRunningChange: (r: boolean) => void }) {
  const [rerunning, setRerunning] = useState(false);
  const progress = useSidecarProgress();

  useEffect(() => { if (progress.done) onComplete(); }, [progress.done]);
  useEffect(() => { onRunningChange(progress.running); }, [progress.running]);

  function run() {
    // --stop-on-errors: abort immediately on 10 consecutive FIDE errors rather
    // than pausing for hours, so the wizard never appears to hang.
    void progress.run(["players", "normalise", "--limit", String(NORMALISE_LIMIT), "--stop-on-errors"]);
  }

  if (completed && !rerunning) {
    return <CompletedBanner summary="Player names normalised" onRerun={() => setRerunning(true)} />;
  }

  return (
    <div className="space-y-4">
      <p className="text-on-surface-variant text-body-md">
        Update player names to their FIDE-canonical form by looking up each player's FIDE ID.
        This improves search results and name consistency.
      </p>
      {/* Names already in our cache are resolved instantly (one request, no
          limit); only the slow FIDE lookups for the rest are capped. */}
      <div className="bg-warning-container text-on-warning-container rounded-md px-4 py-3 text-body-sm space-y-1">
        <p>
          Names in our shared cache are resolved instantly. To keep setup quick, the
          remaining online FIDE lookups are capped at{" "}
          <span className="font-mono">{NORMALISE_LIMIT}</span> for this step.
        </p>
        <p>
          For a complete pass — recommended especially if you didn't import a player reference file —
          run <span className="font-mono">chess-db players normalise</span> from the command line.
        </p>
      </div>
      {/* Run (also shown again after a stop, so the user can retry or skip). */}
      {!progress.running && !progress.done && (
        <button onClick={run} className="w-full h-10 rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard">
          Normalise Player Names
        </button>
      )}
      {(progress.running || progress.done) && (
        <div className="space-y-2">
          <div className="flex justify-between text-label-md text-on-surface-variant">
            <span>{progress.done ? "Complete" : "Looking up FIDE names…"}</span>
            <span>{Math.round(progress.percent)}%</span>
          </div>
          <ProgressBar value={progress.percent} />
          {progress.done && <p className="text-success text-body-sm">✓ {progress.doneMessage}</p>}
          {progress.running && !progress.done && (
            <div className="flex justify-end">
              <button
                onClick={progress.cancel}
                className="h-8 px-4 inline-flex items-center rounded-full text-error border border-outline text-label-md hover:bg-error/8 transition-colors duration-short3 ease-standard"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      {/* Backend log: the "limited to N of M" warning, and any "stopped after N
          consecutive errors" message. Kept visible after the run stops. */}
      {progress.log.length > 0 && (
        <div className="bg-surface-container-lowest rounded-sm p-2 text-label-sm font-mono text-on-surface-variant max-h-24 overflow-y-auto space-y-0.5">
          {progress.log.slice(-6).map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}

// ── Step: Index positions ─────────────────────────────────────────────────────

function IndexStep({ completed, onComplete, onRunningChange }: { completed: boolean; onComplete: () => void; onRunningChange: (r: boolean) => void }) {
  const [rerunning, setRerunning] = useState(false);
  const progress = useSidecarProgress();

  useEffect(() => { if (progress.done) onComplete(); }, [progress.done]);
  useEffect(() => { onRunningChange(progress.running); }, [progress.running]);

  function run() {
    // --fast = appender-based inserts (much quicker than row-by-row
    // transactional inserts, which crawl on a full-database rebuild). Like the
    // import step it must not be interrupted, so the progress below renders no
    // Cancel button.
    void progress.run(["index-positions", "--fast"]);
  }

  if (completed && !rerunning) {
    return <CompletedBanner summary="Position index updated" onRerun={() => setRerunning(true)} />;
  }

  return (
    <div className="space-y-4">
      <p className="text-on-surface-variant text-body-md">
        Build the position index — required for the move explorer. Each game is replayed and every position is recorded with its Zobrist hash.
      </p>
      {!progress.running && !progress.done && (
        <button onClick={run} className="w-full h-10 rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard">
          Build Position Index
        </button>
      )}
      {(progress.running || progress.done) && (
        <div className="space-y-2">
          <div className="flex justify-between text-label-md text-on-surface-variant">
            <span>{progress.done ? "Complete" : "Indexing…"}</span>
            <span>{Math.round(progress.percent)}%</span>
          </div>
          <ProgressBar value={progress.percent} />
          {progress.done && <p className="text-success text-body-sm">✓ {progress.doneMessage}</p>}
          {/* No Cancel button: --fast (appender) indexing must not be
              interrupted — doing so can corrupt the database. */}
        </div>
      )}
    </div>
  );
}

// ── Step: Your profile ────────────────────────────────────────────────────────

function ProfileStep({ completed, onComplete }: { completed: boolean; onComplete: () => void }) {
  const [saved, setSaved] = useState<PlayerInfo | null>(loadMyPlayer);
  const [changing, setChanging] = useState(false);

  // A profile set previously (this or an earlier run) counts as done.
  useEffect(() => { if (saved && !completed) onComplete(); }, []);

  function handleSave(p: PlayerInfo) {
    saveMyPlayer(p);
    setSaved(p);
    setChanging(false);
    onComplete();
  }

  return (
    <div className="space-y-4">
      <p className="text-on-surface-variant text-body-md">
        Tell us who you are. The Home screen uses this to show your FIDE ratings, recent
        activity, and your games in the database. You can change it later under “My profile”.
      </p>
      {saved && !changing ? (
        <div className="flex items-center gap-3 bg-success-container text-on-success-container rounded-md px-4 py-3">
          <span className="text-base">✓</span>
          <span className="text-body-md flex-1">
            Set as <span className="font-medium">{saved.name}</span>
            {saved.fide_id ? ` · FIDE ${saved.fide_id}` : ""}
          </span>
          <button
            onClick={() => setChanging(true)}
            className="h-7 px-3 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard shrink-0"
          >
            Change
          </button>
        </div>
      ) : (
        <ProfileSetupForm onSave={handleSave} />
      )}
    </div>
  );
}

// ── Step: Done ────────────────────────────────────────────────────────────────

function DoneStep() {
  return (
    <div className="space-y-4">
      <div className="text-center py-4">
        <div className="text-4xl mb-3">♟</div>
        <h3 className="text-headline-sm text-on-surface">Setup complete</h3>
        <p className="text-on-surface-variant text-body-md mt-1">Your chess database is ready to use.</p>
      </div>
      <div className="bg-surface-container-highest rounded-md p-3 text-body-sm">
        <div className="flex justify-between items-center">
          <span className="text-on-surface-variant">Database</span>
          <span className="font-mono text-on-surface text-label-md">{DB_PATH}</span>
        </div>
      </div>
      <p className="text-on-surface-variant text-label-md">
        Download newer TWIC issues and run maintenance operations at any time from the Setup panel in the header.
      </p>
    </div>
  );
}

// ── Wizard shell ──────────────────────────────────────────────────────────────

export default function SetupWizard({ onClose, onFinish }: Props) {
  const initial = loadState();
  const [stepIndex, setStepIndex] = useState(initial.stepIndex);
  const [completedSteps, setCompletedSteps] = useState<Set<Step>>(new Set(initial.completedSteps));
  const [skippedSteps, setSkippedSteps] = useState<Set<Step>>(new Set(initial.skippedSteps));
  const [stepRunning, setStepRunning] = useState(false);

  const step = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = step === "done";
  const isOptional = OPTIONAL_STEPS.includes(step);

  function handleClose() {
    if (stepRunning && !window.confirm("An operation is in progress. Close anyway?")) return;
    onClose();
  }

  function handleRestart() {
    localStorage.removeItem(STORAGE_KEY);
    setStepIndex(0);
    setCompletedSteps(new Set());
    setSkippedSteps(new Set());
  }

  // Persist on every change
  useEffect(() => {
    saveState({ stepIndex, completedSteps: Array.from(completedSteps), skippedSteps: Array.from(skippedSteps) });
  }, [stepIndex, completedSteps, skippedSteps]);

  function markComplete(s: Step) {
    setCompletedSteps((prev) => new Set([...prev, s]));
    setSkippedSteps((prev) => { const next = new Set(prev); next.delete(s); return next; });
  }

  function next() { if (stepIndex < STEPS.length - 1) setStepIndex((i) => i + 1); }
  function skip() { setSkippedSteps((prev) => new Set([...prev, step])); next(); }
  function back() { if (stepIndex > 0) setStepIndex((i) => i - 1); }

  // Welcome choices. Advanced walks every step; Express marks the two optional
  // import steps (players, databases) as skipped and jumps straight to TWIC.
  function startAdvanced() {
    markComplete("welcome");
    next();
  }
  function startExpress() {
    markComplete("welcome");
    setSkippedSteps((prev) => new Set([...prev, "players", "databases"]));
    setStepIndex(STEPS.indexOf("twic"));
  }

  const stepProps = (s: Step) => ({
    completed: completedSteps.has(s),
    onComplete: () => markComplete(s),
    onRunningChange: setStepRunning,
  });

  // Footer button presets
  const filledBtn = "h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard";
  const tonalBtn = "h-9 px-4 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 transition-all duration-short3 ease-standard";
  const textBtn = "h-9 px-4 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard";

  return (
    // Full-screen, non-modal panel: a flex column with a pinned header and
    // footer and a scrollable body. This keeps the Back/Next navigation
    // reachable at any font size (a centered fixed-width modal overflowed the
    // viewport at large fonts, hiding the footer).
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <div className="flex-1 min-h-0 w-full max-w-3xl mx-auto flex flex-col">

        {/* Header */}
        <div className="px-6 pt-5 pb-4 shrink-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-title-md text-on-surface">Database Setup</h2>
            <div className="flex items-center gap-2">
              <span className="text-label-md text-on-surface-variant">{stepIndex + 1} / {STEPS.length}</span>
              <button onClick={handleClose} className="w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard text-base leading-none">✕</button>
            </div>
          </div>
          <div className="flex gap-1">
            {STEPS.map((s, i) => (
              <div key={s} className="flex-1 flex flex-col items-center gap-1">
                <div className={`h-1 w-full rounded-full ${
                  completedSteps.has(s) ? "bg-success"
                  : i === stepIndex      ? "bg-primary"
                  : skippedSteps.has(s)  ? "bg-warning"
                  :                        "bg-surface-container-highest"
                }`} />
                <span className={`text-label-sm ${i === stepIndex ? "text-on-surface" : "text-on-surface-variant"}`}>
                  {STEP_LABELS[s]}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 flex-1 min-h-0 overflow-y-auto">
          {step === "welcome"   && <WelcomeStep onExpress={startExpress} onAdvanced={startAdvanced} />}
          {step === "players"   && <PlayersStep   {...stepProps("players")} />}
          {step === "databases" && <DatabasesStep {...stepProps("databases")} />}
          {step === "twic"      && <TwicStep      {...stepProps("twic")} />}
          {step === "dedup"     && <DedupStep     {...stepProps("dedup")} />}
          {step === "normalise" && <NormaliseStep {...stepProps("normalise")} />}
          {step === "index"     && <IndexStep     {...stepProps("index")} />}
          {step === "profile"   && <ProfileStep   completed={completedSteps.has("profile")} onComplete={() => markComplete("profile")} />}
          {step === "done"      && <DoneStep />}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex items-center justify-between shrink-0">
          <button
            onClick={back}
            disabled={isFirst || stepRunning}
            className={`${textBtn} disabled:opacity-0`}
          >
            ← Back
          </button>
          <div className="flex gap-2 items-center">
            {isLast ? (
              <div className="flex items-center gap-2">
                <button onClick={handleRestart} className={tonalBtn}>
                  Restart the wizard
                </button>
                <button onClick={onFinish ?? onClose} className={filledBtn}>
                  Finish
                </button>
              </div>
            ) : step === "welcome" ? (
              // Navigation for Welcome is the Express / Advanced choice in the body.
              null
            ) : completedSteps.has(step) ? (
              <button onClick={next} className={filledBtn}>
                Next →
              </button>
            ) : isOptional && !stepRunning ? (
              <button onClick={skip} className={textBtn}>
                Skip
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
