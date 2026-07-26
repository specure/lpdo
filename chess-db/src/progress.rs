use indicatif::ProgressStyle;

/// Format an integer with thousands separators, e.g. `12040323` → `"12,040,323"`.
/// Used for human-facing counts (import summaries, status, progress labels).
pub fn thousands(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        out.push('-');
    }
    out.chars().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::thousands;

    #[test]
    fn groups_by_threes() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(42), "42");
        assert_eq!(thousands(1_000), "1,000");
        assert_eq!(thousands(91_238), "91,238");
        assert_eq!(thousands(12_040_323), "12,040,323");
        assert_eq!(thousands(-1_234), "-1,234");
    }
}

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
