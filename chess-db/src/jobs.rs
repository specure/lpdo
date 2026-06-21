//! In-process job system for the server.
//!
//! The server owns the database read-write. All mutations run here as jobs on a
//! single dedicated writer thread (so writes serialize), while query handlers
//! read through a pool of cloned connections concurrently (DuckDB MVCC). Each
//! job streams progress via a `Reporter::channel` whose events are fanned out to
//! SSE subscribers. Every operation reuses the existing functions in `importer`,
//! `twic`, `dedup`, `normalise`, `players` and the `do_*` helpers unchanged.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use duckdb::Connection;
use serde::Serialize;
use tokio::runtime::Handle;
use tokio::sync::broadcast;

use crate::reporter::{JobEvent, Reporter};

// ── Connection actor ────────────────────────────────────────────────────────

type WorkFn = Box<dyn FnOnce(&Connection) + Send + 'static>;

/// Owns one DuckDB connection on a dedicated OS thread for its whole lifetime
/// (DuckDB connections have thread affinity). Work is submitted as closures and
/// runs serially on that thread.
#[derive(Clone)]
pub struct ConnActor {
    tx: std::sync::mpsc::SyncSender<WorkFn>,
}

impl ConnActor {
    pub fn new(conn: Connection) -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<WorkFn>(128);
        std::thread::Builder::new()
            .name("duckdb".into())
            .spawn(move || {
                for work in rx {
                    work(&conn);
                }
            })
            .expect("failed to spawn db thread");
        ConnActor { tx }
    }

    /// Run a closure on the connection thread and await its result.
    pub async fn run<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Connection) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(Box::new(move |conn| {
                let _ = resp_tx.send(f(conn));
            }))
            .expect("db thread gone");
        resp_rx.await.expect("db thread dropped sender")
    }

    /// Fire-and-forget a closure — used to start a long job without awaiting it.
    pub fn spawn_fn<F>(&self, f: F)
    where
        F: FnOnce(&Connection) + Send + 'static,
    {
        let _ = self.tx.send(Box::new(f));
    }
}

// ── Read pool ───────────────────────────────────────────────────────────────

/// A pool of read connections (clones of the same DuckDB instance) so query
/// handlers run concurrently with a running write job (in-process MVCC).
#[derive(Clone)]
pub struct ReadPool {
    actors: Arc<Vec<ConnActor>>,
    next: Arc<AtomicUsize>,
}

impl ReadPool {
    pub fn new(conns: Vec<Connection>) -> Self {
        let actors: Vec<ConnActor> = conns.into_iter().map(ConnActor::new).collect();
        assert!(!actors.is_empty(), "read pool needs at least one connection");
        ReadPool { actors: Arc::new(actors), next: Arc::new(AtomicUsize::new(0)) }
    }

    /// Round-robin a read closure onto one of the pooled connections.
    pub async fn run<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Connection) -> R + Send + 'static,
        R: Send + 'static,
    {
        let i = self.next.fetch_add(1, Ordering::Relaxed) % self.actors.len();
        self.actors[i].run(f).await
    }

    /// Fire-and-forget a closure on one of the pooled connections — used to run
    /// a long read-only job (e.g. backup) without occupying the writer.
    pub fn spawn_fn<F>(&self, f: F)
    where
        F: FnOnce(&Connection) + Send + 'static,
    {
        let i = self.next.fetch_add(1, Ordering::Relaxed) % self.actors.len();
        self.actors[i].spawn_fn(f);
    }
}

// ── Jobs ────────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct JobSnapshot {
    pub id: String,
    #[serde(rename = "type")]
    pub job_type: String,
    pub status: String, // queued | running | done | error
    pub value: u64,
    pub total: u64,
    pub message: String,
    /// False for appender (fast) operations, which can corrupt the database if
    /// the process is killed mid-write — the UI uses this to guard app-close.
    pub interruptible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Whether a job uses DuckDB's appender path, which is not crash-safe: killing
/// the process mid-write can corrupt the database. Transactional jobs roll back
/// cleanly, so they are safe to interrupt.
fn uses_appender(job_type: &str, params: &serde_json::Value) -> bool {
    let fast = params.get("fast").and_then(|v| v.as_bool()).unwrap_or(false);
    match job_type {
        "import" | "import_pgn" | "index_positions" => fast,
        // The update job runs `import --fast` and `index-positions --fast`.
        "update" => true,
        _ => false,
    }
}

struct JobState {
    status: String,
    value: u64,
    total: u64,
    message: String,
    path: Option<String>,
    error: Option<String>,
}

pub struct JobSlot {
    id: String,
    job_type: String,
    interruptible: bool,
    state: Mutex<JobState>,
    events: broadcast::Sender<JobEvent>,
    buffer: Mutex<Vec<JobEvent>>,
    cancel: Arc<AtomicBool>,
}

impl JobSlot {
    fn snapshot(&self) -> JobSnapshot {
        let s = self.state.lock().unwrap();
        JobSnapshot {
            id: self.id.clone(),
            job_type: self.job_type.clone(),
            status: s.status.clone(),
            value: s.value,
            total: s.total,
            message: s.message.clone(),
            interruptible: self.interruptible,
            path: s.path.clone(),
            error: s.error.clone(),
        }
    }

    /// Buffered events so far plus a live receiver — used by the SSE handler so a
    /// subscriber that connects mid-job still sees earlier progress.
    pub fn subscribe(&self) -> (Vec<JobEvent>, broadcast::Receiver<JobEvent>) {
        // Subscribe before snapshotting the buffer so no event is missed.
        let rx = self.events.subscribe();
        let buf = self.buffer.lock().unwrap().clone();
        (buf, rx)
    }
}

const EVENT_BUFFER_CAP: usize = 512;

pub struct JobManager {
    writer: ConnActor,
    reads: ReadPool,
    rt: Handle,
    jobs: Mutex<HashMap<String, Arc<JobSlot>>>,
    order: Mutex<Vec<String>>,
    counter: AtomicU64,
}

/// Read-only jobs only read the database (e.g. backup reads games and writes a
/// PGN file). They run on the read pool so they don't queue behind a long write
/// like an index rebuild.
fn is_read_only(job_type: &str) -> bool {
    matches!(job_type, "backup")
}

impl JobManager {
    pub fn new(writer: ConnActor, reads: ReadPool, rt: Handle) -> Self {
        JobManager {
            writer,
            reads,
            rt,
            jobs: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
            counter: AtomicU64::new(1),
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<JobSlot>> {
        self.jobs.lock().unwrap().get(id).cloned()
    }

    pub fn snapshot(&self, id: &str) -> Option<JobSnapshot> {
        self.get(id).map(|s| s.snapshot())
    }

    pub fn list(&self) -> Vec<JobSnapshot> {
        let jobs = self.jobs.lock().unwrap();
        self.order
            .lock()
            .unwrap()
            .iter()
            .filter_map(|id| jobs.get(id))
            .map(|s| s.snapshot())
            .collect()
    }

    /// Request cooperative cancellation. Returns false if the job is unknown.
    pub fn cancel(&self, id: &str) -> bool {
        match self.get(id) {
            Some(slot) => {
                slot.cancel.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Enqueue a job and return its id immediately. The job runs on the writer
    /// thread (serialized after any in-flight write).
    pub fn submit(self: &Arc<Self>, job_type: String, params: serde_json::Value) -> String {
        let id = format!("job-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let (events_tx, _keep) = broadcast::channel::<JobEvent>(256);
        let slot = Arc::new(JobSlot {
            id: id.clone(),
            job_type: job_type.clone(),
            interruptible: !uses_appender(&job_type, &params),
            state: Mutex::new(JobState {
                status: "queued".into(),
                value: 0,
                total: 0,
                message: String::new(),
                path: None,
                error: None,
            }),
            events: events_tx,
            buffer: Mutex::new(Vec::new()),
            cancel: Arc::new(AtomicBool::new(false)),
        });
        {
            self.jobs.lock().unwrap().insert(id.clone(), slot.clone());
            self.order.lock().unwrap().push(id.clone());
        }

        // Event pipeline: drain the reporter's channel, update the snapshot and
        // ring buffer, and fan out to SSE subscribers. Ends when the reporter
        // (and thus its sender) is dropped at job completion.
        let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel::<JobEvent>();
        let slot_ev = slot.clone();
        self.rt.spawn(async move {
            while let Some(ev) = ev_rx.recv().await {
                {
                    let mut s = slot_ev.state.lock().unwrap();
                    if let Some(v) = ev.value {
                        s.value = v;
                    }
                    if let Some(t) = ev.total {
                        s.total = t;
                    }
                    if !ev.message.is_empty() {
                        s.message = ev.message.clone();
                    }
                    match ev.kind.as_str() {
                        "done" => {
                            s.status = "done".into();
                            if ev.path.is_some() {
                                s.path = ev.path.clone();
                            }
                        }
                        "error" => {
                            s.status = "error".into();
                            s.error = Some(ev.message.clone());
                        }
                        _ => {
                            if s.status == "queued" {
                                s.status = "running".into();
                            }
                        }
                    }
                }
                {
                    let mut b = slot_ev.buffer.lock().unwrap();
                    if b.len() >= EVENT_BUFFER_CAP {
                        b.remove(0);
                    }
                    b.push(ev.clone());
                }
                let _ = slot_ev.events.send(ev);
            }
        });

        // Job body: read-only jobs run on the read pool (concurrent with a
        // write); everything else runs on the writer thread (serialized with all
        // other writes).
        let slot_run = slot.clone();
        let cancel = slot.cancel.clone();
        let rt = self.rt.clone();
        let body = move |conn: &Connection| {
            {
                slot_run.state.lock().unwrap().status = "running".into();
            }
            let reporter = Reporter::channel(ev_tx, cancel);
            if reporter.is_cancelled() {
                reporter.error("Cancelled before start");
                return;
            }
            match run_job(&slot_run.job_type, &params, conn, &reporter, &rt) {
                // Empty message keeps the operation's own final message; this
                // just guarantees a terminal "done" even if the op didn't emit one.
                Ok(()) => reporter.done(""),
                Err(e) => reporter.error(format!("{:#}", e)),
            }
        };
        if is_read_only(&job_type) {
            self.reads.spawn_fn(body);
        } else {
            self.writer.spawn_fn(body);
        }

        id
    }
}

// ── Job dispatch ────────────────────────────────────────────────────────────

fn run_job(
    job_type: &str,
    p: &serde_json::Value,
    conn: &Connection,
    reporter: &Reporter,
    rt: &Handle,
) -> Result<()> {
    use crate::{dedup, importer, normalise, players, twic};

    match job_type {
        "download" => {
            let from = p.get("from").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            let to = p.get("to").and_then(|v| v.as_u64()).map(|v| v as u32);
            let dir = dir_param(p);
            std::fs::create_dir_all(&dir)?;
            // download() is async; drive it to completion on this writer thread.
            rt.block_on(twic::download(conn, from, to, &dir, reporter))?;
        }
        "import" => {
            let dir = dir_param(p);
            let fast = flag(p, "fast");
            let skip_dedup = flag(p, "skip_dedup");
            importer::import(conn, &dir, Some(40), 10, fast, skip_dedup, reporter)?;
        }
        "import_pgn" => {
            let path = path_param(p, "path")?;
            let collection = p.get("collection").and_then(|v| v.as_str()).unwrap_or("Manual").to_string();
            let on_duplicate = p.get("on_duplicate").and_then(|v| v.as_str()).unwrap_or("skip").to_string();
            let fast = flag(p, "fast");
            let visibility = if flag(p, "private") { "private" } else { "public" }.to_string();
            let spec = importer::ImportSpec { collection, visibility, on_duplicate };
            importer::import_pgn(conn, &path, Some(40), 10, fast, false, &spec, reporter)?;
        }
        "index_positions" => {
            importer::index_positions(conn, Some(40), flag(p, "rebuild"), flag(p, "fast"), reporter)?;
        }
        "dedup_games" => {
            dedup::dedup_games(conn, flag(p, "dry_run"), reporter)?;
        }
        "cleanup" => {
            dedup::cleanup_nonstandard(conn, flag(p, "non_standard"), flag(p, "dry_run"), reporter)?;
        }
        "normalise" => {
            let limit = p.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
            normalise::normalise_players(
                conn, flag(p, "dry_run"),
                1500, 100, 30_000, 3, 10, 7_200_000,
                flag(p, "stop_on_errors"), limit, None, None, false, reporter,
            )?;
        }
        "players_import" => {
            let path = path_param(p, "path")?;
            players::import(conn, &path, reporter)?;
        }
        "backup" => {
            let collection = p.get("collection").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("backup: 'collection' required"))?;
            let dir = path_param(p, "dir")?;
            crate::do_backup(conn, collection, &dir, reporter)?;
        }
        // The bridge for scheduled updates — mirrors ~/bin/chess-db-update.sh.
        "update" => {
            let dir = crate::default_dir();
            std::fs::create_dir_all(&dir)?;
            reporter.log("Step 1/4: download");
            rt.block_on(twic::download(conn, 1, None, &dir, reporter))?;
            if reporter.is_cancelled() { return Ok(()); }
            reporter.log("Step 2/4: import (fast)");
            importer::import(conn, &dir, None, 0, true, false, reporter)?;
            if reporter.is_cancelled() { return Ok(()); }
            reporter.log("Step 3/4: index-positions (fast)");
            importer::index_positions(conn, Some(40), false, true, reporter)?;
            if reporter.is_cancelled() { return Ok(()); }
            reporter.log("Step 4/4: players normalise");
            normalise::normalise_players(
                conn, false, 1500, 100, 30_000, 3, 10, 7_200_000, false, None, None, None, false, reporter,
            )?;
            reporter.done("Database update complete");
        }
        other => return Err(anyhow!("unknown job type: {}", other)),
    }
    Ok(())
}

fn flag(p: &serde_json::Value, key: &str) -> bool {
    p.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Resolve a directory param, expanding a leading `~` and falling back to the
/// default TWIC directory.
fn dir_param(p: &serde_json::Value) -> PathBuf {
    match p.get("dir").and_then(|v| v.as_str()) {
        Some(d) => crate::expand_home(Path::new(d)),
        None => crate::default_dir(),
    }
}

fn path_param(p: &serde_json::Value, key: &str) -> Result<PathBuf> {
    let s = p.get(key).and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("'{}' required", key))?;
    Ok(crate::expand_home(Path::new(s)))
}
