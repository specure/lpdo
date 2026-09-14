import { GameSummary } from "../types";

// Where the user was on the Players page, remembered per player — the selected
// game and move — so opening a game in Analysis (which unmounts that view) or a
// restart doesn't lose it. The Games page keeps its own state under its own key.
// Filters aren't remembered here: a forgotten filter would silently hide some of
// a player's games the next time.
const KEY = "playerViewState";
const MAX_PLAYERS = 20; // most recently used; older entries are dropped

export interface PlayerViewState {
  selectedGame: GameSummary | null;
  selectedPly: number;
}

type Stored = Record<string, PlayerViewState & { at: number }>;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

/** The state last saved for `playerId`, validated — it outlives the code that wrote it. */
export function loadPlayerViewState(playerId: number): PlayerViewState | null {
  const s = readAll()[String(playerId)];
  if (!s || typeof s !== "object") return null;
  const game = s.selectedGame && typeof s.selectedGame.id === "number" ? s.selectedGame : null;
  const ply = Number.isInteger(s.selectedPly) && s.selectedPly > 0 ? s.selectedPly : 0;
  return { selectedGame: game, selectedPly: game ? ply : 0 };
}

export function savePlayerViewState(playerId: number, state: PlayerViewState, now: number = Date.now()) {
  try {
    const all = readAll();
    all[String(playerId)] = { ...state, at: now };
    const kept = Object.entries(all)
      .sort(([, a], [, b]) => (b?.at ?? 0) - (a?.at ?? 0))
      .slice(0, MAX_PLAYERS);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or unavailable — remembering is a convenience, never an error.
  }
}
