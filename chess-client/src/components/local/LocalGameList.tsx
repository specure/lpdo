import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LocalGame } from "../../types";
import { splitPgnFile } from "../../lib/pgnSplitter";
import {
  assemblePgnFile,
  markBlockDeleted,
  unmarkBlockDeleted,
} from "../../lib/pgnEditor";
import AddGameModal from "./AddGameModal";
import EditHeadersModal from "./EditHeadersModal";
import IndexedGameList from "./IndexedGameList";

type ColorFilter = "any" | "white" | "black";

interface Props {
  filePath: string;
  selectedId: number | null;
  onSelect: (game: LocalGame) => void;
  onGameCount?: (count: number) => void;
}

function matchesName(game: LocalGame, name: string, color: ColorFilter): boolean {
  const q = name.toLowerCase();
  if (color === "white") return game.white.toLowerCase().includes(q);
  if (color === "black") return game.black.toLowerCase().includes(q);
  return game.white.toLowerCase().includes(q) || game.black.toLowerCase().includes(q);
}

function matchesDate(dateStr: string | null, from: string, to: string): boolean {
  if (!dateStr) return !from && !to;
  const year = dateStr.slice(0, 4);
  if (from && year < from) return false;
  if (to && year > to) return false;
  return true;
}

export default function LocalGameList({ filePath, selectedId, onSelect, onGameCount }: Props) {
  const [allGames, setAllGames] = useState<LocalGame[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Files over read_pgn_file's in-memory cap can't be loaded whole; hand them to
  // the indexed (read-only) browser instead of failing with "File too large" (#104).
  const [oversized, setOversized] = useState(false);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Add-game modal + reload counter + pending post-reload selection
  const [addOpen, setAddOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const pendingSelectIndexRef = useRef<number | null>(null);

  // Kebab menu, show-deleted toggle, purge confirm, edit-headers modal
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  // Filters
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [player1, setPlayer1] = useState("");
  const [player1Color, setPlayer1Color] = useState<ColorFilter>("any");
  const [player2, setPlayer2] = useState("");
  const [player2Color, setPlayer2Color] = useState<ColorFilter>("any");

  const opposite: Record<ColorFilter, ColorFilter> = { any: "any", white: "black", black: "white" };

  function setP1Color(c: ColorFilter) {
    setPlayer1Color(c);
    setPlayer2Color(opposite[c]);
  }
  function setP2Color(c: ColorFilter) {
    setPlayer2Color(c);
    setPlayer1Color(opposite[c]);
  }
  const [event, setEvent] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    setLoading(true);
    setError(null);
    setAllGames([]);
    setOversized(false);

    invoke<string>("read_pgn_file", { path: filePath })
      .then((text) => {
        const parsed = splitPgnFile(text);
        setAllGames(parsed);
        onGameCount?.(parsed.length);
        const pending = pendingSelectIndexRef.current;
        if (pending !== null && parsed[pending]) {
          onSelect(parsed[pending]);
          pendingSelectIndexRef.current = null;
        } else if (parsed.length === 1) {
          onSelect(parsed[0]);
        }
      })
      .catch((e) => {
        // Too big for the whole-file editor → switch to the indexed browser.
        if (/too large/i.test(String(e))) setOversized(true);
        else setError(String(e));
      })
      .finally(() => setLoading(false));
  }, [filePath, reloadKey]);

  const activeFilterCount =
    (player1 ? 1 : 0) +
    (player2 ? 1 : 0) +
    (event ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0);

  const deletedCount = useMemo(
    () => allGames.filter((g) => g.deleted_at !== null).length,
    [allGames],
  );

  const games = useMemo(() => {
    return allGames.filter((g) => {
      if (g.deleted_at !== null && !showDeleted) return false;
      if (activeFilterCount > 0) {
        if (player1 && !matchesName(g, player1, player1Color)) return false;
        if (player2 && !matchesName(g, player2, player2Color)) return false;
        if (event && !(g.event ?? "").toLowerCase().includes(event.toLowerCase())) return false;
        if ((dateFrom || dateTo) && !matchesDate(g.date, dateFrom, dateTo)) return false;
      }
      return true;
    });
  }, [allGames, showDeleted, player1, player1Color, player2, player2Color, event, dateFrom, dateTo, activeFilterCount]);

  async function rewriteFile(blocks: string[]) {
    setBusy(true);
    setWriteError(null);
    try {
      const content = assemblePgnFile(blocks);
      await invoke("write_pgn_file", { path: filePath, content });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setWriteError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleDeleted(targetIndex: number) {
    if (busy) return;
    const updated = allGames.map((g, i) => {
      if (i !== targetIndex) return g.pgn;
      return g.deleted_at !== null
        ? unmarkBlockDeleted(g.pgn)
        : markBlockDeleted(g.pgn, new Date().toISOString());
    });
    await rewriteFile(updated);
  }

  async function purgeDeleted() {
    if (busy) return;
    const kept = allGames.filter((g) => g.deleted_at === null).map((g) => g.pgn);
    setPurgeOpen(false);
    await rewriteFile(kept);
  }

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // A file too large for the in-memory editor is browsed read-only via the index.
  if (oversized) {
    return (
      <IndexedGameList
        filePath={filePath}
        selectedId={selectedId}
        onSelect={onSelect}
        onGameCount={onGameCount}
      />
    );
  }

  const fileName = filePath.split("/").pop() ?? filePath;
  const showFilters = allGames.length > 1;

  // Reusable M3 chip class — three states (mirrors GameList chip helper)
  function chipClass(active: boolean, hasValue: boolean) {
    const base = "inline-flex items-center h-7 px-3 rounded-full text-label-md transition-colors duration-short3 ease-standard";
    if (active) return `${base} bg-secondary-container text-on-secondary-container`;
    if (hasValue) return `${base} bg-tertiary-container text-on-tertiary-container hover:brightness-110`;
    return `${base} border border-outline text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12`;
  }

  return (
    <div className="flex flex-col h-full bg-surface-container-low">
      {/* Header */}
      <div className="px-3 pt-3 pb-3 shrink-0 space-y-2">
        <div className="text-title-md text-on-surface truncate" title={filePath}>
          {fileName}
        </div>
        <div className="flex justify-between items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            {!loading && !error && (
              <div className="text-label-md text-on-surface-variant">
                {games.length}{activeFilterCount > 0 ? ` / ${allGames.length}` : ""} game{games.length !== 1 ? "s" : ""}
              </div>
            )}
            {deletedCount > 0 && (
              <button
                onClick={() => setShowDeleted((s) => !s)}
                className={chipClass(showDeleted, false)}
                title={showDeleted ? "Hide deleted games" : "Show deleted games"}
              >
                {showDeleted ? "Hide" : "Show"} deleted ({deletedCount})
              </button>
            )}
          </div>
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={() => setAddOpen(true)}
              className={chipClass(false, false)}
              title="Add a game"
            >
              + Add
            </button>
            {showFilters && (
              <button
                onClick={() => setFiltersOpen((o) => !o)}
                className={chipClass(filtersOpen, activeFilterCount > 0)}
              >
                {activeFilterCount > 0 ? `Filters · ${activeFilterCount}` : "Filters"}
              </button>
            )}
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="w-7 h-7 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
                title="More actions"
              >
                ⋮
              </button>
              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setMenuOpen(false)}
                  />
                  {/* M3 menu surface */}
                  <div className="absolute right-0 top-full mt-1 w-48 bg-surface-container-high rounded-md shadow-xl z-20 py-1">
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        if (deletedCount > 0) setPurgeOpen(true);
                      }}
                      disabled={deletedCount === 0}
                      className="w-full text-left text-body-sm px-3 py-2 text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 disabled:text-on-surface-variant disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors duration-short3 ease-standard"
                    >
                      Purge deleted games{deletedCount > 0 ? ` (${deletedCount})…` : ""}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        {writeError && (
          <div className="text-body-sm text-error truncate" title={writeError}>
            {writeError}
          </div>
        )}
      </div>

      {/* Filters — tonal step up to signal grouping */}
      {filtersOpen && (() => {
        const textInput = "h-9 px-3 rounded-sm bg-transparent text-on-surface placeholder:text-on-surface-variant text-body-sm border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard";
        function colorBtn(active: boolean) {
          return `text-label-md h-7 px-2.5 inline-flex items-center rounded-full transition-colors duration-short3 ease-standard ${
            active
              ? "bg-secondary-container text-on-secondary-container"
              : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
          }`;
        }
        return (
          <div className="p-4 bg-surface-container shrink-0 space-y-4">
            {/* Player 1 */}
            <div>
              <div className="text-label-md text-on-surface-variant mb-1.5">Player</div>
              <div className="flex gap-1">
                <input
                  type="text"
                  value={player1}
                  onChange={(e) => setPlayer1(e.target.value)}
                  placeholder="Name…"
                  className={`flex-1 min-w-0 ${textInput}`}
                />
                <div className="flex gap-0.5">
                  {(["any", "white", "black"] as ColorFilter[]).map((c) => (
                    <button key={c} onClick={() => setP1Color(c)} className={colorBtn(player1Color === c)}>
                      {c === "any" ? "Any" : c === "white" ? "W" : "B"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Player 2 */}
            <div>
              <div className="text-label-md text-on-surface-variant mb-1.5">Player 2</div>
              <div className="flex gap-1">
                <input
                  type="text"
                  value={player2}
                  onChange={(e) => setPlayer2(e.target.value)}
                  placeholder="Name…"
                  className={`flex-1 min-w-0 ${textInput}`}
                />
                <div className="flex gap-0.5">
                  {(["any", "white", "black"] as ColorFilter[]).map((c) => (
                    <button key={c} onClick={() => setP2Color(c)} className={colorBtn(player2Color === c)}>
                      {c === "any" ? "Any" : c === "white" ? "W" : "B"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Event */}
            <div>
              <div className="text-label-md text-on-surface-variant mb-1.5">Event</div>
              <input
                type="text"
                value={event}
                onChange={(e) => setEvent(e.target.value)}
                placeholder="Event…"
                className={`w-full ${textInput}`}
              />
            </div>

            {/* Date range */}
            <div>
              <div className="text-label-md text-on-surface-variant mb-1.5">Date range</div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  placeholder="From (YYYY)"
                  className={`flex-1 min-w-0 ${textInput}`}
                />
                <input
                  type="text"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  placeholder="To (YYYY)"
                  className={`flex-1 min-w-0 ${textInput}`}
                />
              </div>
            </div>
          </div>
        );
      })()}

      {/* Game list */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="p-4 text-center text-on-surface-variant text-body-md">Loading...</div>
        )}
        {error && (
          <div className="p-4 text-center text-error text-body-md">{error}</div>
        )}
        {!loading && !error && games.length === 0 && (
          <div className="p-4 text-center text-on-surface-variant text-body-md">
            {activeFilterCount > 0 ? "No matching games" : "No games found"}
          </div>
        )}
        {games.map((game) => {
          const selected = selectedId === game.id;
          const isDeleted = game.deleted_at !== null;
          // ID is -(index+1) from splitPgnFile.
          const allGamesIndex = -game.id - 1;
          const nameClass = isDeleted ? "line-through" : "";
          // Sub-text colors flip when the row is selected, to stay legible on the container fill.
          const subText = selected ? "text-on-secondary-container/80" : "text-on-surface-variant";
          const iconBtn = `w-7 h-7 inline-flex items-center justify-center rounded-full transition-colors duration-short3 ease-standard disabled:opacity-30 disabled:cursor-not-allowed ${
            selected
              ? "text-on-secondary-container hover:bg-on-secondary-container/10"
              : "text-on-surface-variant hover:bg-on-surface/8"
          }`;
          return (
            <div key={game.id} className="relative group">
              <button
                ref={selected ? selectedRef : null}
                onClick={() => onSelect(game)}
                className={`w-full text-left pl-4 pr-20 py-3 transition-colors duration-short3 ease-standard ${
                  selected
                    ? "bg-secondary-container text-on-secondary-container"
                    : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
                } ${isDeleted ? "opacity-60" : ""}`}
              >
                <div className="text-body-md truncate flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${selected ? "bg-on-secondary-container" : "bg-on-surface"}`} />
                  <span className={`truncate ${nameClass}`}>{game.white}</span>
                  {game.white_elo && (
                    <span className={`text-body-sm shrink-0 ${subText}`}>({game.white_elo})</span>
                  )}
                </div>
                <div className="text-body-md truncate flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full bg-transparent shrink-0 border ${selected ? "border-on-secondary-container" : "border-on-surface-variant"}`} />
                  <span className={`truncate ${nameClass}`}>{game.black}</span>
                  {game.black_elo && (
                    <span className={`text-body-sm shrink-0 ${subText}`}>({game.black_elo})</span>
                  )}
                </div>
                <div className={`text-body-sm mt-0.5 flex gap-2 truncate ${subText}`}>
                  {game.result && (
                    <span className={selected ? "" : "text-on-surface"}>
                      {game.result === "1/2-1/2" ? "½-½" : game.result}
                    </span>
                  )}
                  {game.date && <span>{game.date.slice(0, 10)}</span>}
                  {game.event && <span className="truncate">{game.event}</span>}
                  {isDeleted && game.deleted_at && (
                    <span className="text-warning shrink-0">
                      deleted {game.deleted_at.slice(0, 10)}
                    </span>
                  )}
                </div>
              </button>
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingIndex(allGamesIndex);
                  }}
                  disabled={busy}
                  className={`${iconBtn} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                  title="Edit headers"
                >
                  <span className="text-sm leading-none">✎</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleDeleted(allGamesIndex);
                  }}
                  disabled={busy}
                  className={`${iconBtn} ${
                    isDeleted ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  }`}
                  title={isDeleted ? "Restore game" : "Mark game as deleted"}
                >
                  <span className="text-base leading-none">{isDeleted ? "↺" : "🗑"}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {addOpen && (
        <AddGameModal
          filePath={filePath}
          onClose={() => setAddOpen(false)}
          onAppended={() => {
            // splitPgnFile preserves order, so the first newly-appended game
            // sits at the current allGames length after reload.
            pendingSelectIndexRef.current = allGames.length;
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      {editingIndex !== null && allGames[editingIndex] && (
        <EditHeadersModal
          filePath={filePath}
          game={allGames[editingIndex]}
          gameIndex={editingIndex}
          allGames={allGames}
          onClose={() => setEditingIndex(null)}
          onSaved={() => {
            // Keep the same row selected after the file reloads.
            pendingSelectIndexRef.current = editingIndex;
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      {purgeOpen && (
        <div
          className="fixed inset-0 bg-on-surface/40 flex items-center justify-center z-50"
          onClick={() => setPurgeOpen(false)}
        >
          <div
            className="bg-surface-container-high rounded-xl shadow-2xl w-[28rem] max-w-[92vw] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-title-md text-on-surface mb-2">Purge deleted games</div>
            <div className="text-body-md text-on-surface-variant mb-5">
              Permanently remove {deletedCount} game{deletedCount !== 1 ? "s" : ""} marked as
              deleted from <span className="text-on-surface">{fileName}</span>. This cannot be
              undone.
            </div>
            <div className="flex justify-end gap-2">
              {/* Text button */}
              <button
                onClick={() => setPurgeOpen(false)}
                disabled={busy}
                className="h-9 px-4 inline-flex items-center rounded-full text-primary text-label-lg hover:bg-primary/8 active:bg-primary/12 disabled:opacity-50 transition-colors duration-short3 ease-standard"
              >
                Cancel
              </button>
              {/* Filled error — irreversible destructive action */}
              <button
                onClick={purgeDeleted}
                disabled={busy}
                className="h-9 px-4 inline-flex items-center rounded-full bg-error text-on-error text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard"
              >
                {busy ? "Purging…" : `Purge ${deletedCount}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
