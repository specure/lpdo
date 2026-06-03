import { useEffect, useMemo, useRef, useState } from "react";

interface CollectionInfo {
  id: number;
  name: string;
  game_count: number;
}

interface Props {
  /** Collection names already on the current game — filtered out of suggestions. */
  excluded: string[];
  /** Fired when the user selects (or creates) a collection. Parent handles the mutation. */
  onPick: (name: string) => void;
  onClose: () => void;
}

// Anchored popover that lets the user pick an existing collection or create a
// new one. Lives inline as `{open && <CollectionPicker .../>}` next to the chip
// that triggers it; the parent provides a wrapping `relative` container so
// the popover positions itself below.
export default function CollectionPicker({ excluded, onPick, onClose }: Props) {
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/collections")
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json() as Promise<CollectionInfo[]>; })
      .then(setCollections)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load collections"));
  }, []);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Close on outside click. Bound to the document so clicks anywhere outside
  // the popover dismiss it (the chip's own click is inside `ref`).
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onClose]);

  const excludedSet = useMemo(() => new Set(excluded), [excluded]);
  const q = query.trim();
  const ql = q.toLowerCase();

  const matches = useMemo(() => {
    return collections
      .filter((c) => !excludedSet.has(c.name))
      .filter((c) => ql.length === 0 || c.name.toLowerCase().includes(ql))
      .sort((a, b) => b.game_count - a.game_count);
  }, [collections, excludedSet, ql]);

  // Offer "Create new collection: <q>" when the typed value is non-empty and
  // doesn't exactly match any existing collection (case-insensitive).
  const showCreate = q.length > 0
    && !collections.some((c) => c.name.toLowerCase() === ql);

  const totalRows = matches.length + (showCreate ? 1 : 0);

  useEffect(() => { setHighlighted(0); }, [query]);

  function commit(idx: number) {
    if (idx < matches.length) {
      onPick(matches[idx].name);
    } else if (showCreate) {
      onPick(q);
    }
    onClose();
  }

  return (
    <div
      ref={ref}
      className="absolute z-20 left-0 top-full mt-1 w-64 bg-surface-container-high rounded-md shadow-xl py-1"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-2 pb-1">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { setHighlighted((i) => Math.min(totalRows - 1, i + 1)); e.preventDefault(); }
            else if (e.key === "ArrowUp") { setHighlighted((i) => Math.max(0, i - 1)); e.preventDefault(); }
            else if (e.key === "Enter" && totalRows > 0) { commit(highlighted); e.preventDefault(); }
            else if (e.key === "Escape") { onClose(); e.preventDefault(); }
          }}
          placeholder="Search or create…"
          className="w-full h-8 px-2 rounded-sm bg-surface-container-lowest text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary placeholder:text-on-surface-variant transition-colors duration-short3 ease-standard"
        />
      </div>

      <div className="max-h-48 overflow-y-auto">
        {error && (
          <div className="px-3 py-2 text-body-sm text-error">{error}</div>
        )}
        {!error && totalRows === 0 && (
          <div className="px-3 py-2 text-body-sm text-on-surface-variant">
            {collections.length === 0 ? "No collections yet" : "No matches"}
          </div>
        )}
        {matches.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onClick={() => commit(i)}
            onMouseEnter={() => setHighlighted(i)}
            className={`w-full text-left px-3 py-1.5 text-body-sm transition-colors duration-short3 ease-standard ${
              i === highlighted ? "bg-on-surface/8" : ""
            } hover:bg-on-surface/8`}
          >
            <div className="text-on-surface truncate">{c.name}</div>
            <div className="text-label-sm text-on-surface-variant">{c.game_count.toLocaleString()} games</div>
          </button>
        ))}
        {showCreate && (
          <button
            type="button"
            onClick={() => commit(matches.length)}
            onMouseEnter={() => setHighlighted(matches.length)}
            className={`w-full text-left px-3 py-1.5 text-body-sm transition-colors duration-short3 ease-standard ${
              highlighted === matches.length ? "bg-on-surface/8" : ""
            } hover:bg-on-surface/8`}
          >
            <span className="text-on-surface-variant">Create new collection: </span>
            <span className="text-primary">{q}</span>
          </button>
        )}
      </div>
    </div>
  );
}
