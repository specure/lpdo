import { useState } from "react";
import { PlayerInfo } from "../types";
import { apiUrl } from "../api";
import PlayerPicker from "./PlayerPicker";

/** Merge duplicate player records into one: all games move to the kept player,
 *  the duplicates are deleted. Wraps POST /players/{keep}/merge/{drop}, once
 *  per duplicate — a player can reach the database under several spellings
 *  ("Paehtz, Elisabeth", "Paehtz, E. (wh)", "Paehtz, Elisabeth GER"), and
 *  merging them two at a time meant reopening this dialog for each one. */
export default function MergePlayersDialog({
  initialKeep = null,
  initialDrops = [],
  onClose,
  onMerged,
}: {
  initialKeep?: PlayerInfo | null;
  initialDrops?: PlayerInfo[];
  onClose: () => void;
  /** Called after every duplicate has been merged, with the ids that are gone. */
  onMerged: (keepId: number, dropIds: number[]) => void;
}) {
  const [keep, setKeep] = useState<PlayerInfo | null>(initialKeep);
  const [drops, setDrops] = useState<PlayerInfo[]>(initialDrops);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targets = drops.filter((d) => d.id !== keep?.id);
  const ready = !!keep && targets.length > 0;
  const movedGames = targets.reduce((n, d) => n + d.game_count, 0);

  async function doMerge() {
    if (!ready || !keep) return;
    setError(null);
    const merged: number[] = [];
    for (const [i, drop] of targets.entries()) {
      setBusy(targets.length > 1 ? `Merging ${i + 1} of ${targets.length}…` : "Merging…");
      try {
        const res = await fetch(apiUrl(`/players/${keep.id}/merge/${drop.id}`), { method: "POST" });
        if (!res.ok) throw new Error((await res.text().catch(() => "")) || `${res.status}`);
        merged.push(drop.id);
      } catch (e) {
        // Each merge stands on its own, so the ones already done are kept and
        // reported; only the rest are abandoned.
        setBusy(null);
        setError(`${drop.name}: ${String(e)}${merged.length ? ` — ${merged.length} merged before this` : ""}`);
        setDrops(targets.filter((d) => !merged.includes(d.id)));
        if (merged.length) onMerged(keep.id, merged);
        return;
      }
    }
    onMerged(keep.id, merged);
    onClose();
  }

  /** Make `player` the survivor; whoever was the survivor joins the duplicates. */
  function keepInstead(player: PlayerInfo) {
    const previous = keep;
    setKeep(player);
    setDrops((prev) => [...prev.filter((d) => d.id !== player.id), ...(previous ? [previous] : [])]);
  }

  const rowBtn = "h-7 px-2.5 inline-flex items-center rounded-full text-label-md text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40"
      onClick={onClose}
    >
      <div
        className="bg-surface-container-high rounded-xl shadow-2xl w-[34rem] max-w-[92vw] max-h-[88vh] overflow-y-auto flex flex-col p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-title-lg text-on-surface">Merge players</h2>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Move all games from the duplicate records onto the player you keep, then delete the
            duplicates. Tip: keep the one with a FIDE ID.
          </p>
        </div>

        <PlayerPicker
          label="Keep this player"
          value={keep}
          onPick={setKeep}
          excludeId={targets[0]?.id}
        />

        {targets.length > 0 && (
          <div className="space-y-1">
            <div className="text-label-md text-on-surface-variant">Merge in &amp; delete</div>
            {targets.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-3 py-1.5 rounded-sm bg-surface-container">
                <span className="min-w-0 flex-1 truncate text-body-sm text-on-surface">
                  {d.name}
                  <span className="text-on-surface-variant">
                    {" — "}{d.game_count.toLocaleString()} games{d.fide_id ? ` · FIDE ${d.fide_id}` : ""}
                  </span>
                </span>
                <button onClick={() => keepInstead(d)} className={rowBtn} title="Keep this record instead">
                  Keep instead
                </button>
                <button
                  onClick={() => setDrops((prev) => prev.filter((p) => p.id !== d.id))}
                  className={rowBtn}
                  title="Leave this player alone"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <PlayerPicker
          label={targets.length > 0 ? "Add another duplicate" : "Merge in & delete"}
          value={null}
          onPick={(p) => p && setDrops((prev) => (prev.some((d) => d.id === p.id) ? prev : [...prev, p]))}
          excludeId={keep?.id}
        />

        {ready && keep && (
          <div className="text-body-sm text-on-surface-variant bg-surface-container rounded-sm px-3 py-2">
            <span className="font-medium text-on-surface">{movedGames.toLocaleString()}</span> game(s) will move
            from <span className="font-medium text-on-surface">{targets.length}</span> record
            {targets.length > 1 ? "s" : ""} to{" "}
            <span className="font-medium text-on-surface">{keep.name}</span>
            {keep.fide_id ? ` (FIDE ${keep.fide_id})` : ""}, then {targets.length > 1 ? "they are" : "it is"}{" "}
            deleted. Result:{" "}
            <span className="font-medium text-on-surface">
              {keep.name} — {(keep.game_count + movedGames).toLocaleString()} games
            </span>
            .
          </div>
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
            disabled={!ready || busy !== null}
            className="h-9 px-4 inline-flex items-center rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard"
          >
            {busy ?? (targets.length > 1 ? `Merge ${targets.length} players` : "Merge")}
          </button>
        </div>
      </div>
    </div>
  );
}
