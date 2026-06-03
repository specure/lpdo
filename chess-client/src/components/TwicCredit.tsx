// Credit + donation nudge for The Week in Chess (TWIC), shown wherever the app
// downloads TWIC data — the wizard's Download step and the Maintenance TWIC tool.
// TWIC is Mark Crowther's free, decades-long labour of love that this feature
// relies on, so we acknowledge it (and link to a possible donation) before the
// first download. The acknowledgement is one-time and persisted.

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

// TWIC homepage (carries the terms + donation/support links). Adjust if a more
// specific donate URL is preferred.
const TWIC_URL = "https://theweekinchess.com/";
const TWIC_ACK_KEY = "twicAcknowledged";

/** "I've read the TWIC credit" flag, persisted so the user confirms once across
 *  the wizard and the Maintenance panel. The setter toggles both ways — unchecking
 *  clears it (and re-gates the download). */
export function useTwicAck(): [boolean, (value: boolean) => void] {
  const [ack, setAck] = useState(() => localStorage.getItem(TWIC_ACK_KEY) === "1");
  function setAcknowledged(value: boolean) {
    if (value) localStorage.setItem(TWIC_ACK_KEY, "1");
    else localStorage.removeItem(TWIC_ACK_KEY);
    setAck(value);
  }
  return [ack, setAcknowledged];
}

export function TwicCredit({ acknowledged, onAcknowledgeChange }: {
  acknowledged: boolean;
  onAcknowledgeChange: (value: boolean) => void;
}) {
  return (
    <div className="bg-surface-container-highest rounded-md p-3 text-body-sm space-y-2">
      <p className="text-on-surface-variant leading-relaxed">
        <span className="text-on-surface">The Week in Chess (TWIC)</span> has been published weekly
        since 1994 by <span className="text-on-surface">Mark Crowther</span> — a free, invaluable
        resource for the chess community that this download relies on. Please review its terms and
        consider a donation to support his work.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => { void openUrl(TWIC_URL); }}
          className="h-8 px-3 inline-flex items-center rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 transition-all duration-short3 ease-standard"
        >
          Visit The Week in Chess →
        </button>
        <label className="flex items-center gap-2 text-on-surface cursor-pointer select-none">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => onAcknowledgeChange(e.target.checked)}
            className="w-4 h-4 accent-primary"
          />
          <span>I've read this</span>
        </label>
      </div>
    </div>
  );
}
