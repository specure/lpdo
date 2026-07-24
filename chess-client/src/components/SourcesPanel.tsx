import { useState, useEffect, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getSources,
  setSourceEnabled,
  setSourceWindow,
} from "../api";
import type { SourceStatus } from "../types";

/** Open a source's homepage (about / licence) in the OS browser. A plain
 *  <a target="_blank"> doesn't reliably open externally from the Tauri webview,
 *  so route through the opener plugin. */
function SourceLink({ url }: { url: string }) {
  let host = url;
  try { host = new URL(url).host; } catch { /* keep raw */ }
  return (
    <button
      type="button"
      onClick={() => { void openUrl(url); }}
      className="text-primary hover:underline"
    >
      {host} ↗
    </button>
  );
}

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

// Plain-English date window (used as "games <label>"), e.g. "up to 2012-12-31",
// "2013-01-01 onward", "2020-01-01 to 2024-08-01", "all dates". Mirrors the
// backend DateWindow::describe(); avoids the cryptic "… → 2012-12-31" render.
function windowLabel(s: SourceStatus): string {
  const from = s.from_date;
  const to = s.to_date;
  if (!from && !to) return "all dates";
  if (from && to) return `${from} to ${to}`;
  if (from) return `${from} onward`;
  return `up to ${to}`;
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

// Rough monotonic day index for ordering dates (not for exact math).
function dayIndex(d: string): number {
  const [y, m, day] = d.split("-").map(Number);
  return (y || 0) * 366 + ((m || 1) - 1) * 31 + ((day || 1) - 1);
}

function CoverageTimeline({ sources }: { sources: SourceStatus[] }) {
  const shown = sources.filter((s) => s.enabled || s.items > 0);
  if (shown.length === 0) return null;

  // Schematic (not to scale), but ordered by start date: deep-history sources
  // (no `from`) come first / on the left; feeds with a `from` are placed by that
  // start date, so a later-starting feed (Lichess, 2026) visibly begins to the
  // right of an earlier one (TWIC, 2013). A deep-history bar ends exactly where
  // the earliest feed begins, so a sharp hand-off (Ajedrez → 2012-12-31, TWIC
  // 2013-01-01 →) reads as contiguous, not overlapping.
  const feedFroms = shown.filter((s) => s.from_date).map((s) => dayIndex(s.from_date!));
  const hasFeeds = feedFroms.length > 0;
  const minFrom = hasFeeds ? Math.min(...feedFroms) : 0;
  const maxFrom = hasFeeds ? Math.max(...feedFroms) : 0;
  const BAND_L = 40, BAND_R = 68, RIGHT = 97; // feed starts span [40%, 68%]; bars run to 97%
  const feedLeft = (from: string) =>
    feedFroms.length <= 1 || maxFrom === minFrom
      ? BAND_L
      : BAND_L + (BAND_R - BAND_L) * ((dayIndex(from) - minFrom) / (maxFrom - minFrom));

  // Earliest coverage first (deep history on top, then feeds by start date).
  const ordered = [...shown].sort(
    (a, b) => (a.from_date ? dayIndex(a.from_date) : -Infinity) - (b.from_date ? dayIndex(b.from_date) : -Infinity),
  );

  return (
    <div className="bg-surface-container-low rounded-xl border border-outline-variant p-4 space-y-2">
      <div className="text-label-sm text-on-surface-variant uppercase tracking-wide">Coverage</div>
      <div className="space-y-2">
        {ordered.map((s) => {
          const historical = !s.from_date;
          const left = historical ? 1 : feedLeft(s.from_date!);
          // Deep-history bars stop where the first feed starts (BAND_L) so a sharp
          // hand-off touches rather than overlaps; if there are no feeds they run full.
          const width = historical ? (hasFeeds ? BAND_L : RIGHT) - left : RIGHT - left;
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
                style={{ left: `${left}%`, width: `${width}%` }}
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
        Not to scale — ordered by start date. Overlapping ranges are deduplicated automatically.
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
        <SourceLink url={source.homepage} />
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

      {/* Enabled sources import automatically in the background (the daemon's
          scheduler picks them up; progress shows in the header activity queue).
          There's no manual "Sync now" — enabling is the trigger. */}
      {source.enabled && (
        <div className="mt-auto pt-1 space-y-2">
          <div className="text-label-sm text-on-surface-variant opacity-85">
            ⓘ Imports run automatically in the background — follow progress from the activity indicator in the header.
          </div>
          <div className="text-label-sm text-on-surface-variant opacity-85">
            Disabling keeps imported games — remove them via the “{source.collection}” collection.
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
