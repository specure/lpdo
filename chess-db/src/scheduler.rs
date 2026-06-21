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

use std::sync::Arc;
use std::time::Duration;

use chrono::{Duration as ChronoDuration, NaiveDateTime};

use crate::jobs::{ConnActor, JobManager, JobSnapshot, ReadPool};

/// How often the scheduler wakes to check the clock. One minute keeps the run
/// close to the chosen time without meaningful cost (a single COUNT each tick).
const TICK: Duration = Duration::from_secs(60);
/// Grace period after startup before the first check, so the server is fully up.
const STARTUP_DELAY: Duration = Duration::from_secs(10);

struct Schedule {
    enabled: bool,
    daily_minute: i64,
    last_run: Option<String>,
    last_status: Option<String>,
}

/// Spawn the scheduler loop onto the current Tokio runtime.
pub fn spawn(jobs: Arc<JobManager>, reads: ReadPool, writer: ConnActor) {
    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        let mut ticker = tokio::time::interval(TICK);
        loop {
            ticker.tick().await;
            if let Err(e) = tick(&jobs, &reads, &writer).await {
                eprintln!("scheduler: {e:#}");
            }
        }
    });
}

async fn tick(jobs: &Arc<JobManager>, reads: &ReadPool, writer: &ConnActor) -> anyhow::Result<()> {
    let s = read_schedule(reads).await?;

    // 1. If a run is recorded as in progress, settle it once the job finishes.
    //    The terminal status comes from the latest `update` job (covers both a
    //    scheduled run and a manual "run now"); if no such job exists any more —
    //    e.g. the registry was cleared by a restart — the run was interrupted.
    if s.last_status.as_deref() == Some("running") {
        match latest_update(jobs) {
            Some(j) if j.status == "done" => mark_status(writer, "ok".into()).await,
            Some(j) if j.status == "error" => {
                mark_status(writer, format!("error: {}", j.error.unwrap_or_default())).await
            }
            Some(_) => return Ok(()), // still running/queued — wait for it
            None => mark_status(writer, "interrupted".into()).await,
        }
        return Ok(());
    }

    // 2. Due? (enabled, and we haven't run since today's scheduled time)
    if !s.enabled || !is_due(s.daily_minute, s.last_run.as_deref()) {
        return Ok(());
    }

    // 3. Don't overlap with an update already in flight (e.g. a manual run).
    if update_in_flight(jobs) {
        return Ok(());
    }

    // 4. Stamp BEFORE submitting — the update occupies the single writer thread
    //    for its whole duration, so any write after submit would queue behind it.
    stamp_running(writer).await;
    let id = jobs.submit("update".into(), serde_json::json!({}));
    spawn_settle_watcher(jobs.clone(), writer.clone(), id);
    Ok(())
}

/// Record an update's terminal status to the schedule as soon as the job
/// finishes, rather than waiting for the next periodic tick — so a manual "run
/// now" flips from `running` to `ok`/`error` promptly. The periodic tick stays
/// as the fallback (e.g. when a restart kills this task mid-run).
pub fn spawn_settle_watcher(jobs: Arc<JobManager>, writer: ConnActor, job_id: String) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            match jobs.snapshot(&job_id) {
                Some(s) if s.status == "done" => {
                    mark_status(&writer, "ok".into()).await;
                    break;
                }
                Some(s) if s.status == "error" => {
                    mark_status(&writer, format!("error: {}", s.error.unwrap_or_default())).await;
                    break;
                }
                Some(_) => continue, // still running/queued
                None => break,       // job gone — leave it for the tick fallback
            }
        }
    });
}

/// The most recently submitted `update` job, or None if none are tracked.
fn latest_update(jobs: &Arc<JobManager>) -> Option<JobSnapshot> {
    jobs.list().into_iter().rfind(|j| j.job_type == "update")
}

fn update_in_flight(jobs: &Arc<JobManager>) -> bool {
    jobs.list()
        .iter()
        .any(|j| j.job_type == "update" && (j.status == "running" || j.status == "queued"))
}

// ── Clock math (all in local wall-clock time) ─────────────────────────────────

fn parse_dt(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S"))
        .ok()
}

fn hm(daily_minute: i64) -> (u32, u32) {
    let dm = daily_minute.rem_euclid(1440);
    ((dm / 60) as u32, (dm % 60) as u32)
}

/// A run is due if we have not run since the most recent occurrence of the
/// scheduled time (today's if it has passed, otherwise yesterday's). A NULL
/// `last_run` is always due, which also gives catch-up after downtime.
fn is_due(daily_minute: i64, last_run: Option<&str>) -> bool {
    let now = chrono::Local::now().naive_local();
    let (h, m) = hm(daily_minute);
    let today = now.date().and_hms_opt(h, m, 0).unwrap_or(now);
    let threshold = if now >= today { today } else { today - ChronoDuration::days(1) };
    match last_run.and_then(parse_dt) {
        Some(lr) => lr < threshold,
        None => true,
    }
}

/// The next future occurrence of the scheduled time, for display.
pub fn next_due(daily_minute: i64) -> NaiveDateTime {
    let now = chrono::Local::now().naive_local();
    let (h, m) = hm(daily_minute);
    let today = now.date().and_hms_opt(h, m, 0).unwrap_or(now);
    if now < today { today } else { today + ChronoDuration::days(1) }
}

pub fn fmt_dt(dt: NaiveDateTime) -> String {
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

// ── Schedule-row reads/writes ─────────────────────────────────────────────────

async fn read_schedule(reads: &ReadPool) -> anyhow::Result<Schedule> {
    reads
        .run(|conn| {
            conn.query_row(
                "SELECT enabled, daily_minute, CAST(last_run AS VARCHAR), last_status
                 FROM schedule WHERE id = 1",
                [],
                |r| {
                    Ok(Schedule {
                        enabled: r.get(0)?,
                        daily_minute: r.get::<_, i32>(1)? as i64,
                        last_run: r.get(2)?,
                        last_status: r.get(3)?,
                    })
                },
            )
            .map_err(|e| anyhow::anyhow!(e))
        })
        .await
}

/// Record that a run has just started: stamp `last_run = now` (local wall clock,
/// so it matches the due check) and `last_status = 'running'`. Shared by the
/// scheduler's due path and the manual "run now" endpoint.
pub async fn stamp_running(writer: &ConnActor) {
    let now = fmt_dt(chrono::Local::now().naive_local());
    let _ = writer
        .run(move |conn| {
            conn.execute(
                "UPDATE schedule SET last_run = CAST(? AS TIMESTAMP), last_status = 'running' WHERE id = 1",
                duckdb::params![now],
            )
        })
        .await;
}

async fn mark_status(writer: &ConnActor, status: String) {
    let _ = writer
        .run(move |conn| {
            conn.execute(
                "UPDATE schedule SET last_status = ? WHERE id = 1",
                duckdb::params![status],
            )
        })
        .await;
}
