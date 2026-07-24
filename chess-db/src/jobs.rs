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

use anyhow::{anyhow, Context, Result};
use duckdb::Connection;
use serde::Serialize;
use tokio::runtime::Handle;
use tokio::sync::broadcast;

use crate::reporter::{JobEvent, Reporter};

// ── Connection actor ────────────────────────────────────────────────────────

type WorkFn = Box<dyn FnOnce(&Connection) + Send + 'static>;

/// A message to a connection actor: either a unit of work, or a request to
/// recover from a DuckDB whole-instance invalidation by swapping in a fresh
/// connection (see [`ReopenGate`]).
enum ActorMsg {
    Work(WorkFn),
    Reopen(Arc<ReopenGate>),
}

/// Owns one DuckDB connection on a dedicated OS thread for its whole lifetime
/// (DuckDB connections have thread affinity). Work is submitted as closures and
/// runs serially on that thread.
#[derive(Clone)]
pub struct ConnActor {
    tx: std::sync::mpsc::SyncSender<ActorMsg>,
}

impl ConnActor {
    pub fn new(conn: Connection) -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<ActorMsg>(128);
        std::thread::Builder::new()
            .name("duckdb".into())
            .spawn(move || {
                let mut conn = conn;
                for msg in rx {
                    match msg {
                        ActorMsg::Work(work) => work(&conn),
                        // Hand our (dead) connection to the gate and block until a
                        // fresh one is handed back. The gate drops every actor's
                        // old connection before reopening, so the invalidated
                        // DuckDB instance is fully released first.
                        ActorMsg::Reopen(gate) => conn = gate.swap(conn),
                    }
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
            .send(ActorMsg::Work(Box::new(move |conn| {
                let _ = resp_tx.send(f(conn));
            })))
            .expect("db thread gone");
        resp_rx.await.expect("db thread dropped sender")
    }

    /// Fire-and-forget a closure — used to start a long job without awaiting it.
    pub fn spawn_fn<F>(&self, f: F)
    where
        F: FnOnce(&Connection) + Send + 'static,
    {
        let _ = self.tx.send(ActorMsg::Work(Box::new(f)));
    }

    /// Enqueue a reopen request on this actor.
    fn send_reopen(&self, gate: Arc<ReopenGate>) {
        let _ = self.tx.send(ActorMsg::Reopen(gate));
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

    fn len(&self) -> usize {
        self.actors.len()
    }

    fn send_reopen_all(&self, gate: Arc<ReopenGate>) {
        for actor in self.actors.iter() {
            actor.send_reopen(gate.clone());
        }
    }
}

// ── Connection recovery ───────────────────────────────────────────────────────

/// Coordinates an in-process recovery from a DuckDB **whole-instance**
/// invalidation. The writer and every read connection are `try_clone()`s of one
/// instance, so a fatal "database has been invalidated" error kills them all at
/// once and they stay dead until the connection is reopened.
///
/// Every actor sends its (dead) connection into [`swap`](ReopenGate::swap). Once
/// all `parties` have arrived, the last one drops the collected connections —
/// releasing the invalidated instance — restores any safety snapshot, opens a
/// fresh instance, and clones it back out so each actor resumes on a live
/// connection. This is exactly what a process restart does, minus the restart.
struct ReopenGate {
    db_path: PathBuf,
    parties: usize,
    /// When true this is a *reset*, not a recovery: the old DB files are deleted
    /// and a fresh empty schema is initialised, instead of restoring a snapshot.
    reset: bool,
    inner: Mutex<GateInner>,
    cv: std::sync::Condvar,
}

struct GateInner {
    arrived: Vec<Connection>,
    fresh: Vec<Connection>,
    ready: bool,
    taken: usize,
}

impl ReopenGate {
    fn new(db_path: PathBuf, parties: usize, reset: bool) -> Self {
        ReopenGate {
            db_path,
            parties,
            reset,
            inner: Mutex::new(GateInner {
                arrived: Vec::with_capacity(parties),
                fresh: Vec::new(),
                ready: false,
                taken: 0,
            }),
            cv: std::sync::Condvar::new(),
        }
    }

    /// Surrender `old` and block until a fresh connection is available, then
    /// return it. The final arriver performs the reopen while holding the lock.
    fn swap(&self, old: Connection) -> Connection {
        let mut g = self.inner.lock().unwrap();
        g.arrived.push(old);
        if g.arrived.len() == self.parties {
            // Last arriver: drop every dead connection to release the invalidated
            // instance, then reopen a fresh one and clone it per party.
            g.arrived.clear();
            if self.reset {
                // Reset: discard the (possibly half-written) database entirely and
                // start from a fresh empty schema. Safe because reset is only ever
                // invoked on a disposable initial-setup database.
                delete_db_files(&self.db_path);
            } else if let Err(e) = restore_snapshot_if_present(&self.db_path) {
                eprintln!("reopen: safety-snapshot restore failed: {e:#}");
            }
            match open_set(&self.db_path, self.parties) {
                Ok(conns) => {
                    if self.reset {
                        if let Err(e) = crate::db::schema::init(&conns[0]) {
                            eprintln!(
                                "FATAL: could not initialise schema after reset ({e:#}). \
                                 Exiting so the service manager restarts the daemon."
                            );
                            std::process::exit(1);
                        }
                    }
                    g.fresh = conns;
                    g.ready = true;
                    self.cv.notify_all();
                }
                Err(e) => {
                    eprintln!(
                        "FATAL: could not reopen the database after invalidation ({e:#}). \
                         Exiting so the service manager restarts the daemon."
                    );
                    std::process::exit(1);
                }
            }
        }
        while !g.ready {
            g = self.cv.wait(g).unwrap();
        }
        let conn = g.fresh.pop().expect("reopen gate ran out of fresh connections");
        g.taken += 1;
        if g.taken == self.parties {
            self.cv.notify_all();
        }
        conn
    }

    /// Block until every party has swapped in its fresh connection.
    fn wait_done(&self) {
        let mut g = self.inner.lock().unwrap();
        while g.taken < self.parties {
            g = self.cv.wait(g).unwrap();
        }
    }
}

/// Open one fresh instance and clone it into `n` connections (mirrors the
/// writer + read-pool layout established in `serve::run`).
fn open_set(db_path: &Path, n: usize) -> Result<Vec<Connection>> {
    let primary = crate::db::open(db_path)?;
    let mut conns = Vec::with_capacity(n);
    for _ in 0..n.saturating_sub(1) {
        conns.push(primary.try_clone()?);
    }
    conns.push(primary);
    Ok(conns)
}

/// Whether a job error message indicates DuckDB's whole-instance invalidation —
/// the fatal state that a connection reopen recovers from.
fn is_invalidation_error(msg: &str) -> bool {
    msg.to_lowercase().contains("invalidated")
}

/// Drive a full connection reopen across the writer and read pool, blocking
/// until every actor is live again.
fn reopen_connections(writer: &ConnActor, reads: &ReadPool, db_path: PathBuf) {
    let parties = 1 + reads.len();
    let gate = Arc::new(ReopenGate::new(db_path, parties, false));
    writer.send_reopen(gate.clone());
    reads.send_reopen_all(gate.clone());
    gate.wait_done();
}

/// Reset to a fresh, empty database: surrender every connection (writer + read
/// pool), delete the database and its sidecar files, then reopen on a freshly
/// initialised empty schema. Blocks until every actor is live on the new file.
///
/// This is the clean-recovery path for an interrupted initial setup (#40 C4):
/// the database is disposable until setup succeeds, so on failure we discard it
/// and let the user re-run the wizard. Cancel in-flight jobs before calling, so
/// no queued write runs ahead of the reopen on the writer's FIFO channel.
pub(crate) fn reset_connections(writer: &ConnActor, reads: &ReadPool, db_path: PathBuf) {
    let parties = 1 + reads.len();
    let gate = Arc::new(ReopenGate::new(db_path, parties, true));
    writer.send_reopen(gate.clone());
    reads.send_reopen_all(gate.clone());
    gate.wait_done();
}

// ── Initial-setup sentinel ────────────────────────────────────────────────────
//
// A marker file written next to the database while the wizard's first-run "fast"
// pipeline runs (removed on success or reset). Because `--fast` (appender)
// imports can leave the database unopenable if interrupted, its presence lets the
// daemon recognise a disposable, mid-initial-setup database and recover cleanly
// (see the startup safety-net in `main.rs`) — never touching a populated DB.

pub fn setup_sentinel_path(db: &Path) -> PathBuf { with_suffix(db, ".setup-in-progress") }
pub fn write_setup_sentinel(db: &Path) { let _ = std::fs::write(setup_sentinel_path(db), b"1"); }
pub fn remove_setup_sentinel(db: &Path) { let _ = std::fs::remove_file(setup_sentinel_path(db)); }
pub fn setup_sentinel_present(db: &Path) -> bool { setup_sentinel_path(db).exists() }

/// Delete the database and every sidecar file (WAL, any safety snapshot, and the
/// setup sentinel) — used by the reset path and the startup safety-net to start
/// from a clean slate. Best-effort per file.
pub fn delete_db_files(db: &Path) {
    let _ = std::fs::remove_file(db);
    let _ = std::fs::remove_file(wal_path(db));
    remove_snapshot(db);
    remove_setup_sentinel(db);
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
    /// The submission params, so the UI can label a job by what it touches (e.g.
    /// which source/collection) and the scheduler can de-dupe by it.
    pub params: serde_json::Value,
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
    /// The job's submission params (e.g. `{ "source": "ajedrez-otb" }`), kept so
    /// the scheduler can de-dupe an auto-sync against an in-flight one and the
    /// Activity view can label a job by what it operates on.
    params: serde_json::Value,
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
            params: self.params.clone(),
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
    db_path: PathBuf,
    jobs: Mutex<HashMap<String, Arc<JobSlot>>>,
    order: Mutex<Vec<String>>,
    counter: AtomicU64,
    /// Set while a connection reopen is in flight, so a second failure during
    /// recovery does not start an overlapping reopen cycle.
    reopening: Arc<AtomicBool>,
    /// Debounced, coalesced post-import maintenance (#131). Import submitters
    /// call `request_maintenance`; the coalesced pass (index + normalise, plus a
    /// global dedup when a `skip_dedup` import owed one) is enqueued exactly once
    /// after the import queue drains, so later imports never miss maintenance and
    /// two passes never stack for one drain cycle.
    maintenance: Mutex<MaintenanceNeeds>,
}

/// What post-import maintenance is currently owed. `index_normalise` is the
/// always-cheap incremental tail (only new games are indexed/normalised);
/// `dedup` is set only by imports that deferred dedup (first-run `skip_dedup`),
/// since ordinary imports dedup inline.
#[derive(Default, Clone, Copy)]
struct MaintenanceNeeds {
    index_normalise: bool,
    dedup: bool,
}

/// Job types that must drain before a coalesced maintenance pass runs: any
/// import-class job (would add games maintenance must then cover) or a
/// maintenance job already in flight (don't stack a second pass).
fn blocks_maintenance(job_type: &str) -> bool {
    matches!(
        job_type,
        "import" | "import_pgn" | "sources_sync" | "download" | "update"
            | "dedup_games" | "index_positions" | "normalise"
    )
}

/// Read-only jobs only read the database (e.g. backup reads games and writes a
/// PGN file). They run on the read pool so they don't queue behind a long write
/// like an index rebuild.
fn is_read_only(job_type: &str) -> bool {
    matches!(job_type, "backup" | "players_export")
}

impl JobManager {
    pub fn new(writer: ConnActor, reads: ReadPool, rt: Handle, db_path: PathBuf) -> Self {
        JobManager {
            writer,
            reads,
            rt,
            db_path,
            jobs: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
            counter: AtomicU64::new(1),
            reopening: Arc::new(AtomicBool::new(false)),
            maintenance: Mutex::new(MaintenanceNeeds::default()),
        }
    }

    /// Whether a coalesced maintenance pass is owed but not yet enqueued (it runs
    /// once the import queue drains). Surfaced in the activity panel as a pending
    /// row so the user can see maintenance is coming while an import is still in
    /// flight (#131).
    pub fn maintenance_owed(&self) -> bool {
        self.maintenance.lock().unwrap().index_normalise
    }

    /// Request post-import maintenance (#131). Idempotent: sets the "owed" flags;
    /// the coalesced pass runs later, once the import queue has drained. Pass
    /// `needs_dedup = true` when the import deferred dedup (first-run
    /// `skip_dedup`) so a single global `dedup_games` is included in the tail.
    pub fn request_maintenance(&self, needs_dedup: bool) {
        let mut m = self.maintenance.lock().unwrap();
        m.index_normalise = true;
        m.dedup |= needs_dedup;
    }

    /// If maintenance is owed and nothing import- or maintenance-class is queued
    /// or running, enqueue the coalesced pass ([dedup] → index → normalise) once
    /// and clear the owed flags. If the queue hasn't drained yet, re-arm and wait
    /// for a later call. Safe to call from any thread and as often as you like —
    /// the flags are claimed atomically so two callers can't both submit (#131).
    pub fn maybe_run_maintenance(self: &Arc<Self>) {
        // Atomically claim what's owed so a concurrent caller sees nothing.
        let needs = {
            let mut m = self.maintenance.lock().unwrap();
            std::mem::take(&mut *m)
        };
        if !needs.index_normalise {
            return;
        }
        let busy = self
            .list()
            .iter()
            .any(|j| (j.status == "queued" || j.status == "running") && blocks_maintenance(&j.job_type));
        if busy {
            // Not drained yet — put back what we claimed and wait for a later call.
            let mut m = self.maintenance.lock().unwrap();
            m.index_normalise = true;
            m.dedup |= needs.dedup;
            return;
        }
        if needs.dedup {
            self.submit("dedup_games".to_string(), serde_json::json!({}));
        }
        self.submit("index_positions".to_string(), serde_json::json!({ "fast": true }));
        self.submit("normalise".to_string(), serde_json::json!({}));
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
            params: params.clone(),
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
        // Trigger a coalesced-maintenance drain check the instant this job ends
        // (the loop below exits when the reporter's sender drops at completion),
        // so maintenance starts right after the queue drains rather than waiting
        // for the scheduler's periodic tick. No-op unless maintenance is owed and
        // the queue is empty (#131).
        let jm = Arc::clone(self);
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
            jm.maybe_run_maintenance();
        });

        // Job body: read-only jobs run on the read pool (concurrent with a
        // write); everything else runs on the writer thread (serialized with all
        // other writes).
        let slot_run = slot.clone();
        let cancel = slot.cancel.clone();
        let rt = self.rt.clone();
        let db_path = self.db_path.clone();
        let writer = self.writer.clone();
        let reads = self.reads.clone();
        let reopening = self.reopening.clone();
        let body = move |conn: &Connection| {
            {
                slot_run.state.lock().unwrap().status = "running".into();
            }
            let reporter = Reporter::channel(ev_tx, cancel);
            if reporter.is_cancelled() {
                reporter.error("Cancelled before start");
                return;
            }
            match run_job(&slot_run.job_type, &params, conn, &reporter, &rt, &db_path) {
                // Empty message keeps the operation's own final message; this
                // just guarantees a terminal "done" even if the op didn't emit one.
                Ok(()) => reporter.done(""),
                Err(e) => {
                    let msg = format!("{:#}", e);
                    // A whole-instance DuckDB invalidation poisons every shared
                    // connection (writer + read pool). Reopen them in-process so
                    // the server recovers without a manual restart (#82). Done off
                    // this actor thread so it can return and process its own
                    // Reopen message; guarded so overlapping failures don't start
                    // a second cycle.
                    if is_invalidation_error(&msg)
                        && reopening
                            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                    {
                        let writer = writer.clone();
                        let reads = reads.clone();
                        let db_path = db_path.clone();
                        let reopening = reopening.clone();
                        std::thread::spawn(move || {
                            eprintln!(
                                "Database invalidated by a failed job — reopening the connection in-process…"
                            );
                            reopen_connections(&writer, &reads, db_path);
                            reopening.store(false, Ordering::SeqCst);
                            eprintln!("Database connection reopened; the server has recovered.");
                        });
                    }
                    reporter.error(msg);
                }
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
    db: &Path,
) -> Result<()> {
    use crate::{dedup, importer, normalise, players};

    // Fault injection for testing the auto-recovery path on a live daemon
    // (#82). Inert unless LPDO_FAULT_INJECTION is set in the server's
    // environment. Returns an error carrying DuckDB's invalidation signature so
    // the job machinery treats it like a real whole-instance invalidation and
    // exercises the in-process connection reopen. The connection isn't actually
    // poisoned (that can't be forced cleanly from SQL) — this verifies the live
    // detect → reopen → keep-serving wiring; the reopen-revives-a-dead-instance
    // half is covered by the unit tests and an empirical process restart.
    if job_type == "__fault_invalidate" {
        if std::env::var_os("LPDO_FAULT_INJECTION").is_none() {
            return Err(anyhow!(
                "__fault_invalidate is disabled; set LPDO_FAULT_INJECTION=1 on the server to enable it"
            ));
        }
        reporter.log("Fault injection: simulating a database invalidation…");
        return Err(anyhow!(
            "FATAL Error: database has been invalidated (injected fault). \
             The connection has been invalidated by a previous fatal error."
        ));
    }

    match job_type {
        "download" => {
            let source_key = p.get("source").and_then(|v| v.as_str()).unwrap_or("twic");
            let src = crate::sources::get(source_key)
                .ok_or_else(|| anyhow!("unknown source '{}'", source_key))?;
            let from = p.get("from").and_then(|v| v.as_u64()).map(|v| v as u32);
            let to = p.get("to").and_then(|v| v.as_u64()).map(|v| v as u32);
            let dir = source_dir_param(p, source_key);
            std::fs::create_dir_all(&dir)?;
            // download_feed() is async; drive it to completion on this writer thread.
            rt.block_on(crate::sources::download_feed(conn, src, from, to, &dir, reporter))?;
        }
        "import" => {
            let source_key = p.get("source").and_then(|v| v.as_str()).unwrap_or("twic");
            let src = crate::sources::get(source_key)
                .ok_or_else(|| anyhow!("unknown source '{}'", source_key))?;
            let dir = source_dir_param(p, source_key);
            let fast = flag(p, "fast");
            let skip_dedup = flag(p, "skip_dedup");
            importer::import(conn, &dir, src.key, src.collection, Some(40), 10, fast, skip_dedup, reporter)?;
        }
        "sources_set_enabled" => {
            let key = p.get("source").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("sources_set_enabled: 'source' required"))?;
            let enabled = flag(p, "enabled");
            // The GUI's acknowledge→enable gate sets credit_acked alongside enabling.
            if flag(p, "credit_acked") {
                crate::sources::acknowledge(conn, key)?;
            }
            crate::sources::set_enabled(conn, key, enabled)?;
            reporter.done(format!("Source '{}' {}.", key, if enabled { "enabled" } else { "disabled" }));
        }
        "sources_set_window" => {
            let key = p.get("source").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("sources_set_window: 'source' required"))?;
            let from = p.get("from").and_then(|v| v.as_str());
            let to = p.get("to").and_then(|v| v.as_str());
            let exclude_undated = flag(p, "exclude_undated");
            crate::sources::set_window(conn, key, from, to, exclude_undated)?;
            reporter.done(format!("Updated date window for '{}'.", key));
        }
        // Download + import one source in a single job (CLI `sources sync`, GUI).
        "sources_sync" => {
            let source_key = p.get("source").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("sources_sync: 'source' required"))?;
            let src = crate::sources::get(source_key)
                .ok_or_else(|| anyhow!("unknown source '{}'", source_key))?;
            let fast = flag(p, "fast");
            let skip_dedup = flag(p, "skip_dedup");
            // Absent (GUI/scheduler) → default depth 40; 0 disables indexing.
            let depth = match p.get("max_position_depth").and_then(|v| v.as_u64()) {
                Some(0) => None,
                Some(d) => Some(d as i16),
                None => Some(40),
            };
            let dir = crate::source_dir(source_key);
            std::fs::create_dir_all(&dir)?;
            let step = reporter.sub_step();
            let sync = (|| -> Result<()> {
                reporter.log(format!("{}: download", src.name));
                rt.block_on(crate::sources::download_feed(conn, src, None, None, &dir, &step))?;
                if reporter.is_cancelled() { return Ok(()); }
                reporter.log(format!("{}: import", src.name));
                importer::import(conn, &dir, src.key, src.collection, depth, 10, fast, skip_dedup, &step)?;
                // Complete the maintenance the import may have deferred, so a large
                // (bulk) sync is immediately searchable instead of waiting for the
                // next daily update (#145/#146).
                run_post_import_maintenance(conn, db, depth, fast, &step, src.name)?;
                Ok(())
            })();
            // Record the run's outcome so the enable→auto-sync scheduler doesn't
            // re-fire a source that finished or failed (a still-NULL last_run is
            // what marks a source as "never synced"). A user cancellation also
            // records, so it isn't auto-restarted; only a crash/restart mid-sync
            // leaves last_run NULL, so an interrupted sync resumes. Errors still
            // propagate (via `?`) so a DuckDB invalidation triggers recovery (#82).
            if reporter.is_cancelled() {
                let _ = crate::sources::record_run(conn, src.key, "cancelled");
                return Ok(());
            }
            match sync {
                Ok(()) => {
                    crate::sources::record_run(conn, src.key, "ok")?;
                    reporter.done(format!("{} synced.", src.name));
                }
                Err(e) => {
                    let _ = crate::sources::record_run(conn, src.key, &format!("error: {e}"));
                    return Err(e);
                }
            }
        }
        "import_pgn" => {
            let collection = p.get("collection").and_then(|v| v.as_str()).unwrap_or("Manual").to_string();
            let on_duplicate = p.get("on_duplicate").and_then(|v| v.as_str()).unwrap_or("skip").to_string();
            let fast = flag(p, "fast");
            // A bulk upload sets `skip_dedup` so a single background `dedup_games`
            // pass (coalesced maintenance, #131) does the dedup instead — keeping
            // per-game fingerprinting and a growing in-memory fingerprint map off
            // the critical path of a multi-million-game load (#154).
            let skip_dedup = flag(p, "skip_dedup");
            let visibility = if flag(p, "private") { "private" } else { "public" }.to_string();
            let spec = importer::ImportSpec { collection, visibility, on_duplicate };
            // Absent → default depth 40; 0 disables position indexing (bulk loads).
            let depth = match p.get("max_position_depth").and_then(|v| v.as_u64()) {
                Some(0) => None,
                Some(d) => Some(d as i16),
                None => Some(40),
            };
            // #121: the client may send PGN *content* instead of a path, because the
            // hardened system daemon (ProtectHome/PrivateTmp) can't read files in the
            // user's home or /tmp. Write it to a daemon-owned temp beside the DB
            // (which the daemon can read/write), import, then clean up. A `path`
            // (a daemon-local file, or the `--local` CLI) still works unchanged.
            let import_res = if let Some(content) = p.get("content").and_then(|v| v.as_str()) {
                let dir = db.parent().unwrap_or_else(|| Path::new("."));
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let tmp = dir.join(format!("upload-{stamp}.pgn"));
                std::fs::write(&tmp, content)
                    .with_context(|| format!("writing uploaded PGN to {}", tmp.display()))?;
                let res = importer::import_pgn(conn, &tmp, depth, 10, fast, skip_dedup, &spec, reporter);
                let _ = std::fs::remove_file(&tmp);
                res
            } else {
                let path = path_param(p, "path")?;
                let res = importer::import_pgn(conn, &path, depth, 10, fast, skip_dedup, &spec, reporter);
                // Streamed uploads (#154) spool to a daemon-owned file and set
                // `cleanup` so it's removed once imported (success or failure).
                if flag(p, "cleanup") {
                    let _ = std::fs::remove_file(&path);
                }
                res
            };
            import_res?;
        }
        "index_positions" => {
            run_index_positions_guarded(conn, db, Some(40), flag(p, "rebuild"), flag(p, "fast"), reporter)?;
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
        "players_export" => {
            // Two shapes: an explicit `path` (the CLI `players export <path>`),
            // or a `dir` into which we write a date-stamped file (the GUI, which
            // then offers "Reveal in file manager").
            let path = if let Ok(path) = path_param(p, "path") {
                match path.parent() {
                    Some(parent) if !parent.as_os_str().is_empty() => {
                        std::fs::create_dir_all(parent)
                            .with_context(|| format!("cannot create export directory {}", parent.display()))?;
                    }
                    _ => {}
                }
                path
            } else {
                let dir = path_param(p, "dir")?;
                std::fs::create_dir_all(&dir)
                    .with_context(|| format!("cannot create export directory {}", dir.display()))?;
                let stamp = chrono::Local::now().format("%Y%m%d");
                dir.join(format!("{stamp}-players.csv"))
            };
            let n = players::export(conn, &path)?;
            if n == 0 {
                anyhow::bail!("no normalised players to export");
            }
            reporter.done_with_path(
                format!("Exported {} player(s) to {}", n, path.display()),
                path.display(),
            );
        }
        "backup" => {
            let collection = p.get("collection").and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("backup: 'collection' required"))?;
            let dir = path_param(p, "dir")?;
            crate::do_backup(conn, collection, &dir, reporter)?;
        }
        // Scheduled/manual update: refresh every enabled feed source, then run a
        // single global index + normalise pass. Generalized from the old TWIC-only
        // pipeline (#40).
        "update" => {
            // Each step's own `done` would otherwise terminate the job's event
            // stream after step 1; the sub-step reporter downgrades those to log
            // lines so only the final `done` below ends the job.
            let step = reporter.sub_step();
            let feeds = crate::sources::enabled_feeds(conn)?;
            if feeds.is_empty() {
                reporter.done("No feed sources enabled — nothing to update.");
                return Ok(());
            }
            for (i, src) in feeds.iter().enumerate() {
                if reporter.is_cancelled() { return Ok(()); }
                let dir = crate::source_dir(src.key);
                std::fs::create_dir_all(&dir)?;
                reporter.log(format!("[{}/{}] {}: download", i + 1, feeds.len(), src.name));
                // Errors propagate (via ?) so a fatal DuckDB invalidation reaches
                // the job's error handler and triggers in-process recovery (#82/#87).
                rt.block_on(crate::sources::download_feed(conn, src, None, None, &dir, &step))?;
                if reporter.is_cancelled() { return Ok(()); }
                reporter.log(format!("{}: import (fast)", src.name));
                importer::import(conn, &dir, src.key, src.collection, None, 0, true, false, &step)?;
                crate::sources::record_run(conn, src.key, "ok")?;
            }
            if reporter.is_cancelled() { return Ok(()); }
            reporter.log("Indexing positions (fast)");
            run_index_positions_guarded(conn, db, Some(40), false, true, &step)?;
            if reporter.is_cancelled() { return Ok(()); }
            reporter.log("Normalising players");
            normalise::normalise_players(
                conn, false, 1500, 100, 30_000, 3, 10, 7_200_000, false, None, None, None, false, &step,
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
/// per-source download directory (`data_root/<source_key>`) (#40).
fn source_dir_param(p: &serde_json::Value, source_key: &str) -> PathBuf {
    match p.get("dir").and_then(|v| v.as_str()) {
        Some(d) => crate::expand_home(Path::new(d)),
        None => crate::source_dir(source_key),
    }
}

fn path_param(p: &serde_json::Value, key: &str) -> Result<PathBuf> {
    let s = p.get(key).and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("'{}' required", key))?;
    Ok(crate::expand_home(Path::new(s)))
}

// ── Safety snapshot (for the from-scratch index rebuild) ──────────────────────
//
// A from-scratch rebuild uses the appender, which is not crash-safe. Before it
// runs we copy the database to `<db>.snapshot`; on success we delete it, and if
// it's left behind (crash / failure) the next server start restores it. The copy
// uses a reflink where the filesystem supports it (instant, space-efficient),
// and degrades to "warn and proceed without a snapshot" on any failure.

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}
/// A fast incremental index only takes a (whole-DB) safety snapshot when at least
/// this many games are pending — below it the copy cost isn't worth it and a
/// killed appender just leaves a consistent partial to resume. A rebuild always
/// snapshots regardless of this. (#139)
const FAST_INDEX_SNAPSHOT_THRESHOLD: i64 = 200_000;

/// Run a position index with the fast-path safety-snapshot guard (#139). Shared
/// by the daemon job handler and the `--local` CLI path so both are crash-safe
/// even with fast (appender) inserts as the default.
///
/// Fast indexing isn't crash-safe, so for a rebuild or a large incremental we
/// CHECKPOINT + copy the DB to `<db>.snapshot` first; on success it's removed, and
/// on a crash it's restored on next start (see `restore_snapshot_if_present`).
/// Small incrementals skip it (cheap, and a killed appender only leaves a
/// consistent partial to resume), as does first-run setup (the setup sentinel
/// already protects a disposable DB).
/// After an import, complete the maintenance the import may have deferred so the
/// new games are immediately searchable and FIDE-normalised: build any positions
/// the import skipped, then normalise new players. Both are incremental and
/// idempotent (cheap no-ops when nothing is pending). Dedup runs inline during
/// import. `reporter` must be a sub-step reporter — each step emits its own
/// `done`, so only the caller's final `done` should terminate the job.
fn run_post_import_maintenance(
    conn: &Connection,
    db: &Path,
    depth: Option<i16>,
    fast: bool,
    reporter: &Reporter,
    label: &str,
) -> Result<()> {
    if reporter.is_cancelled() {
        return Ok(());
    }
    // Skip when indexing is disabled (depth 0/None) — passing None would *clear*
    // the positions table rather than skip it (#144 + #145/#146).
    if depth.is_some() {
        reporter.log(format!("{label}: indexing positions"));
        run_index_positions_guarded(conn, db, depth, false, fast, reporter)?;
    }
    if reporter.is_cancelled() {
        return Ok(());
    }
    reporter.log(format!("{label}: normalising players"));
    crate::normalise::normalise_players(
        conn, false, 1500, 100, 30_000, 3, 10, 7_200_000, false, None, None, None, false, reporter,
    )?;
    Ok(())
}

pub fn run_index_positions_guarded(
    conn: &Connection,
    db: &Path,
    depth: Option<i16>,
    rebuild: bool,
    fast: bool,
    reporter: &Reporter,
) -> Result<()> {
    let pending = crate::importer::pending_position_count(conn, rebuild).unwrap_or(0);
    let snapshotted = fast
        && (rebuild || pending >= FAST_INDEX_SNAPSHOT_THRESHOLD)
        && !setup_sentinel_present(db)
        && make_safety_snapshot(conn, db, reporter);
    let res = crate::importer::index_positions(conn, depth, rebuild, fast, reporter);
    if snapshotted {
        match &res {
            Ok(_) => {
                remove_snapshot(db);
                reporter.log("Safety snapshot removed.");
            }
            Err(_) => reporter.log(
                "Indexing did not complete — the safety snapshot will be restored on next start.",
            ),
        }
    }
    res
}

pub fn snapshot_path(db: &Path) -> PathBuf { with_suffix(db, ".snapshot") }
fn snapshot_tmp_path(db: &Path) -> PathBuf { with_suffix(db, ".snapshot.tmp") }
fn wal_path(db: &Path) -> PathBuf { with_suffix(db, ".wal") }
fn snapshot_wal_path(db: &Path) -> PathBuf { with_suffix(db, ".snapshot.wal") }

#[cfg(unix)]
fn copy_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    // Prefer a reflink (instant + space-efficient on Btrfs/XFS/ZFS/APFS),
    // falling back to a full byte copy on ext4 etc.
    let reflinked = std::process::Command::new("cp")
        .arg("--reflink=auto").arg("-f").arg("--").arg(src).arg(dst)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if reflinked {
        return Ok(());
    }
    std::fs::copy(src, dst).map(|_| ())
}
#[cfg(not(unix))]
fn copy_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::copy(src, dst).map(|_| ())
}

/// Best-effort consistent snapshot before a risky rebuild. Returns true if one
/// was made; on any failure (e.g. low disk) it warns and returns false so the
/// caller proceeds without a snapshot.
fn make_safety_snapshot(conn: &Connection, db: &Path, reporter: &Reporter) -> bool {
    reporter.log("Creating a safety snapshot of the database before rebuilding…");
    // Flush the WAL into the main file when possible; we also copy the WAL if it
    // remains, so the snapshot is consistent either way.
    let _ = conn.execute_batch("CHECKPOINT;");

    let tmp = snapshot_tmp_path(db);
    let _ = std::fs::remove_file(&tmp);
    if let Err(e) = copy_file(db, &tmp) {
        reporter.log(format!("Could not create safety snapshot ({e}); proceeding without one."));
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    // Publish atomically — a crash mid-copy leaves only the .tmp.
    if let Err(e) = std::fs::rename(&tmp, snapshot_path(db)) {
        reporter.log(format!("Could not finalise safety snapshot ({e}); proceeding without one."));
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    let wal = wal_path(db);
    if wal.exists() {
        let _ = copy_file(&wal, &snapshot_wal_path(db));
    }
    reporter.log("Safety snapshot created.");
    true
}

fn remove_snapshot(db: &Path) {
    let _ = std::fs::remove_file(snapshot_path(db));
    let _ = std::fs::remove_file(snapshot_wal_path(db));
    let _ = std::fs::remove_file(snapshot_tmp_path(db));
}

/// At server startup: a leftover safety snapshot means the previous rebuild did
/// not complete cleanly — restore it over the (possibly corrupt) database.
pub fn restore_snapshot_if_present(db: &Path) -> Result<()> {
    let _ = std::fs::remove_file(snapshot_tmp_path(db)); // stray partial copy
    let snap = snapshot_path(db);
    if !snap.exists() {
        return Ok(());
    }
    eprintln!(
        "A previous index rebuild did not finish cleanly — restoring the database from its safety snapshot…"
    );
    let _ = std::fs::remove_file(db);
    let _ = std::fs::remove_file(wal_path(db));
    std::fs::rename(&snap, db)?;
    let snap_wal = snapshot_wal_path(db);
    if snap_wal.exists() {
        std::fs::rename(&snap_wal, wal_path(db))?;
    }
    eprintln!("Database restored from snapshot.");
    Ok(())
}

#[cfg(test)]
mod reopen_tests {
    use super::*;
    use std::sync::mpsc;

    /// Mirror `serve::run`'s layout: one writer + a read pool, all clones of one
    /// instance. After a reopen every actor must run on a live connection and see
    /// the committed data — proving the gate drops the old instance, reopens, and
    /// redistributes without deadlocking.
    #[test]
    fn reopen_yields_live_consistent_connections() {
        let dir = std::env::temp_dir().join(format!("lpdo-reopen-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");

        let conn = crate::db::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE t(x INT); INSERT INTO t VALUES (1), (2), (3);")
            .unwrap();

        let mut readers = Vec::new();
        for _ in 0..4 {
            readers.push(conn.try_clone().unwrap());
        }
        let reads = ReadPool::new(readers);
        let writer = ConnActor::new(conn);

        // Recover the whole instance in-process (the real trigger drops dead
        // connections; here they are simply valid clones being swapped out).
        reopen_connections(&writer, &reads, db.clone());

        // The writer is live: it can both read existing rows and commit a new one.
        let (tx, rx) = mpsc::channel();
        writer.spawn_fn(move |c| {
            let n: i64 = c.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
            c.execute("INSERT INTO t VALUES (4)", []).unwrap();
            tx.send(n).unwrap();
        });
        assert_eq!(rx.recv().unwrap(), 3, "writer lost data across reopen");

        // Every read actor is live and sees the writer's post-reopen commit.
        for _ in 0..4 {
            let (tx, rx) = mpsc::channel();
            reads.spawn_fn(move |c| {
                let n: i64 = c.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
                tx.send(n).unwrap();
            });
            assert_eq!(rx.recv().unwrap(), 4, "read connection dead or stale after reopen");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A reopen can run repeatedly (the recovery path is re-entrant across cycles).
    #[test]
    fn reopen_is_repeatable() {
        let dir = std::env::temp_dir().join(format!("lpdo-reopen2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");

        let conn = crate::db::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE t(x INT); INSERT INTO t VALUES (42);")
            .unwrap();
        let reads = ReadPool::new(vec![conn.try_clone().unwrap(), conn.try_clone().unwrap()]);
        let writer = ConnActor::new(conn);

        for _ in 0..3 {
            reopen_connections(&writer, &reads, db.clone());
        }

        let (tx, rx) = mpsc::channel();
        writer.spawn_fn(move |c| {
            let v: i64 = c.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
            tx.send(v).unwrap();
        });
        assert_eq!(rx.recv().unwrap(), 42);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

