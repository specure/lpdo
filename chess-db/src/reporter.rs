use indicatif::ProgressBar;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use crate::progress;

/// A structured progress event, mirroring the newline-delimited JSON the CLI
/// emits in `--json` mode. The in-process channel sink uses this so the server
/// can stream operation progress to HTTP clients without the operations
/// themselves knowing anything about HTTP.
#[derive(Clone, Debug, serde::Serialize)]
pub struct JobEvent {
    #[serde(rename = "type")]
    pub kind: String, // "log" | "progress" | "done" | "error"
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Clone)]
enum Sink {
    /// Interactive terminal: indicatif progress bars + plain println.
    Terminal,
    /// Newline-delimited JSON on stdout (the CLI `--json` mode).
    Json,
    /// In-process channel (the server's job runner). The job manager owns the
    /// receiver and forwards events to SSE subscribers.
    Channel(tokio::sync::mpsc::UnboundedSender<JobEvent>),
}

/// Abstracts over terminal (indicatif), JSON stdout, and in-process channel
/// progress output. Operations take `&Reporter` and report through it, so the
/// same code path runs in the CLI and inside the server unchanged.
pub struct Reporter {
    sink: Sink,
    /// Cooperative cancellation. Long operations that loop can poll
    /// `is_cancelled()` to stop early; the job manager sets it on cancel.
    cancel: Arc<AtomicBool>,
    /// When true, `done`/`done_with_path` emit a `log` event instead of a
    /// terminal `done`. Used for the sub-steps of a composite job (e.g. the
    /// `update` job's download/import/index/normalise), so a sub-step finishing
    /// doesn't look like the whole job finished.
    mute_done: bool,
}

impl Reporter {
    pub fn new(json: bool) -> Self {
        Self {
            sink: if json { Sink::Json } else { Sink::Terminal },
            cancel: Arc::new(AtomicBool::new(false)),
            mute_done: false,
        }
    }

    /// Build a reporter that streams events into `tx` (the server's job runner),
    /// cancellable via the shared `cancel` flag.
    pub fn channel(tx: tokio::sync::mpsc::UnboundedSender<JobEvent>, cancel: Arc<AtomicBool>) -> Self {
        Self { sink: Sink::Channel(tx), cancel, mute_done: false }
    }

    /// A reporter that discards all output — for synchronous server endpoints
    /// that call an operation but don't stream its progress anywhere.
    pub fn silent() -> Self {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        Self { sink: Sink::Channel(tx), cancel: Arc::new(AtomicBool::new(false)), mute_done: false }
    }

    /// A reporter sharing this one's sink and cancel flag, but whose completion
    /// events are downgraded to log lines. Pass this to the individual steps of a
    /// composite job so only the job's own final `done` terminates the stream.
    pub fn sub_step(&self) -> Self {
        Self { sink: self.sink.clone(), cancel: self.cancel.clone(), mute_done: true }
    }

    /// True when output is machine-consumed (JSON stdout or in-process channel)
    /// rather than an interactive terminal. Callers use this to suppress
    /// terminal-only UI such as `MultiProgress` bars.
    pub fn is_json(&self) -> bool {
        !matches!(self.sink, Sink::Terminal)
    }

    /// Whether a cooperative-cancellation request is pending.
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn emit_json(&self, value: serde_json::Value) {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{}", value);
        let _ = stdout.flush();
    }

    fn send(&self, ev: JobEvent) {
        if let Sink::Channel(tx) = &self.sink {
            let _ = tx.send(ev);
        }
    }

    /// Informational / intermediate message.
    pub fn log(&self, msg: impl std::fmt::Display) {
        match &self.sink {
            Sink::Terminal => println!("{}", msg),
            Sink::Json => self.emit_json(serde_json::json!({ "type": "log", "message": msg.to_string() })),
            Sink::Channel(_) => self.send(JobEvent {
                kind: "log".into(), message: msg.to_string(), value: None, total: None, path: None,
            }),
        }
    }

    /// Progress update. No-op for the terminal sink (indicatif owns the bar).
    pub fn progress(&self, current: u64, total: u64, msg: impl std::fmt::Display) {
        match &self.sink {
            Sink::Terminal => {}
            Sink::Json => self.emit_json(serde_json::json!({
                "type": "progress", "value": current, "total": total, "message": msg.to_string()
            })),
            Sink::Channel(_) => self.send(JobEvent {
                kind: "progress".into(), message: msg.to_string(),
                value: Some(current), total: Some(total), path: None,
            }),
        }
    }

    /// Final completion message.
    pub fn done(&self, msg: impl std::fmt::Display) {
        if self.mute_done {
            self.log(msg);
            return;
        }
        match &self.sink {
            Sink::Terminal => println!("{}", msg),
            Sink::Json => self.emit_json(serde_json::json!({
                "type": "done", "value": 100, "message": msg.to_string()
            })),
            Sink::Channel(_) => self.send(JobEvent {
                kind: "done".into(), message: msg.to_string(),
                value: Some(100), total: Some(100), path: None,
            }),
        }
    }

    /// Completion event carrying a result file path, so the GUI can offer to
    /// reveal the produced file in the OS file manager.
    pub fn done_with_path(&self, msg: impl std::fmt::Display, path: impl std::fmt::Display) {
        if self.mute_done {
            self.log(msg);
            let _ = &path;
            return;
        }
        match &self.sink {
            Sink::Terminal => println!("{}", msg),
            Sink::Json => self.emit_json(serde_json::json!({
                "type": "done", "value": 100, "message": msg.to_string(), "path": path.to_string()
            })),
            Sink::Channel(_) => self.send(JobEvent {
                kind: "done".into(), message: msg.to_string(),
                value: Some(100), total: Some(100), path: Some(path.to_string()),
            }),
        }
    }

    /// Error message.
    pub fn error(&self, msg: impl std::fmt::Display) {
        match &self.sink {
            Sink::Terminal => eprintln!("{}", msg),
            Sink::Json => self.emit_json(serde_json::json!({ "type": "error", "message": msg.to_string() })),
            Sink::Channel(_) => self.send(JobEvent {
                kind: "error".into(), message: msg.to_string(), value: None, total: None, path: None,
            }),
        }
    }

    /// Terminal event for a cooperatively-cancelled job — a clean stop, distinct
    /// from `done` (finished) and `error` (failed), so the UI can label it.
    pub fn cancelled(&self, msg: impl std::fmt::Display) {
        match &self.sink {
            Sink::Terminal => println!("{}", msg),
            Sink::Json => self.emit_json(serde_json::json!({ "type": "cancelled", "message": msg.to_string() })),
            Sink::Channel(_) => self.send(JobEvent {
                kind: "cancelled".into(), message: msg.to_string(), value: None, total: None, path: None,
            }),
        }
    }

    /// NON-terminal pause: a network job lost connectivity and will be retried by
    /// the job runner (#206). Only meaningful for the in-process channel (the job
    /// runner owns the retry). For the CLI, there's no retry machinery, so it's
    /// just a log line and the operation's error is surfaced normally.
    pub fn waiting(&self, msg: impl std::fmt::Display) {
        match &self.sink {
            Sink::Terminal => eprintln!("{}", msg),
            Sink::Json => self.emit_json(serde_json::json!({ "type": "waiting", "message": msg.to_string() })),
            Sink::Channel(_) => self.send(JobEvent {
                kind: "waiting".into(), message: msg.to_string(), value: None, total: None, path: None,
            }),
        }
    }

    /// Create a count-based progress bar (hidden unless interactive terminal).
    pub fn bar(&self, len: u64) -> ProgressBar {
        if matches!(self.sink, Sink::Terminal) {
            let pb = ProgressBar::new(len);
            pb.set_style(progress::bar_style());
            pb
        } else {
            ProgressBar::hidden()
        }
    }

    /// Create a count-based progress bar with ETA (hidden unless interactive).
    pub fn bar_with_eta(&self, len: u64) -> ProgressBar {
        if matches!(self.sink, Sink::Terminal) {
            let pb = ProgressBar::new(len);
            pb.set_style(progress::bar_style_with_eta());
            pb
        } else {
            ProgressBar::hidden()
        }
    }

    /// Create a spinner (hidden unless interactive terminal).
    pub fn spinner(&self) -> ProgressBar {
        if matches!(self.sink, Sink::Terminal) {
            let pb = ProgressBar::new_spinner();
            pb.set_style(progress::spinner_style());
            pb.enable_steady_tick(std::time::Duration::from_millis(80));
            pb
        } else {
            ProgressBar::hidden()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression for #157: a large single-file import (one Ajedrez .7z part)
    // hands `process_pgn_stream` a `sub_step` child so byte progress flows while
    // terminal `done` stays muted. That child MUST still observe the parent's
    // cancel flag, or the per-batch cancellation check never fires and the import
    // runs to completion despite the user hitting Cancel.
    #[test]
    fn sub_step_shares_parent_cancel_flag() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let parent = Reporter::channel(tx, cancel.clone());
        let child = parent.sub_step();

        assert!(!child.is_cancelled());
        cancel.store(true, Ordering::Relaxed);
        assert!(child.is_cancelled(), "sub_step child must see the parent's cancel");
    }

    // `silent()` is intentionally detached — its fresh flag is never set. This
    // pins the distinction that made the bug: it is NOT a cancellation-aware
    // reporter, so it must never be used inside a cancellable loop.
    #[test]
    fn silent_is_detached_from_cancellation() {
        let cancel = Arc::new(AtomicBool::new(true));
        let parent = Reporter::channel(tokio::sync::mpsc::unbounded_channel().0, cancel);
        let detached = Reporter::silent();
        assert!(parent.is_cancelled());
        assert!(!detached.is_cancelled());
    }
}
