import React from "react";
import { recordCrash, formatCrashLog } from "../lib/crashLog";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

// A render error used to blank the window: React unmounts the whole tree, and a
// desktop app has no console to read the reason from — the only evidence was a
// dark rectangle. This catches it and shows what happened, with the stack, so a
// crash can be reported instead of guessed at.
//
// Deliberately dependency-free and inline-styled: whatever broke may have been
// the app's own styling or state, so this must render on its own.
/** Write the whole crash log (this failure included) somewhere the user chooses.
 *  Guarded end to end — the error screen must not be able to fail. */
async function saveDiagnostics() {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const path = await save({ defaultPath: `lpdo-diagnostics-${stamp}.txt`, filters: [{ name: "Text", extensions: ["txt"] }] });
    if (path) await invoke("write_pgn_file", { path, content: formatCrashLog() });
  } catch { /* nothing more we can do from here */ }
}

interface Props { children: React.ReactNode }
interface State { error: Error | null; info: string | null }

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ info: info.componentStack ?? null });
    recordCrash("render", error, { componentStack: info.componentStack ?? undefined });
    // eslint-disable-next-line no-console
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const details = [
      `${error.name}: ${error.message}`,
      error.stack ? `\n${error.stack}` : "",
      info ? `\nComponent stack:${info}` : "",
    ].join("");

    return (
      <div style={{
        position: "fixed", inset: 0, overflow: "auto", padding: "32px",
        background: "#1b1b1f", color: "#e5e2e9",
        font: "14px/1.5 ui-sans-serif, system-ui, sans-serif",
      }}>
        <h1 style={{ font: "600 20px/1.3 ui-sans-serif, system-ui, sans-serif", margin: "0 0 8px" }}>
          Something in the interface failed
        </h1>
        <p style={{ margin: "0 0 20px", color: "#c9c5d0", maxWidth: "70ch" }}>
          The view stopped rendering. Your database is untouched — reloading brings the app back.
          Please include the detail below when reporting it.
        </p>
        <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              font: "inherit", padding: "8px 18px", borderRadius: "999px", border: 0,
              background: "#b6c4ff", color: "#001945", cursor: "pointer",
            }}
          >Reload</button>
          <button
            onClick={() => { void saveDiagnostics(); }}
            style={{
              font: "inherit", padding: "8px 18px", borderRadius: "999px",
              border: "1px solid #48454e", background: "transparent", color: "#e5e2e9", cursor: "pointer",
            }}
          >Save diagnostics…</button>
          <button
            onClick={() => { void navigator.clipboard?.writeText(details); }}
            style={{
              font: "inherit", padding: "8px 18px", borderRadius: "999px",
              border: "1px solid #48454e", background: "transparent", color: "#e5e2e9", cursor: "pointer",
            }}
          >Copy details</button>
        </div>
        <pre style={{
          margin: 0, padding: "16px", borderRadius: "8px", background: "#131316",
          color: "#ffb4ab", font: "12px/1.5 ui-monospace, Menlo, monospace",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{details}</pre>
      </div>
    );
  }
}
