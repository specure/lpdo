//! Server-owned update scheduler.
//!
//! Runs the `update` job once a day at a user-chosen local clock time
//! (`schedule.daily_minute`, minutes past local midnight). Outcome state lives in
//! the `schedule` table, so catch-up after downtime is automatic: if the server
//! was down at the scheduled time, the next tick after it comes back sees the run
//! is overdue and fires it.
//!
//! Each run is recorded as `running` *before* the job starts (the single writer
//! thread is occupied for the whole update, so a write afterwards would queue
//! behind it). The terminal status is then settled on a later tick by inspecting
//! the latest `update` job — which works for a manual "run now" too, and heals a
//! `running` status orphaned by a restart (the in-memory job registry doesn't
//! survive one, so the job is simply gone → the run was interrupted).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{Duration as ChronoDuration, NaiveDateTime};

use crate::jobs::{JobManager, ReadPool};

/// How often the scheduler wakes to check the clock. One minute keeps the run
/// close to the chosen time without meaningful cost (a single COUNT each tick).
const TICK: Duration = Duration::from_secs(60);
/// Grace period after startup before the first check, so the server is fully up.
const STARTUP_DELAY: Duration = Duration::from_secs(10);


/// Spawn the scheduler loop onto the current Tokio runtime.
pub fn spawn(jobs: Arc<JobManager>, reads: ReadPool, db_path: PathBuf) {
    // Test/debug escape hatch: skip background work entirely so the writer thread
    // stays free (e.g. when exercising the #82 fault injector).
    if std::env::var_os("LPDO_DISABLE_SCHEDULER").is_some() {
        eprintln!("Scheduler disabled (LPDO_DISABLE_SCHEDULER set).");
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        let mut ticker = tokio::time::interval(TICK);
        loop {
            ticker.tick().await;
            if let Err(e) = tick(&jobs, &reads, &db_path).await {
                eprintln!("scheduler: {e:#}");
            }
        }
    });
}

async fn tick(jobs: &Arc<JobManager>, reads: &ReadPool, db_path: &Path) -> anyhow::Result<()> {
    // #131: fallback trigger for coalesced post-import maintenance. The job-
    // completion hook (jobs.rs) normally starts it the instant the queue drains;
    // this periodic call covers the case where maintenance was requested with an
    // already-empty queue (no completion event to react to). Deliberately BEFORE
    // the setup-sentinel gate so it also runs after the wizard's first-run
    // imports finish. No-op unless maintenance is owed and nothing is in flight.
    jobs.maybe_run_maintenance();

    // While the wizard's first-run pipeline owns the database, stay out of its
    // way entirely: it imports the enabled sources itself (with `--fast`), so an
    // auto-sync here would double-import or collide on the writer.
    if crate::jobs::setup_sentinel_present(db_path) {
        return Ok(());
    }

    // Gate (#40 C4): hold off ALL background work until first-run setup has
    // completed (a DB that already has games also opens the gate). Manual runs
    // ("Sync now", the maintenance buttons) are explicit and bypass this.
    if !setup_gate_open(reads).await? {
        return Ok(());
    }

    let daily_minute = read_daily_minute(reads).await?;

    // FIDE-list housekeeping (#160/#162): keep the local FIDE list current
    // (~monthly), independent of feeds. Submitted as a guarded job that no-ops
    // when not due; one at a time so ticks don't stack duplicates.
    if !job_in_flight(jobs, "fide_refresh") {
        let due = reads
            .run(|c| crate::fide::refresh_due(c).map_err(|e| anyhow::anyhow!(e)))
            .await
            .unwrap_or(false);
        if due {
            jobs.submit("fide_refresh".into(), serde_json::json!({ "if_due": true }));
        }
    }

    // Per-source auto-sync (#160): enabling a source opts it into background
    // refresh — there is no global "automatic updates" toggle. Sync any enabled
    // feed that's never synced or is due for its daily refresh; if nothing is
    // enabled, nothing runs. Skips a source that already has a sync in flight.
    let threshold = fmt_dt(most_recent_scheduled(daily_minute));
    let candidates = reads
        .run(move |c| crate::sources::feeds_due_for_resync(c, &threshold).map_err(|e| anyhow::anyhow!(e)))
        .await?;
    if !candidates.is_empty() {
        let in_flight = sources_sync_in_flight(jobs);
        // One cluster for the batch of due feeds, so if the first pauses offline the
        // rest wait behind it rather than each running and pausing too (#206).
        let cluster = jobs.next_cluster_id();
        for src in candidates {
            if !in_flight.contains(src.key) {
                // Download + Import pair (#244): separate, individually-timed
                // activity entries; the cluster keeps the import behind an
                // offline-paused download (#206).
                jobs.submit_in_cluster(
                    "sources_download".into(),
                    serde_json::json!({ "source": src.key }),
                    Some(cluster.clone()),
                );
                jobs.submit_in_cluster(
                    "sources_import".into(),
                    serde_json::json!({ "source": src.key }),
                    Some(cluster.clone()),
                );
            }
        }
    }
    Ok(())
}

/// Whether a job of `job_type` is currently queued or running.
fn job_in_flight(jobs: &Arc<JobManager>, job_type: &str) -> bool {
    jobs.list()
        .iter()
        // "waiting" (offline-paused, #206) counts as in-flight so we don't stack a
        // duplicate each tick while the machine is offline.
        .any(|j| j.job_type == job_type && matches!(j.status.as_str(), "running" | "queued" | "waiting"))
}

/// Whether background imports may run (#40 C4): only after first-run setup has
/// completed (set by the wizard's `/setup/start`), or once the DB already has
/// games (upgrades / CLI-populated). Before that, a source enabled mid-wizard
/// must not be auto-imported until the user finishes setup.
async fn setup_gate_open(reads: &ReadPool) -> anyhow::Result<bool> {
    reads
        .run(|c| -> anyhow::Result<bool> {
            let done: bool = c
                .query_row("SELECT setup_completed FROM schedule WHERE id = 1", [], |r| r.get(0))
                .unwrap_or(false);
            if done {
                return Ok(true);
            }
            let games: i64 = c
                .query_row("SELECT COUNT(*) FROM games WHERE deleted_at IS NULL", [], |r| r.get(0))
                .unwrap_or(0);
            Ok(games > 0)
        })
        .await
}

/// Source keys with a `sources_sync` job currently queued or running.
fn sources_sync_in_flight(jobs: &Arc<JobManager>) -> std::collections::HashSet<String> {
    jobs.list()
        .into_iter()
        .filter(|j| {
            matches!(j.job_type.as_str(), "sources_sync" | "sources_download" | "sources_import")
                && matches!(j.status.as_str(), "queued" | "running" | "waiting")
        })
        .filter_map(|j| j.params.get("source").and_then(|v| v.as_str()).map(str::to_owned))
        .collect()
}

// ── Clock math (all in local wall-clock time) ─────────────────────────────────

fn hm(daily_minute: i64) -> (u32, u32) {
    let dm = daily_minute.rem_euclid(1440);
    ((dm / 60) as u32, (dm % 60) as u32)
}

/// The most recent occurrence of the daily scheduled time (today's if it has
/// passed, otherwise yesterday's). A source whose `last_run` is before this is due
/// for its periodic refresh; a NULL `last_run` is always due (initial sync +
/// catch-up after downtime, via the `last_run IS NULL` clause in the SQL).
fn most_recent_scheduled(daily_minute: i64) -> NaiveDateTime {
    let now = chrono::Local::now().naive_local();
    let (h, m) = hm(daily_minute);
    let today = now.date().and_hms_opt(h, m, 0).unwrap_or(now);
    if now >= today { today } else { today - ChronoDuration::days(1) }
}

/// Format a local datetime as the SQL-comparable string used for the per-source
/// refresh threshold.
fn fmt_dt(dt: NaiveDateTime) -> String {
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// The next occurrence of the daily scheduled time from now (today's if it's
/// still ahead, otherwise tomorrow's). Powers the "next check" readout on the
/// Sources page (#194).
pub fn next_scheduled(daily_minute: i64) -> NaiveDateTime {
    let now = chrono::Local::now().naive_local();
    let (h, m) = hm(daily_minute);
    let today = now.date().and_hms_opt(h, m, 0).unwrap_or(now);
    if now < today { today } else { today + ChronoDuration::days(1) }
}

/// The off-peak clock time (minutes past local midnight) that governs the daily
/// per-source refresh cadence. Kept in the `schedule` table (default 240 = 04:00).
async fn read_daily_minute(reads: &ReadPool) -> anyhow::Result<i64> {
    reads
        .run(|conn| {
            conn.query_row("SELECT daily_minute FROM schedule WHERE id = 1", [], |r| {
                Ok(r.get::<_, i32>(0)? as i64)
            })
            .map_err(|e| anyhow::anyhow!(e))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    #[test]
    fn next_scheduled_uses_the_clock_time_and_is_in_the_future() {
        let n = next_scheduled(4 * 60 + 30); // 04:30
        assert_eq!((n.hour(), n.minute()), (4, 30), "keeps the configured clock time");
        assert!(n > chrono::Local::now().naive_local(), "always the next occurrence, never past");
    }

    #[test]
    fn daily_minute_wraps_into_a_valid_clock_time() {
        assert_eq!(hm(240), (4, 0));
        assert_eq!(hm(1439), (23, 59));
        assert_eq!(hm(1440), (0, 0)); // wraps
    }
}
