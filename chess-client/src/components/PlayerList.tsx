import { useCallback, useEffect, useRef, useState } from "react";
import { PlayerInfo } from "../types";

interface Props {
  selectedId: number | null;
  onSelect: (player: PlayerInfo) => void;
  /** Optional external ref for the search input (so HomeEmptyState's
   *  "Search a player" card can focus it from above). */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Persistent "Recent" shortcut list rendered above the search results.
   *  Lets users jump back to a previously-selected player at any time. */
  recentPlayers?: PlayerInfo[];
  /** When provided, each Recent row shows a trailing × button to remove it. */
  onRemoveRecent?: (id: number) => void;
  /** Bumped externally to force a re-fetch of search results (e.g. after a merge). */
  reloadKey?: number;
}

// Single-line player row — used both for search results and Recent shortcuts.
// If `onRemove` is supplied, a × button is rendered in the trailing edge to
// drop the player from the Recent list without selecting them.
function PlayerRow({
  player, selected, onClick, onRemove,
}: {
  player: PlayerInfo;
  selected: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="relative group">
      <button
        onClick={onClick}
        className={`w-full text-left px-4 py-3 ${onRemove ? "pr-10" : ""} transition-colors duration-short3 ease-standard ${
          selected
            ? "bg-secondary-container text-on-secondary-container"
            : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
        }`}
      >
        <div className="text-body-lg truncate">{player.name}</div>
        <div className={`text-body-sm mt-0.5 ${selected ? "text-on-secondary-container/80" : "text-on-surface-variant"}`}>
          {player.game_count.toLocaleString()} games
          {player.fide_id && <span className="ml-2">FIDE {player.fide_id}</span>}
        </div>
      </button>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove from recent"
          aria-label={`Remove ${player.name} from recent`}
          className={`absolute top-1/2 right-2 -translate-y-1/2 w-7 h-7 inline-flex items-center justify-center rounded-full text-base leading-none opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity duration-short3 ease-standard ${
            selected
              ? "text-on-secondary-container hover:bg-on-secondary-container/12 active:bg-on-secondary-container/16"
              : "text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12"
          }`}
        >×</button>
      )}
    </div>
  );
}

export default function PlayerList({ selectedId, onSelect, inputRef, recentPlayers, onRemoveRecent, reloadKey }: Props) {
  const [query, setQuery] = useState("");
  const [players, setPlayers] = useState<PlayerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const search = useCallback((name: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    if (!name.trim()) {
      setPlayers([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ name: name.trim() });
    fetch(`/api/players?${params}`, { signal: abortRef.current.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        return res.json() as Promise<PlayerInfo[]>;
      })
      .then((data) => { setPlayers(data); setLoading(false); })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load players");
        setPlayers([]);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length > 0 && query.trim().length < 2) return;
    debounceRef.current = setTimeout(() => search(query), 2000);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, search]);

  // Force an immediate re-fetch when asked (e.g. after a player merge).
  useEffect(() => {
    if (reloadKey) search(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* M3 search field — filled, full-pill */}
      <div className="p-3 shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && query.trim().length >= 2) search(query); }}
          placeholder="Search player…"
          className="w-full h-10 px-4 rounded-full bg-surface-container-high text-on-surface placeholder:text-on-surface-variant text-body-md border border-transparent focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
        />
      </div>

      {/* Results — M3 list with state-layer rows */}
      <div className="flex-1 overflow-y-auto">
        {/* Recent players — shortcut list at the top, hidden once the user
            starts typing a search so the results aren't pushed off-screen. */}
        {recentPlayers && recentPlayers.length > 0 && query.trim().length === 0 && (
          <>
            <div className="px-4 pt-3 pb-1.5 text-label-sm text-on-surface-variant uppercase tracking-wider">
              Recent
            </div>
            {recentPlayers.map((p) => (
              <PlayerRow
                key={`r-${p.id}`}
                player={p}
                selected={selectedId === p.id}
                onClick={() => onSelect(p)}
                onRemove={onRemoveRecent ? () => onRemoveRecent(p.id) : undefined}
              />
            ))}
            <div className="mx-4 my-2 border-t border-outline-variant" />
          </>
        )}

        {loading && (
          <div className="p-4 text-center text-on-surface-variant text-body-md">Loading…</div>
        )}
        {error && (
          <div className="p-4 text-center text-error text-body-md">{error}</div>
        )}
        {!loading && !error && players.length === 0 && (
          <div className="p-4 text-center text-on-surface-variant text-body-md">
            {query.trim().length > 0 && query.trim().length < 2
              ? "Type at least 2 characters"
              : query ? "No players found" : "Search for a player"}
          </div>
        )}
        {players.map((player) => (
          <PlayerRow
            key={player.id}
            player={player}
            selected={selectedId === player.id}
            onClick={() => onSelect(player)}
          />
        ))}
      </div>
    </div>
  );
}
