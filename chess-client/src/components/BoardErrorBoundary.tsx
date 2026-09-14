import React from "react";
import { recordCrash } from "../lib/crashLog";

// Keeps a failing board from taking the whole app down (#283). react-chessboard
// throws from an effect when it can't measure a square mid-animation; without
// this the error reached the app-wide ErrorBoundary and replaced every view.
// Here it's logged like any render crash (Maintenance → Diagnostics), and only
// the board is swapped for a placeholder that can draw it again.

interface Props { children: React.ReactNode }
interface State { failed: boolean; attempt: number }

export default class BoardErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    recordCrash("render", error, { componentStack: info.componentStack ?? undefined });
    // eslint-disable-next-line no-console
    console.error("Board render error (contained):", error, info.componentStack);
  }

  render() {
    const { failed, attempt } = this.state;
    // Keyed by attempt, so "Redraw board" mounts a fresh board rather than
    // resuming the one that failed mid-animation.
    if (!failed) return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-body-sm text-on-surface-variant text-center">
        <span>The board failed to draw.</span>
        <button
          onClick={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))}
          className="h-8 px-4 rounded-full border border-outline text-label-lg text-on-surface hover:bg-on-surface/8 active:bg-on-surface/12 transition-colors duration-short3 ease-standard"
        >
          Redraw board
        </button>
      </div>
    );
  }
}
