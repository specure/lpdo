import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface ChessDbEvent {
  type: "log" | "progress" | "done" | "error";
  message?: string;
  value?: number;
  total?: number;
  /** Absolute path to a file the operation produced (e.g. a backup PGN),
   *  carried on the terminal "done" event so the UI can reveal it. */
  path?: string;
}

export interface SidecarProgress {
  percent: number;
  running: boolean;
  done: boolean;
  doneMessage: string;
  /** Result file path from the "done" event, when the command emitted one. */
  donePath: string | null;
  log: string[];
  run: (args: string[]) => void;
  reset: () => void;
  /** Cancel the in-flight operation (sends SIGTERM to the spawned chess-db
   *  process). No-op when nothing is running. */
  cancel: () => void;
}

export function useSidecarProgress(): SidecarProgress {
  const [percent, setPercent] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [doneMessage, setDoneMessage] = useState("");
  const [donePath, setDonePath] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  // The eventId of the currently-running operation. Cancel uses this to
  // address the right child PID on the Rust side.
  const eventIdRef = useRef<string | null>(null);

  function reset() {
    unlistenRef.current?.();
    unlistenRef.current = null;
    eventIdRef.current = null;
    setPercent(0);
    setRunning(false);
    setDone(false);
    setLog([]);
    setDoneMessage("");
    setDonePath(null);
  }

  function cancel() {
    const id = eventIdRef.current;
    if (!id) return;
    void invoke("cancel_chess_db", { eventId: id });
  }

  function run(args: string[]) {
    reset();
    setRunning(true);

    const eventId = crypto.randomUUID();
    const eventName = `chess-db:${eventId}`;
    eventIdRef.current = eventId;

    listen<string>(eventName, (event) => {
      try {
        const data: ChessDbEvent = JSON.parse(event.payload);
        if (data.type === "log") {
          if (data.message) setLog((l) => [...l, data.message!]);
        } else if (data.type === "progress") {
          if (data.total && data.total > 0) {
            setPercent(Math.min(99, ((data.value ?? 0) / data.total) * 100));
          }
          if (data.message) setLog((l) => [...l, data.message!]);
        } else if (data.type === "done") {
          setPercent(100);
          setRunning(false);
          setDone(true);
          setDoneMessage(data.message ?? "Done");
          if (data.path) setDonePath(data.path);
          if (data.message) setLog((l) => [...l, data.message!]);
        } else if (data.type === "error") {
          if (data.message) setLog((l) => [...l, `⚠ ${data.message}`]);
          setRunning(false);
        }
      } catch {
        /* ignore parse errors */
      }
    }).then((unlisten) => {
      unlistenRef.current = unlisten;

      invoke("run_chess_db", { args, eventId }).catch((e: unknown) => {
        setRunning(false);
        setLog((l) => [...l, `Error: ${String(e)}`]);
      }).finally(() => {
        unlisten();
        if (unlistenRef.current === unlisten) unlistenRef.current = null;
      });
    });
  }

  useEffect(() => () => { unlistenRef.current?.(); }, []);

  return { percent, running, done, doneMessage, donePath, log, run, reset, cancel };
}
