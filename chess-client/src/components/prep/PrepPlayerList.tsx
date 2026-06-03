import { LikelyOpponent, PlayerInfo, PrepContext } from "../../types";

interface Props {
  context: PrepContext;
  onSelectPlayer: (player: PlayerInfo) => void;
  onBack: () => void;
  onClose: () => void;
}

async function resolvePlayer(opponent: LikelyOpponent): Promise<PlayerInfo> {
  try {
    // Prefer FIDE ID lookup — immune to name spelling differences
    if (opponent.fide_id) {
      const res = await fetch(`/api/players?fide_id=${opponent.fide_id}`);
      if (res.ok) {
        const players: PlayerInfo[] = await res.json();
        if (players.length > 0) return players[0];
      }
    }
    // Fall back to name search for players without a FIDE ID
    const params = new URLSearchParams({ name: opponent.name.trim(), limit: "5" });
    const res = await fetch(`/api/players?${params}`);
    if (res.ok) {
      const players: PlayerInfo[] = await res.json();
      if (players.length > 0) return players[0];
    }
  } catch {
    // fall through to synthetic
  }
  return { id: 0, name: opponent.name, fide_id: opponent.fide_id, game_count: 0 };
}

function fmt(n: number | null, decimals = 0) {
  if (n === null) return "—";
  return n.toFixed(decimals);
}

export default function PrepPlayerList({ context, onSelectPlayer, onBack, onClose }: Props) {
  async function handleSelect(opponent: LikelyOpponent) {
    const player = await resolvePlayer(opponent);
    onSelectPlayer(player);
  }

  const colorStyle =
    context.color === "White"
      ? "text-on-surface"
      : context.color === "Black"
      ? "text-on-surface-variant"
      : "text-outline";

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div className="px-3 py-2.5 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={onBack}
            className="h-7 px-3 inline-flex items-center rounded-full text-primary text-label-md hover:bg-primary/8 transition-colors duration-short3 ease-standard"
          >
            ← Reconfigure
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 inline-flex items-center justify-center rounded-full text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
            title="Close prep search"
          >✕</button>
        </div>
        <div className="text-title-sm text-on-surface leading-snug truncate">{context.tournamentName}</div>
        <div className="text-body-sm text-on-surface-variant mt-0.5">
          Round {context.round}
          {context.datetime ? ` · ${context.datetime}` : ""}
        </div>
        <div className="text-body-sm text-on-surface-variant mt-0.5 truncate">
          {[
            context.opponentTeam ? `vs ${context.opponentTeam}` : null,
            context.board !== null ? `Board ${context.board}` : null,
          ].filter(Boolean).join(" · ")}
        </div>
        {context.color && (
          <div className={`text-body-sm mt-0.5 ${colorStyle}`}>{context.color}</div>
        )}
      </div>

      {/* Opponent list */}
      <div className="flex-1 overflow-y-auto">
        {context.opponents.length === 0 ? (
          <div className="p-4 text-center text-on-surface-variant text-body-sm">
            No historical data yet.
          </div>
        ) : (
          <>
            <div className="px-3 py-1.5 text-label-sm text-on-surface-variant uppercase tracking-wide">
              Likely opponents
            </div>
            {context.opponents.map((opp, i) => {
              const stats = [
                opp.rating ? `${opp.rating}` : null,
                opp.tournament_points !== null ? `${opp.tournament_points} pts` : null,
                opp.performance !== null && opp.performance > 0 ? `perf ${opp.performance}` : null,
                opp.fide_id ? `FIDE\u00a0${opp.fide_id}` : null,
              ].filter(Boolean).join(" · ");

              return (
                <button
                  key={opp.snr}
                  onClick={() => handleSelect(opp)}
                  className="w-full text-left px-3 py-2 text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-on-surface-variant text-body-sm w-5 shrink-0 text-right">{i + 1}.</span>
                    <span className="flex-1 text-body-md truncate">
                      {opp.name}
                    </span>
                    {opp.probability < 100 && (
                      <span className="text-warning text-label-md shrink-0">
                        {fmt(opp.probability, 0)}%
                      </span>
                    )}
                  </div>
                  {stats && (
                    <div className="mt-0.5 pl-[26px] text-body-sm text-on-surface-variant">{stats}</div>
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
