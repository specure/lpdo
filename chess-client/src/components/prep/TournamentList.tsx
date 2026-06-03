import { ShortlistEntry } from "../../types";

interface Props {
  entries: ShortlistEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

const kindLabel: Record<ShortlistEntry["kind"], string> = {
  Individual: "Indi",
  Team: "Team",
};

const kindStyle: Record<ShortlistEntry["kind"], string> = {
  Individual: "bg-tertiary-container text-on-tertiary-container",
  Team: "bg-secondary-container text-on-secondary-container",
};

export default function TournamentList({ entries, selectedId, onSelect, onRemove, onAdd }: Props) {
  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="flex items-center justify-between px-3 py-2.5 shrink-0">
        <span className="text-label-md text-on-surface-variant uppercase tracking-wide">Tournaments</span>
        <button
          onClick={onAdd}
          className="w-7 h-7 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 text-label-md transition-colors duration-short3 ease-standard"
          title="Add tournament"
        >+</button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 && (
          <div className="p-4 text-center text-on-surface-variant text-body-sm">
            No tournaments yet.<br />Click + to add one.
          </div>
        )}
        {entries.map((entry) => {
          const selected = selectedId === entry.id;
          return (
            <button
              key={entry.id}
              onClick={() => onSelect(entry.id)}
              className={`w-full text-left px-3 py-2.5 transition-colors duration-short3 ease-standard group ${
                selected
                  ? "bg-secondary-container text-on-secondary-container"
                  : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
              }`}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="text-body-md leading-snug">{entry.name}</span>
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); onRemove(entry.id); }}
                  className={`shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-short3 ease-standard text-label-md leading-none mt-0.5 px-1 ${
                    selected ? "text-on-secondary-container hover:text-error" : "text-on-surface-variant hover:text-error"
                  }`}
                  title="Remove"
                >✕</span>
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={`text-label-sm px-2 h-5 inline-flex items-center rounded-full ${kindStyle[entry.kind]}`}>
                  {kindLabel[entry.kind]}
                </span>
                <span className={`text-body-sm ${selected ? "text-on-secondary-container/80" : "text-on-surface-variant"}`}>
                  {entry.kind === "Team" ? entry.my_team_name : `SNR ${entry.my_snr} · ${entry.my_name}`}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
