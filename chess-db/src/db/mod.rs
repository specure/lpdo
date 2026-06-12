pub mod queries;
pub mod schema;

use anyhow::Result;
use duckdb::Connection;
use std::path::Path;

/// Returns 80% of total system RAM as a DuckDB memory_limit string (e.g. "38GiB").
/// Falls back to "8GiB" if total RAM cannot be determined.
fn memory_limit_str() -> String {
    let total_kb = read_total_ram_kb().unwrap_or(0);
    if total_kb == 0 {
        return "8GiB".to_string();
    }
    let limit_gib = (total_kb * 80 / 100) / (1024 * 1024);
    format!("{}GiB", limit_gib.max(1))
}

/// Read total system RAM in kilobytes.
/// Tries /proc/meminfo (Linux), then sysctl (macOS/BSD).
#[cfg(not(windows))]
fn read_total_ram_kb() -> Option<u64> {
    // Linux
    if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
        for line in content.lines() {
            if line.starts_with("MemTotal:") {
                return line.split_whitespace().nth(1)?.parse().ok();
            }
        }
    }
    // macOS / BSD: `sysctl -n hw.memsize` returns bytes
    if let Ok(output) = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output() {
        if let Ok(s) = std::str::from_utf8(&output.stdout) {
            if let Ok(bytes) = s.trim().parse::<u64>() {
                return Some(bytes / 1024);
            }
        }
    }
    None
}

/// Read total system RAM in kilobytes via the Win32 `GlobalMemoryStatusEx` API.
/// Neither /proc/meminfo nor `sysctl` exist on Windows, so without this the
/// memory_limit would always fall back to 8GiB — which on machines with less
/// than ~8-16GiB RAM lets DuckDB overcommit (it won't spill below its limit)
/// and thrash/OOM during heavy ops like `index-positions`.
#[cfg(windows)]
fn read_total_ram_kb() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: MEMORYSTATUSEX is a plain-old-data struct; zeroing it and setting
    // dwLength is the documented way to call GlobalMemoryStatusEx.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok != 0 {
        Some(status.ullTotalPhys / 1024)
    } else {
        None
    }
}

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    let mem_limit = memory_limit_str();
    conn.execute_batch(&format!(
        "SET threads=4;
         SET memory_limit='{mem_limit}';
         SET preserve_insertion_order=false;",
    ))?;
    Ok(conn)
}

/// Open a read-only connection. Allows concurrent read-write connections from
/// other processes (e.g. chess-db subprocesses spawned by the Tauri shell).
pub fn open_readonly(path: &Path) -> Result<Connection> {
    let config = duckdb::Config::default()
        .access_mode(duckdb::AccessMode::ReadOnly)?;
    let conn = Connection::open_with_flags(path, config)?;
    conn.execute_batch("SET threads=4;")?;
    Ok(conn)
}
