import { useEffect, useRef, useState } from "react";
import { PlayerInfo } from "../types";

/** Search-and-select one player by name (reuses the server's /players search).
 *  Shows the chosen player with a "Change" affordance, or a search box with a
 *  results dropdown. */
export default function PlayerPicker({
  label,
  value,
  onPick,
  excludeId,
}: {
  label: string;
  value: PlayerInfo | null;
  onPick: (p: PlayerInfo | null) => void;
  /** Hide this player from results (e.g. the other side of the merge). */
  excludeId?: number;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlayerInfo[]>([]);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (value || q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/players?name=${encodeURIComponent(q)}`, { signal: abortRef.current!.signal })
        .then((r) => (r.ok ? (r.json() as Promise<PlayerInfo[]>) : []))
        .then((ps) => {
          setResults(ps.filter((p) => p.id !== excludeId));
          setOpen(true);
        })
        .catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [query, value, excludeId]);

  if (value) {
    return (
      <div>
        {label && <div className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-1">{label}</div>}
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-sm bg-surface-container">
          <div className="min-w-0">
            <div className="text-body-md text-on-surface truncate">{value.name}</div>
            <div className="text-label-sm text-on-surface-variant">
              {value.game_count} games{value.fide_id ? ` · FIDE ${value.fide_id}` : " · no FIDE ID"}
            </div>
          </div>
          <button
            onClick={() => { onPick(null); setQuery(""); }}
            className="shrink-0 h-7 px-3 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-1">{label}</div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search player by name…"
        className="w-full h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
      />
      {open && results.length > 0 && (
        <div className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-sm bg-surface-container-high shadow-2xl border border-outline-variant">
          {results.map((p) => (
            <button
              key={p.id}
              onClick={() => { onPick(p); setOpen(false); }}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-on-surface/8 transition-colors duration-short3 ease-standard"
            >
              <span className="text-body-sm text-on-surface truncate">{p.name}</span>
              <span className="shrink-0 text-label-sm text-on-surface-variant">
                {p.game_count} · {p.fide_id ?? "—"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
