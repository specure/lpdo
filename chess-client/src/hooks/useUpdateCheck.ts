import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

// In-app update *check* (notify-only). LPDO is distributed via GitHub Releases
// as a .deb/AppImage (Linux) and an NSIS installer (Windows) — none of which can
// be auto-replaced from inside the running app without breaking dpkg's package
// database (the .deb files live in root-owned /usr). So instead of downloading
// and installing, we just compare the running version against the latest
// published release and surface a banner with a download link. Updating stays a
// manual `apt install ./lpdo_X.deb` (or re-download), which never conflicts with
// the package manager.
//
// `releases/latest` deliberately excludes drafts and pre-releases, so this only
// fires once a release is actually published as Latest — matching how versions
// are cut today.

const REPO = "specure/lpdo";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
// Remembers the version the user dismissed, so the banner stays hidden until a
// newer one ships (a fresh tag clears the dismissal automatically).
const DISMISS_KEY = "updateDismissedVersion";

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
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

// "v0.2.0" / "0.2.0-rc1" → "0.2.0" (strip the tag's leading v and any pre-release suffix).
function normalize(tag: string): string {
  return tag.replace(/^v/i, "").split("-")[0].trim();
}

/** Checks GitHub Releases once per launch and reports whether a newer published
 *  version exists. Network/offline/rate-limit failures are swallowed — the
 *  banner simply doesn't appear, and we retry next launch. */
export function useUpdateCheck() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const currentVersion = await getVersion();
        const res = await fetch(RELEASES_API, {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) return;
        const data = await res.json();
        const latestVersion = normalize(data.tag_name ?? "");
        if (!latestVersion || cancelled) return;

        const available =
          compareVersions(latestVersion, normalize(currentVersion)) > 0;
        setInfo({
          available,
          currentVersion,
          latestVersion,
          url: data.html_url || RELEASES_PAGE,
        });
        if (available) {
          setDismissed(localStorage.getItem(DISMISS_KEY) === latestVersion);
        }
      } catch {
        /* offline or rate-limited — skip silently, try again next launch */
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    if (info) localStorage.setItem(DISMISS_KEY, info.latestVersion);
    setDismissed(true);
  }

  return { show: !!info?.available && !dismissed, info, dismiss };
}
