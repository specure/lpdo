use indicatif::ProgressStyle;

/// Standard count bar: `[elapsed] ████ pos/len  message`
pub fn bar_style() -> ProgressStyle {
    ProgressStyle::default_bar()
        .template("[{elapsed_precise}] {bar:40.cyan/blue} {pos}/{len} {msg}")
        .unwrap()
}

/// Count bar with ETA — for long-running network operations where time matters.
pub fn bar_style_with_eta() -> ProgressStyle {
    ProgressStyle::default_bar()
        .template("[{elapsed_precise}] {bar:40.cyan/blue} {pos}/{len}  ETA {eta_precise}  {msg}")
        .unwrap()
}

/// Byte progress bar in yellow — visually distinct, used for large file reads.
pub fn byte_bar_style() -> ProgressStyle {
    ProgressStyle::default_bar()
        .template("[{elapsed_precise}] {bar:40.yellow/white} {bytes}/{total_bytes} ({bytes_per_sec})")
        .unwrap()
}

/// Spinner for indeterminate waits.
pub fn spinner_style() -> ProgressStyle {
    ProgressStyle::default_spinner()
        .template("{spinner:.cyan} {msg}")
        .unwrap()
}
