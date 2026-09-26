import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { apiUrl } from "../api";
import type { UpdateState } from "../hooks/useUpdateCheck";

/** Notify-only strip shown under the top app bar. Covers three cases:
 *  - the server is too old to work with this app (warning, not dismissible);
 *  - a newer release is available for the app and/or the server (dismissible).
 *  Links open the GitHub release page (notes + downloadable installers). */
export default function UpdateBanner({
  state,
  onDismiss,
}: {
  state: UpdateState;
  onDismiss: () => void;
}) {
  if (state.incompatible) {
    return (
      <div className="flex items-center gap-3 px-4 py-2 bg-error-container text-on-error-container shrink-0 text-label-md">
        <span className="w-2 h-2 rounded-full bg-error shrink-0" />
        <span className="flex-1 min-w-0 truncate">
          The LPDO server ({state.serverVersion ?? "unknown"}) is too old for this app and may not
          work correctly — update or restart the server.
        </span>
        <Link url={state.url} label="Details" />
      </div>
    );
  }

  // A newer release exists for the app and/or the server.
  let message: string;
  if (state.appUpdate && state.serverUpdate) {
    message = `LPDO ${state.latestVersion} is available — app ${state.appVersion}, server ${state.serverVersion}.`;
  } else if (state.serverUpdate) {
    message = `A newer LPDO server (${state.latestVersion}) is available — the server is on ${state.serverVersion}.`;
  } else {
    message = `LPDO ${state.latestVersion} is available — you're on ${state.appVersion}.`;
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-primary-container text-on-primary-container shrink-0 text-label-md">
      <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
      <span className="flex-1 min-w-0 truncate">{message}</span>
      <Link url={state.url} label="What's new" />
      <button
        onClick={() => { void openUrl(state.url); }}
        className="inline-flex items-center h-7 px-3 rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
      >
        Download
      </button>
      <button
        onClick={onDismiss}
        className="w-7 h-7 inline-flex items-center justify-center rounded-full text-on-primary-container hover:bg-on-primary-container/8 active:bg-on-primary-container/12 transition-colors duration-short3 ease-standard"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

function Link({ url, label }: { url: string; label: string }) {
  return (
    <button
      onClick={() => { void openUrl(url); }}
      className="inline-flex items-center h-7 px-3 rounded-full underline underline-offset-2 hover:bg-on-primary-container/8 active:bg-on-primary-container/12 transition-colors duration-short3 ease-standard"
    >
      {label}
    </button>
  );
}

/** The same strip for the server's chess engines (#309): one per engine
 *  switched on whose release is older than the newest. Dismissing hides that
 *  engine's strip until its next release. Asks the server once per
 *  connection; a server without the engine endpoints shows nothing. */
const ENGINE_DISMISS_KEY = "engineUpdateDismissed";

interface EngineUpdate {
  kind: "stockfish" | "lc0";
  name: string | null;
  version: string | null;
  update_available: boolean;
  latest: { version: string; url: string } | null;
  os: string;
}

function readDismissed(kind: string): string | null {
  try {
    // Stockfish's dismissal used to be stored under the bare key.
    return localStorage.getItem(`${ENGINE_DISMISS_KEY}:${kind}`) ?? (kind === "stockfish" ? localStorage.getItem(ENGINE_DISMISS_KEY) : null);
  } catch { return null; }
}

export function EngineUpdateBanner({ serverVersion }: { serverVersion: string | null }) {
  const [engines, setEngines] = useState<EngineUpdate[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, string | null>>(() => ({
    stockfish: readDismissed("stockfish"),
    lc0: readDismissed("lc0"),
  }));
  useEffect(() => {
    if (!serverVersion) return;
    (async () => {
      const on = await fetch(apiUrl("/engines")).then((r) => (r.ok ? r.json() : { stockfish: true, lc0: false })).catch(() => ({ stockfish: true, lc0: false }));
      const kinds = (["stockfish", "lc0"] as const).filter((k) => on[k]);
      const got = await Promise.all(kinds.map((k) =>
        fetch(apiUrl(`/engine?engine=${k}`)).then((r) => (r.ok ? r.json() : null)).then((e) => (e ? { ...e, kind: k } : null)).catch(() => null)));
      setEngines(got.filter((e): e is EngineUpdate => !!e));
    })();
  }, [serverVersion]);

  const due = engines.filter((e) => e.update_available && e.latest && dismissed[e.kind] !== e.latest.version);
  if (due.length === 0) return null;
  return (
    <>
      {due.map((engine) => {
        const latest = engine.latest!;
        const label = engine.kind === "lc0" ? "Lc0" : "Stockfish";
        const where = engine.os === "linux"
          ? engine.kind === "lc0" ? " Build it and install it on the server as /usr/local/bin/lc0 (see the guide)." : " Install it on the server as /usr/local/bin/stockfish."
          : " Install it on the server.";
        return (
          <div key={engine.kind} className="flex items-center gap-3 px-4 py-2 bg-primary-container text-on-primary-container shrink-0 text-label-md">
            <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
            <span className="flex-1 min-w-0 truncate">
              {label} {latest.version} is available — the server runs {engine.name ?? `${label} ${engine.version}`}.{where}
            </span>
            <button
              onClick={() => { void openUrl(latest.url); }}
              className="inline-flex items-center h-7 px-3 rounded-full bg-primary text-on-primary text-label-md hover:brightness-110 active:brightness-95 transition-all duration-short3 ease-standard"
            >
              Download
            </button>
            <button
              onClick={() => {
                try { localStorage.setItem(`${ENGINE_DISMISS_KEY}:${engine.kind}`, latest.version); } catch { /* per-device convenience only */ }
                setDismissed((d) => ({ ...d, [engine.kind]: latest.version }));
              }}
              className="w-7 h-7 inline-flex items-center justify-center rounded-full text-on-primary-container hover:bg-on-primary-container/8 active:bg-on-primary-container/12 transition-colors duration-short3 ease-standard"
              title={`Dismiss until the next ${label} release`}
            >
              ✕
            </button>
          </div>
        );
      })}
    </>
  );
}
