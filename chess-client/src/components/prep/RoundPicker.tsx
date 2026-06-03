import { TeamScheduleRound } from "../../types";

interface TeamProps {
  kind: "team";
  schedule: TeamScheduleRound[];
  value: number | null;
  onChange: (round: number) => void;
}

interface IndividualProps {
  kind: "individual";
  currentRound: number;
  onChange: (round: number) => void;
}

type Props = TeamProps | IndividualProps;

export default function RoundPicker(props: Props) {
  if (props.kind === "team") {
    const { schedule, value, onChange } = props;
    if (schedule.length === 0) return null;
    return (
      <div className="flex items-center gap-2">
        <label className="text-label-md text-on-surface-variant shrink-0">Round</label>
        <div className="relative">
          <select
            value={value ?? ""}
            onChange={(e) => onChange(Number(e.target.value))}
            className="appearance-none h-8 pl-3 pr-7 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary cursor-pointer transition-colors duration-short3 ease-standard"
          >
            {schedule.map((r) => (
              <option key={r.round} value={r.round}>
                {r.round}
                {r.date ? ` — ${r.date}` : ""}
                {r.is_played ? " ✓" : ""}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant text-label-sm">▾</span>
        </div>
      </div>
    );
  }

  // Individual: simple number input allowing override
  return (
    <div className="flex items-center gap-2">
      <label className="text-label-md text-on-surface-variant shrink-0">Round</label>
      <input
        type="number"
        value={props.currentRound}
        onChange={(e) => { const v = parseInt(e.target.value, 10); if (v > 0) props.onChange(v); }}
        min={1}
        className="w-16 h-8 px-2 rounded-sm bg-transparent text-on-surface text-body-sm border border-outline focus:outline-none focus:border-primary transition-colors duration-short3 ease-standard"
      />
    </div>
  );
}
