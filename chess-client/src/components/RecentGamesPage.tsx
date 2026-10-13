// Recent games (#90): one's games of the last days — over the board and
// online, one's linked handles' too — each with how it stood to the
// repertoire: the chapters it went into (one per book, several when the
// books overlap; a book it only started is not listed), and where one or
// the opponent deviated in each. A chapter puts
// itself on the Repertoire page's board where the game left it; Open puts
// the game on the Analysis board. The same as a chapter's own-games list,
// for every game of the day at once.

import { useEffect, useState } from "react";
import { SCOPES, TIME_CLASSES, getRecentGames, platformName, timeControlLabel, type RecentGame, type RecentGames, type Scope, type TimeClass } from "../lib/accounts";
import type { LineMatch } from "../lib/repertoire";
import { currentMyPlayer } from "./MyStatsWidget";
import { PlatformBadge } from "./AccountsSection";
import type { GameSummary, PlayerInfo } from "../types";

interface Props {
  /** Put a chapter on the Repertoire page's board at a position, in the
   *  variation the game's moves took. */
  onOpenChapter: (chapterId: number, key: string, moves: string[]) => void;
  /** Open games on the Analysis board. */
  onOpenGame: (games: GameSummary[]) => Promise<number>;
}

const DAYS = [1, 3, 7, 30] as const;
const DAYS_KEY = "lpdoRecentDays";
const SCOPE_KEY = "lpdoRecentScope";
const read = <T,>(key: string, ok: (v: string) => T | null, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? (ok(v) ?? fallback) : fallback; } catch { return fallback; }
};
const keep = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* per-device convenience only */ } };

const summary = (g: RecentGame): GameSummary => ({
  id: g.id, white: g.white, black: g.black, white_elo: g.white_elo, black_elo: g.black_elo,
  event: g.event, date: g.date, result: g.result, eco: null, move_count: null, opening_line: null,
});

/** The chapters a game went into, to list — as far as it went in each,
 *  deepest first, as the server has them — the books it only started
 *  (`left_book`) left out as noise. */
function chaptersOf(g: RecentGame): LineMatch[] {
  return g.matches.filter((m) => !m.left_book);
}

type Tone = "good" | "bad" | "muted" | "plain";
const TONE: Record<Tone, string> = { good: "text-success", bad: "text-error", muted: "text-on-surface-variant", plain: "" };

/** "5...Nxd5": the move that brought the line to `ply` half-moves. */
const moveAt = (moves: string[], ply: number) =>
  `${Math.floor((ply - 1) / 2) + 1}${(ply - 1) % 2 ? "..." : "."}${moves[ply - 1] ?? ""}`;

/** How the game (its `moves`) stood to a chapter, in words — to the
 *  repertoire, with no chapter. */
function verdict(m: LineMatch | undefined, moves: string[]): { text: string; tone: Tone } {
  if (!m) return { text: "Not in the repertoire", tone: "muted" };
  // Where the line left, the chapter's move there: "Book move: 4.d4".
  const has = m.book_has ?? [];
  const book = has.length ? ` Book move${has.length > 1 ? "s" : ""}: ${has.join(", ")}` : "";
  if (m.followed === "left") {
    return m.left_by === "you"
      ? { text: `You deviated at ${m.move ?? "?"}.${book}`, tone: "bad" }
      : { text: `Opponent deviated at ${m.move ?? "?"}.${book}`, tone: "plain" };
  }
  // To the end of the chapter's line, or the game's: the last move in the book.
  const last = m.ply > 0 ? ` Last book move: ${moveAt(moves, m.ply)}` : "";
  return { text: `${m.followed === "ended" ? "The game ended in the book." : "In book to the end."}${last}`, tone: "good" };
}

export default function RecentGamesPage({ onOpenChapter, onOpenGame }: Props) {
  const [days, setDays] = useState<number>(() => read(DAYS_KEY, (v) => (DAYS as readonly number[]).includes(Number(v)) ? Number(v) : null, 7));
  const [scope, setScope] = useState<Scope>(() => read(SCOPE_KEY, (v) => SCOPES.some((s) => s.id === v) ? (v as Scope) : null, "all"));
  const [classes, setClasses] = useState<Set<TimeClass>>(() => new Set(TIME_CLASSES));
  const [me, setMe] = useState<PlayerInfo | null | undefined>(undefined);
  const [data, setData] = useState<RecentGames | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { void currentMyPlayer().then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => {
    if (!me) return;
    let gone = false;
    setLoading(true);
    setError(null);
    getRecentGames(me.id, days, scope)
      .then((d) => { if (!gone) setData(d); })
      .catch((e: unknown) => { if (!gone) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!gone) setLoading(false); });
    return () => { gone = true; };
  }, [me, days, scope]);

  const pickDays = (d: number) => { setDays(d); keep(DAYS_KEY, String(d)); };
  const pickScope = (s: Scope) => { setScope(s); keep(SCOPE_KEY, s); };
  const toggleClass = (c: TimeClass) => setClasses((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c); else next.add(c);
    return next;
  });

  // The classes among the games, and the games shown: a game without a
  // class (an over-the-board game from a PGN without the tag) always.
  const present = new Set((data?.games ?? []).map((g) => g.time_class).filter((c): c is TimeClass => !!c));
  const shown = (data?.games ?? []).filter((g) => !g.time_class || classes.has(g.time_class));
  // The tally counts each game once, by the chapter it went deepest into.
  const tally = shown.reduce((t, g) => {
    const m = chaptersOf(g)[0];
    if (!m) t.out++;
    else if (m.followed !== "left") t.inBook++;
    else if (m.left_by === "you") t.you++;
    else t.opp++;
    if (g.score === 1) t.w++; else if (g.score === 0.5) t.d++; else if (g.score === 0) t.l++;
    return t;
  }, { inBook: 0, you: 0, opp: 0, out: 0, w: 0, d: 0, l: 0 });

  const chip = (on: boolean) => `h-7 px-2.5 rounded-full text-label-md border ${on ? "bg-secondary-container text-on-secondary-container border-transparent" : "text-on-surface-variant border-outline/40 hover:bg-on-surface/8"}`;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 px-4 py-3 border-b border-outline/40 flex items-center gap-3 flex-wrap">
        <h2 className="text-title-md text-on-surface">Recent games</h2>
        <div className="inline-flex rounded-full border border-outline/40 overflow-hidden" role="group" aria-label="Days">
          {DAYS.map((d) => (
            <button key={d} onClick={() => pickDays(d)} className={`h-8 px-3 text-label-md ${days === d ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-on-surface/8"}`}>
              {d === 1 ? "Today" : d === 3 ? "3 days" : d === 7 ? "Week" : "Month"}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-full border border-outline/40 overflow-hidden" role="group" aria-label="Which games">
          {SCOPES.map((s) => (
            <button key={s.id} onClick={() => pickScope(s.id)} className={`h-8 px-3 text-label-md ${scope === s.id ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-on-surface/8"}`}>
              {s.label}
            </button>
          ))}
        </div>
        {present.size > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {TIME_CLASSES.filter((c) => present.has(c)).map((c) => (
              <button key={c} onClick={() => toggleClass(c)} className={chip(classes.has(c))} aria-pressed={classes.has(c)}>{c}</button>
            ))}
          </div>
        )}
        {data && (
          <div className="ml-auto text-label-md text-on-surface-variant tabular-nums" title="In book to the end · you deviated · the opponent deviated · not in the repertoire">
            {shown.length} {shown.length === 1 ? "game" : "games"} · <span className="text-success">+{tally.w}</span> ={tally.d} <span className="text-error">−{tally.l}</span>
            <span className="ml-3">{tally.inBook} in book · <span className="text-error">{tally.you} you deviated</span> · {tally.opp} opponent deviated · {tally.out} outside</span>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {me === null ? (
          <p className="p-4 text-body-md text-on-surface-variant">Set your player on the Home page to see your games here.</p>
        ) : error ? (
          <p className="p-4 text-body-md text-error">{error}</p>
        ) : !data || (loading && data.days !== days) ? (
          <p className="p-4 text-body-md text-on-surface-variant">Looking up your games…</p>
        ) : shown.length === 0 ? (
          <p className="p-4 text-body-md text-on-surface-variant">
            No games of yours since {data.since}{scope !== "all" ? ` (${SCOPES.find((s) => s.id === scope)?.label.toLowerCase()})` : ""}.
            Online games come in with the daily update, or with <i>Sync now</i> on the Maintenance page, Online accounts.
          </p>
        ) : (
          <table className="w-full text-body-sm">
            <thead className="sticky top-0 bg-surface text-label-sm text-on-surface-variant">
              <tr className="text-left">
                <th className="px-4 py-1.5 font-normal">Date</th>
                <th className="px-2 py-1.5 font-normal"></th>
                <th className="px-2 py-1.5 font-normal">Players</th>
                <th className="px-2 py-1.5 font-normal">Game</th>
                <th className="px-2 py-1.5 font-normal">Chapter</th>
                <th className="px-2 py-1.5 font-normal">Repertoire</th>
                <th className="px-2 py-1.5 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => {
                // The chapters it went into; a row opens the first, a
                // chapter's name its own.
                const ms = chaptersOf(g);
                const first = ms[0];
                const canOpen = (m: LineMatch | undefined): m is LineMatch => !!m;
                const open = (m: LineMatch | undefined) => { if (canOpen(m)) onOpenChapter(m.chapter_id, m.at_key, g.moves); };
                return (
                  <tr key={g.id}
                    className={`border-t border-outline/20 align-top ${canOpen(first) ? "cursor-pointer hover:bg-on-surface/5" : ""}`}
                    onClick={() => open(first)}
                    title={canOpen(first) ? "The chapter on the board where the game left it" : undefined}>
                    <td className="px-4 py-1.5 whitespace-nowrap text-on-surface-variant">{g.date ?? "?"}</td>
                    <td className={`px-2 py-1.5 font-semibold tabular-nums ${g.score === 1 ? "text-success" : g.score === 0 ? "text-error" : "text-on-surface-variant"}`}>
                      {g.score === 1 ? "1" : g.score === 0.5 ? "½" : g.score === 0 ? "0" : "·"}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {g.white}{g.white_elo ? <span className="text-on-surface-variant"> ({g.white_elo})</span> : null}
                      <span className="text-on-surface-variant"> - </span>
                      {g.black}{g.black_elo ? <span className="text-on-surface-variant"> ({g.black_elo})</span> : null}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {g.time_control
                        ? <span className="text-on-surface-variant" title={g.time_class ?? undefined}>{timeControlLabel(g.time_control)}</span>
                        : <span className="text-on-surface-variant">{g.time_class ?? g.event ?? ""}</span>}
                      {g.platform && <span className="ml-1.5"><PlatformBadge platform={g.platform} /></span>}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {ms.length === 0 ? <span className="text-on-surface-variant">—</span> : ms.map((m) => (
                        <div key={m.chapter_id}
                          className={canOpen(m) && m !== first ? "cursor-pointer hover:underline" : undefined}
                          onClick={m !== first ? (e) => { e.stopPropagation(); open(m); } : undefined}
                          title={canOpen(m) && m !== first ? "This chapter on the board where the game left it" : undefined}>
                          {m.chapter_name}<span className="text-label-sm text-on-surface-variant"> · {m.book_name}</span>
                        </div>
                      ))}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {ms.length === 0 ? <div className={TONE.muted}>{verdict(undefined, g.moves).text}</div> : ms.map((m) => {
                        const v = verdict(m, g.moves);
                        return <div key={m.chapter_id} className={TONE[v.tone]}>{v.text}</div>;
                      })}
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      <button onClick={(e) => { e.stopPropagation(); void onOpenGame([summary(g)]); }}
                        className="h-7 px-2.5 rounded-full text-label-md text-primary hover:bg-primary/8" title="The game on the Analysis board">Open</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {data && data.games.some((g) => g.platform) && (
        <div className="shrink-0 px-4 py-1.5 border-t border-outline/40 text-label-sm text-on-surface-variant">
          Online games are those of your linked accounts ({[...new Set(data.games.map((g) => g.platform).filter(Boolean))].map(platformName).join(", ")}); the chapters' own game lists on the Repertoire page count them too.
        </div>
      )}
    </div>
  );
}
