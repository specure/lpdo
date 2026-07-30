import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import PlayerList from "./components/PlayerList";
import GameBoard from "./components/GameBoard";
import SetupWizard from "./components/SetupWizard";
import MaintenancePanel from "./components/MaintenancePanel";
import AddGameDialog from "./components/AddGameDialog";
import PrepView from "./components/prep/PrepView";
import PrepPlayerList from "./components/prep/PrepPlayerList";
import DirectoryBrowser from "./components/local/DirectoryBrowser";
import LocalGameList from "./components/local/LocalGameList";
import GamesPage from "./components/GamesPage";
import AnalysisPage, { AnalysisTab } from "./components/AnalysisPage";
import { loadGamePgn } from "./lib/useGamePgn";
import HomeEmptyState from "./components/HomeEmptyState";
import UpdateBanner from "./components/UpdateBanner";
import ActivityIndicator from "./components/ActivityIndicator";
import { loadMyPlayer } from "./components/MyStatsWidget";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { GameSummary, LocalGame, PlayerInfo, PrepContext, StatusInfo } from "./types";

type ServerStatus = "checking" | "connected" | "disconnected";

// Status polling cadence: the displayed numbers (games / players / TWIC count)
// change after explicit user actions (imports, dedup, purge), not on a tick —
// so polling every few seconds is wasted work. 30 minutes catches drift after
// long sessions while keeping the heartbeat indicator meaningfully responsive.
const STATUS_POLL_INTERVAL_MS = 30 * 60 * 1000;

function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus>("checking");
  const [info, setInfo] = useState<StatusInfo | null>(null);
  // Holds the latest `check` closure so callers (e.g. dialog onClose handlers)
  // can trigger an out-of-band refresh without waiting for the next 30-min tick.
  const checkRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) throw new Error();
        const data: StatusInfo = await res.json();
        if (!cancelled) { setStatus("connected"); setInfo(data); }
      } catch {
        if (!cancelled) { setStatus("disconnected"); setInfo(null); }
      }
    }

    checkRef.current = check;
    check();
    const interval = setInterval(check, STATUS_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Stable identity so consumers can safely include `refresh` in dep arrays.
  const refresh = useCallback(() => { checkRef.current(); }, []);

  return { status, info, refresh };
}

function StatusBadge({ status }: { status: ServerStatus }) {
  // M3 assist chip — tonal container surface, no border, label-md type.
  // The game count moved to the Home screen's database card; the badge now
  // just signals reachability.
  const styles: Record<ServerStatus, string> = {
    checking: "bg-warning-container text-on-warning-container",
    connected: "bg-success-container text-on-success-container",
    disconnected: "bg-error-container text-on-error-container",
  };
  const dots: Record<ServerStatus, string> = {
    checking: "bg-warning animate-pulse",
    connected: "bg-success",
    disconnected: "bg-error",
  };
  const label: Record<ServerStatus, string> = {
    checking: "Connecting…",
    connected: "Online",
    disconnected: "Server offline",
  };

  return (
    <span className={`inline-flex items-center gap-2 h-7 px-3 rounded-full text-label-md ${styles[status]}`}>
      <span className={`w-2 h-2 rounded-full ${dots[status]}`} />
      {label[status]}
    </span>
  );
}

const FONT_STEPS = [1, 1.25, 1.5, 1.75, 2];

function useFontScale() {
  const [step, setStep] = useState(() => {
    const saved = localStorage.getItem("fontStep");
    return saved !== null ? Number(saved) : 0;
  });

  useEffect(() => {
    const scale = FONT_STEPS[step];
    document.documentElement.style.fontSize = `${scale * 16}px`;
    localStorage.setItem("fontStep", String(step));
  }, [step]);

  return { step, setStep, max: FONT_STEPS.length - 1 };
}

function useHighContrast() {
  const [hc, setHc] = useState(() => localStorage.getItem("hc") === "1");
  return { hc, toggle: () => setHc((v) => { localStorage.setItem("hc", v ? "0" : "1"); return !v; }) };
}

type Scheme = "dark" | "light";

function initialScheme(): Scheme {
  const saved = localStorage.getItem("colorScheme");
  if (saved === "light" || saved === "dark") return saved;
  // First run — follow the OS preference. Tauri's webview honours this too.
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light" : "dark";
}

function useColorScheme() {
  const [scheme, setScheme] = useState<Scheme>(initialScheme);
  useEffect(() => { localStorage.setItem("colorScheme", scheme); }, [scheme]);
  return { scheme, toggle: () => setScheme((s) => s === "dark" ? "light" : "dark") };
}

const RECENT_PLAYERS_KEY = "recentPlayers";
const RECENT_PLAYERS_MAX = 8;

function useRecentPlayers() {
  const [recent, setRecent] = useState<PlayerInfo[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_PLAYERS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  function add(player: PlayerInfo) {
    // Skip synthetic stub players (id===0 means "not in DB"); they'd be unselectable later.
    if (player.id === 0) return;
    setRecent((prev) => {
      const next = [player, ...prev.filter((p) => p.id !== player.id)].slice(0, RECENT_PLAYERS_MAX);
      localStorage.setItem(RECENT_PLAYERS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function remove(id: number) {
    setRecent((prev) => {
      const next = prev.filter((p) => p.id !== id);
      localStorage.setItem(RECENT_PLAYERS_KEY, JSON.stringify(next));
      return next;
    });
  }

  return { recent, add, remove };
}

/** Re-resolve a (possibly stale) player against the current DB by a STABLE key —
 *  fide_id when known, else exact name. Recent players persist a surrogate `id`
 *  that a purge+reimport invalidates (the same person gets a new id), so trusting
 *  it would open a different player's games. Returns the current player row, or
 *  null if that person is no longer in the database. */
async function resolveCurrentPlayer(p: PlayerInfo): Promise<PlayerInfo | null> {
  try {
    const url = p.fide_id != null
      ? `/api/players?fide_id=${p.fide_id}`
      : `/api/players?name=${encodeURIComponent(p.name)}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const list = (await resp.json()) as PlayerInfo[];
    return p.fide_id != null
      ? (list[0] ?? null)
      : (list.find((x) => x.name === p.name) ?? null);
  } catch {
    return null;
  }
}

const RECENT_PGN_KEY = "recentPgnFiles";
const RECENT_PGN_MAX = 8;

interface RecentPgnFile {
  path: string;
  gameCount: number;
}

function useRecentPgnFiles() {
  const [recent, setRecent] = useState<RecentPgnFile[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_PGN_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  function add(path: string, gameCount: number) {
    if (!path || gameCount <= 0) return;
    setRecent((prev) => {
      // Avoid an unnecessary write when the entry is already at the head with
      // the same count — prevents a localStorage write on every onGameCount tick.
      if (prev[0]?.path === path && prev[0]?.gameCount === gameCount) return prev;
      const next = [
        { path, gameCount },
        ...prev.filter((r) => r.path !== path),
      ].slice(0, RECENT_PGN_MAX);
      localStorage.setItem(RECENT_PGN_KEY, JSON.stringify(next));
      return next;
    });
  }

  return { recent, add };
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export default function App() {
  const { status, info, refresh: refreshServerStatus } = useServerStatus();
  const { step, setStep, max } = useFontScale();
  const { hc, toggle: toggleHc } = useHighContrast();
  const { scheme, toggle: toggleScheme } = useColorScheme();
  const { show: showUpdate, state: updateState, dismiss: dismissUpdate } = useUpdateCheck(info);
  const { recent: recentPlayers, add: addRecentPlayer, remove: removeRecentPlayer } = useRecentPlayers();
  const { recent: recentPgnFiles, add: addRecentPgnFile } = useRecentPgnFiles();
  const playerSearchRef = useRef<HTMLInputElement | null>(null);
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerInfo | null>(null);
  // Additional players Ctrl/Cmd-clicked alongside the anchor (for merging two).
  const [selectedExtras, setSelectedExtras] = useState<PlayerInfo[]>([]);
  const [playersCollapsed, setPlayersCollapsed] = useState(false);

  // Analysis board (#220): several games open at once as mini-board tabs.
  const [analysisTabs, setAnalysisTabs] = useState<AnalysisTab[]>([]);
  const [activeAnalysisKey, setActiveAnalysisKey] = useState<string | null>(null);
  async function openInAnalysis(game: GameSummary) {
    const key = `g${game.id}`;
    setActiveAnalysisKey(key);
    setMode("analysis");
    if (analysisTabs.some((t) => t.key === key)) return;   // already open → just focus
    try {
      const loaded = await loadGamePgn(game.id);
      setAnalysisTabs((prev) => (prev.some((t) => t.key === key) ? prev : [...prev, { key, game, loaded, ply: 0 }]));
    } catch { /* load failure → tab simply doesn't appear */ }
  }
  function closeAnalysisTab(key: string) {
    setAnalysisTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      setActiveAnalysisKey((cur) => (cur === key ? next[next.length - 1]?.key ?? null : cur));
      return next;
    });
  }
  // Persist open Analysis tabs across restarts. We store just the game summaries
  // + active tab; the parsed PGN (loaded) is re-fetched on restore. Edits persist
  // via the DB (saved on Done/switch); in-progress unsaved edits are not restored.
  const analysisRestored = useRef(false);
  useEffect(() => {
    const raw = localStorage.getItem("analysisTabs");
    let persisted: { tabs: { key: string; game: GameSummary }[]; activeKey: string | null } | null = null;
    try { persisted = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    if (!persisted?.tabs?.length) { analysisRestored.current = true; return; }
    Promise.all(persisted.tabs.map(async (p) => {
      try { return { key: p.key, game: p.game, loaded: await loadGamePgn(p.game.id), ply: 0 } as AnalysisTab; }
      catch { return null; }
    })).then((results) => {
      const tabs = results.filter((t): t is AnalysisTab => t !== null);
      setAnalysisTabs(tabs);
      const wanted = persisted!.activeKey;
      setActiveAnalysisKey(wanted && tabs.some((t) => t.key === wanted) ? wanted : tabs[0]?.key ?? null);
      analysisRestored.current = true;
    });
  }, []);
  useEffect(() => {
    if (!analysisRestored.current) return;
    localStorage.setItem("analysisTabs", JSON.stringify({
      tabs: analysisTabs.map((t) => ({ key: t.key, game: t.game })),
      activeKey: activeAnalysisKey,
    }));
  }, [analysisTabs, activeAnalysisKey]);
  const [showSetup, setShowSetup] = useState(false);
  const [showAddGame, setShowAddGame] = useState(false);
  const [mode, setMode] = useState<"home" | "players" | "prep" | "games" | "analysis" | "local" | "maintenance">("home");
  // When set, focuses the player search input on the next render (used so the
  // Home screen's "Search a player" card can switch tabs and focus in one step).
  const [pendingSearchFocus, setPendingSearchFocus] = useState(false);
  const [prepContext, setPrepContext] = useState<PrepContext | null>(null);
  const [localSelectedFile, setLocalSelectedFile] = useState<string | null>(null);
  const [localSelectedGame, setLocalSelectedGame] = useState<LocalGame | null>(null);
  const [localGameCount, setLocalGameCount] = useState<number | null>(null);

  // Open a PGN in the local browser: switch to the PGNs page and select the file.
  // It lands at the top of "recent" via the existing onGameCount → addRecentPgnFile
  // path once it loads. Shared by the file-association open (below).
  const openLocalFile = useCallback((path: string) => {
    setMode("local");
    setLocalSelectedFile(path);
    setLocalSelectedGame(null);
    setLocalGameCount(null);
  }, []);

  // File association (#104/#210): open a .pgn passed on launch (`lpdo file.pgn`,
  // or a double-click), and — while already running — a second launch that the
  // single-instance plugin forwards here as an "open-pgn-file" event.
  useEffect(() => {
    invoke<string | null>("take_launch_file").then((p) => { if (p) openLocalFile(p); }).catch(() => {});
    const unlisten = listen<string>("open-pgn-file", (e) => openLocalFile(e.payload));
    return () => { void unlisten.then((off) => off()); };
  }, [openLocalFile]);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [gameListCollapsed, setGameListCollapsed] = useState(false);
  const [scopePublicOnly, setScopePublicOnly] = useState<boolean>(
    () => localStorage.getItem("scopePublicOnly") === "1",
  );
  const [scopeCollectionId, setScopeCollectionId] = useState<number | null>(() => {
    const v = localStorage.getItem("scopeCollectionId");
    return v && v !== "null" ? Number(v) : null;
  });
  const [scopeIncludeDeleted] = useState<boolean>(
    () => localStorage.getItem("scopeIncludeDeleted") === "1"
  );
  const [collectionsList, setCollectionsList] = useState<{ id: number; name: string; game_count: number }[]>([]);
  // Bumped whenever a game is mutated (soft-delete, restore, future edits) so
  // the GameList re-fetches and reflects the change.
  const [gameMutationKey, setGameMutationKey] = useState(0);
  const onGameMutated = () => setGameMutationKey((k) => k + 1);
  // Bumped after a player merge so the player search list re-fetches.
  const [playerReloadKey] = useState(0);
  useEffect(() => {
    localStorage.setItem("scopePublicOnly", scopePublicOnly ? "1" : "0");
  }, [scopePublicOnly]);
  useEffect(() => {
    localStorage.setItem("scopeCollectionId", scopeCollectionId === null ? "null" : String(scopeCollectionId));
  }, [scopeCollectionId]);
  useEffect(() => {
    localStorage.setItem("scopeIncludeDeleted", scopeIncludeDeleted ? "1" : "0");
  }, [scopeIncludeDeleted]);
  // Load the collection list (used by the player-filter dropdown and "My games").
  // Stable identity so it can be a dep / an event handler.
  const refreshCollections = useCallback(() => {
    fetch("/api/collections").then((r) => r.ok ? r.json() : []).then(setCollectionsList).catch(() => {});
  }, []);
  // Re-fetch on every game mutation so newly-created collections (added via
  // the DetailsPanel "+ Add to collection" chip) appear in the filter list.
  useEffect(() => { refreshCollections(); }, [gameMutationKey, refreshCollections]);


  function handleSelectPlayer(player: PlayerInfo, additive?: boolean) {
    // Ctrl/Cmd-click toggles a second selection without changing the anchor view.
    if (additive && selectedPlayer) {
      if (player.id === selectedPlayer.id) return;
      setSelectedExtras((prev) =>
        prev.some((p) => p.id === player.id)
          ? prev.filter((p) => p.id !== player.id)
          : [...prev, player],
      );
      return;
    }
    // Plain click: this player becomes the anchor; clear any multi-selection.
    setSelectedPlayer(player);
    setSelectedExtras([]);
    addRecentPlayer(player);
  }

  // A recent player carries a persisted (possibly stale) id — re-resolve it to
  // the current DB row before selecting, so a purge+reimport can't make it open a
  // different player's games. Drops the entry if that person is gone.
  async function handleSelectRecent(player: PlayerInfo, additive?: boolean) {
    const fresh = await resolveCurrentPlayer(player);
    if (!fresh) {
      removeRecentPlayer(player.id);
      return;
    }
    if (fresh.id !== player.id) removeRecentPlayer(player.id); // drop the stale entry; handleSelectPlayer re-adds the fresh one
    handleSelectPlayer(fresh, additive);
  }

  // Home "My games" card: open the Players view scoped to the user's own games —
  // their profile player plus the private "My games" collection filter.
  function handleMyGames() {
    const myPlayer = loadMyPlayer();
    const myGames = collectionsList.find((c) => c.name === "My games");
    setScopePublicOnly(false);                              // My games is private
    setScopeCollectionId(myGames ? myGames.id : null);
    if (myPlayer) handleSelectPlayer(myPlayer);
    else setPendingSearchFocus(true);                       // no profile yet → let them pick
    setMode("players");
  }

  function handleShowGameInPlayers(player: PlayerInfo, _game: GameSummary) {
    // Clear any prep-context overlay so the normal Players view shows up and pick
    // the player. (Pre-selecting the specific game is a follow-up once GamesPage
    // accepts an initial selection.)
    setPrepContext(null);
    handleSelectPlayer(player);
    setMode("players");
  }

  // Resolve the pending focus request once Players mode is active and the
  // input is reachable. Runs after commit, so the input is in the live DOM.
  useEffect(() => {
    if (pendingSearchFocus && mode === "players") {
      playerSearchRef.current?.focus();
      setPendingSearchFocus(false);
    }
  }, [pendingSearchFocus, mode]);

  // Entering the Players view with nothing selected: auto-select the most
  // recent player so the board area isn't empty. The recent list on the left
  // stays available for switching; skipped during a prep-context flow.
  useEffect(() => {
    if (mode === "players" && !prepContext && !selectedPlayer && recentPlayers.length > 0) {
      void handleSelectRecent(recentPlayers[0]);
    }
  }, [mode, prepContext, selectedPlayer, recentPlayers]);


  return (
    <div className={`flex flex-col h-screen bg-surface text-on-surface${scheme === "light" ? " light" : ""}${hc ? " hc" : ""}`}>
      {/* Header — M3 Expressive top app bar */}
      <header className="flex items-center justify-between px-4 h-14 bg-surface-container shrink-0">
        <span className="text-title-lg tracking-tight">LPDO</span>
        <div className="flex items-center gap-3">
          {/* Icon buttons — circular with state-layer overlays */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
              className="w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors duration-short3 ease-standard"
              title="Decrease font size"
            >A−</button>
            <button
              onClick={() => setStep((s) => Math.min(max, s + 1))}
              disabled={step === max}
              className="w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors duration-short3 ease-standard"
              title="Increase font size"
            >A+</button>
            <button
              onClick={toggleScheme}
              className="w-8 h-8 inline-flex items-center justify-center rounded-full text-on-surface-variant text-label-md hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
              title={scheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >{scheme === "dark" ? "☀" : "☾"}</button>
            <button
              onClick={toggleHc}
              className={`w-8 h-8 inline-flex items-center justify-center rounded-full transition-colors duration-short3 ease-standard ${
                hc
                  ? "bg-primary text-on-primary"
                  : "text-on-surface-variant hover:bg-on-surface/8 active:bg-on-surface/12"
              }`}
              title="Toggle high contrast"
            >
              {/* Half-filled circle — the standard "contrast" glyph, as a crisp
                  SVG so it's legible at this size (the ◑ character rendered tiny). */}
              <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
              </svg>
            </button>
          </div>

          {/* Segmented mode switcher — outlined pill */}
          <div className="inline-flex items-center h-9 rounded-full border border-outline overflow-hidden">
            {(["home", "players", "prep", "games", "analysis", "local"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-4 h-full text-label-lg transition-colors duration-short3 ease-standard ${
                  mode === m
                    ? "bg-secondary-container text-on-secondary-container"
                    : "text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12"
                }`}
              >
                {m === "home" ? "Home" : m === "players" ? "Players" : m === "prep" ? "Prep" : m === "games" ? "Games" : m === "analysis" ? "Analysis" : "PGNs"}
              </button>
            ))}
          </div>

          {/* Filled button — primary action */}
          <button
            onClick={() => setShowAddGame(true)}
            className="inline-flex items-center h-9 px-4 rounded-full bg-primary text-on-primary text-label-lg hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
            title="Add games to the database — from scratch, paste, or PGN file"
          >+ Add games</button>

          {/* Filled tonal button — secondary action. Toggles the full-screen
              Maintenance view (a mode, not a modal). */}
          <button
            onClick={() => { setMode("maintenance"); refreshServerStatus(); }}
            className={`inline-flex items-center h-9 px-4 rounded-full text-label-lg transition-all duration-short3 ease-standard ${
              mode === "maintenance"
                ? "bg-secondary text-on-secondary"
                : "bg-secondary-container text-on-secondary-container hover:brightness-110"
            }`}
            title="Database maintenance"
          >Maintenance</button>

          {/* A background job finishing (e.g. an onboarding import) can create or
              populate collections and change the game/player counts — refresh the
              collection list and Home tiles so the player-filter dropdown and
              stats don't sit stale until the next 30-min poll. */}
          <ActivityIndicator onSettled={() => { refreshCollections(); refreshServerStatus(); }} />
          <StatusBadge status={status} />
        </div>
      </header>

      {showUpdate && updateState && (
        <UpdateBanner state={updateState} onDismiss={dismissUpdate} />
      )}

      {/* Body */}

      {/* Local view — works without server, always mounted */}
      <div className={mode !== "local" ? "hidden" : "flex flex-1 overflow-hidden"}>
        {/* Files panel — always mounted to preserve directory state */}
        {filesCollapsed && (
          <button
            onClick={() => setFilesCollapsed(false)}
            className="shrink-0 w-6 flex items-start pt-3 justify-center border-r border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            title="Show files"
          >
            <span className="text-xs" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>Files</span>
          </button>
        )}
        <div className={`shrink-0 flex relative ${filesCollapsed ? "hidden" : ""}`} style={{ width: "14rem" }}>
          <div className="flex-1 overflow-hidden flex flex-col">
            <DirectoryBrowser
              selectedFile={localSelectedFile}
              onSelectFile={(path) => { setLocalSelectedFile(path); setLocalSelectedGame(null); setLocalGameCount(null); }}
              recentFiles={recentPgnFiles}
            />
          </div>
          <button
            onClick={() => setFilesCollapsed(true)}
            className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-10 w-5 h-8 flex items-center justify-center rounded bg-zinc-700 border border-zinc-600 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-600 transition-colors text-sm"
            title="Hide files"
          >‹</button>
        </div>

        {/* Game list panel — always mounted so onGameCount fires */}
        {localSelectedFile && (
          <>
            {localGameCount !== 1 && gameListCollapsed && (
              <button
                onClick={() => setGameListCollapsed(false)}
                className="shrink-0 w-6 flex items-start pt-3 justify-center border-r border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                title="Show games"
              >
                <span className="text-xs" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>Games</span>
              </button>
            )}
            <div className={`shrink-0 flex relative ${localGameCount === 1 || gameListCollapsed ? "hidden" : ""}`} style={{ width: "18rem" }}>
              <div className="flex-1 overflow-hidden flex flex-col">
                <LocalGameList
                  filePath={localSelectedFile}
                  selectedId={localSelectedGame?.id ?? null}
                  onSelect={setLocalSelectedGame}
                  onGameCount={(count) => {
                    setLocalGameCount(count);
                    // Track files that actually parsed (count > 0) so the
                    // empty-state chips reflect "files I've successfully opened".
                    if (localSelectedFile) addRecentPgnFile(localSelectedFile, count);
                  }}
                />
              </div>
              <button
                onClick={() => setGameListCollapsed(true)}
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-10 w-5 h-8 flex items-center justify-center rounded bg-zinc-700 border border-zinc-600 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-600 transition-colors text-sm"
                title="Hide games"
              >‹</button>
            </div>
          </>
        )}
        <div className="flex-1 flex overflow-hidden">
          {localSelectedGame ? (
            <GameBoard game={localSelectedGame} pgn={localSelectedGame.pgn} />
          ) : localSelectedFile ? (
            <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md">
              Select a game
            </div>
          ) : recentPgnFiles.length > 0 ? (
            /* No file selected — surface recently opened PGNs as chips. */
            <div className="flex-1 overflow-y-auto bg-surface">
              <div className="max-w-3xl mx-auto px-8 py-12 space-y-3">
                <h2 className="text-label-md text-on-surface-variant uppercase tracking-wider">Recent</h2>
                <div className="flex flex-wrap gap-2">
                  {recentPgnFiles.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => { setLocalSelectedFile(f.path); setLocalSelectedGame(null); setLocalGameCount(null); }}
                      title={f.path}
                      className="inline-flex items-center gap-2 h-9 px-4 rounded-full bg-tertiary-container text-on-tertiary-container text-label-md hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
                    >
                      <span>{basename(f.path)}</span>
                      <span className="text-label-sm opacity-70">
                        {f.gameCount.toLocaleString()} {f.gameCount === 1 ? "game" : "games"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md">
              Browse to a PGN file
            </div>
          )}
        </div>
      </div>

      {/* Home view — server-independent welcome screen */}
      {mode === "home" && (
        <HomeEmptyState
          status={info}
          onMyGames={handleMyGames}
          onSearchPlayer={() => { setMode("players"); setPendingSearchFocus(true); }}
          onOpenTournament={() => setMode("prep")}
          onBrowseLocal={() => setMode("local")}
          onRunWizard={() => setShowSetup(true)}
        />
      )}

      {/* Maintenance view — full-screen, server-status aware. Mutations inside
          re-poll status (and refresh open game lists) via onMutated. */}
      {mode === "maintenance" && (
        <MaintenancePanel
          onRunWizard={() => setShowSetup(true)}
          status={info}
          onMutated={() => { refreshServerStatus(); onGameMutated(); }}
        />
      )}

      {status === "disconnected" && (mode === "players" || mode === "prep" || mode === "games" || mode === "analysis") ? (
        <div className="flex-1 flex items-center justify-center bg-surface-dim">
          {/* M3 outlined card — Expressive uses xl (28px) corners */}
          <div className="max-w-md p-8 rounded-xl bg-surface-container-high text-center space-y-3">
            <div className="text-headline-sm text-on-surface">LPDO server not reachable</div>
            <div className="text-body-md text-on-surface-variant">
              The app connects to the LPDO server, which runs as a background
              service. Make sure it's running — on Linux:{" "}
              <code className="bg-surface-container-highest text-on-surface px-2 py-0.5 rounded-sm">sudo systemctl start lpdo-server</code>
              {" "}— or install the LPDO server if it isn't installed.
            </div>
          </div>
        </div>
      ) : (mode === "players" || mode === "prep") ? (
        <>
          {/* Prep view — always mounted to preserve state, hidden when not active */}
          <div className={mode !== "prep" ? "hidden" : "flex flex-1 overflow-hidden"}>
            <PrepView
              onOpponentsReady={(ctx) => {
                setPrepContext(ctx);
                setMode("players");
              }}
              onShowGame={handleShowGameInPlayers}
            />
          </div>

          {/* Players view — always mounted, hidden when prep is active.
              Read-only analysis layout (#219) scoped to the selected player, with
              a collapsible player list on the left (filters collapse inside it). */}
          <div className={mode === "prep" ? "hidden" : "flex flex-1 overflow-hidden"}>
            {/* Collapsible player list (prep opponents or normal search) */}
            {playersCollapsed ? (
              <button
                onClick={() => setPlayersCollapsed(false)}
                className="w-8 shrink-0 flex flex-col items-center gap-2 pt-3 bg-surface-container-low border-r border-outline/40 text-on-surface-variant hover:text-on-surface hover:bg-on-surface/4 transition-colors duration-short3 ease-standard"
                title="Show players"
              >
                <span className="text-body-md">»</span>
                <span className="text-label-sm uppercase tracking-wider" style={{ writingMode: "vertical-rl" }}>Players</span>
              </button>
            ) : (
              <div className="w-56 shrink-0 overflow-hidden flex flex-col border-r border-outline/40">
                <div className="px-3 py-2 flex items-center justify-between border-b border-outline/40">
                  <span className="text-label-md text-on-surface-variant uppercase tracking-wider">{prepContext ? "Opponents" : "Players"}</span>
                  <button onClick={() => setPlayersCollapsed(true)} className="h-7 px-2 inline-flex items-center rounded-full text-on-surface-variant hover:bg-on-surface/8 text-body-md" title="Hide players">«</button>
                </div>
                {prepContext ? (
                  <PrepPlayerList
                    context={prepContext}
                    onSelectPlayer={handleSelectPlayer}
                    onBack={() => { setPrepContext(null); setMode("prep"); }}
                    onClose={() => setPrepContext(null)}
                  />
                ) : (
                  <PlayerList
                    selectedId={selectedPlayer?.id ?? null}
                    selectedIds={selectedPlayer ? [selectedPlayer.id, ...selectedExtras.map((p) => p.id)] : []}
                    onSelect={handleSelectPlayer}
                    onSelectRecent={handleSelectRecent}
                    inputRef={playerSearchRef}
                    recentPlayers={recentPlayers}
                    onRemoveRecent={removeRecentPlayer}
                    reloadKey={playerReloadKey}
                  />
                )}
              </div>
            )}

            {/* Analysis mosaic scoped to the selected player */}
            {selectedPlayer ? (
              <GamesPage
                player={selectedPlayer}
                scopePublicOnly={scopePublicOnly}
                scopeCollectionId={scopeCollectionId}
                scopeIncludeDeleted={scopeIncludeDeleted}
                onOpenInAnalysis={openInAnalysis}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-md">
                {prepContext ? "Select an opponent to view their games" : "Search for a player"}
              </div>
            )}
          </div>
        </>
      ) : mode === "games" ? (
        <GamesPage
          scopePublicOnly={scopePublicOnly}
          scopeCollectionId={scopeCollectionId}
          scopeIncludeDeleted={scopeIncludeDeleted}
          onOpenInAnalysis={openInAnalysis}
        />
      ) : mode === "analysis" ? (
        <AnalysisPage
          tabs={analysisTabs}
          activeKey={activeAnalysisKey}
          onActivate={setActiveAnalysisKey}
          onClose={closeAnalysisTab}
          onOpenGame={openInAnalysis}
          onGameMutated={onGameMutated}
        />
      ) : null}
      {/* Each of these dialogs can mutate database contents (import/dedup/purge),
          so re-poll status on close so the Home Database section + empty-DB CTA
          reflect the new state without waiting for the 30-min polling tick. */}
      {showSetup && (
        <SetupWizard
          onClose={() => { setShowSetup(false); refreshServerStatus(); }}
          onFinish={() => { setShowSetup(false); refreshServerStatus(); setMode("home"); }}
        />
      )}
      {showAddGame && (
        <AddGameDialog
          onClose={() => { setShowAddGame(false); refreshServerStatus(); }}
          onImported={onGameMutated}
        />
      )}
    </div>
  );
}
