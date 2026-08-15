import { useEffect, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
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
  const saved = useDefaultLayout({ id: "prep-cols", storage: localStorage });

  return (
    <div className="flex flex-1 overflow-hidden bg-surface">
      {/* Tournament list | prep panel, as resizable siblings — two panels, so the
          divider trades between them and there is nothing else to disturb. */}
      <Group
        orientation="horizontal"
        className="flex-1 min-w-0 flex"
        defaultLayout={saved.defaultLayout}
        onLayoutChanged={saved.onLayoutChanged}
      >
      <Panel id="tournaments" defaultSize="22" minSize="14" maxSize="40">
      <div className="h-full overflow-hidden flex flex-col">
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
      </Panel>

      <Separator className="w-1.5 bg-transparent hover:bg-primary/30 data-[separator=drag]:bg-primary/50 transition-colors" />

      {/* Right: prep panel or empty state */}
      <Panel id="prep" defaultSize="78" minSize="40">
      <div className="h-full overflow-hidden flex flex-col bg-surface-container-low">
        {selectedEntry ? (
          <TournamentPrepPanel entry={selectedEntry} onOpponentsReady={onOpponentsReady} onShowGame={onShowGame} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md">
            {entries.length === 0 ? "Add a tournament to get started" : "Select a tournament"}
          </div>
        )}
      </div>
      </Panel>
      </Group>

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
