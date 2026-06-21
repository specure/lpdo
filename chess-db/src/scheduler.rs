//! Server-owned update scheduler.
//!
//! A background task that periodically checks the single-row `schedule` config
//! and, when automatic updates are enabled and due, submits the existing
//! `update` job (the same one the Maintenance "update" path uses). Outcome state
//! lives in the `schedule` table, so catch-up after downtime is automatic: a
//! NULL or old `last_run` makes the next tick "due".

use std::sync::Arc;
use std::time::Duration;

use crate::jobs::{ConnActor, JobManager, ReadPool};

/// How often the scheduler wakes to check whether an update is due.
const TICK: Duration = Duration::from_secs(600); // 10 minutes
/// Grace period after startup before the first check, so the server is fully up.
const STARTUP_DELAY: Duration = Duration::from_secs(10);

struct Check {
    enabled: bool,
    due: bool,
}

/// Spawn the scheduler loop onto the current Tokio runtime.
pub fn spawn(jobs: Arc<JobManager>, reads: ReadPool, writer: ConnActor) {
    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        let mut tracked: Option<String> = None;
        let mut ticker = tokio::time::interval(TICK);
        loop {
            ticker.tick().await;
            if let Err(e) = tick(&jobs, &reads, &writer, &mut tracked).await {
                eprintln!("scheduler: {e:#}");
            }
        }
    });
}

async fn tick(
    jobs: &Arc<JobManager>,
    reads: &ReadPool,
    writer: &ConnActor,
    tracked: &mut Option<String>,
) -> anyhow::Result<()> {
    // 1. If we kicked off an update last time, record its outcome once it finishes.
    //    (The writer thread is busy with the update until then, so this write only
    //    lands after the job completes — which is exactly when we want it.)
    if let Some(id) = tracked.clone() {
        match jobs.snapshot(&id) {
            Some(s) if s.status == "done" => {
                mark_done(writer, "ok".into(), id).await;
                *tracked = None;
            }
            Some(s) if s.status == "error" => {
                mark_done(writer, format!("error: {}", s.error.unwrap_or_default()), id).await;
                *tracked = None;
            }
            Some(_) => return Ok(()), // still running/queued — wait for it
            None => *tracked = None,  // job vanished (shouldn't happen) — re-evaluate
        }
    }

    // 2. Is an automatic update enabled and due?
    let check = read_check(reads).await?;
    if !check.enabled || !check.due {
        return Ok(());
    }

    // 3. Don't overlap with any in-flight update (scheduled or a manual "run now").
    let in_flight = jobs
        .list()
        .iter()
        .any(|j| j.job_type == "update" && (j.status == "running" || j.status == "queued"));
    if in_flight {
        return Ok(());
    }

    // 4. Stamp the attempt BEFORE submitting: the update job occupies the writer
    //    thread for a long time, so any write *after* submit would queue behind it.
    //    last_run is set now (not on completion) so a failed run waits the full
    //    interval before retrying rather than hammering.
    mark_attempt(writer).await;
    let id = jobs.submit("update".into(), serde_json::json!({}));
    *tracked = Some(id);
    Ok(())
}

async fn read_check(reads: &ReadPool) -> anyhow::Result<Check> {
    reads
        .run(|conn| {
            conn.query_row(
                "SELECT enabled,
                        (last_run IS NULL
                         OR last_run < CAST(now() AS TIMESTAMP) - to_hours(interval_hours)) AS due
                 FROM schedule WHERE id = 1",
                [],
                |r| Ok(Check { enabled: r.get(0)?, due: r.get(1)? }),
            )
            .map_err(|e| anyhow::anyhow!(e))
        })
        .await
}

async fn mark_attempt(writer: &ConnActor) {
    let _ = writer
        .run(|conn| {
            conn.execute(
                "UPDATE schedule SET last_run = CAST(now() AS TIMESTAMP), last_status = 'running' WHERE id = 1",
                [],
            )
        })
        .await;
}

async fn mark_done(writer: &ConnActor, status: String, job_id: String) {
    let _ = writer
        .run(move |conn| {
            conn.execute(
                "UPDATE schedule SET last_status = ?, last_job_id = ? WHERE id = 1",
                duckdb::params![status, job_id],
            )
        })
        .await;
}
