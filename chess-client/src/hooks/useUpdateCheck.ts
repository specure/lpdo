import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

// In-app update *check* (notify-only). LPDO is distributed via GitHub Releases
// as a .deb/AppImage (Linux), an NSIS installer (Windows) and a .dmg (macOS) —
// none of which can be auto-replaced from inside the running app without
// breaking dpkg's package database or re-mounting the .app. So instead of
// downloading and installing, we compare the running versions against the latest
// published release and surface a banner with a download link.
//
// Because the server is now a separate (possibly remote) process, we report
// update-availability for BOTH the app and the connected server, using a single
// GitHub fetch. The server's version comes from the API (`GET /status`), so this
// works whether the server is local or on another machine — and it catches a
// server bugfix release even when the API hasn't changed. A separate
// `api_version` guards the one case the version check can't: a client too new
// for a server too old to talk to.

const REPO = "specure/lpdo";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const DISMISS_KEY = "updateDismissedVersion";

// The minimum server API version this client needs. A server reporting a lower
// api_version is too old to work correctly with this app. Bump when the client
// starts relying on a newer server API.
const REQUIRED_SERVER_API = 1;

export interface UpdateState {
  /** A newer published release than the running app. */
  appUpdate: boolean;
  /** A newer published release than the connected server. */
  serverUpdate: boolean;
  /** The server is too old to talk to this client (api_version too low). */
  incompatible: boolean;
  appVersion: string;
  serverVersion: string | null;
  latestVersion: string;
  url: string;
}

// Compare dotted numeric versions: >0 if a is newer than b, <0 if older, 0 equal.
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// "v0.2.0" / "0.2.0-rc1" → "0.2.0" (strip the leading v and any pre-release suffix).
function normalize(tag: string): string {
  return tag.replace(/^v/i, "").split("-")[0].trim();
}

interface ServerVersionInfo {
  version?: string | null;
  api_version?: number | null;
}

/** Checks GitHub Releases once per launch and reports whether a newer published
 *  version exists for the app and/or the connected server. Pass the server's
 *  `/status` (for its version + api_version); update as it changes. Network /
 *  offline / rate-limit failures are swallowed — nothing appears, retry next launch. */
export function useUpdateCheck(server?: ServerVersionInfo | null) {
  const [appVersion, setAppVersion] = useState("");
  const [latest, setLatest] = useState<{ version: string; url: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await getVersion();
        if (!cancelled) setAppVersion(current);
        const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
        if (!res.ok) return;
        const data = await res.json();
        const v = normalize(data.tag_name ?? "");
        if (v && !cancelled) setLatest({ version: v, url: data.html_url || RELEASES_PAGE });
      } catch {
        /* offline or rate-limited — skip silently, try again next launch */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const serverVersion = server?.version ? normalize(server.version) : null;
  const serverApi = server?.api_version ?? null;

  const state: UpdateState | null = useMemo(() => {
    if (!latest) return null;
    return {
      appUpdate: !!appVersion && compareVersions(latest.version, normalize(appVersion)) > 0,
      serverUpdate: !!serverVersion && compareVersions(latest.version, serverVersion) > 0,
      // Only treat a *reported* api_version below the floor as incompatible; an
      // absent one (very old server) is handled by the softer "update" nudge.
      incompatible: serverApi != null && serverApi < REQUIRED_SERVER_API,
      appVersion,
      serverVersion,
      latestVersion: latest.version,
      url: latest.url,
    };
  }, [latest, appVersion, serverVersion, serverApi]);

  // Dismissal is keyed to the latest version, so a newer release re-shows it.
  useEffect(() => {
    if (latest) setDismissed(localStorage.getItem(DISMISS_KEY) === latest.version);
  }, [latest]);

  function dismiss() {
    if (latest) localStorage.setItem(DISMISS_KEY, latest.version);
    setDismissed(true);
  }

  const hasUpdate = !!state && (state.appUpdate || state.serverUpdate);
  // Incompatibility is a hard problem — surface it even after updates are dismissed.
  const show = !!state && (state.incompatible || (hasUpdate && !dismissed));

  return { show, state, dismiss };
}
