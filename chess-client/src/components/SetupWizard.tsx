import { useState, useEffect, useCallback } from "react";
import { getSources, setSourceEnabled, startSetup } from "../api";
import { SourceStatus } from "../types";

interface Props {
  onClose: () => void;
  /** Called by the Finish button on the last step. Falls back to onClose.
   *  The host uses this to navigate Home after setup completes. */
  onFinish?: () => void;
}

type Step = "welcome" | "history" | "feeds" | "done";

const STEPS: Step[] = ["welcome", "history", "feeds", "done"];
const STEP_LABELS: Record<Step, string> = {
  welcome:   "Welcome",
  history:   "History",
  feeds:     "Feeds",
  done:      "Summary",
};

const OPTIONAL_STEPS: Step[] = ["history", "feeds"];
// Bumped on each step-set change so stale persisted state is discarded rather
// than mis-mapped. -v4: dropped the Profile step (setting your identity is
// premature before any games exist — do it from the Home "My profile" widget
// once the database is populated). Earlier: -v3 removed the manual maintenance
// steps; -v2 removed the welcome fork + players/databases steps.
const STORAGE_KEY = "chess-setup-state-v4";

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

function OptionalBadge() {
  /* M3 assist chip */
  return <span className="text-label-sm text-on-surface-variant border border-outline px-2 h-5 inline-flex items-center rounded-full">Optional</span>;
}

// ── Step: Welcome ─────────────────────────────────────────────────────────────

function WelcomeStep({ onStart }: { onStart: () => void }) {
  return (
    <div className="space-y-5">
      <p className="text-on-surface text-body-md leading-relaxed">
        This wizard sets up your chess reference database. You'll pick an optional historical
        base and the live tournament feeds to keep current — then LPDO downloads, imports and
        prepares everything for you in the background. You can stop at any time and continue
        later; completed steps are remembered, and you can change everything afterwards under
        Maintenance → Sources.
      </p>

      <ul className="space-y-1.5 text-body-md text-on-surface-variant">
        {[
          "Choose a deep historical base",
          "Choose the live tournament feeds to follow",
        ].map((text, i) => (
          <li key={i} className="flex gap-3">
            <span className="text-outline shrink-0">{i + 1}.</span>
            <span>{text}</span>
          </li>
        ))}
      </ul>

      <button
        onClick={onStart}
        className="h-10 px-5 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
      >
        Get started →
      </button>
    </div>
  );
}

// ── Sources (multi-source import catalog, #40) ────────────────────────────────
//
// Phase C2 (#98): onboarding is split into two simple steps — pick a deep
// historical base (this step), then pick the live feeds — with all per-source
// detail (date windows, timeline, manual sync) deferred to Maintenance → Sources
// (C1). Selecting a source IS its acknowledgment: a ticked row enables the
// source and records the attribution acknowledgment via the C1 `credit_acked`
// gate in one gesture, and sources are independently selectable (no feed is
// forced). The daemon's scheduler picks up enabled-but-not-yet-synced sources
// and imports them in the background (#40 C3), so each step finishes immediately.

/** A non-commercial / restrictive licence we should visibly flag (e.g.
 *  CC BY-NC-SA sources). Derived from the catalog credit line so new sources are
 *  flagged without extra metadata. */
function isNonCommercial(credit: string): boolean {
  return /non-?commercial|CC[\s-]?BY-NC|\bNC[\s-]?SA\b/i.test(credit);
}

/** One selectable source row (#130): the source's description + attribution/licence
 *  are shown, then an EXPLICIT "I agree to these terms" checkbox that must be
 *  ticked before the source is included — an informed agreement, not a passive
 *  row-click. Mirrors the Maintenance → Sources acknowledgment gate. */
function SourceRow({ source, checked, onChange }: { source: SourceStatus; checked: boolean; onChange: (v: boolean) => void }) {
  const nc = isNonCommercial(source.credit);
  return (
    <div className="bg-surface-container-low rounded-lg px-3 py-2.5 space-y-1.5">
      <div className="flex items-center gap-2 text-body-sm text-on-surface">
        {source.name}
        {nc && <span className="text-label-sm text-warning">⚠ non-commercial</span>}
      </div>
      {source.description && (
        <p className="text-label-sm text-on-surface-variant">{source.description}</p>
      )}
      <p className="text-label-sm text-on-surface-variant italic">{source.credit}</p>
      <label className="flex items-center gap-2 pt-1 mt-0.5 border-t border-outline-variant cursor-pointer">
        <input type="checkbox" className="shrink-0 mt-2" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="pt-2 text-label-md text-on-surface">Include — I accept these terms</span>
      </label>
    </div>
  );
}

function SourcesLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-body-sm text-error">Couldn't load the source catalog: {error}</p>
      <button
        onClick={onRetry}
        className="h-9 px-4 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 transition-all duration-short3 ease-standard"
      >
        Retry
      </button>
    </div>
  );
}

/** Load the source catalog (+ this DB's per-source state). */
function useSourceCatalog() {
  const [sources, setSources] = useState<SourceStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setLoadError(null);
    setSources(null);
    getSources()
      .then(setSources)
      .catch((e: unknown) => setLoadError(String(e)));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { sources, loadError, reload };
}

/** Make the enabled/acked state of `scope` match `selected`: enable + acknowledge
 *  newly selected sources, disable newly deselected ones. Idempotent, so retrying
 *  after a partial failure (or re-running the step) is safe. */
async function applySourceSelection(scope: SourceStatus[], selected: Set<string>): Promise<void> {
  for (const s of scope) {
    const want = selected.has(s.key);
    if (want && (!s.enabled || !s.credit_acked)) await setSourceEnabled(s.key, true, true);
    else if (!want && s.enabled) await setSourceEnabled(s.key, false);
  }
}

const sourcesFilledBtn =
  "w-full h-10 rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-40 transition-all duration-short3 ease-standard";

// ── Step: Deep history (the historical base — chosen first) ───────────────────

function DeepHistoryStep({ onComplete, onAdvance, onRunningChange }: { onComplete: () => void; onAdvance: () => void; onRunningChange: (r: boolean) => void }) {
  const { sources, loadError, reload } = useSourceCatalog();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [enabling, setEnabling] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Pre-select bulk archives already enabled (e.g. on re-run); compute the filter
  // inside the effect so the only dependency is the loaded catalog.
  useEffect(() => {
    if (!sources) return;
    setSelected(new Set(sources.filter((s) => s.kind === "bulk" && s.enabled).map((s) => s.key)));
  }, [sources]);

  useEffect(() => { onRunningChange(enabling); }, [enabling, onRunningChange]);

  if (loadError !== null) return <SourcesLoadError error={loadError} onRetry={reload} />;
  if (sources === null) return <p className="text-body-sm text-on-surface-variant">Loading sources…</p>;

  const bulk = sources.filter((s) => s.kind === "bulk");

  function toggle(key: string, on: boolean) {
    setSelected((prev) => { const next = new Set(prev); if (on) next.add(key); else next.delete(key); return next; });
  }

  async function apply() {
    setSubmitError(null);
    setEnabling(true);
    try {
      // Include the ticked archives; leaving them all unticked = no base (and
      // clears any previously-enabled archive on re-run).
      await applySourceSelection(bulk, selected);
      onComplete();
      onAdvance();
    } catch (e: unknown) {
      setSubmitError(`Couldn't apply your choice: ${String(e)} — some sources may already be enabled; you can retry.`);
    } finally {
      setEnabling(false);
    }
  }

  const any = selected.size > 0;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-on-surface text-body-md leading-relaxed">
          Optionally start with a free deep-history base — a deep archive of older games beneath the
          live feeds. Review its terms and tick to include it, or leave it unticked to start without
          one. You can change this later under Maintenance → Sources.
        </p>
        <OptionalBadge />
      </div>

      {bulk.length > 0 ? (
        <div className="space-y-2">
          {bulk.map((s) => (
            <SourceRow key={s.key} source={s} checked={selected.has(s.key)} onChange={(v) => toggle(s.key, v)} />
          ))}
        </div>
      ) : (
        <p className="text-body-sm text-on-surface-variant">No free archive is available right now.</p>
      )}

      <p className="text-label-sm text-on-surface-variant">
        Bringing your own database (e.g. a ChessBase Megabase)? Leave this unticked and import it
        later from Add games.
      </p>

      <div className="space-y-2">
        <button onClick={() => { void apply(); }} disabled={enabling} className={sourcesFilledBtn}>
          {enabling ? "Saving…" : any ? "Add base & continue" : "Continue without a base"}
        </button>
        {submitError && <p className="text-label-sm text-error">{submitError}</p>}
        {any && (
          <p className="text-label-sm text-on-surface-variant">
            ⓘ The archive imports on the daemon in the background — you can keep going.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Step: Live feeds (auto-updating sources) ──────────────────────────────────

function FeedsStep({ onComplete, onAdvance, onRunningChange }: { onComplete: () => void; onAdvance: () => void; onRunningChange: (r: boolean) => void }) {
  const { sources, loadError, reload } = useSourceCatalog();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [enabling, setEnabling] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Pre-select feeds already enabled (TWIC defaults on; and on re-run).
  useEffect(() => {
    if (!sources) return;
    setSelected(new Set(sources.filter((s) => s.kind === "feed" && s.enabled).map((s) => s.key)));
  }, [sources]);

  useEffect(() => { onRunningChange(enabling); }, [enabling, onRunningChange]);

  if (loadError !== null) return <SourcesLoadError error={loadError} onRetry={reload} />;
  if (sources === null) return <p className="text-body-sm text-on-surface-variant">Loading sources…</p>;

  const feeds = sources.filter((s) => s.kind === "feed");

  function toggle(key: string, on: boolean) {
    setSelected((prev) => { const next = new Set(prev); if (on) next.add(key); else next.delete(key); return next; });
  }

  async function apply() {
    setSubmitError(null);
    setEnabling(true);
    try {
      await applySourceSelection(feeds, selected);
      onComplete();
      onAdvance();
    } catch (e: unknown) {
      setSubmitError(`Couldn't apply your choice: ${String(e)} — some feeds may already be enabled; you can retry.`);
    } finally {
      setEnabling(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-on-surface text-body-md leading-relaxed">
          Optionally follow live tournament feeds. They refresh automatically in the background to
          keep recent games current, starting where the free base leaves off — no date to set.
          Review each feed's terms and tick to include it. You can change this later under
          Maintenance → Sources.
        </p>
        <OptionalBadge />
      </div>

      {feeds.length === 0 ? (
        <p className="text-body-sm text-on-surface-variant">No live feeds are available right now.</p>
      ) : (
        <div className="space-y-2">
          {feeds.map((s) => (
            <SourceRow key={s.key} source={s} checked={selected.has(s.key)} onChange={(v) => toggle(s.key, v)} />
          ))}
        </div>
      )}

      <div className="space-y-2">
        <button onClick={() => { void apply(); }} disabled={enabling} className={sourcesFilledBtn}>
          {enabling ? "Saving…" : selected.size > 0 ? "Enable selected feeds" : "Continue without feeds"}
        </button>
        {submitError && <p className="text-label-sm text-error">{submitError}</p>}
        <p className="text-label-sm text-on-surface-variant">
          ⓘ Imports run on the daemon — you can finish setup and even close LPDO; it keeps going.
        </p>
      </div>
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
        <p className="text-on-surface-variant text-body-md mt-1">
          Your database is now being prepared in the background — no further steps needed.
        </p>
      </div>

      {/* The maintenance the wizard used to ask the user to run by hand
          (deduplicate / index / normalise) now happens automatically once the
          chosen sources import. We surface it here so the process is visible,
          rather than as manual steps that — with imports running asynchronously
          on the daemon — would otherwise run before the games arrived. */}
      <div className="bg-surface-container-low rounded-lg px-4 py-3 text-body-sm text-on-surface-variant space-y-2">
        <p className="text-on-surface">What happens now, automatically</p>
        <ol className="space-y-1 list-decimal list-inside">
          <li>Your selected sources download and import — the daemon keeps going even if you close LPDO.</li>
          <li>Imported games are deduplicated.</li>
          <li>The position index is built — this powers the move explorer.</li>
          <li>Player names are normalised to their FIDE-canonical form.</li>
        </ol>
        <p>
          You don't need to run any of these by hand. After a first-time import these can take
          a while; follow progress any time from the activity indicator in the header.
        </p>
      </div>

      <p className="text-on-surface-variant text-label-md">
        Once your games have imported, set yourself as a player from the Home screen’s “My
        profile” to see your FIDE ratings and games. Manage your reference sources any time
        from Maintenance → Sources, or re-open this wizard from the header.
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

  // Finishing kicks off the daemon's first-run pipeline: it downloads + imports
  // the chosen sources (fast), then deduplicates, indexes and normalises — all in
  // the background, visible in the header activity queue (#40 C4). Fire-and-forget
  // and a no-op server-side if no sources were enabled ("empty database" choice).
  function handleFinish() {
    void startSetup();
    (onFinish ?? onClose)();
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
          {step === "welcome"   && <WelcomeStep onStart={() => { markComplete("welcome"); next(); }} />}
          {step === "history"   && <DeepHistoryStep onComplete={() => markComplete("history")} onAdvance={next} onRunningChange={setStepRunning} />}
          {step === "feeds"     && <FeedsStep       onComplete={() => markComplete("feeds")}   onAdvance={next} onRunningChange={setStepRunning} />}
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
                <button onClick={handleFinish} className={filledBtn}>
                  Finish
                </button>
              </div>
            ) : step === "welcome" ? (
              // Navigation for Welcome is the "Get started" button in the body.
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
