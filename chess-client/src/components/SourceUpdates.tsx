import { useEffect, useState } from "react";
import { SourceStatus } from "../types";

// Per-source "latest update" summary (#176). For each enabled source that has
// imported something, show its most recently ingested item + date + game count.
// Generalises the old TWIC-only home tile across TWIC / Lichess Broadcasts /
// Ajedrez via the source registry — no hardcoded feed, and only sources that
// actually apply (enabled + have an import) are shown. Renders nothing otherwise.

// TWIC's external_id is a bare issue number — show it as an identifier ("#1649");
// other sources (Lichess "2026-06", Ajedrez part ids) read fine as-is.
function itemLabel(s: SourceStatus): string {
  const id = s.last_import!.external_id;
  return s.key === "twic" ? `#${id}` : id;
}

function UpdateRow({ source }: { source: SourceStatus }) {
  const li = source.last_import!;
  const date = (li.published_at ?? li.imported_at)?.slice(0, 10) ?? null;
  return (
    <div className="flex items-baseline justify-between gap-3 bg-surface-container rounded-md px-3 py-2 hover:bg-secondary-container/40 transition-colors duration-short3 ease-standard">
      <div className="min-w-0">
        <div className="text-body-sm text-on-surface truncate">{source.name}</div>
        <div className="text-label-sm text-on-surface-variant">
          <span className="font-mono">{itemLabel(source)}</span>
          {date && <span className="ml-2">{date}</span>}
        </div>
      </div>
      <div className="text-body-sm font-mono text-on-surface shrink-0">
        {li.game_count.toLocaleString()}
        <span className="text-label-sm text-on-surface-variant font-sans ml-1">games</span>
      </div>
    </div>
  );
}

export default function SourceUpdates({ reloadKey }: { reloadKey?: number }) {
  const [sources, setSources] = useState<SourceStatus[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sources")
      .then((r) => (r.ok ? r.json() : []))
      .then((s: SourceStatus[]) => { if (!cancelled) setSources(s); })
      .catch(() => { if (!cancelled) setSources([]); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const rows = (sources ?? []).filter((s) => s.enabled && s.last_import);
  if (rows.length === 0) return null;

  return (
    <div className="space-y-1.5 mt-3">
      <div className="text-label-sm text-on-surface-variant uppercase tracking-wider">Latest updates</div>
      <div className="space-y-1">
        {rows.map((s) => <UpdateRow key={s.key} source={s} />)}
      </div>
    </div>
  );
}
