pub mod ids;
pub mod queries;
pub mod schema;

use anyhow::{Context, Result};
use duckdb::Connection;
use std::path::Path;

/// Run `f` inside an explicit transaction, committing on success and rolling
/// back on **any** early exit — error, `?`, or panic.
///
/// The manual `BEGIN … ? … COMMIT` shape this replaces leaked a transaction
/// whenever anything in between failed, and the daemon's writer connection is
/// long-lived: every later job then ran inside that stale transaction, where
/// DuckDB refuses DDL with "Cannot create index with outstanding updates" — so
/// a failed import broke the maintenance pipeline's index rebuilds and left the
/// database without its secondary indexes (#255).
pub fn with_tx<T>(conn: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    conn.execute_batch("BEGIN").context(
        "could not begin a transaction — the connection is already in one, \
         which means an earlier operation failed without rolling back",
    )?;
    // Guard, not just an error branch: a panic must not leave the transaction
    // open either, since the connection outlives the job.
    struct Rollback<'a> {
        conn: &'a Connection,
        armed: bool,
    }
    impl Drop for Rollback<'_> {
        fn drop(&mut self) {
            if self.armed {
                let _ = self.conn.execute_batch("ROLLBACK");
            }
        }
    }
    let mut guard = Rollback { conn, armed: true };
    let value = f()?;
    guard.armed = false;
    conn.execute_batch("COMMIT")?;
    Ok(value)
}

/// Clear a transaction the connection should not be in, **committing** rather
/// than discarding it: whatever is pending belongs to an earlier import, and
/// losing rows is worse than keeping a partial batch. A no-op (harmless error,
/// connection stays usable) when no transaction is active.
///
/// Call this BEFORE the statement that needs a clean connection, never as a
/// recovery step after it failed: DuckDB aborts a transaction as soon as one of
/// its statements fails, and committing an aborted transaction discards it.
///
/// Belt and braces for [`with_tx`]: databases already wedged by the old code
/// recover on the next maintenance run instead of staying un-indexed (#255).
pub fn clear_stray_transaction(conn: &Connection) {
    let _ = conn.execute_batch("COMMIT");
}

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
         SET preserve_insertion_order=false;
         -- 16 MiB default → 1 GB: a bulk import commits multi-MB batches, so the
         -- default threshold checkpoints constantly; each checkpoint synchronously
         -- flushes the main DB file, which is far costlier on Windows
         -- (FlushFileBuffers) than Linux (fdatasync). Measured ~35% off the
         -- multi-file feed imports on Windows (#244). Durability unchanged —
         -- still checkpoints at the threshold, on CHECKPOINT, and on shutdown.
         SET checkpoint_threshold='1GB';",
    ))?;
    Ok(conn)
}


#[cfg(test)]
mod tx_tests {
    use super::*;

    /// A file-backed database: the transaction/index interaction is what is
    /// under test, and in-memory DuckDB does not exercise the same paths.
    fn setup(tag: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("lpdo-tx-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join("t.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE g(id INTEGER, white_id INTEGER);
             INSERT INTO g SELECT i, i%100 FROM range(1, 5000) t(i);",
        )
        .unwrap();
        (dir, conn)
    }

    fn can_create_index(conn: &Connection) -> bool {
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_probe ON g(white_id);")
            .and_then(|()| conn.execute_batch("DROP INDEX IF EXISTS idx_probe;"))
            .is_ok()
    }

    /// The #255 bug: a failure between BEGIN and COMMIT left the connection in a
    /// transaction, and DuckDB then refuses to build an index on it ("Cannot
    /// create index with outstanding updates") — so a failed import broke every
    /// later index rebuild. with_tx must roll back and leave the connection
    /// clean.
    #[test]
    fn a_failed_transaction_does_not_wedge_the_connection() {
        let (dir, conn) = setup("fail");

        let r: Result<()> = with_tx(&conn, || {
            conn.execute("UPDATE g SET white_id = 1 WHERE id < 1000", [])?;
            anyhow::bail!("boom");
        });
        assert!(r.is_err(), "the closure's error must propagate");
        assert!(
            can_create_index(&conn),
            "no transaction may be left open after a failed with_tx"
        );
        // Rolled back, so the update is gone.
        let touched: i64 = conn
            .query_row("SELECT COUNT(*) FROM g WHERE id < 1000 AND white_id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(touched, 10, "rolled back: only the rows seeded with white_id=1 remain");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_successful_transaction_commits_and_leaves_no_transaction() {
        let (dir, conn) = setup("ok");

        with_tx(&conn, || {
            conn.execute("UPDATE g SET white_id = 7 WHERE id < 10", [])?;
            Ok(())
        })
        .unwrap();

        let touched: i64 = conn
            .query_row("SELECT COUNT(*) FROM g WHERE id < 10 AND white_id = 7", [], |r| r.get(0))
            .unwrap();
        assert_eq!(touched, 9, "committed");
        assert!(can_create_index(&conn), "connection is out of the transaction");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Databases already wedged by the old code must recover: the guard commits
    /// the stray transaction so the rebuild can proceed, and is a harmless no-op
    /// when there is nothing to clear.
    #[test]
    fn clear_stray_transaction_unblocks_index_creation() {
        let (dir, conn) = setup("stray");

        conn.execute_batch("BEGIN").unwrap();
        conn.execute("UPDATE g SET white_id = 2 WHERE id < 1000", []).unwrap();

        clear_stray_transaction(&conn);
        assert!(can_create_index(&conn), "guard must unblock the rebuild");

        // Committed, not discarded — those rows belong to someone's import. This
        // is why the guard must run BEFORE the rebuild attempt: see
        // an_aborted_transaction_cannot_be_salvaged below.
        let touched: i64 = conn
            .query_row("SELECT COUNT(*) FROM g WHERE id < 1000 AND white_id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(touched, 999, "pending work is kept, not rolled back");

        clear_stray_transaction(&conn); // no transaction active: must not break anything
        assert!(can_create_index(&conn));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// DuckDB aborts a transaction as soon as a statement in it fails, and a
    /// COMMIT on an aborted transaction discards the work. Hence the ordering in
    /// dedup: clear the stray transaction BEFORE attempting the rebuild — trying
    /// the rebuild first would abort the transaction and throw the pending rows
    /// away, which is exactly what the old code did.
    #[test]
    fn an_aborted_transaction_cannot_be_salvaged() {
        let (dir, conn) = setup("aborted");

        conn.execute_batch("BEGIN").unwrap();
        conn.execute("UPDATE g SET white_id = 3 WHERE id < 1000", []).unwrap();
        assert!(!can_create_index(&conn), "index creation is blocked inside a transaction");

        clear_stray_transaction(&conn); // too late: the failure above aborted it
        let touched: i64 = conn
            .query_row("SELECT COUNT(*) FROM g WHERE id < 1000 AND white_id = 3", [], |r| r.get(0))
            .unwrap();
        assert_eq!(touched, 10, "an aborted transaction's work is lost, not committed");
        assert!(can_create_index(&conn), "the connection is at least usable again");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
