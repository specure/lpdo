// Compact database summary used on the Home screen and inside the Maintenance
// dialog. Games, Players, latest TWIC issue (number + import date).
//
// Pass `prominent` on the Home screen for bigger headline-scale numbers.
// The Maintenance dialog has its own full version with path + all 6 counters.

import { StatusInfo } from "../types";
import CountUp from "./CountUp";

interface Props {
  status: StatusInfo | null;
  prominent?: boolean;
  /** Delay number animations to align with a parent rise-in. */
  countStartDelayMs?: number;
  /** Show the hardcoded "Latest TWIC issue" tile. Off on the Home screen, where
   *  the per-source SourceUpdates list covers all feeds instead (#176). */
  showFeedTile?: boolean;
}

export default function DatabaseStats({
  status, prominent = false, countStartDelayMs = 0, showFeedTile = true,
}: Props) {
  if (!status) {
    return <p className="text-body-sm text-on-surface-variant">Server offline — statistics unavailable.</p>;
  }

  // Prefer TWIC's own publication date; fall back to our import timestamp until a
  // `download` has backfilled published_at. Format "2026-06-15T…" → "2026-06-15".
  const lastDate = status.last_twic_published ?? status.last_twic_imported ?? null;
  const lastImported = lastDate ? lastDate.slice(0, 10) : null;

  // Two presentations: dense (Maintenance dialog) vs prominent (Home banner).
  const numberClass = prominent
    ? "text-headline-sm font-mono text-on-surface mt-1"
    : "text-body-md font-mono text-on-surface mt-0.5";
  const tilePadding = prominent ? "px-4 py-3" : "px-3 py-2";

  // Per-tile hover wash, each tile lights up in its own M3 role colour —
  // mirrors the personal-stats widget so both card sections behave the same.
  // The order (primary / tertiary / secondary) matches the personal-stats row,
  // creating a visual rhyme between the two sections.
  const tileBase = `bg-surface-container rounded-md ${tilePadding} transition-colors duration-short3 ease-standard`;
  const gamesTile  = `${tileBase} hover:bg-primary-container/40`;
  const playersTile = `${tileBase} hover:bg-tertiary-container/40`;
  const twicTile   = `${tileBase} hover:bg-secondary-container/40`;

  return (
    <div className={`grid gap-2 ${showFeedTile ? "grid-cols-3" : "grid-cols-2"}`}>
      <div className={gamesTile}>
        <div className="text-label-sm text-on-surface-variant uppercase tracking-wider">Games</div>
        <div className={numberClass}><CountUp value={status.games} startDelayMs={countStartDelayMs} /></div>
      </div>
      <div className={playersTile}>
        <div className="text-label-sm text-on-surface-variant uppercase tracking-wider">Players</div>
        <div className={numberClass}><CountUp value={status.players} startDelayMs={countStartDelayMs} /></div>
      </div>
      {showFeedTile && (
        <div className={twicTile}>
          <div className="text-label-sm text-on-surface-variant uppercase tracking-wider">Latest TWIC issue</div>
          <div className={numberClass}>
            {status.last_twic_issue != null ? (
              <>
                {/* An issue number is an identifier, not a tally — fade it in
                    plainly (no thousands separator, no count-up from zero). */}
                #<CountUp value={status.last_twic_issue} plain mode="fade" startDelayMs={countStartDelayMs} />
                {lastImported && (
                  <span className="text-label-sm text-on-surface-variant font-sans ml-2">({lastImported})</span>
                )}
              </>
            ) : (
              <span className="text-on-surface-variant">—</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
