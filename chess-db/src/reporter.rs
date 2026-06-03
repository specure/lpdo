use indicatif::ProgressBar;
use std::io::Write;
use crate::progress;

/// Abstracts over terminal (indicatif) and JSON stdout progress output.
///
/// - Terminal mode: progress bars render normally.
/// - JSON mode: all bars are hidden; events emitted as newline-delimited JSON
///   on stdout, flushed immediately for the Tauri sidecar reader.
pub struct Reporter {
    json: bool,
}

impl Reporter {
    pub fn new(json: bool) -> Self {
        Self { json }
    }

    pub fn is_json(&self) -> bool {
        self.json
    }

    fn emit(&self, value: serde_json::Value) {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{}", value);
        let _ = stdout.flush();
    }

    /// Informational / intermediate message.
    pub fn log(&self, msg: impl std::fmt::Display) {
        if self.json {
            self.emit(serde_json::json!({ "type": "log", "message": msg.to_string() }));
        } else {
            println!("{}", msg);
        }
    }

    /// Progress update. Only emits in JSON mode; terminal output is handled by indicatif.
    pub fn progress(&self, current: u64, total: u64, msg: impl std::fmt::Display) {
        if self.json {
            self.emit(serde_json::json!({
                "type": "progress",
                "value": current,
                "total": total,
                "message": msg.to_string()
            }));
        }
    }

    /// Final completion message.
    pub fn done(&self, msg: impl std::fmt::Display) {
        if self.json {
            self.emit(serde_json::json!({
                "type": "done",
                "value": 100,
                "message": msg.to_string()
            }));
        } else {
            println!("{}", msg);
        }
    }

    /// Completion event carrying a result file path, so the GUI can offer to
    /// reveal the produced file in the OS file manager.
    pub fn done_with_path(&self, msg: impl std::fmt::Display, path: impl std::fmt::Display) {
        if self.json {
            self.emit(serde_json::json!({
                "type": "done",
                "value": 100,
                "message": msg.to_string(),
                "path": path.to_string()
            }));
        } else {
            println!("{}", msg);
        }
    }

    /// Error message.
    pub fn error(&self, msg: impl std::fmt::Display) {
        if self.json {
            self.emit(serde_json::json!({ "type": "error", "message": msg.to_string() }));
        } else {
            eprintln!("{}", msg);
        }
    }

    /// Create a count-based progress bar (hidden in JSON mode).
    pub fn bar(&self, len: u64) -> ProgressBar {
        if self.json {
            ProgressBar::hidden()
        } else {
            let pb = ProgressBar::new(len);
            pb.set_style(progress::bar_style());
            pb
        }
    }

    /// Create a count-based progress bar with ETA (hidden in JSON mode).
    pub fn bar_with_eta(&self, len: u64) -> ProgressBar {
        if self.json {
            ProgressBar::hidden()
        } else {
            let pb = ProgressBar::new(len);
            pb.set_style(progress::bar_style_with_eta());
            pb
        }
    }

    /// Create a spinner (hidden in JSON mode).
    pub fn spinner(&self) -> ProgressBar {
        if self.json {
            ProgressBar::hidden()
        } else {
            let pb = ProgressBar::new_spinner();
            pb.set_style(progress::spinner_style());
            pb.enable_steady_tick(std::time::Duration::from_millis(80));
            pb
        }
    }
}
