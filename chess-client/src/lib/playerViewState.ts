import { GameSummary, PlayerInfo } from "../types";

// The Players page's view, remembered per player — the colour filters, opponent,
// event and dates, the position line explored under them, and the selected game
// and move — so opening a game in Analysis (which unmounts that view), switching
// players or a restart brings it back. The Games page keeps its own state under
// its own key. Remembered filters show in the Filters panel, so none is hidden.
const KEY = "playerViewState";
const MAX_PLAYERS = 20; // most recently used; older entries are dropped

type Side = "any" | "white" | "black";

export interface PlayerViewState {
  p1Color: Side;
  p2: PlayerInfo | null;
  p2Color: Side;
  event: string;
  dateFrom: string;
  dateTo: string;
  line: string[];
  ply: number;
  selectedGame: GameSummary | null;
  selectedPly: number;
}

/** A player seen for the first time: no filters, nothing explored or selected. */
export const EMPTY_PLAYER_VIEW: PlayerViewState = {
  p1Color: "any",
  p2: null,
  p2Color: "any",
  event: "",
  dateFrom: "",
  dateTo: "",
  line: [],
  ply: 0,
  selectedGame: null,
  selectedPly: 0,
};

type Stored = Record<string, Partial<PlayerViewState> & { at?: number }>;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

const isSide = (v: unknown): v is Side => v === "any" || v === "white" || v === "black";
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);

/** The view last saved for `playerId`, checked field by field — it outlives the
 *  code that wrote it (views saved by 0.17.0 hold only the selected game and move;
 *  the rest falls back to `EMPTY_PLAYER_VIEW`). */
export function loadPlayerViewState(playerId: number): PlayerViewState | null {
  const s = readAll()[String(playerId)];
  if (!s || typeof s !== "object") return null;
  const line = Array.isArray(s.line) && s.line.every((m) => typeof m === "string") ? s.line : [];
  const game = s.selectedGame && typeof s.selectedGame.id === "number" ? s.selectedGame : null;
  return {
    p1Color: isSide(s.p1Color) ? s.p1Color : "any",
    p2: s.p2 && typeof s.p2.id === "number" ? s.p2 : null,
    p2Color: isSide(s.p2Color) ? s.p2Color : "any",
    event: text(s.event),
    dateFrom: text(s.dateFrom),
    dateTo: text(s.dateTo),
    line,
    ply: Math.min(count(s.ply), line.length),
    selectedGame: game,
    selectedPly: game ? count(s.selectedPly) : 0,
  };
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
