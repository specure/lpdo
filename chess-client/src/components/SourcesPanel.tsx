import { useState, useEffect, useCallback } from "react";
import { useSidecarProgress } from "../hooks/useSidecarProgress";
import {
  getSources,
  setSourceEnabled,
  setSourceWindow,
  submitJob,
} from "../api";
import type { SourceStatus } from "../types";

// ── Multi-source catalog screen (#40 Phase C1) ────────────────────────────────
//
// Card catalog of curated import sources, wired to GET /sources and the
// sources_set_enabled / sources_set_window / sources_sync jobs. Per the locked
// mockup: per-source enable (gated by an attribution acknowledgment), a date
// window editor, sync, and status — plus a coverage strip showing how the
// enabled sources partition the timeline.

function cadenceLabel(s: SourceStatus): string {
  return s.kind === "feed" ? "↻ Auto-updating" : "⤓ One-time import · manual refresh";
}

function windowLabel(s: SourceStatus): string {
  if (!s.from_date && !s.to_date) return "all dates";
  const from = s.from_date ?? "…";
  const to = s.to_date ?? "now";
  return `${from} → ${to}`;
}

function statusLine(s: SourceStatus): { text: string; tone: "ok" | "muted" | "error" } {
  if (s.last_status && s.last_status.toLowerCase().startsWith("ok")) {
    return { text: `${s.items.toLocaleString()} imported · synced`, tone: "ok" };
  }
  if (s.last_status && !s.last_status.toLowerCase().startsWith("ok")) {
    return { text: `last sync: ${s.last_status}`, tone: "error" };
  }
  if (s.items > 0) return { text: `${s.items.toLocaleString()} imported`, tone: "muted" };
  return { text: "not yet imported", tone: "muted" };
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      className={`relative w-11 h-6 rounded-full shrink-0 transition-colors duration-short3 ease-standard disabled:opacity-40 ${
        on ? "bg-primary" : "bg-surface-container-highest border border-outline"
      }`}
    >
      <span
        className={`absolute top-1/2 -translate-y-1/2 rounded-full transition-all duration-short3 ease-standard ${
          on ? "left-[22px] w-4 h-4 bg-on-primary" : "left-1 w-3 h-3 bg-outline"
        }`}
      />
    </button>
  );
}

// ── Coverage timeline (schematic, not to scale) ───────────────────────────────

function CoverageTimeline({ sources }: { sources: SourceStatus[] }) {
  const shown = sources.filter((s) => s.enabled || s.items > 0);
  if (shown.length === 0) return null;
  // A source with no `from` is "historical" (sits on the left); one with a `from`
  // is the live/recent tail (sits on the right). Not to scale — the point is to
  // show coverage + overlap, not exact spans.
  return (
    <div className="bg-surface-container-low rounded-xl border border-outline-variant p-4 space-y-2">
      <div className="text-label-sm text-on-surface-variant uppercase tracking-wide">Coverage</div>
      <div className="space-y-2">
        {shown.map((s) => {
          const historical = !s.from_date;
          const left = historical ? "1%" : "62%";
          const width = historical ? "61%" : "37%";
          const disabled = !s.enabled;
          return (
            <div key={s.key} className="relative h-8 rounded-lg bg-surface-container-high overflow-hidden">
              <div
                className={`absolute top-0 h-full rounded-lg flex items-center px-3 gap-2 text-label-sm font-medium whitespace-nowrap ${
                  disabled
                    ? "bg-surface-container-highest text-on-surface-variant opacity-55"
                    : historical
                      ? "bg-tertiary-container text-on-tertiary-container"
                      : "bg-primary-container text-on-primary-container"
                }`}
                style={{ left, width }}
              >
                <span className="truncate">{s.name}</span>
                <span className="opacity-80 font-normal">{windowLabel(s)}</span>
                {disabled && <span className="ml-auto text-[0.5625rem] font-bold tracking-wider">OFF</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-label-sm text-on-surface-variant">
        Not to scale. Overlapping ranges are deduplicated automatically.
      </div>
    </div>
  );
}

// ── Date-window editor ────────────────────────────────────────────────────────

function WindowEditor({
  source,
  onSaved,
  onCancel,
}: {
  source: SourceStatus;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState(source.from_date ?? "");
  const [to, setTo] = useState(source.to_date ?? "");
  const [excludeUndated, setExcludeUndated] = useState(source.exclude_undated);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await setSourceWindow(source.key, from.trim() || null, to.trim() || null, excludeUndated);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    "w-36 h-9 px-3 rounded-sm bg-transparent text-on-surface text-body-sm font-mono border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard";

  return (
    <div className="bg-surface-container-low rounded-xl p-4 space-y-3 border border-primary-container">
      <div className="text-label-md text-on-surface">Date window (by game date)</div>
      <div className="flex items-center gap-2 flex-wrap text-body-sm text-on-surface-variant">
        <input className={inputCls} placeholder="from (YYYY-MM-DD)" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>→</span>
        <input className={inputCls} placeholder="to (YYYY-MM-DD)" value={to} onChange={(e) => setTo(e.target.value)} />
        <span className="text-label-sm">leave blank for unbounded</span>
      </div>
      <label className="flex items-center gap-2 text-body-sm text-on-surface-variant">
        <input type="checkbox" checked={excludeUndated} onChange={(e) => setExcludeUndated(e.target.checked)} />
        Exclude games with no date
      </label>
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={save}
          disabled={saving}
          className="h-8 px-4 rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 disabled:opacity-40 transition-all duration-short3 ease-standard"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={onCancel} className="text-label-md text-primary">Cancel</button>
        <span className="text-label-sm text-on-surface-variant ml-auto">applies on the next sync</span>
      </div>
    </div>
  );
}

// ── Source card ───────────────────────────────────────────────────────────────

function SourceCard({ source, onChanged }: { source: SourceStatus; onChanged: () => void }) {
  const sync = useSidecarProgress(`sources-sync-${source.key}`);
  const [editing, setEditing] = useState(false);
  const [ackChecked, setAckChecked] = useState(source.credit_acked);
  const [busy, setBusy] = useState(false);

  // Show the acknowledgment gate when turning a not-yet-acknowledged source on.
  const needsAck = !source.enabled && !source.credit_acked;

  async function toggleEnabled() {
    setBusy(true);
    try {
      if (!source.enabled) {
        // Enabling: record the acknowledgment in the same step.
        await setSourceEnabled(source.key, true, true);
      } else {
        await setSourceEnabled(source.key, false);
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  function runSync() {
    sync.runJob(() => submitJob({ type: "sources_sync", params: { source: source.key } }));
  }

  const st = statusLine(source);
  const toneCls = st.tone === "ok" ? "text-success" : st.tone === "error" ? "text-error" : "text-on-surface-variant";

  return (
    <div className="bg-surface-container rounded-2xl border border-outline-variant p-5 space-y-3 flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-title-lg text-on-surface">{source.name}</h3>
        <Toggle on={source.enabled} onClick={toggleEnabled} disabled={busy || needsAck} />
      </div>

      <p className="text-body-sm text-on-surface-variant min-h-[2.4rem]">
        {source.description}{" "}
        <a href={source.homepage} target="_blank" rel="noreferrer" className="text-primary">
          {new URL(source.homepage).host} ↗
        </a>
      </p>

      <div className="text-label-md text-on-surface-variant">{cadenceLabel(source)}</div>
      <div className={`text-label-md ${toneCls}`}>{st.text}</div>

      {/* Date window summary + edit */}
      <div className="flex items-center gap-2 bg-surface-container-high rounded-lg px-3 py-2 text-body-sm text-on-surface-variant">
        <span>games {windowLabel(source)}</span>
        {source.exclude_undated && <span className="text-label-sm">· undated excluded</span>}
        <button onClick={() => setEditing((v) => !v)} className="ml-auto text-label-sm text-primary">
          edit ⚙
        </button>
      </div>
      {editing && (
        <WindowEditor
          source={source}
          onCancel={() => setEditing(false)}
          onSaved={() => { setEditing(false); onChanged(); }}
        />
      )}

      {/* Acknowledgment gate (only when enabling a not-yet-acknowledged source) */}
      {needsAck && (
        <div className="bg-surface-container-low rounded-xl border border-primary-container p-3 space-y-2">
          <div className="text-label-sm text-on-surface-variant uppercase tracking-wide">Before enabling</div>
          <label className="flex items-start gap-2 text-body-sm text-on-surface">
            <input type="checkbox" className="mt-1" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} />
            <span>{source.credit}</span>
          </label>
          <button
            onClick={toggleEnabled}
            disabled={!ackChecked || busy}
            className="h-8 px-4 rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 disabled:opacity-40 transition-all duration-short3 ease-standard"
          >
            Acknowledge &amp; enable
          </button>
        </div>
      )}

      {/* Sync + progress */}
      {source.enabled && (
        <div className="mt-auto pt-1 space-y-2">
          {!sync.running ? (
            <button
              onClick={runSync}
              className="h-8 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
            >
              ⟳ Sync now
            </button>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-label-sm text-on-surface-variant">
                <span>{sync.message || "Syncing…"}</span>
                <span>{Math.round(sync.percent)}%</span>
              </div>
              <div className="w-full bg-surface-container-highest rounded-full h-1.5 overflow-hidden">
                <div className="bg-primary h-1.5 rounded-full transition-all duration-short3 ease-standard" style={{ width: `${Math.min(100, sync.percent)}%` }} />
              </div>
            </div>
          )}
          {sync.done && <div className="text-label-sm text-success">{sync.doneMessage || "Synced."}</div>}
          <div className="text-label-sm text-on-surface-variant opacity-85">
            ⓘ Disabling keeps imported games — remove them via the “{source.collection}” collection.
          </div>
        </div>
      )}

      <div className="text-label-sm text-on-surface-variant pt-1">{source.credit}</div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function SourcesPanel({ onMutated }: { onMutated?: () => void }) {
  const [sources, setSources] = useState<SourceStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getSources()
      .then((s) => { setSources(s); setError(null); })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function onChanged() {
    refresh();
    onMutated?.();
  }

  if (error) {
    return <div className="text-body-sm text-error">Couldn’t load sources: {error}</div>;
  }
  if (!sources) {
    return <div className="text-body-sm text-on-surface-variant">Loading sources…</div>;
  }

  return (
    <div className="space-y-4">
      <CoverageTimeline sources={sources} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        {sources.map((s) => (
          <SourceCard key={s.key} source={s} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}
