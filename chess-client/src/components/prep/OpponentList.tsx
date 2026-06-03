import { LikelyOpponent, PlayerInfo } from "../../types";

interface Props {
  opponents: LikelyOpponent[];
  onSelectPlayer: (player: PlayerInfo) => void;
}

async function resolvePlayer(opponent: LikelyOpponent): Promise<PlayerInfo> {
  try {
    const params = new URLSearchParams({ name: opponent.name.trim(), limit: "5" });
    const res = await fetch(`/api/players?${params}`);
    if (res.ok) {
      const players: PlayerInfo[] = await res.json();
      if (players.length > 0) return players[0];
    }
  } catch {
    // fall through to synthetic
  }
  // Not in local DB — use fide_id if available
  return { id: 0, name: opponent.name, fide_id: opponent.fide_id, game_count: 0 };
}

function fmt(n: number | null, decimals = 0) {
  if (n === null) return "—";
  return n.toFixed(decimals);
}

interface RowProps {
  rank: number;
  opponent: LikelyOpponent;
  onSelect: () => void;
}

function OpponentRow({ rank, opponent, onSelect }: RowProps) {
  return (
    <button
      onClick={onSelect}
      className="w-full text-left px-3 py-2 text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-on-surface-variant text-body-sm w-5 shrink-0 text-right">{rank}.</span>
        <span className="flex-1 text-body-md truncate">
          {opponent.name}
        </span>
        <span className="text-on-surface-variant text-body-sm shrink-0">
          {opponent.rating ? `(${opponent.rating})` : ""}
        </span>
        <span className="text-warning text-label-md w-10 text-right shrink-0">
          {fmt(opponent.probability, 0)}%
        </span>
      </div>
      <div className="flex items-baseline gap-2 mt-0.5 pl-7">
        {opponent.tournament_points !== null && (
          <span className="text-on-surface-variant text-body-sm">{opponent.tournament_points} pts</span>
        )}
        {opponent.performance !== null && opponent.performance > 0 && (
          <span className="text-on-surface-variant text-body-sm">perf {opponent.performance}</span>
        )}
        {opponent.fide_id && (
          <span className="text-on-surface-variant text-body-sm">FIDE {opponent.fide_id}</span>
        )}
      </div>
    </button>
  );
}

export default function OpponentList({ opponents, onSelectPlayer }: Props) {
  if (opponents.length === 0) {
    return (
      <div className="p-4 text-center text-on-surface-variant text-body-sm">
        No historical data yet. Run again after round 1 is played.
      </div>
    );
  }

  async function handleSelect(opponent: LikelyOpponent) {
    const player = await resolvePlayer(opponent);
    onSelectPlayer(player);
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-3 py-2 text-label-sm text-on-surface-variant uppercase tracking-wide">
        Likely opponents
      </div>
      {opponents.map((opp, i) => (
        <OpponentRow
          key={opp.snr}
          rank={i + 1}
          opponent={opp}
          onSelect={() => handleSelect(opp)}
        />
      ))}
    </div>
  );
}
