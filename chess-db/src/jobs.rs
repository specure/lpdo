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
//
// The file content is two integers — `"<resume_attempts> <imported_issue_count>"`
// — used to auto-resume an interrupted first-run load on the next start (#134)
// while capping a poison-job crash loop: the count is the durable progress
// yardstick (imported issues only grow), so a resume that makes progress resets
// the attempt counter and only a run that makes *no* progress across
// `SETUP_RESUME_CAP` restarts gives up. A legacy `"1"` parses as (1, 0).

pub fn setup_sentinel_path(db: &Path) -> PathBuf { with_suffix(db, ".setup-in-progress") }
pub fn write_setup_sentinel(db: &Path) { set_setup_sentinel(db, 0, 0); }
pub fn set_setup_sentinel(db: &Path, attempts: u32, imported: u64) {
    let _ = std::fs::write(setup_sentinel_path(db), format!("{attempts} {imported}"));
}
/// `(resume_attempts, imported_issue_count)` recorded in the sentinel; `(0, 0)`
/// if it's absent or unparseable.
pub fn read_setup_sentinel(db: &Path) -> (u32, u64) {
    let s = match std::fs::read_to_string(setup_sentinel_path(db)) {
        Ok(s) => s,
        Err(_) => return (0, 0),
    };
    let mut it = s.split_whitespace();
    let attempts = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let imported = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    (attempts, imported)
}
pub fn remove_setup_sentinel(db: &Path) { let _ = std::fs::remove_file(setup_sentinel_path(db)); }
pub fn setup_sentinel_present(db: &Path) -> bool { setup_sentinel_path(db).exists() }

/// Whether the database holds at least one game. Cheap (LIMIT 1, no full scan).
fn db_has_games(conn: &Connection) -> bool {
    conn.query_row("SELECT 1 FROM games LIMIT 1", [], |_| Ok(())).is_ok()
}

/// A first-run load is *disposable* — safe to skip the pre-op safety snapshot and
/// to let the startup safety-net wipe the DB on an open failure — only while the
/// setup sentinel is present AND the database is still empty. Once it holds games
/// (a genuine partial load, or a STALE sentinel left on a populated DB, #143) the
/// data must be protected: take the snapshot regardless of the sentinel. Because
/// `serve` restores a snapshot before opening, a populated DB then always has a
/// restore point, so a corrupting op recovers instead of being auto-deleted.
fn setup_load_is_disposable(conn: &Connection, db: &Path) -> bool {
    setup_sentinel_present(db) && !db_has_games(conn)
}

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
    /// Whether a *running* job honours cooperative cancellation (its loop polls
    /// is_cancelled and stops on a committed boundary). Distinct from
    /// `interruptible`: a fast import can't be killed mid-write but CAN be asked
    /// to stop between batches. The UI shows the Cancel button on this.
    pub cancellable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Epoch-ms when the job started running / reached a terminal state (#170).
    /// Live-session only (the registry is cleared on restart).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    /// Epoch-ms of the next auto-retry while the job is `"waiting"` for a network
    /// connection (#206). Drives the panel's "retry in ~X min" countdown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<u64>,
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
        // fide_refresh bulk-appends ~1.9M rows into fide_players.
        "fide_refresh" => true,
        _ => false,
    }
}

/// Wall-clock epoch milliseconds — for job started/ended timestamps (#170). The
/// job registry is in-memory (cleared on restart), so these are live-session
/// only, not a durable history.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct JobState {
    status: String,
    value: u64,
    total: u64,
    message: String,
    path: Option<String>,
    error: Option<String>,
    /// Epoch-ms when the job first flipped to `running`, and when it reached a
    /// terminal state (done/error/cancelled). Drive the activity panel's
    /// "5 min ago · took 30s" (#170). None until each transition happens.
    started_at: Option<u64>,
    ended_at: Option<u64>,
    /// Epoch-ms of the next automatic retry while `status == "waiting"` — a
    /// network job paused because the machine is offline (#206). None otherwise.
    retry_at: Option<u64>,
}

pub struct JobSlot {
    id: String,
    job_type: String,
    /// Submission order (the counter value at submit). Used by the offline gate to
    /// compare "earlier than" without parsing the id (#206 dependency model).
    seq: u64,
    /// Jobs submitted together as one logical operation share a cluster id (the
    /// maintenance chain, the wizard's per-source syncs, a scheduler resync batch).
    /// A job submitted on its own gets a unique cluster (its own id). The offline
    /// gate holds a job behind an earlier *same-cluster* job that's stuck; solo
    /// jobs from other clusters skip ahead (#206 dependency model).
    cluster: String,
    /// The job's submission params (e.g. `{ "source": "ajedrez-otb" }`), kept so
    /// the scheduler can de-dupe an auto-sync against an in-flight one and the
    /// Activity view can label a job by what it operates on.
    params: serde_json::Value,
    interruptible: bool,
    state: Mutex<JobState>,
    events: broadcast::Sender<JobEvent>,
    buffer: Mutex<Vec<JobEvent>>,
    cancel: Arc<AtomicBool>,
    /// Bumped on every (re)schedule of an offline retry so a superseded timer —
    /// e.g. after a manual "Retry now" or a cancel — fires as a no-op (#206).
    retry_gen: AtomicU64,
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
            cancellable: is_cancellable(&self.job_type),
            path: s.path.clone(),
            error: s.error.clone(),
            started_at: s.started_at,
            ended_at: s.ended_at,
            retry_at: s.retry_at,
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
    /// Jobs held behind a stuck (paused/deferred) job, in submission order (#206).
    /// A held job stays `queued` and is re-dispatched from here once the thing it
    /// waited on resolves, so the queue reads as one paused job with the rest
    /// queued behind it, not N paused jobs. Holds both network jobs (waiting for
    /// the offline leader) and non-network jobs (waiting for an earlier stuck job
    /// in their own cluster).
    held: Mutex<Vec<Arc<JobSlot>>>,
    /// The single global offline "leader" — the one network job showing "waiting"
    /// with a Retry-now button — or None when no network job is paused (#206).
    /// Only network jobs go offline, and the network rule holds every *later*
    /// network job behind the earliest one, so there is at most one leader ever.
    /// Set SYNCHRONOUSLY the instant a job detects offline (not via the async
    /// status event) so the very next job's gate check sees it — otherwise the
    /// writer moves on before the "waiting" status propagates and a second job
    /// runs and pauses too. Held as the `Arc` so the gate can read its seq/cluster.
    offline_leader: Mutex<Option<Arc<JobSlot>>>,
}

/// What post-import maintenance is currently owed (#131, #167). `requested` marks
/// that a coalesced pass should run once the import queue drains. There is a
/// single pass now that `dedup_games` is incremental (#—): the identity-first
/// pipeline is cheap enough to run after every sync, so there's no longer a
/// separate light/full distinction.
#[derive(Default, Clone, Copy)]
struct MaintenanceNeeds {
    /// Any coalesced maintenance is owed.
    requested: bool,
}

/// Job types that must drain before a coalesced maintenance pass runs: any
/// import-class job (would add games maintenance must then cover) or a
/// maintenance job already in flight (don't stack a second pass).
/// Job types whose long-running loop polls `is_cancelled` and can stop mid-run on
/// a committed boundary (#157/#140). A feed `download` stops between item files
/// (download_feed checks is_cancelled per item). Short/atomic jobs (normalise,
/// resolve_fide) and the single-stream FIDE-list download aren't cancellable
/// mid-flight, so the UI doesn't offer a (dead) Cancel for them while running —
/// but any queued job can still be cancelled before it starts.
fn is_cancellable(job_type: &str) -> bool {
    matches!(
        job_type,
        "import" | "import_pgn" | "sources_sync" | "update" | "download"
            | "index_positions" | "dedup_games" | "dedup_players"
    )
}

/// How long a network job pauses before retrying while the machine is offline
/// (#206). Fixed interval; a connectivity probe (Phase 2) would resume sooner.
const OFFLINE_RETRY_MS: u64 = 15 * 60 * 1000;

/// Job types that make network requests, so a connectivity failure should pause
/// and retry rather than fail (#206). Local jobs (import/dedup/index/…) never do.
fn job_uses_network(job_type: &str) -> bool {
    matches!(job_type, "download" | "sources_sync" | "update" | "fide_refresh")
}

/// The offline-gate dependency predicate in pure form (#206): does any earlier
/// *stuck* job (the paused network leader, or an already-deferred job) block
/// `job`? Each `stuck` entry is `(seq, cluster, is_network)`. A stuck job `k`
/// blocks `job` when it was submitted earlier (`k.seq < job_seq`) AND either the
/// cluster rule (`k.cluster == job_cluster` — cluster-mates wait) or the network
/// rule (`job_net && k.net` — network jobs run one-at-a-time) applies. The leader
/// re-running from its own retry timer never blocks itself (its seq isn't
/// strictly less than its own).
fn offline_gate_blocks(
    job_seq: u64,
    job_cluster: &str,
    job_net: bool,
    stuck: &[(u64, &str, bool)],
) -> bool {
    stuck.iter().any(|&(seq, cluster, net)| {
        seq < job_seq && (cluster == job_cluster || (job_net && net))
    })
}

fn blocks_maintenance(job_type: &str) -> bool {
    matches!(
        job_type,
        "import" | "import_pgn" | "sources_sync" | "download" | "update"
            | "fide_refresh" | "resolve_fide" | "dedup_players" | "dedup_games"
            | "index_positions" | "normalise"
    )
}

/// Read-only jobs only read the database (e.g. backup reads games and writes a
/// PGN file). They run on the read pool so they don't queue behind a long write
/// like an index rebuild.
fn is_read_only(job_type: &str) -> bool {
    matches!(job_type, "backup" | "players_export" | "resolve_export")
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
            held: Mutex::new(Vec::new()),
            offline_leader: Mutex::new(None),
        }
    }

    /// Whether the job about to run should HOLD (stay queued) rather than run,
    /// because an *earlier* stuck job (the paused network leader, or an already-
    /// deferred job) sits ahead of it under either dependency rule (#206):
    ///
    ///   * cluster rule — an earlier job in the SAME cluster is stuck, so later
    ///     cluster-mates wait for it (e.g. `resolve_fide` waits for a paused
    ///     `fide_refresh` in the maintenance chain);
    ///   * network rule — this is a network job and an earlier NETWORK job (any
    ///     cluster) is stuck, so network jobs run strictly one-at-a-time and only
    ///     the earliest is ever paused/retryable.
    ///
    /// The leader itself (re-running from its retry timer) never matches (its seq
    /// isn't < its own), so it runs to re-test the connection. Locks leader before
    /// held everywhere to keep a consistent order.
    fn gate_should_hold(&self, job: &JobSlot) -> bool {
        let leader = self.offline_leader.lock().unwrap();
        let held = self.held.lock().unwrap();
        let stuck: Vec<(u64, &str, bool)> = leader
            .iter()
            .chain(held.iter())
            .map(|k| (k.seq, k.cluster.as_str(), job_uses_network(&k.job_type)))
            .collect();
        offline_gate_blocks(
            job.seq,
            &job.cluster,
            job_uses_network(&job.job_type),
            &stuck,
        )
    }

    /// The leader resolved (reconnected + finished, errored for real, or was
    /// cancelled): clear it and re-dispatch every held job in submission order
    /// (#206). Each re-runs the gate, so most proceed and the next offline network
    /// job becomes the new leader; a job still blocked (e.g. an earlier cluster-mate
    /// hasn't run yet) simply re-holds. Idempotent.
    fn release_held(self: &Arc<Self>) {
        *self.offline_leader.lock().unwrap() = None;
        let held: Vec<Arc<JobSlot>> = std::mem::take(&mut *self.held.lock().unwrap());
        for slot in held {
            if slot.cancel.load(Ordering::Relaxed) {
                continue; // cancelled while held — drop it
            }
            self.dispatch(slot);
        }
    }

    /// Whether a coalesced maintenance pass is owed but not yet enqueued (it runs
    /// once the import queue drains). Surfaced in the activity panel as a pending
    /// row so the user can see maintenance is coming while an import is still in
    /// flight (#131).
    pub fn maintenance_owed(&self) -> bool {
        self.maintenance.lock().unwrap().requested
    }

    /// Request post-import maintenance (#131). Idempotent: sets the "owed" flag;
    /// the coalesced pass runs later, once the import queue has drained. Every
    /// caller (feed sync, first-run setup, bulk import) requests the same
    /// identity-first pass — `dedup_games` is incremental (#—), so there is no
    /// longer a light-vs-full choice.
    pub fn request_maintenance(&self) {
        self.maintenance.lock().unwrap().requested = true;
    }

    /// Cancel owed-but-not-yet-enqueued maintenance (the synthetic
    /// "maintenance-pending" row). Clears the flags so the coalesced pass won't
    /// start when the import queue drains. A later import can re-request it.
    pub fn clear_maintenance(&self) {
        *self.maintenance.lock().unwrap() = MaintenanceNeeds::default();
    }

    /// If maintenance is owed and nothing import- or maintenance-class is queued
    /// or running, enqueue the coalesced pass once and clear the owed flag. The
    /// single identity-first pass (#167) is resolve-fide → dedup_players →
    /// normalise → dedup_games → index; `dedup_games` is incremental (#—), so
    /// it's affordable after every sync and there's no longer a light variant. If
    /// the queue hasn't drained yet, re-arm and wait for a later call. Safe to
    /// call from any thread and as often as you like — the flag is claimed
    /// atomically so two callers can't both submit (#131).
    pub fn maybe_run_maintenance(self: &Arc<Self>) {
        // Atomically claim what's owed so a concurrent caller sees nothing.
        let needs = {
            let mut m = self.maintenance.lock().unwrap();
            std::mem::take(&mut *m)
        };
        if !needs.requested {
            return;
        }
        let busy = self.list().iter().any(|j| {
            // "waiting" (offline-paused, #206) counts as in-flight: don't run
            // maintenance until the paused sync has actually imported.
            matches!(j.status.as_str(), "queued" | "running" | "waiting")
                && blocks_maintenance(&j.job_type)
        });
        if busy {
            // Not drained yet — put back what we claimed and wait for a later call.
            self.maintenance.lock().unwrap().requested = true;
            return;
        }
        // Identity-first (#167): consolidate players (fetch FIDE IDs, merge
        // same-FIDE-ID rows, canonicalise names) BEFORE deduplicating games —
        // dedup_games keys on player IDs — then index once the dust settles.
        // `dedup_games` is incremental (#—) so it's cheap to run every time; the
        // former light pass (normalise → index only) is gone.
        //
        // Ensure the FIDE list exists/current before it's used (no-op when
        // fresh, so no re-download per import); then the identity steps.
        // One cluster for the whole chain so that if `fide_refresh` pauses offline,
        // the identity steps that depend on the FIDE list (`resolve_fide`,
        // `normalise`) — and their neighbours — wait for it rather than jumping
        // ahead and failing with "No FIDE list loaded" (#206).
        let c = self.next_cluster_id();
        let m = |t: &str, p| self.submit_in_cluster(t.to_string(), p, Some(c.clone()));
        m("fide_refresh", serde_json::json!({ "if_due": true }));
        m("resolve_fide", serde_json::json!({}));
        m("dedup_players", serde_json::json!({}));
        m("normalise", serde_json::json!({}));
        m("dedup_games", serde_json::json!({}));
        m("index_positions", serde_json::json!({ "fast": true }));
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
    ///
    /// A job that hasn't started yet (still `queued`) is marked `cancelled`
    /// immediately, so it leaves the visible queue at once (#161) instead of
    /// appearing stuck until the writer thread reaches it — the writer then skips
    /// it (the body's start-of-run cancellation check). A running job just gets
    /// the flag; its loop stops at the next committed boundary.
    pub fn cancel(self: &Arc<Self>, id: &str) -> bool {
        match self.get(id) {
            Some(slot) => {
                slot.cancel.store(true, Ordering::Relaxed);
                // Invalidate any pending offline-retry timer so it fires as a no-op.
                slot.retry_gen.fetch_add(1, Ordering::SeqCst);
                // The offline leader? Cancelling it must free the jobs held behind
                // it so one can take over (#206). Uses the synchronous id, not the
                // (async) "waiting" status.
                let was_leader =
                    self.offline_leader.lock().unwrap().as_ref().map(|l| l.id.as_str()) == Some(id);
                {
                    let mut s = slot.state.lock().unwrap();
                    // Queued (never ran) or waiting (paused for network): terminate
                    // now. A running job just gets the flag + stops on a boundary.
                    if s.status == "queued" || s.status == "waiting" {
                        s.status = "cancelled".into();
                        s.message = "Cancelled".into();
                        s.ended_at = Some(now_ms());
                        s.retry_at = None;
                    }
                }
                if was_leader {
                    self.release_held(); // clears offline_leader + re-dispatches held
                }
                true
            }
            None => false,
        }
    }

    /// A fresh cluster id for a batch of jobs that should wait for each other under
    /// the offline gate's cluster rule (#206). Reuses the job counter, so it can't
    /// collide with a solo job's own-id cluster (`job-N` vs `batch-N`).
    pub fn next_cluster_id(&self) -> String {
        format!("batch-{}", self.counter.fetch_add(1, Ordering::Relaxed))
    }

    /// Enqueue a job and return its id immediately. The job runs on the writer
    /// thread (serialized after any in-flight write). Solo: its cluster is its own
    /// id, so no other job waits on it (except via the network rule) (#206).
    pub fn submit(self: &Arc<Self>, job_type: String, params: serde_json::Value) -> String {
        self.submit_in_cluster(job_type, params, None)
    }

    /// Like [`submit`], but places the job in an explicit cluster so later jobs in
    /// the same cluster wait for it under the offline gate (#206). `cluster: None`
    /// makes it solo (cluster = its own id).
    pub fn submit_in_cluster(
        self: &Arc<Self>,
        job_type: String,
        params: serde_json::Value,
        cluster: Option<String>,
    ) -> String {
        let seq = self.counter.fetch_add(1, Ordering::Relaxed);
        let id = format!("job-{seq}");
        let (events_tx, _keep) = broadcast::channel::<JobEvent>(256);
        let interruptible = !uses_appender(&job_type, &params);
        let slot = Arc::new(JobSlot {
            id: id.clone(),
            job_type,
            seq,
            cluster: cluster.unwrap_or_else(|| id.clone()),
            params,
            interruptible,
            state: Mutex::new(JobState {
                status: "queued".into(),
                value: 0,
                total: 0,
                message: String::new(),
                path: None,
                error: None,
                started_at: None,
                ended_at: None,
                retry_at: None,
            }),
            events: events_tx,
            buffer: Mutex::new(Vec::new()),
            cancel: Arc::new(AtomicBool::new(false)),
            retry_gen: AtomicU64::new(0),
        });
        {
            self.jobs.lock().unwrap().insert(id.clone(), slot.clone());
            self.order.lock().unwrap().push(id.clone());
        }
        self.dispatch(slot);
        id
    }

    /// (Re)run a job's body: wire up a fresh event pipeline and spawn the body on
    /// the writer (or read pool). Called for the initial submit and again for each
    /// offline retry (#206), so the same slot re-runs under the same id.
    fn dispatch(self: &Arc<Self>, slot: Arc<JobSlot>) {
        // Event pipeline: drain the reporter's channel, update the snapshot and
        // ring buffer, and fan out to SSE subscribers. Ends when the reporter
        // (and thus its sender) is dropped at the end of this attempt.
        let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel::<JobEvent>();
        let slot_ev = slot.clone();
        // Trigger a coalesced-maintenance drain check the instant this attempt
        // ends (the loop below exits when the reporter's sender drops), so
        // maintenance starts right after the queue drains rather than waiting for
        // the scheduler's periodic tick. No-op unless owed and the queue is empty.
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
                            s.ended_at = Some(now_ms());
                            if ev.path.is_some() {
                                s.path = ev.path.clone();
                            }
                        }
                        "error" => {
                            s.status = "error".into();
                            s.ended_at = Some(now_ms());
                            s.error = Some(ev.message.clone());
                        }
                        "cancelled" => {
                            s.status = "cancelled".into();
                            s.ended_at = Some(now_ms());
                        }
                        // Offline pause (#206): NOT terminal (no ended_at) — the
                        // retry timer re-dispatches this same slot.
                        "waiting" => {
                            s.status = "waiting".into();
                        }
                        _ => {
                            if s.status == "queued" {
                                s.status = "running".into();
                            }
                            // First progress/log while running: stamp the start if
                            // the body's flip below hasn't (belt-and-suspenders).
                            if s.started_at.is_none() {
                                s.started_at = Some(now_ms());
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
        let params = slot.params.clone();
        let rt = self.rt.clone();
        let db_path = self.db_path.clone();
        let writer = self.writer.clone();
        let reads = self.reads.clone();
        let reopening = self.reopening.clone();
        let read_only = is_read_only(&slot.job_type);
        // Jobs that fan out follow-up work (e.g. sources_sync requesting the
        // coalesced maintenance, #163) need the manager itself.
        let jm_run = Arc::clone(self);
        let body = move |conn: &Connection| {
            let reporter = Reporter::channel(ev_tx, cancel);
            // Check cancellation BEFORE flipping to "running": a job cancelled while
            // queued (#161) is skipped cleanly and never shows a "running" blip.
            if reporter.is_cancelled() {
                reporter.cancelled("Cancelled before it started");
                return;
            }
            // Offline gate (#206): hold this job QUEUED behind an earlier stuck job
            // rather than letting it jump the queue, under either dependency rule —
            // an earlier same-cluster job is stuck (so cluster-mates wait for it),
            // or this is a network job and an earlier network job is stuck (so
            // network jobs run one-at-a-time and only the earliest is retryable).
            // The signal is the synchronous `offline_leader` (NOT the async
            // "waiting" status), so the very next job sees it immediately;
            // release_held re-dispatches held jobs once the leader resolves.
            if jm_run.gate_should_hold(&slot_run) {
                {
                    let mut s = slot_run.state.lock().unwrap();
                    s.status = "queued".into();
                    s.message = String::new(); // just "Queued" (behind the job ahead)
                    s.retry_at = None;
                }
                jm_run.held.lock().unwrap().push(slot_run.clone());
                return;
            }
            {
                // Each attempt (re)stamps its start, so "took" reflects the last
                // run, not the accumulated offline waits (#170/#206).
                let mut s = slot_run.state.lock().unwrap();
                s.status = "running".into();
                s.started_at = Some(now_ms());
                s.retry_at = None;
            }
            match run_job(&slot_run.job_type, &params, conn, &reporter, &rt, &db_path, &jm_run) {
                // A job that returns Ok after observing cancellation stopped
                // cooperatively — report it as cancelled, not done (#157/#140).
                Ok(()) if reporter.is_cancelled() => reporter.cancelled("Cancelled"),
                // Empty message keeps the operation's own final message; this
                // just guarantees a terminal "done" even if the op didn't emit one.
                Ok(()) => {
                    reporter.done("");
                    // A network job succeeding proves we're back online — release
                    // any jobs held behind an offline leader so they run now (#206).
                    if job_uses_network(&slot_run.job_type) {
                        jm_run.release_held();
                    }
                }
                // A network job that lost connectivity pauses and retries instead
                // of failing (#206): same row, no terminal state, re-dispatched by
                // schedule_retry. A genuine (non-connectivity) error still fails.
                Err(e)
                    if job_uses_network(&slot_run.job_type)
                        && crate::net::is_offline_error(&e)
                        && !reporter.is_cancelled() =>
                {
                    // Claim leadership synchronously (before returning) so the next
                    // job's gate check sees it. Already the leader (a retry that's
                    // still offline) → stay the leader; a fresh offliner that raced
                    // past the gate while someone else leads → hold queued instead.
                    let lead = {
                        let mut leader = jm_run.offline_leader.lock().unwrap();
                        match leader.as_ref() {
                            None => { *leader = Some(slot_run.clone()); true }
                            Some(l) => l.id == slot_run.id,
                        }
                    };
                    if lead {
                        reporter.waiting("Offline — waiting for a connection; will retry");
                        jm_run.schedule_retry(&slot_run.id, OFFLINE_RETRY_MS);
                    } else {
                        {
                            let mut s = slot_run.state.lock().unwrap();
                            s.status = "queued".into();
                            s.message = String::new();
                            s.retry_at = None;
                        }
                        jm_run.held.lock().unwrap().push(slot_run.clone());
                    }
                }
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
                    // If the offline leader failed with a *real* (non-connectivity)
                    // error, it's still done — free the jobs held behind it so the
                    // queue doesn't stall (#206). release_held clears offline_leader.
                    if job_uses_network(&slot_run.job_type)
                        && jm_run.offline_leader.lock().unwrap().as_ref().map(|l| l.id.as_str())
                            == Some(slot_run.id.as_str())
                    {
                        jm_run.release_held();
                    }
                }
            }
        };
        if read_only {
            self.reads.spawn_fn(body);
        } else {
            self.writer.spawn_fn(body);
        }
    }

    /// Schedule an offline retry of a paused (`"waiting"`) job (#206): stamp
    /// `retry_at` and spawn a timer that re-dispatches the same slot after
    /// `delay_ms`. A `retry_gen` bump invalidates the timer if a manual "Retry
    /// now" or a cancel happens first.
    fn schedule_retry(self: &Arc<Self>, id: &str, delay_ms: u64) {
        let Some(slot) = self.get(id) else { return };
        let gen = slot.retry_gen.fetch_add(1, Ordering::SeqCst) + 1;
        slot.state.lock().unwrap().retry_at = Some(now_ms() + delay_ms);
        let jm = Arc::clone(self);
        self.rt.spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            // Superseded (retry-now / cancel), or no longer waiting → do nothing.
            if slot.retry_gen.load(Ordering::SeqCst) != gen || slot.cancel.load(Ordering::Relaxed) {
                return;
            }
            {
                let mut s = slot.state.lock().unwrap();
                if s.status != "waiting" {
                    return;
                }
                s.retry_at = None;
            }
            jm.dispatch(slot);
        });
    }

    /// Retry a paused job immediately (the "Retry now" button, #206). Invalidates
    /// its pending timer and re-dispatches at once. No-op unless it's waiting.
    pub fn retry_now(self: &Arc<Self>, id: &str) -> bool {
        let Some(slot) = self.get(id) else { return false };
        {
            let mut s = slot.state.lock().unwrap();
            if s.status != "waiting" {
                return false;
            }
            s.retry_at = None;
        }
        slot.retry_gen.fetch_add(1, Ordering::SeqCst); // kill the pending timer
        self.dispatch(slot);
        true
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
    jm: &Arc<JobManager>,
) -> Result<()> {
    use crate::{dedup, importer, players};

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
            let dir = crate::source_dir(source_key);
            std::fs::create_dir_all(&dir)?;
            // Phase 1 (download) + phase 2 (import, always --fast for these bulk
            // feeds). Positions and dedup are deferred to phase 3 — the coalesced
            // maintenance below — so they show as their own visible jobs instead
            // of a hidden tail that leaves the bar stuck at 100% (#163/#147).
            let step = reporter.sub_step();
            let sync = (|| -> Result<usize> {
                reporter.log(format!("{}: download", src.name));
                rt.block_on(crate::sources::download_feed(conn, src, None, None, &dir, &step))?;
                if reporter.is_cancelled() { return Ok(0); }
                reporter.log(format!("{}: import (fast)", src.name));
                // Snapshot-guard a bulk source import (e.g. Ajedrez) so a fatal
                // appender fault rolls back cleanly instead of half-importing (#82).
                let bulk = importer::source_import_is_bulk(conn, &dir, src.key, 10)?;
                run_import_guarded(conn, db, bulk, &step, || {
                    importer::import(conn, &dir, src.key, src.collection, None, 10, true, true, &step)
                })
            })();
            if reporter.is_cancelled() {
                let _ = crate::sources::record_run(conn, src.key, "cancelled");
                return Ok(());
            }
            match sync {
                Ok(imported) => {
                    // Record the run BEFORE maintenance: the import is committed and
                    // the source marked synced, so an interrupted maintenance can't
                    // leave the ledger unmarked (the items=0 inconsistency, #163).
                    // Then request the coalesced dedup → index → normalise as their
                    // own visible jobs (#131).
                    crate::sources::record_run(conn, src.key, "ok")?;
                    // Report the actual game count rather than a vague "preparing the
                    // database" — the number the user watched climb during the import
                    // (#—). Maintenance runs afterwards as its own visible jobs.
                    reporter.done(if imported == 0 {
                        format!("{}: already up to date — no new games.", src.name)
                    } else {
                        format!(
                            "{}: {} games imported.",
                            src.name,
                            crate::progress::thousands(imported as i64)
                        )
                    });
                    // One coalesced identity-first pass for every source — bulk or
                    // feed. `dedup_games` is incremental (#—) so the pass is cheap
                    // to run after each sync; the old light/full split is gone.
                    jm.request_maintenance();
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
                // A bulk upload sets skip_dedup (serve.rs, from the spooled size) —
                // snapshot-guard it so a fatal appender fault rolls back cleanly (#82).
                let res = run_import_guarded(conn, db, skip_dedup, reporter, || {
                    importer::import_pgn(conn, &tmp, depth, 10, fast, skip_dedup, &spec, reporter)
                });
                let _ = std::fs::remove_file(&tmp);
                res
            } else {
                let path = path_param(p, "path")?;
                let res = run_import_guarded(conn, db, skip_dedup, reporter, || {
                    importer::import_pgn(conn, &path, depth, 10, fast, skip_dedup, &spec, reporter)
                });
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
            // Background maintenance is incremental; an explicit "full" request
            // (or the CLI) re-checks every pair. maybe_run_maintenance omits it.
            dedup::dedup_games(conn, flag(p, "dry_run"), flag(p, "full"), reporter)?;
        }
        "dedup_players" => {
            dedup::dedup_players(conn, reporter)?;
        }
        "cleanup" => {
            dedup::cleanup_nonstandard(conn, flag(p, "non_standard"), flag(p, "dry_run"), reporter)?;
        }
        "normalise" => {
            // #162 phase 4: canonicalise names via a local join against the FIDE
            // list (instant, no network). The old per-player ratings.fide.com
            // scraping was removed — with no list loaded there's simply nothing to
            // do (tell the user to refresh it) rather than a slow scraping fallback.
            let fide_count: i64 =
                conn.query_row("SELECT COUNT(*) FROM fide_players", [], |r| r.get(0))?;
            if fide_count == 0 {
                reporter.done(
                    "No FIDE list loaded yet — skipping name normalisation (nothing to do).",
                );
            } else {
                crate::fide::normalise_from_local(conn, flag(p, "dry_run"), reporter)?;
            }
        }
        // Reverse of `normalise` (#152): fetch missing FIDE IDs for named players
        // (local-DB inversion + shared cache). A distinct job from `normalise`.
        "resolve_fide" => {
            crate::reverse::resolve_fide(conn, flag(p, "dry_run"), None, None, flag(p, "no_service"), reporter)?;
        }
        "resolve_export" => {
            let path = path_param(p, "path")?;
            let n = crate::reverse::export_resolutions(conn, &path)?;
            reporter.done(format!("Exported {} resolution(s) to {}", n, path.display()));
        }
        "resolve_import" => {
            let path = path_param(p, "path")?;
            crate::reverse::import_resolutions(conn, &path, reporter)?;
        }
        // Refresh the local FIDE player list (#162): download the official zip and
        // load it, or load a local `file` if one was given (the daemon can't read
        // the user's home dir, so the default path is a self-contained download).
        "fide_refresh" => {
            // `if_due` (set by the full maintenance pipeline, #167) makes this a
            // no-op when the list is already current — so a large import ensures
            // the FIDE list exists before resolve/normalise without re-downloading
            // it on every import. A manual/scheduled refresh omits it and forces.
            if flag(p, "if_due") && !crate::fide::refresh_due(conn)? {
                reporter.done("FIDE list is current — no refresh needed.");
            } else {
                match p.get("file").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    Some(path) => {
                        crate::fide::load_from_file(conn, Path::new(path), reporter)?;
                    }
                    None => {
                        let url = p
                            .get("url")
                            .and_then(|v| v.as_str())
                            .unwrap_or(crate::fide::FIDE_LIST_URL);
                        crate::fide::download_and_load(conn, url, reporter)?;
                    }
                }
                // Stamp the monthly clock so a manual refresh also defers the next
                // scheduled one (#162).
                crate::fide::record_refresh(conn)?;
            }
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
            // #162: keep the local FIDE list current — monthly, off-peak with the
            // daily update (independent of feed sources). Non-fatal: a failed
            // download just retries on the next update, and the existing list (if
            // any) still serves normalise. Only stamp the monthly clock on success.
            if crate::fide::refresh_due(conn)? {
                reporter.log("Refreshing the FIDE player list…");
                match crate::fide::download_and_load(conn, crate::fide::FIDE_LIST_URL, &step) {
                    Ok(n) => {
                        crate::fide::record_refresh(conn)?;
                        reporter.log(format!("FIDE list refreshed ({n} players)."));
                    }
                    Err(e) => reporter.log(format!(
                        "FIDE list refresh failed (will retry next update): {e:#}"
                    )),
                }
            }
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
            // Local FIDE-list normalise only (no scraping). A fresh DB with no list
            // loaded yet just skips this — the monthly `fide_refresh` fills it in.
            let has_fide: i64 =
                conn.query_row("SELECT COUNT(*) FROM fide_players", [], |r| r.get(0))?;
            if has_fide > 0 {
                reporter.log("Normalising players");
                crate::fide::normalise_from_local(conn, false, &step)?;
            }
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
/// Run a bulk import under a safety snapshot (#82). A `--fast` (Appender) import
/// isn't crash-safe: a fatal DuckDB fault can invalidate the writer connection.
/// When `bulk`, we CHECKPOINT + snapshot the DB first, then:
/// - on success → remove the snapshot;
/// - on a FATAL (invalidation) error → leave it, so the in-process reopen (#81)
///   restores the pre-import state — the import fails all-or-nothing and the
///   writer comes back clean instead of half-imported;
/// - on a non-fatal error → remove it (the connection is still usable; a leftover
///   snapshot would wrongly roll back later work on the next start).
///
/// Non-bulk imports (small feed syncs, scratch/paste) skip the snapshot — they're
/// cheap and low-risk, and a full-DB copy per weekly TWIC sync isn't worth it.
/// First-run setup also skips it (the setup sentinel already guards a disposable DB).
fn run_import_guarded<T>(
    conn: &Connection,
    db: &Path,
    bulk: bool,
    reporter: &Reporter,
    run: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let snapshotted =
        bulk && !setup_load_is_disposable(conn, db) && make_safety_snapshot(conn, db, reporter);
    let res = run();
    if snapshotted {
        match &res {
            Ok(_) => {
                remove_snapshot(db);
                reporter.log("Safety snapshot removed.");
            }
            Err(e) if is_invalidation_error(&format!("{e:#}")) => reporter.log(
                "Import failed fatally — the safety snapshot will be restored, rolling back this import.",
            ),
            Err(_) => remove_snapshot(db),
        }
    }
    res
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
        && !setup_load_is_disposable(conn, db)
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
    // Copying the whole DB is slow and unmeasured. Use a progress event (total=0)
    // so the panel shows a "working" indeterminate bar rather than leaving a prior
    // phase's bar stale (e.g. stuck at 100% after the import step).
    reporter.progress(0, 0, "Creating a safety snapshot of the database before rebuilding…");
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
mod offline_gate_tests {
    use super::offline_gate_blocks;

    // Cluster ids: "M" = the maintenance chain, "S" = a sources-sync batch.
    // A stuck network leader from cluster S, submitted first (seq 1).
    const NET_LEADER_S: (u64, &str, bool) = (1, "S", true);

    #[test]
    fn solo_nonnetwork_job_skips_a_paused_network_cluster() {
        // A local PGN import (non-network, its own cluster) queued after an offline
        // sources-sync must NOT wait — different cluster, and it isn't a network job.
        assert!(!offline_gate_blocks(9, "job-9", false, &[NET_LEADER_S]));
    }

    #[test]
    fn second_network_job_holds_behind_the_paused_leader() {
        // A network job in a *different* cluster still waits for the earlier paused
        // network job (network rule) — so only the leader is ever "waiting".
        assert!(offline_gate_blocks(9, "M", true, &[NET_LEADER_S]));
    }

    #[test]
    fn same_cluster_nonnetwork_job_waits_for_its_paused_network_sibling() {
        // resolve_fide (non-network) behind a paused fide_refresh in the same
        // maintenance cluster → held (cluster rule), so it can't run and hit
        // "No FIDE list loaded".
        let stuck = [(1u64, "M", true)]; // paused fide_refresh
        assert!(offline_gate_blocks(2, "M", false, &stuck));
    }

    #[test]
    fn the_leader_reruns_itself_on_retry() {
        // The leader re-dispatched by its own retry timer must run (to re-test the
        // connection), never block on itself.
        assert!(!offline_gate_blocks(1, "S", true, &[NET_LEADER_S]));
    }

    #[test]
    fn nonnetwork_stuck_job_does_not_block_a_foreign_network_job() {
        // A held *non-network* job (e.g. a deferred dedup) doesn't invoke the
        // network rule, so a network job from another cluster still runs.
        let stuck = [(1u64, "M", false)];
        assert!(!offline_gate_blocks(9, "S", true, &stuck));
    }

    #[test]
    fn a_later_stuck_job_never_blocks_an_earlier_one() {
        // Only *earlier* (smaller seq) stuck jobs block; a job can't wait on one
        // submitted after it.
        assert!(!offline_gate_blocks(1, "S", true, &[(5, "S", true)]));
    }
}

#[cfg(test)]
mod setup_sentinel_tests {
    use super::*;

    fn tmp_db(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lpdo-sentinel-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("t.db")
    }

    #[test]
    fn round_trips_attempts_and_imported_count() {
        let db = tmp_db("rt");
        assert!(!setup_sentinel_present(&db));
        assert_eq!(read_setup_sentinel(&db), (0, 0), "absent sentinel reads as (0, 0)");

        write_setup_sentinel(&db); // fresh first-run: 0 attempts, 0 imported
        assert!(setup_sentinel_present(&db));
        assert_eq!(read_setup_sentinel(&db), (0, 0));

        set_setup_sentinel(&db, 2, 12_345);
        assert_eq!(read_setup_sentinel(&db), (2, 12_345));

        remove_setup_sentinel(&db);
        assert!(!setup_sentinel_present(&db));
    }

    #[test]
    fn legacy_single_value_sentinel_parses() {
        // Pre-#134 sentinels held just "1"; treat as 1 attempt, 0 imported so the
        // first resume after an upgrade still evaluates progress correctly.
        let db = tmp_db("legacy");
        std::fs::write(setup_sentinel_path(&db), b"1").unwrap();
        assert_eq!(read_setup_sentinel(&db), (1, 0));
    }

    // #143: the snapshot guard must NOT treat a populated database as a disposable
    // first-run load just because a (possibly stale) sentinel is present.
    #[test]
    fn populated_db_is_not_a_disposable_load_even_with_sentinel() {
        let db = tmp_db("disposable");
        let conn = crate::db::open(&db).unwrap();
        crate::db::schema::init(&conn).unwrap();

        // No sentinel → never disposable (always snapshot).
        assert!(!setup_load_is_disposable(&conn, &db));

        // Sentinel + empty DB → disposable: a genuine fresh first-run load.
        write_setup_sentinel(&db);
        assert!(setup_load_is_disposable(&conn, &db));

        // Sentinel + games present → NOT disposable: real data must be protected.
        conn.execute_batch("INSERT INTO games (id, date, pgn) VALUES (1, '2020-01-01', 'x');")
            .unwrap();
        assert!(!setup_load_is_disposable(&conn, &db));
    }
}

#[cfg(test)]
mod import_guard_tests {
    use super::*;

    fn tmp_db(name: &str) -> (PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("lpdo-guard-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let conn = crate::db::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE t(x INT); INSERT INTO t VALUES (1);").unwrap();
        (db, conn)
    }

    #[test]
    fn bulk_success_removes_snapshot() {
        let (db, conn) = tmp_db("ok");
        run_import_guarded(&conn, &db, true, &Reporter::silent(), || Ok(())).unwrap();
        assert!(!snapshot_path(&db).exists(), "snapshot removed after a successful bulk import");
    }

    #[test]
    fn bulk_fatal_leaves_snapshot_for_reopen() {
        let (db, conn) = tmp_db("fatal");
        let r = run_import_guarded(&conn, &db, true, &Reporter::silent(), || -> Result<()> {
            Err(anyhow!("FATAL Error: database has been invalidated because of a previous fatal error"))
        });
        assert!(r.is_err());
        assert!(
            snapshot_path(&db).exists(),
            "a fatal invalidation must leave the snapshot so reopen rolls the import back",
        );
    }

    #[test]
    fn bulk_nonfatal_removes_snapshot() {
        let (db, conn) = tmp_db("nonfatal");
        let r = run_import_guarded(&conn, &db, true, &Reporter::silent(), || -> Result<()> {
            Err(anyhow!("a corrupt PGN — ordinary, non-fatal import error"))
        });
        assert!(r.is_err());
        assert!(
            !snapshot_path(&db).exists(),
            "a non-fatal error must not leave a snapshot that would roll back later work on restart",
        );
    }

    #[test]
    fn non_bulk_never_snapshots() {
        let (db, conn) = tmp_db("nonbulk");
        let r =
            run_import_guarded(&conn, &db, false, &Reporter::silent(), || -> Result<()> {
                Err(anyhow!("boom"))
            });
        assert!(r.is_err());
        assert!(!snapshot_path(&db).exists(), "a non-bulk import doesn't snapshot at all");
    }
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

