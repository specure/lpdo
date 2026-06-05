import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpdateInfo } from "../hooks/useUpdateCheck";

/** Dismissible "new version available" strip shown under the top app bar.
 *  Notify-only: "Download" opens the release page in the browser; updating
 *  remains a manual reinstall (see useUpdateCheck for why). */
export default function UpdateBanner({
  info,
  onDismiss,
}: {
  info: UpdateInfo;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-primary-container text-on-primary-container shrink-0 text-label-md">
      <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
      <span className="flex-1 min-w-0 truncate">
        LPDO {info.latestVersion} is available — you're on {info.currentVersion}.
      </span>
      {/* Both links open the GitHub release page — it shows the release notes at
          the top and the downloadable installers below, so one URL serves both
          "read what changed" and "get the file" intents. */}
      <button
        onClick={() => { void openUrl(info.url); }}
        className="inline-flex items-center h-7 px-3 rounded-full text-on-primary-container underline underline-offset-2 hover:bg-on-primary-container/8 active:bg-on-primary-container/12 transition-colors duration-short3 ease-standard"
      >
        What's new
      </button>
      <button
        onClick={() => { void openUrl(info.url); }}
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
