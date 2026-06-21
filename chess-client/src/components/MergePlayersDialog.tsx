import { useState } from "react";
import { PlayerInfo } from "../types";
import { apiUrl } from "../api";
import PlayerPicker from "./PlayerPicker";

/** Merge two duplicate player records into one: all games move to the kept
 *  player, the duplicate is deleted. Wraps POST /players/{keep}/merge/{drop}. */
export default function MergePlayersDialog({
  initialKeep = null,
  initialDrop = null,
  onClose,
  onMerged,
}: {
  initialKeep?: PlayerInfo | null;
  initialDrop?: PlayerInfo | null;
  onClose: () => void;
  /** Called after a successful merge so the host can refresh. */
  onMerged: (keepId: number, dropId: number) => void;
}) {
  const [keep, setKeep] = useState<PlayerInfo | null>(initialKeep);
  const [drop, setDrop] = useState<PlayerInfo | null>(initialDrop);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = !!keep && !!drop && keep.id !== drop.id;

  async function doMerge() {
    if (!ready || !keep || !drop) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/players/${keep.id}/merge/${drop.id}`), { method: "POST" });
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `${res.status}`);
      onMerged(keep.id, drop.id);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  function swap() {
    setKeep(drop);
    setDrop(keep);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40"
      onClick={onClose}
    >
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl w-[34rem] max-w-[92vw] max-h-[88vh] flex flex-col p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-title-lg text-on-surface">Merge players</h2>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Move all games from a duplicate record onto the player you keep, then delete the
            duplicate. Tip: keep the one with a FIDE ID.
          </p>
        </div>

        <PlayerPicker label="Keep this player" value={keep} onPick={setKeep} excludeId={drop?.id} />

        <div className="flex justify-center">
          <button
            onClick={swap}
            disabled={!keep && !drop}
            title="Swap which player is kept"
            className="h-7 px-3 inline-flex items-center gap-1 rounded-full text-on-surface-variant text-label-md hover:bg-on-surface/8 disabled:opacity-40 transition-colors duration-short3 ease-standard"
          >
            ⇅ Swap
          </button>
        </div>

        <PlayerPicker label="Merge in & delete" value={drop} onPick={setDrop} excludeId={keep?.id} />

        {ready && keep && drop && (
          <div className="text-body-sm text-on-surface-variant bg-surface-container rounded-sm px-3 py-2">
            <span className="font-medium text-on-surface">{drop.game_count}</span> game(s) will move
            from <span className="font-medium text-on-surface">{drop.name}</span> to{" "}
            <span className="font-medium text-on-surface">{keep.name}</span>
            {keep.fide_id ? ` (FIDE ${keep.fide_id})` : ""}, then{" "}
            <span className="font-medium text-on-surface">{drop.name}</span> is deleted. Result:{" "}
            <span className="font-medium text-on-surface">
              {keep.name} — {keep.game_count + drop.game_count} games
            </span>
            .
          </div>
        )}
        {keep && drop && keep.id === drop.id && (
          <p className="text-error text-body-sm">Pick two different players.</p>
        )}
        {error && <p className="text-error text-body-sm">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="h-9 px-4 inline-flex items-center rounded-full text-primary text-label-lg hover:bg-primary/8 transition-colors duration-short3 ease-standard"
          >
            Cancel
          </button>
          <button
            onClick={() => void doMerge()}
            disabled={!ready || busy}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard"
          >
            {busy ? "Merging…" : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}
