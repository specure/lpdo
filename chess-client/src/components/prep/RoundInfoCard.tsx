import { IndividualPrepResult, TeamPrepResult } from "../../types";

interface TeamProps {
  kind: "team";
  result: TeamPrepResult;
}

interface IndividualProps {
  kind: "individual";
  result: IndividualPrepResult;
}

type Props = TeamProps | IndividualProps;

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-on-surface-variant text-label-md w-24 shrink-0">{label}</span>
      <span className="text-on-surface text-body-sm">{value}</span>
    </div>
  );
}

export default function RoundInfoCard(props: Props) {
  if (props.kind === "team") {
    const r = props.result;
    return (
      <div className="bg-surface-container-highest rounded-md p-3 space-y-1.5">
        <div className="text-title-sm text-on-surface mb-2">
          Round {r.round}{r.datetime ? ` — ${r.datetime}` : ""}
        </div>
        <Row label="Matchup" value={`${r.my_team} vs ${r.opponent_team}`} />
        <Row
          label="Your team"
          value={
            <>
              <span className="text-on-surface">{r.my_team}</span>
              {(r.my_team_rank || r.my_elo_avg) && (
                <span className="text-on-surface-variant ml-2">
                  {r.my_team_rank ? `Rank ${r.my_team_rank}` : ""}
                  {r.my_team_rank && r.my_elo_avg ? " · " : ""}
                  {r.my_elo_avg ? `EloAvg ${r.my_elo_avg}` : ""}
                </span>
              )}
            </>
          }
        />
        <Row
          label="Opponent"
          value={
            <>
              <span className="text-on-surface">{r.opponent_team}</span>
              {(r.opp_team_rank || r.opp_elo_avg) && (
                <span className="text-on-surface-variant ml-2">
                  {r.opp_team_rank ? `Rank ${r.opp_team_rank}` : ""}
                  {r.opp_team_rank && r.opp_elo_avg ? " · " : ""}
                  {r.opp_elo_avg ? `EloAvg ${r.opp_elo_avg}` : ""}
                </span>
              )}
            </>
          }
        />
        {r.color && (
          <Row
            label="Your color"
            value={
              <span className={r.color === "White" ? "text-on-surface" : "text-on-surface-variant"}>
                {r.color}
              </span>
            }
          />
        )}
      </div>
    );
  }

  const r = props.result;
  return (
    <div className="bg-surface-container-highest rounded-md p-3 space-y-1.5">
      <div className="text-title-sm text-on-surface mb-2">
        Round {r.round}{r.datetime ? ` — ${r.datetime}` : ""}
      </div>
      {r.opponent_name ? (
        <>
          <Row
            label="Opponent"
            value={
              <>
                <span className="text-on-surface">{r.opponent_name}</span>
                {r.opponent_rating && (
                  <span className="text-on-surface-variant ml-2">({r.opponent_rating})</span>
                )}
              </>
            }
          />
          {r.my_color && (
            <Row
              label="Your color"
              value={
                <span className={r.my_color === "White" ? "text-on-surface" : "text-on-surface-variant"}>
                  {r.my_color}
                </span>
              }
            />
          )}
        </>
      ) : (
        <div className="text-body-sm text-on-surface-variant">Pairing not yet published</div>
      )}
    </div>
  );
}
