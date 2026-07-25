// Welcome screen — full-bleed when mode === "home". Sections:
//   - hero: LPDO logo + greeting
//   - 3 colour-coded quick-start cards (primary / tertiary / secondary roles)
//   - database stats banner (3 big numbers)
//   - personalised "My profile" widget
//
// M3 Expressive moves: tonal containers per action role, larger 28px/32px
// corners, display-scale typography, asymmetric icon emphasis.

import { useState, useEffect } from "react";
import DatabaseStats from "./DatabaseStats";
import SourceUpdates from "./SourceUpdates";
import MyStatsWidget from "./MyStatsWidget";
import { StatusInfo, Job } from "../types";
import { getStatus, getJobs, resetSetup } from "../api";

interface Props {
  status: StatusInfo | null;
  onMyGames: () => void;
  onSearchPlayer: () => void;
  onOpenTournament: () => void;
  onBrowseLocal: () => void;
  /** Open the Setup Wizard (used by the empty-database CTA). */
  onRunWizard: () => void;
}

// Chessboard glyph for "My games".
const IconBoard = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 12h18M12 3v18" />
  </svg>
);

const IconSearch = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
);

const IconTrophy = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
    <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
    <path d="M4 22h16" />
    <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
    <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
    <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
  </svg>
);

const IconFolder = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

// Sparkle / wand-tip icon for the empty-database CTA.
const IconSparkles = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 2 13.8 8.2 20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
    <path d="M19 14l0.7 2.3 2.3 0.7-2.3 0.7L19 20l-0.7-2.3L16 17l2.3-0.7z" opacity="0.7" />
    <path d="M5 14l0.4 1.6L7 16l-1.6 0.4L5 18l-0.4-1.6L3 16l1.6-0.4z" opacity="0.6" />
  </svg>
);

// ── First-run setup readiness (#40 C4) ────────────────────────────────────────
//
// The wizard's setup runs as a background queue (download → import → dedup →
// index → normalise). The header activity indicator is the detailed view; here
// on Home we surface a single rolled-up state: Preparing… / Ready / (failed →
// Reset). Readiness is polled live (the parent's status only refreshes every
// ~30 min), fast while preparing/failed and slowly once ready.

const PIPELINE_LABELS: Record<string, string> = {
  download: "Downloading sources",
  import: "Importing games",
  fide_refresh: "Updating the FIDE player list",
  resolve_fide: "Fetching FIDE IDs",
  dedup_players: "Merging duplicate players",
  normalise: "Normalising player names",
  dedup_games: "Deduplicating games",
  index_positions: "Building the position index",
};

function useReadiness(initial: StatusInfo | null) {
  const [status, setStatus] = useState<StatusInfo | null>(initial);
  const [active, setActive] = useState<Job[]>([]);
  // Adopt the parent's status until our own poll supersedes it.
  useEffect(() => { setStatus(initial); }, [initial]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const [s, jobs] = await Promise.all([getStatus(), getJobs()]);
        if (stopped) return;
        setStatus(s);
        setActive(jobs.filter((j) => j.status === "running" || j.status === "queued"));
        const fast = s.setup_status === "preparing" || s.setup_status === "failed";
        timer = setTimeout(tick, fast ? 3000 : 20000);
      } catch {
        if (!stopped) timer = setTimeout(tick, 5000);
      }
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);
  return { status, active };
}

function PreparingBanner({ jobs, delayMs }: { jobs: Job[]; delayMs: number }) {
  const running = jobs.find((j) => j.status === "running");
  const label = running ? (PIPELINE_LABELS[running.type] ?? "Working") : "Preparing";
  const pct = running && running.total > 0 ? Math.round((100 * running.value) / running.total) : null;
  return (
    <div
      className="bg-secondary-container text-on-secondary-container rounded-2xl p-6 lpdo-rise-in"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div className="flex items-center gap-5">
        <div className="w-12 h-12 shrink-0 inline-flex items-center justify-center rounded-2xl bg-on-secondary-container/15 text-2xl">
          <span className="animate-spin">⟳</span>
        </div>
        <div className="flex-1">
          <h2 className="text-title-lg mb-1">Preparing your database…</h2>
          <p className="text-body-md opacity-90">
            {label}{pct !== null ? ` — ${pct}%` : ""}
            {jobs.length > 1 ? ` · ${jobs.length} tasks in the queue` : ""}. You can start
            exploring now — newly imported games appear as processing finishes.
          </p>
          <p className="text-label-md opacity-80 mt-1">
            Follow detailed progress from the activity indicator in the header.
          </p>
        </div>
      </div>
    </div>
  );
}

function SetupFailedBanner({ delayMs }: { delayMs: number }) {
  const [resetting, setResetting] = useState(false);
  return (
    <div
      className="bg-error-container text-on-error-container rounded-2xl p-6 lpdo-rise-in"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div className="flex flex-col md:flex-row md:items-center gap-5">
        <div className="flex-1">
          <h2 className="text-title-lg mb-1">Setup didn’t finish</h2>
          <p className="text-body-md opacity-90">
            The initial import was interrupted, so the database may be incomplete. Start over
            with a fresh database — nothing else on your machine is affected. You’ll re-run the
            setup wizard afterwards.
          </p>
        </div>
        <button
          onClick={() => { setResetting(true); resetSetup().catch(() => {}).finally(() => setResetting(false)); }}
          disabled={resetting}
          className="shrink-0 h-11 px-5 rounded-full bg-error text-on-error text-label-lg hover:brightness-110 active:brightness-95 disabled:opacity-50 transition-all duration-short3 ease-standard"
        >
          {resetting ? "Resetting…" : "Reset & start over"}
        </button>
      </div>
    </div>
  );
}

function EmptyDatabaseCta({
  onRunWizard, delayMs,
}: { onRunWizard: () => void; delayMs: number }) {
  // Prominent primary-tinted card so the empty-DB state is the loudest thing on
  // the page — replaces the Database stats section in the same slot.
  return (
    <div
      className="bg-primary text-on-primary rounded-2xl p-6 lpdo-rise-in"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div className="flex flex-col md:flex-row md:items-center gap-5">
        <div className="w-16 h-16 shrink-0 inline-flex items-center justify-center rounded-2xl bg-on-primary/15">
          <IconSparkles />
        </div>
        <div className="flex-1">
          <h2 className="text-title-lg mb-1">Your database is empty</h2>
          <p className="text-body-md opacity-90">
            Run the setup wizard to choose your reference sources — a historical base and the
            live tournament feeds. LPDO then imports and prepares everything in the background.
          </p>
        </div>
        <button
          onClick={onRunWizard}
          className="shrink-0 h-11 px-5 rounded-full bg-on-primary text-primary text-label-lg hover:brightness-95 active:brightness-90 transition-all duration-short3 ease-standard"
        >
          Run setup wizard
        </button>
      </div>
    </div>
  );
}

type Tone = "primary" | "secondary" | "tertiary" | "neutral";

const TONE_CLASSES: Record<Tone, { card: string; iconBg: string }> = {
  primary: {
    card: "bg-primary-container text-on-primary-container",
    iconBg: "bg-primary text-on-primary",
  },
  tertiary: {
    card: "bg-tertiary-container text-on-tertiary-container",
    iconBg: "bg-tertiary text-on-tertiary",
  },
  secondary: {
    card: "bg-secondary-container text-on-secondary-container",
    iconBg: "bg-secondary text-on-secondary",
  },
  neutral: {
    card: "bg-surface-container-highest text-on-surface",
    iconBg: "bg-on-surface/10 text-on-surface",
  },
};

function ActionCard({
  tone, icon, iconHoverClass, title, description, onClick, delayMs,
}: {
  tone: Tone;
  icon: React.ReactNode;
  /** Per-card hover transform on the icon glyph itself
   *  (the plate around it morphs from squircle to circle uniformly). */
  iconHoverClass?: string;
  title: string;
  description: string;
  onClick: () => void;
  /** Stagger offset for the entrance rise-in. */
  delayMs?: number;
}) {
  const t = TONE_CLASSES[tone];
  // M3 Expressive moves:
  //   - card morphs from uniform 32px corners to an asymmetric "speech-bubble"
  //     shape on hover (TL+BR grow to 40px, TR+BL shrink to 12px)
  //   - icon plate morphs from squircle to a perfect circle
  //   - the icon glyph itself gets a per-card transform via iconHoverClass
  //   - everything springs in together with a gentle overshoot
  return (
    <button
      onClick={onClick}
      style={delayMs !== undefined ? { animationDelay: `${delayMs}ms` } : undefined}
      className={`group flex flex-col items-start gap-5 p-6 ${t.card} text-left h-full cursor-pointer
        rounded-2xl
        hover:rounded-tl-[2.5rem] hover:rounded-br-[2.5rem] hover:rounded-tr-md hover:rounded-bl-md
        hover:brightness-110 active:brightness-95
        transition-all duration-medium2 ease-spring
        motion-reduce:transition-none motion-reduce:hover:rounded-2xl
        lpdo-rise-in`}
    >
      {/* Icon plate: 56×56, so rounded-[28px] is a perfect circle without the
          9999px jump. Uses ease-emphasized (no overshoot) — the spring would
          briefly clamp border-radius to 0 on hover-out, looking like a square. */}
      <div className={`w-14 h-14 inline-flex items-center justify-center
        rounded-2xl group-hover:rounded-[28px]
        ${t.iconBg}
        transition-all duration-medium2 ease-emphasized
        motion-reduce:transition-none motion-reduce:group-hover:rounded-2xl`}
      >
        <span className={`inline-flex transition-transform duration-medium2 ease-spring motion-reduce:transition-none ${iconHoverClass ?? ""}`}>
          {icon}
        </span>
      </div>
      <div>
        <div className="text-title-lg mb-1">{title}</div>
        <div className="text-body-md opacity-85">{description}</div>
      </div>
    </button>
  );
}

export default function HomeEmptyState({
  status, onMyGames, onSearchPlayer, onOpenTournament, onBrowseLocal, onRunWizard,
}: Props) {
  // Live first-run readiness (overrides the parent's slow-polled status). The
  // slot below the quick-start cards becomes one of: Preparing… / failed (Reset)
  // / empty (wizard CTA) / Database stats. "offline" (status === null) falls
  // through to DatabaseStats, which handles it.
  const { status: live, active } = useReadiness(status);
  const setupStatus = live?.setup_status;
  const view =
    setupStatus === "preparing" ? "preparing"
    : setupStatus === "failed" ? "failed"
    : live !== null && (setupStatus === "empty" || live.games === 0) ? "empty"
    : "stats";
  // The DB is ready for a profile only when it's populated and not mid-load —
  // i.e. the stats view (excludes preparing/failed/empty and the offline case
  // where `live` is null). Gates the profile picker so it can't dead-end on a
  // name search with no players to match (#122).
  const dbReady = view === "stats" && live !== null;
  // Atmospheric radial glow sourced near the logo's position. Sits on the
  // bg-surface base; the gradient adds a soft primary-tinted halo that the
  // logo emerges from. Subtle enough to feel like ambient lighting.
  return (
    <div
      className="flex-1 overflow-y-auto bg-surface"
      style={{
        backgroundImage:
          "radial-gradient(ellipse 55% 35% at 18% 18%, color-mix(in oklab, var(--color-primary) 5%, transparent), transparent 60%)",
      }}
    >
      <div className="max-w-6xl mx-auto px-8 py-10 space-y-8">

        {/* Hero — LPDO logo beside the greeting (entrance: 0ms) */}
        <div className="flex flex-col md:flex-row items-center md:items-center gap-6 md:gap-10 text-center md:text-left lpdo-rise-in">
          <img
            src="/lpdo-logo.svg"
            alt="LPDO"
            className="h-44 w-auto select-none shrink-0 lpdo-logo-glow"
            draggable={false}
          />
          <div className="space-y-2">
            <h1 className="text-display-sm text-on-surface">Welcome to LPDO</h1>
            <p className="text-body-lg text-on-surface-variant max-w-2xl">
              An open-source chess database.
            </p>
          </div>
        </div>

        {/* Quick-start cards — colour-coded by action role.
            Each icon has its own personality: the magnifier tilts as if peering,
            the trophy lifts up like a podium presentation, the folder pops at
            an angle suggesting it's about to open. Cards rise in 60ms apart. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <ActionCard
            tone="primary"
            icon={<IconBoard />}
            iconHoverClass="group-hover:scale-110"
            title="My games"
            description="Jump to your games in the database — your name with the “My games” collection."
            onClick={onMyGames}
            delayMs={60}
          />
          <ActionCard
            tone="tertiary"
            icon={<IconTrophy />}
            iconHoverClass="group-hover:-rotate-6 group-hover:scale-110"
            title="Prepare for my next game"
            description="Add a chess-results.com tournament and prep against likely opponents."
            onClick={onOpenTournament}
            delayMs={120}
          />
          <ActionCard
            tone="secondary"
            icon={<IconSearch />}
            iconHoverClass="group-hover:-rotate-12 group-hover:scale-110"
            title="Search a player"
            description="Find any player in the database and explore their games and openings."
            onClick={onSearchPlayer}
            delayMs={180}
          />
          <ActionCard
            tone="neutral"
            icon={<IconFolder />}
            iconHoverClass="group-hover:-rotate-6 group-hover:scale-105"
            title="Browse local PGN files"
            description="Open PGN files from your filesystem without touching the database."
            onClick={onBrowseLocal}
            delayMs={240}
          />
        </div>

        {/* Same slot below the quick-start cards: a live readiness banner while
            the first-run pipeline runs, a reset prompt if it failed, the wizard
            CTA when empty, or the Database stats once populated. */}
        {view === "preparing" ? (
          <PreparingBanner jobs={active} delayMs={320} />
        ) : view === "failed" ? (
          <SetupFailedBanner delayMs={320} />
        ) : view === "empty" ? (
          <EmptyDatabaseCta onRunWizard={onRunWizard} delayMs={320} />
        ) : (
          <div
            className="bg-surface-container-highest rounded-2xl p-6 lpdo-rise-in"
            style={{ animationDelay: "320ms" }}
          >
            <h2 className="text-title-md text-on-surface mb-4">Database</h2>
            {/* Games + Players tiles; the per-source "Latest updates" list below
                replaces the old TWIC-only tile so it covers every enabled feed
                (TWIC, Lichess Broadcasts, …) with its last item + games (#176). */}
            <DatabaseStats status={live} prominent countStartDelayMs={320} showFeedTile={false} />
            <SourceUpdates reloadKey={live?.games} />
          </div>
        )}

        {/* My profile widget (entrance: 520ms — 200ms after Database so the
            two bottom sections don't appear simultaneously). Wrapped so the
            rise-in lives on the outer element, not inside MyStatsWidget. */}
        <div className="lpdo-rise-in" style={{ animationDelay: "520ms" }}>
          <MyStatsWidget countStartDelayMs={520} status={live} dbReady={dbReady} />
        </div>

      </div>
    </div>
  );
}
