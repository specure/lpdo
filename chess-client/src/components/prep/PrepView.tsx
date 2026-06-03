import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GameSummary, PlayerInfo, PrepContext, ShortlistEntry } from "../../types";
import TournamentList from "./TournamentList";
import AddTournamentModal from "./AddTournamentModal";
import TournamentPrepPanel from "./TournamentPrepPanel";

interface Props {
  onOpponentsReady: (ctx: PrepContext) => void;
  /** Switch to the Players tab with this player + game preselected. */
  onShowGame: (player: PlayerInfo, game: GameSummary) => void;
}

export default function PrepView({ onOpponentsReady, onShowGame }: Props) {
  const [entries, setEntries] = useState<ShortlistEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ShortlistEntry[]>("get_shortlist").then(setEntries).catch(() => {});
  }, []);

  async function handleRemove(id: string) {
    setRemoveError(null);
    try {
      const updated = await invoke<ShortlistEntry[]>("remove_tournament", { id });
      setEntries(updated);
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      setRemoveError(String(e));
    }
  }

  const selectedEntry = entries.find((e) => e.id === selectedId) ?? null;

  return (
    <div className="flex flex-1 overflow-hidden bg-surface">
      {/* Left: tournament list */}
      <div className="w-72 shrink-0 overflow-hidden flex flex-col">
        <TournamentList
          entries={entries}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRemove={handleRemove}
          onAdd={() => setShowAdd(true)}
        />
        {removeError && (
          <div className="px-3 py-2 text-body-sm text-error">{removeError}</div>
        )}
      </div>

      {/* Right: prep panel or empty state */}
      <div className="flex-1 overflow-hidden flex flex-col bg-surface-container-low">
        {selectedEntry ? (
          <TournamentPrepPanel entry={selectedEntry} onOpponentsReady={onOpponentsReady} onShowGame={onShowGame} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md">
            {entries.length === 0 ? "Add a tournament to get started" : "Select a tournament"}
          </div>
        )}
      </div>

      {showAdd && (
        <AddTournamentModal
          onClose={() => setShowAdd(false)}
          onAdded={(updated) => {
            setEntries(updated);
            setShowAdd(false);
            // Auto-select the newly added tournament
            const newest = updated[updated.length - 1];
            if (newest) setSelectedId(newest.id);
          }}
        />
      )}
    </div>
  );
}
