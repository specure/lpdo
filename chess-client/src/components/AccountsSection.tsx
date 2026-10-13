// Your online accounts (#90), on the Sources page: handles on Lichess and
// Chess.com linked to your player. Their games are synced into the private
// collection "My online games" by the daily update and on request — a handle
// is a player of its own, marked by its platform, and its games count as
// yours in the repertoire. Nothing is sent anywhere: the platforms' public
// game archives are read.

import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getJobs } from "../api";
import {
  PLATFORMS, addAccount, getAccounts, platformName, removeAccount, setAccountEnabled, setAccountFrom, syncAccount, syncAccounts,
  type Account, type Platform,
} from "../lib/accounts";
import { currentMyPlayer } from "./MyStatsWidget";
import type { PlayerInfo } from "../types";

/** A year ago, as a day: the games worth syncing by default. */
const yearAgo = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
};

const when = (iso: string | null) => {
  if (!iso) return "never";
  const d = new Date(iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** The platform's badge by a handle. */
export function PlatformBadge({ platform }: { platform: string | null | undefined }) {
  if (!platform) return null;
  return (
    <span className={`inline-block px-1.5 py-px rounded-sm text-label-sm leading-4 ${platform === "lichess" ? "bg-on-surface/10 text-on-surface" : "bg-success/15 text-success"}`}>
      {platformName(platform)}
    </span>
  );
}

export default function AccountsSection() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  // undefined: not looked up yet; null: no player set on the Home page.
  const [me, setMe] = useState<PlayerInfo | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>("chesscom");
  const [username, setUsername] = useState("");
  const [from, setFrom] = useState<string>(yearAgo);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [unlinking, setUnlinking] = useState<number | null>(null);

  const refresh = useCallback(() => {
    getAccounts().then((a) => { setAccounts(a); setError(null); }).catch((e: unknown) => setError(String(e)));
  }, []);
  useEffect(() => {
    refresh();
    void currentMyPlayer().then(setMe).catch(() => setMe(null));
  }, [refresh]);

  // A sync running: the job list says; the accounts read again when it ends.
  useEffect(() => {
    let stop = false;
    const check = () => getJobs().then((js) => {
      if (stop) return;
      const on = js.some((j) => j.type === "sync_accounts" && (j.status === "running" || j.status === "queued" || j.status === "waiting"));
      setSyncing((prev) => { if (prev && !on) refresh(); return on; });
    }).catch(() => { /* offline — leave as is */ });
    check();
    const id = setInterval(check, 2500);
    return () => { stop = true; clearInterval(id); };
  }, [refresh]);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await f(); refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const link = () => run(async () => {
    if (!me) throw new Error("Set your player on the Home page first.");
    const u = username.trim();
    if (!u) throw new Error("Which username?");
    await addAccount(platform, u, me.id, from || null);
    setUsername("");
    // The new account's games, now — the first sync takes the whole history.
    await syncAccounts();
  });

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-title-sm text-on-surface">Your online accounts</h3>
        <p className="text-label-sm text-on-surface-variant">
          Your games on Chess.com and Lichess, synced into the collection <i>My online games</i> by the daily update and on
          request — new games since the last sync, nothing twice, from the day you set (a year back by default). They count as yours on the Repertoire page and in
          Recent games; they never count in the reference figures. A handle stays a player of its own, marked by its
          platform. Only public games are read; nothing is sent to the platforms.
        </p>
      </div>

      {accounts === null ? (
        <div className="text-body-sm text-on-surface-variant">Loading…</div>
      ) : accounts.length === 0 ? (
        <div className="text-body-sm text-on-surface-variant">No account linked yet.</div>
      ) : (
        <ul className="divide-y divide-outline/30 rounded-md border border-outline/40 bg-surface-container-low">
          {accounts.map((a) => (
            <li key={a.id} className="px-3 py-2 flex items-center gap-3 flex-wrap">
              <PlatformBadge platform={a.platform} />
              <button onClick={() => void openUrl(PLATFORMS.find((p) => p.id === a.platform)?.profile(a.username) ?? "")}
                className="text-body-md text-primary hover:underline" title="The profile on the platform">{a.username}</button>
              <span className="text-label-sm text-on-surface-variant">→ {a.owner_name}</span>
              <span className="text-label-sm text-on-surface-variant tabular-nums">{a.games} {a.games === 1 ? "game" : "games"}</span>
              <span className="text-label-sm text-on-surface-variant" title={a.last_status ?? undefined}>
                synced {when(a.last_sync)}{a.last_status?.startsWith("failed") ? <span className="text-error"> · failed</span> : null}
              </span>
              <label className="flex items-center gap-1 text-label-sm text-on-surface-variant" title="Games from this day on; empty for all of them. An earlier day fetches again from it.">
                from
                <input type="date" defaultValue={a.from_date ?? ""} disabled={busy}
                  onBlur={(e) => { const v = e.target.value || null; if (v !== (a.from_date ?? null)) void run(() => setAccountFrom(a.id, v)); }}
                  className="h-7 px-1 rounded-sm bg-surface-container border border-outline/40 text-label-sm text-on-surface" />
              </label>
              <div className="ml-auto flex items-center gap-2">
                <label className="flex items-center gap-1 text-label-sm text-on-surface-variant" title="Synced by the daily update">
                  <input type="checkbox" checked={a.enabled} disabled={busy} className="accent-primary"
                    onChange={(e) => void run(() => setAccountEnabled(a.id, e.target.checked))} />
                  daily
                </label>
                <button onClick={() => void run(() => syncAccount(a.id))} disabled={busy || syncing}
                  className="h-7 px-2.5 rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 disabled:opacity-50">
                  {syncing ? "Syncing…" : "Sync now"}
                </button>
                {unlinking === a.id ? (
                  <>
                    <button onClick={() => { setUnlinking(null); void run(() => removeAccount(a.id)); }} disabled={busy}
                      className="h-7 px-2.5 rounded-full bg-error text-on-error text-label-md hover:brightness-110">Unlink</button>
                    <button onClick={() => setUnlinking(null)} className="h-7 px-2 rounded-full text-label-md text-on-surface-variant hover:bg-on-surface/8">Keep</button>
                  </>
                ) : (
                  <button onClick={() => setUnlinking(a.id)} disabled={busy} title="Unlink the account; its games stay"
                    className="h-7 px-2 rounded-full text-label-md text-on-surface-variant hover:bg-on-surface/8">Unlink…</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}
          className="h-8 px-2 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface">
          {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username"
          onKeyDown={(e) => { if (e.key === "Enter") void link(); }}
          className="h-8 px-2 w-48 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface" />
        <label className="flex items-center gap-1 text-label-sm text-on-surface-variant" title="Games from this day on; empty for the whole history">
          from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="h-8 px-1 rounded-sm bg-surface-container border border-outline/40 text-body-sm text-on-surface" />
        </label>
        <button onClick={() => void link()} disabled={busy || me === null || !username.trim()}
          title={me === null ? "Set your player on the Home page first" : "Link the account to your player and sync its games"}
          className="h-8 px-3 rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 disabled:opacity-50">
          Link{me ? ` to ${me.name}` : ""}
        </button>
        {accounts && accounts.length > 1 && (
          <button onClick={() => void run(() => syncAccounts())} disabled={busy || syncing}
            className="h-8 px-3 rounded-full bg-secondary-container text-on-secondary-container text-label-md hover:brightness-110 disabled:opacity-50">
            {syncing ? "Syncing…" : "Sync all now"}
          </button>
        )}
      </div>
      {me === null && <p className="text-label-sm text-on-surface-variant">Set your player on the Home page to link an account.</p>}
      {error && <p className="text-body-sm text-error">{error}</p>}
    </section>
  );
}
