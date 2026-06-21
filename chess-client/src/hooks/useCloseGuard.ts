import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { apiGet } from "../api";

interface JobSnapshot {
  type: string;
  status: string;
  interruptible: boolean;
}

/**
 * Warn before closing the app while a non-interruptible job is running.
 *
 * The server's appender (fast) operations — a from-scratch index rebuild, a
 * fast import, the update job — are not crash-safe: closing the app SIGKILLs
 * the server mid-write, which can corrupt the database. Transactional jobs roll
 * back cleanly, so those (and read-only ones) don't trigger the guard.
 */
export function useCloseGuard() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        // Block the close synchronously; we decide whether to proceed below.
        event.preventDefault();
        const win = getCurrentWindow();

        let danger: JobSnapshot | undefined;
        try {
          const jobs = await apiGet<JobSnapshot[]>("/jobs");
          danger = jobs.find(
            (j) => (j.status === "running" || j.status === "queued") && j.interruptible === false,
          );
        } catch {
          // Server unreachable — nothing in flight to lose; allow the close.
        }

        if (danger) {
          const proceed = await ask(
            `A database operation (${danger.type}) is still running and cannot be safely interrupted. ` +
              `Closing now can corrupt the database — let it finish if you can.\n\nClose anyway?`,
            {
              title: "Operation in progress",
              kind: "warning",
              okLabel: "Close anyway",
              cancelLabel: "Keep running",
            },
          );
          if (!proceed) return; // keep the window open
        }

        await win.destroy(); // proceed with closing
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
