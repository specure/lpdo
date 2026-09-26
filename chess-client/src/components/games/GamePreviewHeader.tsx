import { GameSummary } from "../../types";

// The header tags of a game, above a preview board: who played, how strong
// they were, how it ended, when and where. Shared by the Analysis page's
// Games tab and the Players/Games page preview, so a previewed game reads the
// same wherever it is shown. Everything comes from the list row already in
// hand — showing it costs no request.

export default function GamePreviewHeader({ game }: { game: GameSummary }) {
  const details = [
    game.result === "1/2-1/2" ? "½-½" : game.result,
    game.date ?? null,
    game.event,
    // "?" and "-" are PGN's ways of saying the round is unknown.
    game.round && !/^[?\-\s]*$/.test(game.round) ? `round ${game.round}` : null,
    game.eco,
  ].filter(Boolean).join(" · ");

  return (
    <span className="min-w-0 flex-1 flex flex-col">
      <span className="truncate text-label-md text-on-surface">
        {game.white}
        {game.white_elo != null && <span className="tabular-nums opacity-70"> ({game.white_elo})</span>}
        {" – "}
        {game.black}
        {game.black_elo != null && <span className="tabular-nums opacity-70"> ({game.black_elo})</span>}
      </span>
      <span className="truncate text-label-sm text-on-surface-variant" title={game.event ?? undefined}>
        {details}
      </span>
    </span>
  );
}
