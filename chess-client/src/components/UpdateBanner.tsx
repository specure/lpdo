import { openUrl } from "@tauri-apps/plugin-opener";
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
