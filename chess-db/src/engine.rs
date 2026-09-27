//! A local UCI engine on the server (#309): Stockfish, or anything else that
//! speaks UCI. The engine is one the user installed — LPDO does not ship one
//! (Stockfish is GPL-3) — found in the usual install locations or named in
//! `engine.json` in the data directory.
//!
//! One engine process serves everyone. An analysis request stops whatever the
//! engine was doing, sets up the new position and searches until the client
//! goes away, a newer request arrives, or a time cap runs out. Progress is a
//! stream of snapshots: depth, speed and the current best lines, each line's
//! score from White's point of view (the way the cloud evaluations report it).
//!
//! Choosing the engine through the API is limited to engines found in the
//! standard locations. Anyone who can reach the API — which since #299
//! includes every account on the server's machine — could otherwise make the
//! server run any program as its own user. A custom path goes in `engine.json`
//! on the server itself.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, Mutex, Notify};

/// The two local engines (#309): Stockfish, the default, and Lc0 (Leela
/// Chess Zero), optional because it wants a GPU. Each has its own process,
/// settings file and places it is looked for.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Stockfish,
    Lc0,
}

impl Kind {
    pub fn parse(s: Option<&str>) -> Option<Kind> {
        match s.unwrap_or("stockfish") {
            "stockfish" => Some(Kind::Stockfish),
            "lc0" => Some(Kind::Lc0),
            _ => None,
        }
    }
    fn settings_file(self) -> &'static str {
        match self { Kind::Stockfish => "engine.json", Kind::Lc0 => "lc0.json" }
    }
    fn path_names(self) -> &'static [&'static str] {
        match self { Kind::Stockfish => &["stockfish"], Kind::Lc0 => &["lc0"] }
    }
    /// Where package managers and the install guide put the engine, besides
    /// `$PATH` (a service's PATH is short: Debian installs to /usr/games,
    /// which systemd units rarely include). Windows has no package location;
    /// these are the ones docs/chess-engine.md tells people to use.
    fn known_locations(self) -> &'static [&'static str] {
        match self {
            Kind::Stockfish => &[
                "/usr/games/stockfish",
                "/usr/bin/stockfish",
                "/usr/local/bin/stockfish",
                "/opt/homebrew/bin/stockfish",
                "/snap/bin/stockfish",
                r"C:\Program Files\Stockfish\stockfish.exe",
            ],
            Kind::Lc0 => &[
                "/usr/local/bin/lc0",
                "/usr/bin/lc0",
                "/opt/homebrew/bin/lc0",
                r"C:\Program Files\Lc0\lc0.exe",
            ],
        }
    }
    /// How long the engine may take to start. Lc0 loads its network onto the
    /// GPU (and compiles kernels the first time), which takes seconds.
    fn handshake(self) -> Duration {
        match self { Kind::Stockfish => Duration::from_secs(10), Kind::Lc0 => Duration::from_secs(90) }
    }
}

/// The Engine panel says it is still open this often (the client's timer);
/// a search whose panel has not said so for `ALIVE_TTL` — closed without
/// word, or its computer asleep — is stopped. Generous, as a hidden browser
/// tab runs its timers only once a minute.
const ALIVE_TTL: Duration = Duration::from_secs(180);
const ALIVE_CHECK: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EngineSettings {
    /// The engine to run. None: the first one found.
    pub path: Option<String>,
    /// Search threads. For Lc0, 0 leaves it to the engine.
    pub threads: u32,
    /// Stockfish's hash table. Lc0 keeps its network on the GPU and does not
    /// use it.
    pub hash_mb: u32,
    /// Lc0's network file. None: the first one found.
    pub weights: Option<String>,
    /// Lc0's backend ("cuda-fp16", "opencl", …). None: the engine picks.
    pub backend: Option<String>,
    /// Stop a search here — always set, as a search runs for as long as its
    /// panel is open: a depth for Stockfish (its depth is how far it has
    /// searched), a node count for Lc0 (whose "depth" is only the average
    /// length of its playouts, so nodes are the measure).
    pub max_depth: u32,
    pub max_nodes: u64,
    /// Lc0's smart pruning: end a search once the best move cannot be
    /// overtaken. Off by default — the other lines stop improving too.
    pub smart_pruning: bool,
    /// Switched off, the engine is not started (Lc0 then holds no GPU
    /// memory), its tab leaves the Engine panel and analysis is refused.
    /// Maintenance's Auto (true, the default) or Off: on Auto the engine runs
    /// when it is installed on the server — see `Engine::on`.
    pub enabled: bool,
    /// Replies & Strong: a helper process of the same engine counts, for each
    /// candidate move, the opponent's replies and how many of them are strong.
    pub replies: bool,
    /// Stockfish's helper: its threads (taken from the main search's, which
    /// default to the physical cores less these), hash, and depth.
    pub helper_threads: u32,
    pub helper_hash_mb: u32,
    pub helper_depth: u32,
    /// A reply is strong within this many centipawns of the best (Stockfish).
    pub strong_cp: u32,
    /// Lc0's helper: nodes per candidate, and a reply is strong within this
    /// many percent of expected score of the best.
    pub helper_nodes: u64,
    pub strong_pct: f32,
    /// A move up to this far behind the best is neutral, unmarked; further
    /// behind, it is marked "?" (within `strong_cp` / `strong_pct`, "!").
    /// Stockfish in centipawns, Lc0 in percent of expected score.
    pub neutral_cp: u32,
    pub neutral_pct: f32,
}

impl Default for EngineSettings {
    fn default() -> Self { Self::for_kind(Kind::Stockfish) }
}

impl EngineSettings {
    fn for_kind(kind: Kind) -> Self {
        match kind {
            // One thread per physical core: the second hardware thread of a
            // core adds little to Stockfish, and the server also answers
            // queries while it analyses. An eighth of the memory for hash,
            // 256 MB to 4 GB — out of the budget it shares with the database
            // (see db::memory).
            // Replies & Strong on by default, with five single-threaded
            // helpers — one for each of the five lines the Engine panel shows
            // by default, so all are counted at once: 11 + 5 on a 16-core
            // machine. 320 MB of hash for them, 64 MB each.
            Kind::Stockfish => Self {
                path: None, threads: physical_cores().saturating_sub(5).clamp(1, 64),
                hash_mb: crate::db::default_engine_hash_mb(), weights: None, backend: None,
                max_depth: 35, max_nodes: 0, smart_pruning: false, enabled: true,
                replies: true, helper_threads: 5, helper_hash_mb: 320, helper_depth: 24, strong_cp: 10,
                helper_nodes: 0, strong_pct: 0.0, neutral_cp: 30, neutral_pct: 0.0,
            },
            // Off by default for Lc0: its helper loads a second copy of the
            // network onto the graphics card.
            Kind::Lc0 => Self {
                path: None, threads: 0, hash_mb: 0, weights: None, backend: None,
                max_depth: 0, max_nodes: 2_000_000, smart_pruning: false, enabled: true,
                replies: false, helper_threads: 0, helper_hash_mb: 0, helper_depth: 0, strong_cp: 0,
                helper_nodes: 50_000, strong_pct: 1.0, neutral_cp: 0, neutral_pct: 3.0,
            },
        }
    }
}

/// A backend name as Lc0 spells them: letters, digits and dashes only, so
/// nothing but an option value reaches the engine's command line.
fn valid_backend(b: &str) -> bool {
    !b.is_empty() && b.len() <= 40 && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[derive(Clone, Debug, Serialize)]
pub struct EngineStatus {
    pub kind: Kind,
    /// In use: on Auto, and installed.
    pub enabled: bool,
    /// The setting: Auto (true) or Off.
    pub auto: bool,
    /// The program (and for Lc0 a network) is on the server.
    pub installed: bool,
    pub available: bool,
    /// The engine in use (or that would be used).
    pub path: Option<String>,
    /// What the engine calls itself: "Stockfish 16".
    pub name: Option<String>,
    pub error: Option<String>,
    pub settings: EngineSettings,
    /// Engines found in the standard locations — the ones the API may choose.
    pub found: Vec<String>,
    /// Where the server looked, for the install guidance.
    pub searched: Vec<String>,
    /// The file a custom path goes in.
    pub settings_file: String,
    /// The server's operating system ("linux", "macos", "windows"), for the
    /// install steps: the engine goes on the server, not the client.
    pub os: String,
    /// The Stockfish release number the engine reports ("16", "17.1"); None
    /// for another engine or a development build.
    pub version: Option<String>,
    /// The newest Stockfish release, checked on GitHub at most once a day.
    pub latest: Option<LatestRelease>,
    /// A Stockfish older than the newest release is running.
    pub update_available: bool,
    /// The server's logical processors and memory, for choosing threads and
    /// hash (memory is None where it cannot be read).
    pub cores: u32,
    /// Physical cores: the most threads LPDO recommends.
    pub physical_cores: u32,
    pub memory_mb: Option<u64>,
    /// What the server may use of the memory, the database's share of it
    /// (the rest after the engine's hash), and the largest hash allowed.
    pub budget_mb: u64,
    pub database_mb: u64,
    pub max_hash_mb: u32,
    /// Lc0: the network in use, and the network files found in the standard
    /// places (the data directory's networks/, beside the program).
    pub weights: Option<String>,
    pub networks: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LatestRelease {
    pub version: String,
    pub url: String,
}

/// One line of analysis. Scores are from White's point of view.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Line {
    pub multipv: u32,
    pub eval_cp: Option<i32>,
    pub mate: Option<i32>,
    pub pv_uci: Vec<String>,
    /// Win / draw / loss in permille, from White's point of view: White's
    /// win, the draw, Black's win. Lc0 always reports it; Stockfish too,
    /// since UCI_ShowWDL is switched on.
    pub wdl: Option<[u32; 3]>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub gen: u64,
    pub depth: u32,
    pub nodes: u64,
    pub nps: u64,
    pub lines: Vec<Line>,
    /// The search has ended (stopped, capped, or the engine finished).
    pub done: bool,
    /// Remembered from an earlier search of this position, sent first so the
    /// client has something at once; the live search replaces it once it
    /// goes deeper.
    #[serde(default)]
    pub cached: bool,
    /// Computed by another version of the engine (an older Stockfish, Lc0
    /// with another network): shown, labelled, until the engine in use has
    /// a result of its own for the position.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
}

/// What the stdout reader shares with the controller.
struct Search {
    gen: u64,
    /// The position's key in the remembered results, with the engine's name.
    key: String,
    /// The same apart: the engine's identity and the position, for the
    /// database.
    ident: String,
    position: String,
    white_to_move: bool,
    searching: bool,
    /// Lines in a complete set: the MultiPV asked for, or fewer when the
    /// position has fewer legal moves. Stockfish sends a depth's lines one
    /// by one; a snapshot waits for the last, or it would mix two depths.
    want: u32,
    depth: u32,
    nodes: u64,
    nps: u64,
    lines: BTreeMap<u32, Line>,
    /// Stockfish on Unix searches without a depth of its own and is frozen
    /// here (see `freeze`) — so "search further" goes on from where it was.
    stop_at: Option<u32>,
    /// Frozen at `stop_at`: the search is kept, but uses no processor.
    frozen: bool,
    /// Thawed: the speed is measured from the first report after the thaw
    /// (its time and nodes — what came before the freeze was not all read),
    /// not over the time it was frozen.
    resumed: Option<Option<(std::time::Instant, u64)>>,
}

/// Stockfish on Unix is frozen at its target depth instead of stopped: a
/// finished search cannot be continued, a frozen one can. Elsewhere, and for
/// Lc0 (which keeps its tree between searches anyway), the engine stops by
/// itself at its threshold.
fn can_freeze(kind: Kind) -> bool {
    cfg!(unix) && kind == Kind::Stockfish
}

/// Freeze or thaw the engine process (SIGSTOP / SIGCONT).
#[cfg(unix)]
fn signal_engine(pid: Option<u32>, thaw: bool) {
    if let Some(pid) = pid {
        // SAFETY: kill() only sends a signal to the engine's own process.
        unsafe { libc::kill(pid as libc::pid_t, if thaw { libc::SIGCONT } else { libc::SIGSTOP }); }
    }
}
#[cfg(not(unix))]
fn signal_engine(_pid: Option<u32>, _thaw: bool) {}

struct Running {
    child: Child,
    stdin: ChildStdin,
    path: String,
    name: String,
    /// What its results are kept under: the name ("Stockfish 19"), and for
    /// Lc0 the network too ("Lc0 v0.32.1 · t3-512x15x16h-distill-swa-2767500").
    ident: String,
}

/// Engine results kept in the database (`engine_evals`), one per engine and
/// position — the furthest one, as in memory — so they outlive restarts. It
/// runs on the read connections: small writes to a table of its own, which
/// need not wait behind a long import on the writer.
#[derive(Clone)]
pub struct EvalStore {
    reads: crate::jobs::ReadPool,
}

/// One engine's results in the database, for Maintenance.
#[derive(Clone, Debug, Serialize)]
pub struct StoredEngine {
    pub engine: String,
    pub kind: String,
    pub positions: u64,
    /// Bytes of the lines kept (an estimate of the room they take).
    pub bytes: u64,
    /// When the last result was kept, seconds since 1970.
    pub updated: Option<i64>,
}

impl EvalStore {
    pub fn new(reads: crate::jobs::ReadPool) -> Self {
        Self { reads }
    }

    /// Keep `snap` for `ident` and `position` if it goes further than what is
    /// kept (the rule of `deeper`). In the background.
    fn save(&self, kind: Kind, ident: &str, position: &str, snap: &Snapshot) {
        if snap.lines.is_empty() { return; }
        let Ok(lines) = serde_json::to_string(&snap.lines) else { return };
        let further = match kind {
            Kind::Lc0 => "excluded.nodes > engine_evals.nodes",
            Kind::Stockfish => "(excluded.depth > engine_evals.depth OR (excluded.depth = engine_evals.depth AND excluded.nodes > engine_evals.nodes))",
        };
        let sql = format!(
            "INSERT INTO engine_evals (engine, kind, position, depth, nodes, multipv, lines, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, now())
             ON CONFLICT (engine, position) DO UPDATE SET
               depth = excluded.depth, nodes = excluded.nodes, multipv = excluded.multipv,
               lines = excluded.lines, updated_at = excluded.updated_at
             WHERE excluded.multipv >= engine_evals.multipv AND {further}"
        );
        let (ident, position, kind_s) = (ident.to_string(), position.to_string(), kind_name(kind));
        let (depth, nodes, multipv) = (snap.depth as i64, snap.nodes as i64, snap.lines.len() as i64);
        self.reads.spawn_fn(move |conn| {
            if let Err(e) = conn.execute(&sql, duckdb::params![ident, kind_s, position, depth, nodes, multipv, lines]) {
                eprintln!("engine results: could not keep a result: {e}");
            }
        });
    }

    /// The result kept for `ident` and `position`.
    async fn load(&self, ident: &str, position: &str) -> Option<Snapshot> {
        let (ident, position) = (ident.to_string(), position.to_string());
        self.reads.run(move |conn| {
            conn.query_row(
                "SELECT depth, nodes, lines FROM engine_evals WHERE engine = ? AND position = ?",
                duckdb::params![ident, position],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
            ).ok()
        }).await.and_then(|(d, n, l)| stored_snapshot(d, n, &l, None))
    }

    /// The furthest result another version of the engine (same kind, another
    /// identity) has for `position`, labelled with that engine.
    async fn load_older(&self, kind: Kind, ident: &str, position: &str) -> Option<Snapshot> {
        let (ident, position, kind_s) = (ident.to_string(), position.to_string(), kind_name(kind));
        let order = match kind { Kind::Lc0 => "nodes DESC", Kind::Stockfish => "depth DESC, nodes DESC" };
        let sql = format!(
            "SELECT engine, depth, nodes, lines FROM engine_evals
             WHERE kind = ? AND position = ? AND engine <> ? ORDER BY {order} LIMIT 1"
        );
        self.reads.run(move |conn| {
            conn.query_row(&sql, duckdb::params![kind_s, position, ident],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?)),
            ).ok()
        }).await.and_then(|(e, d, n, l)| stored_snapshot(d, n, &l, Some(e)))
    }

    /// The engines with results kept, most recently used first.
    pub async fn list(&self) -> Result<Vec<StoredEngine>, String> {
        self.reads.run(|conn| {
            let mut st = conn.prepare(
                "SELECT engine, any_value(kind), count(*), sum(length(lines)), epoch(max(updated_at))::BIGINT
                 FROM engine_evals GROUP BY engine ORDER BY max(updated_at) DESC",
            ).map_err(|e| e.to_string())?;
            let rows = st.query_map([], |r| Ok(StoredEngine {
                engine: r.get(0)?, kind: r.get(1)?,
                positions: r.get::<_, i64>(2)? as u64,
                bytes: r.get::<_, Option<i64>>(3)?.unwrap_or(0) as u64,
                updated: r.get(4)?,
            })).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        }).await
    }

    /// Delete the result kept for one position (recalculating it). In the
    /// background.
    fn delete_one(&self, ident: &str, position: &str) {
        let (ident, position) = (ident.to_string(), position.to_string());
        self.reads.spawn_fn(move |conn| {
            if let Err(e) = conn.execute("DELETE FROM engine_evals WHERE engine = ? AND position = ?", duckdb::params![ident, position]) {
                eprintln!("engine results: could not delete a result: {e}");
            }
        });
    }

    /// Delete an engine's results; how many there were.
    pub async fn delete(&self, ident: &str) -> Result<u64, String> {
        let ident = ident.to_string();
        self.reads.run(move |conn| {
            conn.execute("DELETE FROM engine_evals WHERE engine = ?", duckdb::params![ident])
                .map(|n| n as u64).map_err(|e| e.to_string())
        }).await
    }
}

fn kind_name(kind: Kind) -> &'static str {
    match kind { Kind::Stockfish => "stockfish", Kind::Lc0 => "lc0" }
}

/// A kept result as the panel gets a remembered one.
fn stored_snapshot(depth: i64, nodes: i64, lines: &str, engine: Option<String>) -> Option<Snapshot> {
    let lines: Vec<Line> = serde_json::from_str(lines).ok()?;
    if lines.is_empty() { return None; }
    Some(Snapshot { gen: 0, depth: depth as u32, nodes: nodes as u64, nps: 0, lines, done: true, cached: true, engine })
}

/// Where an engine's known identities are kept.
fn identities_file(kind: Kind) -> String {
    format!("{}-identities.json", kind_name(kind))
}

/// What an engine's identity depends on: its program — the file, and when it
/// was last changed, as an upgrade may replace it in place — and Lc0's
/// network.
fn identity_config(path: &str, s: &EngineSettings) -> Option<String> {
    let changed = std::fs::metadata(path).ok()?.modified().ok()?
        .duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(format!("{path}|{changed}|{}", s.weights.clone().unwrap_or_default()))
}

/// A network file's name without its folder and extension.
fn network_name(path: &str) -> String {
    let file = Path::new(path).file_name().and_then(|f| f.to_str()).unwrap_or(path);
    file.trim_end_matches(".gz").trim_end_matches(".pb").trim_end_matches(".onnx").to_string()
}

pub struct Engine {
    kind: Kind,
    /// The results kept in the database, once the server has given it one.
    store: Arc<std::sync::OnceLock<EvalStore>>,
    /// First-sight move orders per position (see `quick_order`).
    quick_cache: std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>,
    /// The identity each program (and network) had when it last ran —
    /// kept in a file, so the kept results can be found after a restart
    /// before the engine is started (a paused panel does not start it).
    identities: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// When an Engine panel last said it is open.
    alive: std::sync::Mutex<std::time::Instant>,
    data_dir: PathBuf,
    settings_file: PathBuf,
    settings: Mutex<EngineSettings>,
    running: Mutex<Option<Running>>,
    last_error: Mutex<Option<String>>,
    search: Arc<std::sync::Mutex<Search>>,
    idle: Arc<Notify>,
    tx: broadcast::Sender<Snapshot>,
    gen: AtomicU64,
    remembered: Arc<std::sync::Mutex<Remembered>>,
    /// The newest Stockfish release and when it was looked up.
    latest: Mutex<Option<(std::time::Instant, Option<LatestRelease>)>>,
    /// Held while a benchmark runs.
    benching: Mutex<()>,
    /// Replies & Strong: the idle helper processes, how many may count at
    /// once, the counts under way and what has been counted.
    helpers: std::sync::Mutex<Vec<Helper>>,
    reply_queue: std::sync::Mutex<ReplyQueue>,
    reply_cache: std::sync::Mutex<std::collections::HashMap<String, ReplyCount>>,
    /// Nodes the last Stockfish count took: sibling positions take about as
    /// many, which makes the progress of the next one an estimate.
    reply_nodes: AtomicU64,
}

/// A helper process: the same engine, started with the helper's settings.
struct Helper {
    // Held for kill_on_drop: dropping a helper ends its process.
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    /// What it was started with; a change starts another.
    config: String,
}

/// A count asked for and not yet cached: waiting for a helper, under way
/// (percent done), or failed. It is kept while the Engine panel asks about its
/// position (`parent`), also when its move leaves the panel's list for a
/// while; once the panel has moved on to another position, a waiting count is
/// dropped and a running one stopped.
struct ReplyJob {
    fen: String,
    parent: String,
    settings: EngineSettings,
    state: ReplyProgress,
    /// When the panel last asked for this count by name — on its list now.
    asked: std::time::Instant,
    queued: std::time::Instant,
    cancel: Arc<Notify>,
}

/// The counts asked for, and when the panel last asked about each position.
struct ReplyQueue {
    jobs: std::collections::HashMap<String, ReplyJob>,
    parents: std::collections::HashMap<String, std::time::Instant>,
    /// How many count at once: the helpers.
    limit: usize,
}

#[derive(Clone, Debug)]
enum ReplyProgress {
    Waiting,
    Counting(u32),
    Failed(String, std::time::Instant),
}

/// Where the count for one position stands, for the Engine panel.
#[derive(Clone, Debug, Serialize)]
pub struct ReplyState {
    pub fen: String,
    /// "done", "counting", "waiting", "failed" or "none" (not counted, and
    /// not asked for).
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<ReplyCount>,
    /// Percent done while counting: exact for Lc0 (nodes of the limit), an
    /// estimate for Stockfish.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The position analysed deeper than the helper counts (the move was
    /// played): its best line, White-relative, and how deep — the move's own
    /// evaluation, where deeper than the panel's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<Line>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_nodes: Option<u64>,
    /// The count is a lower bound: every line of the deeper analysis is
    /// strong, and there may be more beyond them.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub at_least: bool,
}

/// The Engine panel's answer: each candidate's count or progress, and how many
/// counts for the position are still waiting or running — also those of moves
/// no longer on its list, which it keeps asking for until they are done.
#[derive(Clone, Debug, Serialize)]
pub struct ReplyAnswer {
    pub lines: Vec<ReplyState>,
    pub pending: usize,
}

/// What a count stopped because the panel left its position returns.
const STOPPED: &str = "stopped";

/// How deep the first-sight ranking of all moves searches: some tens of
/// milliseconds on one thread.
const QUICK_DEPTH: u32 = 8;

/// The lines a Stockfish helper searches, as many as the Engine panel shows
/// by default: the strong count is exact up to four, "5+" beyond.
const HELPER_LINES: u32 = 5;

/// A position the panel has not asked about for this long is left: its
/// counts are dropped (the panel asks twice a second).
const REPLY_ASK_TTL: Duration = Duration::from_secs(3);
/// A candidate asked for this recently is on the panel's list now, and is
/// counted before those that left it.
const REPLY_ON_LIST: Duration = Duration::from_millis(1500);

/// The opponent's replies after one candidate move.
#[derive(Clone, Debug, Serialize)]
pub struct ReplyCount {
    /// Legal replies.
    pub replies: u32,
    /// Replies within the threshold of the best.
    pub strong: u32,
    /// How deep (Stockfish) or how many nodes (Lc0) the count rests on.
    pub depth: u32,
    pub nodes: u64,
}

/// The deepest result reached for each position, while the server runs.
/// Stockfish cannot resume a search from a score, and its hash table lives
/// only as long as the process; this is what lets a position come back with
/// its evaluation on screen at once. Bounded: the oldest go first.
#[derive(Default)]
struct Remembered {
    by_key: std::collections::HashMap<String, Snapshot>,
    order: std::collections::VecDeque<String>,
}
const REMEMBER_MAX: usize = 20_000;

impl Remembered {
    fn get(&self, key: &str) -> Option<Snapshot> {
        self.by_key.get(key).cloned()
    }
    fn remove(&mut self, key: &str) {
        if self.by_key.remove(key).is_some() { self.order.retain(|k| k != key); }
    }
    /// Keep `s` if it is deeper than what is remembered for `key` (see
    /// `deeper`).
    fn offer(&mut self, key: &str, s: &Snapshot, kind: Kind) {
        if s.lines.is_empty() { return; }
        match self.by_key.get(key) {
            Some(old) if !deeper(kind, s, old) => return,
            Some(_) => {}
            None => {
                self.order.push_back(key.to_string());
                if self.order.len() > REMEMBER_MAX {
                    if let Some(k) = self.order.pop_front() { self.by_key.remove(&k); }
                }
            }
        }
        let mut keep = s.clone();
        keep.cached = true;
        keep.done = true;
        self.by_key.insert(key.to_string(), keep);
    }
}

/// Whether `new` goes further than `old`: for Lc0 by nodes (its "depth" is
/// only the average length of its lines, and can fall as the search grows);
/// for Stockfish by depth, then — at the same depth — by nodes. Never with
/// fewer lines.
fn deeper(kind: Kind, new: &Snapshot, old: &Snapshot) -> bool {
    if new.lines.len() < old.lines.len() { return false; }
    match kind {
        Kind::Lc0 => new.nodes > old.nodes,
        Kind::Stockfish => new.depth > old.depth || (new.depth == old.depth && new.nodes > old.nodes),
    }
}

/// A position's key: placement, side, castling and en passant — the move
/// counters do not change the evaluation.
fn position_key(fen: &str) -> String {
    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
}

impl Engine {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        Self::new_kind(data_dir, Kind::Stockfish)
    }

    pub fn new_kind(data_dir: &Path, kind: Kind) -> Arc<Self> {
        let settings_file = data_dir.join(kind.settings_file());
        let settings = std::fs::read_to_string(&settings_file)
            .ok()
            .and_then(|s| {
                // Fields the file leaves out take this kind's defaults.
                let mut base = serde_json::to_value(EngineSettings::for_kind(kind)).ok()?;
                let over: serde_json::Value = serde_json::from_str(&s).ok()?;
                if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
                    for (k, v) in o { b.insert(k.clone(), v.clone()); }
                }
                serde_json::from_value(base).ok()
            })
            .unwrap_or_else(|| EngineSettings::for_kind(kind));
        // The old "0: no limit" is gone — a search runs while its panel is
        // open — so such a file gets the default threshold.
        let mut settings = settings;
        match kind {
            Kind::Stockfish if settings.max_depth == 0 => settings.max_depth = EngineSettings::for_kind(kind).max_depth,
            Kind::Lc0 if settings.max_nodes == 0 => settings.max_nodes = EngineSettings::for_kind(kind).max_nodes,
            _ => {}
        }
        let (tx, _) = broadcast::channel(64);
        let helpers = helper_count(kind, &settings);
        Arc::new(Self {
            kind,
            store: Arc::new(std::sync::OnceLock::new()),
            quick_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            identities: std::sync::Mutex::new(
                std::fs::read_to_string(data_dir.join(identities_file(kind))).ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
                    .unwrap_or_default(),
            ),
            alive: std::sync::Mutex::new(std::time::Instant::now()),
            data_dir: data_dir.to_path_buf(),
            settings_file,
            settings: Mutex::new(settings),
            running: Mutex::new(None),
            last_error: Mutex::new(None),
            search: Arc::new(std::sync::Mutex::new(Search {
                gen: 0, key: String::new(), ident: String::new(), position: String::new(), white_to_move: true, searching: false, want: 1, depth: 0, nodes: 0, nps: 0,
                lines: BTreeMap::new(), stop_at: None, frozen: false, resumed: None,
            })),
            idle: Arc::new(Notify::new()),
            tx,
            gen: AtomicU64::new(0),
            remembered: Arc::new(std::sync::Mutex::new(Remembered::default())),
            latest: Mutex::new(None),
            benching: Mutex::new(()),
            helpers: std::sync::Mutex::new(Vec::new()),
            reply_queue: std::sync::Mutex::new(ReplyQueue {
                jobs: std::collections::HashMap::new(),
                parents: std::collections::HashMap::new(),
                limit: helpers,
            }),
            reply_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            reply_nodes: AtomicU64::new(0),
        })
    }

    /// Whether the engine can run: its program (named, or found in the
    /// standard locations) and, for Lc0, a network.
    fn installed(&self, s: &EngineSettings) -> bool {
        let program = s.path.clone().filter(|p| is_executable(Path::new(p)))
            .or_else(|| self.found().0.into_iter().next());
        match (self.kind, program) {
            (_, None) => false,
            (Kind::Stockfish, Some(_)) => true,
            (Kind::Lc0, Some(p)) => s.weights.as_deref().is_some_and(|w| Path::new(w).is_file()) || !self.networks(Some(&p)).is_empty(),
        }
    }

    /// In use: set to Auto, and installed — looked up each time, so an
    /// engine installed (or removed) while the server runs is picked up.
    pub async fn on(&self) -> bool {
        let s = self.settings.lock().await.clone();
        s.enabled && self.installed(&s)
    }

    /// The newest Stockfish release, from GitHub. Asked at most once a day
    /// (an hour after a failure), and never for long: a server without
    /// internet access just does not say.
    /// The newest release of this engine, from GitHub: Stockfish's tags are
    /// "sf_19", Lc0's "v0.32.1" (its release candidates are marked
    /// pre-release, which the "latest" endpoint leaves out).
    async fn latest_release(&self) -> Option<LatestRelease> {
        let mut cached = self.latest.lock().await;
        if let Some((at, value)) = cached.as_ref() {
            let ttl = if value.is_some() { Duration::from_secs(24 * 3600) } else { Duration::from_secs(3600) };
            if at.elapsed() < ttl { return value.clone(); }
        }
        let fetched = async {
            let client = reqwest::Client::builder()
                .user_agent(concat!("LPDO/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(4))
                .build()
                .ok()?;
            let (repo, url) = match self.kind {
                Kind::Stockfish => ("official-stockfish/Stockfish", "https://stockfishchess.org/download/"),
                Kind::Lc0 => ("LeelaChessZero/lc0", "https://lczero.org/play/download/"),
            };
            let v: serde_json::Value = client
                .get(format!("https://api.github.com/repos/{repo}/releases/latest"))
                .send().await.ok()?
                .error_for_status().ok()?
                .json().await.ok()?;
            let tag = v.get("tag_name")?.as_str()?;
            let version = tag.strip_prefix("sf_").or_else(|| tag.strip_prefix('v')).unwrap_or(tag);
            Some(LatestRelease { version: version.to_string(), url: url.to_string() })
        }
        .await;
        *cached = Some((std::time::Instant::now(), fetched.clone()));
        fetched
    }

    /// Engines of this kind found in the standard locations, in order of
    /// preference, and where the server looked.
    pub fn found(&self) -> (Vec<String>, Vec<String>) {
        Self::found_kind(self.kind)
    }

    pub fn found_kind(kind: Kind) -> (Vec<String>, Vec<String>) {
        let mut searched: Vec<String> = Vec::new();
        let mut found: Vec<String> = Vec::new();
        let mut consider = |p: PathBuf| {
            let s = p.to_string_lossy().to_string();
            if searched.contains(&s) { return; }
            searched.push(s.clone());
            if is_executable(&p) {
                let real = std::fs::canonicalize(&p).map(|r| r.to_string_lossy().to_string()).unwrap_or(s.clone());
                if !found.iter().any(|f| f == &s || std::fs::canonicalize(f).map(|r| r.to_string_lossy() == real).unwrap_or(false)) {
                    found.push(s);
                }
            }
        };
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                for name in kind.path_names() {
                    consider(dir.join(name));
                    #[cfg(windows)]
                    consider(dir.join(format!("{name}.exe")));
                }
            }
        }
        for loc in kind.known_locations() {
            consider(PathBuf::from(loc));
        }
        (found, searched)
    }

    /// Lc0 network files in the standard places: `networks/` in the data
    /// directory, the data directory itself, and beside the Lc0 program.
    pub fn networks(&self, engine_path: Option<&str>) -> Vec<String> {
        if self.kind != Kind::Lc0 { return Vec::new(); }
        let mut dirs = vec![self.data_dir.join("networks"), self.data_dir.clone()];
        if let Some(dir) = engine_path.and_then(|p| Path::new(p).parent()) { dirs.push(dir.to_path_buf()); }
        dirs.push(PathBuf::from("/usr/local/share/lc0"));
        dirs.push(PathBuf::from("/usr/share/lc0"));
        let mut out = Vec::new();
        for d in dirs {
            let Ok(entries) = std::fs::read_dir(&d) else { continue };
            let mut files: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .filter(|p| {
                    let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    n.ends_with(".pb.gz") || n.ends_with(".pb") || n.ends_with(".onnx")
                })
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            files.sort();
            for f in files { if !out.contains(&f) { out.push(f); } }
        }
        out
    }

    pub async fn status(&self) -> EngineStatus {
        let auto = self.settings.lock().await.enabled;
        let installed = self.installed(&self.settings.lock().await.clone());
        let enabled = auto && installed;
        if enabled { let _ = self.ensure_started().await; }
        let settings = self.settings.lock().await.clone();
        let hash_mb = settings.hash_mb;
        let (found, searched) = self.found();
        let name = self.running.lock().await.as_ref().map(|r| r.name.clone());
        let version = name.as_deref().and_then(|n| match self.kind {
            Kind::Stockfish => stockfish_version(n),
            Kind::Lc0 => lc0_version(n),
        });
        // Asked for the engine this slot is named after, or when there is none
        // yet (the install guidance can then name the newest release).
        let ours = |n: &str| match self.kind {
            Kind::Stockfish => n.starts_with("Stockfish"),
            Kind::Lc0 => n.starts_with("Lc0"),
        };
        let latest = if enabled && name.as_deref().is_none_or(ours) { self.latest_release().await } else { None };
        let update_available = matches!((&version, &latest), (Some(v), Some(l)) if older(v, &l.version));
        let running = self.running.lock().await;
        let error = self.last_error.lock().await.clone();
        let path_now = running.as_ref().map(|r| r.path.clone()).or_else(|| settings.path.clone()).or_else(|| found.first().cloned());
        let networks = self.networks(path_now.as_deref());
        let weights = settings.weights.clone().or_else(|| networks.first().cloned());
        EngineStatus {
            kind: self.kind,
            enabled,
            auto,
            installed,
            available: running.is_some(),
            path: running.as_ref().map(|r| r.path.clone()).or_else(|| settings.path.clone()).or_else(|| found.first().cloned()),
            name: running.as_ref().map(|r| r.name.clone()),
            error: if running.is_some() { None } else { error },
            settings,
            found,
            searched,
            settings_file: self.settings_file.to_string_lossy().to_string(),
            os: std::env::consts::OS.to_string(),
            version,
            latest,
            update_available,
            cores: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1),
            physical_cores: physical_cores(),
            memory_mb: crate::db::total_ram_mb(),
            budget_mb: crate::db::server_budget_mb(),
            database_mb: crate::db::db_limit_mb(hash_mb),
            max_hash_mb: crate::db::max_engine_hash_mb(),
            weights,
            networks,
        }
    }

    /// Change the engine or its options. `path` must be one of the engines
    /// found in the standard locations (see the module note); `None` keeps
    /// the current choice.
    #[cfg(test)]
    pub async fn configure(&self, path: Option<String>, threads: Option<u32>, hash_mb: Option<u32>) -> Result<EngineStatus, String> {
        self.configure_all(path, threads, hash_mb, None, None, None, None, None, None, ReplySettings::default()).await
    }

    /// As `configure`, with Lc0's network and backend. The network must be one
    /// of those found in the standard places, for the reason the engine must.
    pub async fn configure_all(
        &self,
        path: Option<String>,
        threads: Option<u32>,
        hash_mb: Option<u32>,
        weights: Option<String>,
        backend: Option<String>,
        max_depth: Option<u32>,
        max_nodes: Option<u64>,
        smart_pruning: Option<bool>,
        enabled: Option<bool>,
        reply: ReplySettings,
    ) -> Result<EngineStatus, String> {
        let (restart_engine, restart_helpers) = {
            let mut s = self.settings.lock().await;
            let before = s.clone();
            if let Some(p) = path {
                let (found, _) = self.found();
                if !found.contains(&p) {
                    return Err(format!(
                        "{p} is not one of the engines found in the standard locations. \
                         To use another engine, name it in {} on the server.",
                        self.settings_file.display()
                    ));
                }
                s.path = Some(p);
            }
            let min_threads = if self.kind == Kind::Lc0 { 0 } else { 1 };
            if let Some(t) = threads { s.threads = t.clamp(min_threads, 256); }
            if let Some(h) = hash_mb {
                if self.kind == Kind::Stockfish { s.hash_mb = h.clamp(16, crate::db::max_engine_hash_mb()); }
            }
            if let Some(w) = weights {
                let path_now = s.path.clone().or_else(|| self.found().0.into_iter().next());
                if !self.networks(path_now.as_deref()).contains(&w) {
                    return Err(format!(
                        "{w} is not a network file in the standard places. Put it in {} or name it in {} on the server.",
                        self.data_dir.join("networks").display(),
                        self.settings_file.display()
                    ));
                }
                s.weights = Some(w);
            }
            if let Some(d) = max_depth { s.max_depth = d.clamp(1, 245); }
            if let Some(n) = max_nodes { s.max_nodes = n.clamp(1_000, 1_000_000_000_000); }
            if let Some(p) = smart_pruning { s.smart_pruning = p; }
            if let Some(e) = enabled { s.enabled = e; }
            if let Some(v) = reply.replies { s.replies = v; }
            if let Some(v) = reply.helper_threads { s.helper_threads = v.clamp(1, 64); }
            if let Some(v) = reply.helper_hash_mb { s.helper_hash_mb = v.clamp(16, 4096); }
            if let Some(v) = reply.helper_depth { s.helper_depth = v.clamp(1, 60); }
            if let Some(v) = reply.strong_cp { s.strong_cp = v.min(500); }
            if let Some(v) = reply.helper_nodes { s.helper_nodes = v.clamp(1_000, 10_000_000); }
            if let Some(v) = reply.strong_pct { s.strong_pct = v.clamp(0.0, 50.0); }
            if let Some(v) = reply.neutral_cp { s.neutral_cp = v.min(1000); }
            if let Some(v) = reply.neutral_pct { s.neutral_pct = v.clamp(0.0, 50.0); }
            if let Some(b) = backend {
                if b.is_empty() { s.backend = None; }
                else if valid_backend(&b) { s.backend = Some(b); }
                else { return Err(format!("{b:?} is not a backend name")); }
            }
            let json = serde_json::to_string_pretty(&*s).map_err(|e| e.to_string())?;
            std::fs::write(&self.settings_file, json)
                .map_err(|e| format!("{}: {e}", self.settings_file.display()))?;
            // Restart only for what the processes are started with: the
            // program and its options, or the helpers'. Limits and
            // thresholds are read at each search and count.
            let engine = (&s.path, s.threads, s.hash_mb, &s.weights, &s.backend, s.smart_pruning, s.enabled)
                != (&before.path, before.threads, before.hash_mb, &before.weights, &before.backend, before.smart_pruning, before.enabled);
            let helpers = (s.replies, s.helper_threads, s.helper_hash_mb) != (before.replies, before.helper_threads, before.helper_hash_mb);
            (engine, helpers)
        };
        if restart_engine {
            self.shutdown().await;
        } else if restart_helpers {
            self.reset_helpers().await;
        }
        Ok(self.status().await)
    }

    /// End the helpers and their counts (started again as needed, with the
    /// settings now in force).
    async fn reset_helpers(&self) {
        let limit = helper_count(self.kind, &*self.settings.lock().await);
        self.helpers.lock().unwrap().clear();
        let mut q = self.reply_queue.lock().unwrap();
        for (_, j) in q.jobs.drain() { j.cancel.notify_one(); }
        q.parents.clear();
        q.limit = limit;
    }

    async fn shutdown(&self) {
        // Dropping the idle helpers ends them; counts under way are stopped.
        self.reset_helpers().await;
        self.reply_cache.lock().unwrap().clear();
        self.reply_nodes.store(0, Ordering::Relaxed);
        if let Some(mut r) = self.running.lock().await.take() {
            if self.search.lock().unwrap().frozen { signal_engine(r.child.id(), true); }
            let _ = r.stdin.write_all(b"quit\n").await;
            let _ = tokio::time::timeout(Duration::from_secs(2), r.child.wait()).await;
            let _ = r.child.start_kill();
        }
        let mut s = self.search.lock().unwrap();
        s.searching = false;
        drop(s);
        self.idle.notify_waiters();
    }

    /// Start the engine if it is not running: spawn it, run the UCI handshake
    /// and set its options, then hand stdout to a reader task.
    async fn ensure_started(&self) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if let Some(r) = running.as_mut() {
            if r.child.try_wait().ok().flatten().is_none() {
                return Ok(());
            }
            *running = None; // it died; start another
        }
        let settings = self.settings.lock().await.clone();
        let path = match settings.path.clone().or_else(|| self.found().0.into_iter().next()) {
            Some(p) => p,
            None => {
                let msg = "No chess engine found on the server.".to_string();
                *self.last_error.lock().await = Some(msg.clone());
                return Err(msg);
            }
        };
        let mut settings = settings;
        if self.kind == Kind::Lc0 && settings.weights.is_none() {
            settings.weights = self.networks(Some(&path)).into_iter().next();
        }
        match start(&path, &settings, self.kind).await {
            Ok((child, stdin, stdout, name)) => {
                let search = self.search.clone();
                let idle = self.idle.clone();
                let tx = self.tx.clone();
                let remembered = self.remembered.clone();
                tokio::spawn(read_engine(stdout, search, idle, tx, remembered, self.kind, child.id(), self.store.clone()));
                // Lc0's results depend on its network as much as on its version.
                let ident = match (self.kind, settings.weights.as_deref()) {
                    (Kind::Lc0, Some(w)) => format!("{name} · {}", network_name(w)),
                    _ => name.clone(),
                };
                if let Some(config) = identity_config(&path, &settings) {
                    let mut ids = self.identities.lock().unwrap();
                    if ids.get(&config) != Some(&ident) {
                        ids.insert(config, ident.clone());
                        if let Ok(json) = serde_json::to_string_pretty(&*ids) {
                            let _ = std::fs::write(self.data_dir.join(identities_file(self.kind)), json);
                        }
                    }
                }
                *running = Some(Running { child, stdin, path, name, ident });
                *self.last_error.lock().await = None;
                Ok(())
            }
            Err(e) => {
                let msg = format!("{path}: {e}");
                *self.last_error.lock().await = Some(msg.clone());
                Err(msg)
            }
        }
    }

    /// Start analysing `fen` (already validated) with `lines` lines. With
    /// `history` — the game's starting position and the moves to `fen`, as
    /// UCI — the engine sees how the position arose and can tell a draw by
    /// repetition. Returns the search's number, what is remembered for the
    /// position (if anything), and a receiver of the search's snapshots.
    pub async fn analyse(
        self: &Arc<Self>,
        fen: &str,
        history: Option<(String, Vec<String>)>,
        lines: u32,
        target: Option<u64>,
        fresh: bool,
    ) -> Result<(u64, Option<Snapshot>, broadcast::Receiver<Snapshot>), String> {
        // A benchmark needs the processor to itself: an analysis beside it
        // skews its figures badly (one run took ten times as long).
        if self.benching.try_lock().is_err() {
            return Err("the engine is being benchmarked — try again when it is done".to_string());
        }
        if !self.settings.lock().await.enabled {
            return Err("this engine is switched off (Maintenance → Engines)".to_string());
        }
        self.ensure_started().await?;
        let rx = self.tx.subscribe();
        let depth_to = {
            let s = self.settings.lock().await;
            target.map_or(s.max_depth, |t| t.min(245) as u32).clamp(1, 245)
        };
        let legal = legal_moves(fen);
        let want = lines.clamp(1, 20).min(legal.max(1));
        // Frozen at its depth, not stopped — unless there is nothing to
        // search: "go infinite" then waits for a stop, spinning a core.
        let freeze = can_freeze(self.kind) && legal > 0;
        // Remembered per engine: Stockfish 16 and 19 disagree.
        let ident = self.running.lock().await.as_ref().map(|r| r.ident.clone()).ok_or("the engine stopped")?;
        let position = position_key(fen);
        // Recalculate (the panel's ⟳): what is known of the position goes —
        // remembered and kept — and the engine's hash with it (below), so the
        // search starts from nothing.
        if fresh {
            self.remembered.lock().unwrap().remove(&format!("{ident}|{position}"));
            if let Some(store) = self.store.get() { store.delete_one(&ident, &position); }
        }
        let known = if fresh { None } else { self.lookup(&ident, &position).await };

        let mut running = self.running.lock().await;
        let r = running.as_mut().ok_or("the engine stopped")?;
        let key = format!("{ident}|{position}");
        let pid = r.child.id();

        // Stockfish already on this position (searching, or frozen at its
        // depth) with the same lines: move its target instead of starting
        // again — and thaw it if frozen, so it goes on from where it was.
        if freeze && !fresh {
            let mut s = self.search.lock().unwrap();
            if s.searching && s.key == key && s.want == want {
                let snap = |s: &Search, done: bool| Snapshot {
                    gen: s.gen, depth: s.depth, nodes: s.nodes, nps: s.nps,
                    lines: s.lines.values().cloned().collect(), done, cached: false, engine: None,
                };
                if s.frozen && depth_to <= s.depth {
                    // Already there: say so.
                    return Ok((s.gen, Some(snap(&s, true)), rx));
                }
                s.stop_at = Some(depth_to);
                if s.frozen {
                    s.frozen = false;
                    s.resumed = Some(None);
                    signal_engine(pid, true);
                }
                self.alive();
                return Ok((s.gen, Some(snap(&s, false)), rx));
            }
        }
        let gen = self.gen.fetch_add(1, Ordering::SeqCst) + 1;
        let remembered = known.map(|mut s| { s.gen = gen; s });

        // Finish the previous search first, so its closing `bestmove` is not
        // taken for the end of this one.
        let (was_searching, was_frozen) = { let s = self.search.lock().unwrap(); (s.searching, s.frozen) };
        if was_searching {
            let waiting = self.idle.notified();
            // A frozen engine reads nothing: thaw it to hear the stop.
            if was_frozen { signal_engine(pid, true); }
            send(&mut r.stdin, "stop").await?;
            let _ = tokio::time::timeout(Duration::from_secs(3), waiting).await;
        }
        {
            let mut s = self.search.lock().unwrap();
            *s = Search {
                gen,
                key,
                ident,
                position: position.clone(),
                white_to_move: fen.split_whitespace().nth(1) != Some("b"),
                searching: true,
                want,
                depth: 0, nodes: 0, nps: 0,
                lines: BTreeMap::new(),
                stop_at: freeze.then_some(depth_to),
                frozen: false,
                resumed: None,
            };
        }
        send(&mut r.stdin, &format!("setoption name MultiPV value {}", lines.clamp(1, 20))).await?;
        let position = match &history {
            Some((start, moves)) if !moves.is_empty() => format!("position fen {start} moves {}", moves.join(" ")),
            _ => format!("position fen {fen}"),
        };
        // A new game to the engine: Stockfish clears its hash, Lc0 its tree.
        if fresh { send(&mut r.stdin, "ucinewgame").await?; }
        send(&mut r.stdin, &position).await?;
        // Stop at the threshold — or at `target`, the panel's "search further"
        // once the threshold was reached. Never without one: a search runs
        // as long as its panel is open (see ALIVE_TTL).
        // Stockfish on Unix: no depth of its own — the reader freezes it at
        // `stop_at`.
        let go = match self.kind {
            Kind::Stockfish if freeze => "go infinite".to_string(),
            Kind::Stockfish => format!("go depth {depth_to}"),
            Kind::Lc0 => {
                let s = self.settings.lock().await;
                format!("go nodes {}", target.unwrap_or(s.max_nodes).clamp(1_000, 1_000_000_000_000))
            }
        };
        send(&mut r.stdin, &go).await?;
        drop(running);

        // Stop the search once its panel has gone quiet.
        self.alive();
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(ALIVE_CHECK).await;
                let current = { let s = me.search.lock().unwrap(); s.gen == gen && s.searching };
                if !current { return; }
                if me.alive.lock().unwrap().elapsed() > ALIVE_TTL {
                    me.stop(gen).await;
                    return;
                }
            }
        });
        Ok((gen, remembered, rx))
    }

    /// The Engine panel is still open: its search goes on.
    pub fn alive(&self) {
        *self.alive.lock().unwrap() = std::time::Instant::now();
    }

    /// Stop search `gen` if it is still the current one (thawing it first
    /// if it is frozen).
    pub async fn stop(&self, gen: u64) {
        let (current, frozen) = {
            let s = self.search.lock().unwrap();
            (s.gen == gen && s.searching, s.frozen)
        };
        if current {
            if let Some(r) = self.running.lock().await.as_mut() {
                if frozen { signal_engine(r.child.id(), true); }
                let _ = send(&mut r.stdin, "stop").await;
            }
        }
    }

    /// The panel paused this engine: freeze Stockfish's search where it is
    /// (Unix), so running it again goes on from there — the next analysis of
    /// the same position thaws it. Other engines, and elsewhere, the search
    /// just stops when the panel's stream closes.
    pub async fn pause(&self) -> bool {
        if !can_freeze(self.kind) { return false; }
        let pid = self.running.lock().await.as_ref().and_then(|r| r.child.id());
        let mut s = self.search.lock().unwrap();
        if !s.searching || s.frozen || s.stop_at.is_none() { return false; }
        s.frozen = true;
        s.resumed = None;
        signal_engine(pid, false);
        // Keep what it has, as when a search ends.
        let (key, ident, position) = (s.key.clone(), s.ident.clone(), s.position.clone());
        drop(s);
        if let (Some(store), Some(best)) = (self.store.get(), self.remembered.lock().unwrap().get(&key)) {
            store.save(self.kind, &ident, &position, &best);
        }
        true
    }

    /// A stream of search `gen` went away. Stop the search unless another
    /// stream watches it — the panel reconnects to move the target — or it is
    /// frozen at its depth, kept for "search further" while the panel is open
    /// (the heartbeat ends it after that). A moment's grace, as a reconnect
    /// closes the old stream before the new one opens.
    pub async fn stream_gone(&self, gen: u64) {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let keep = {
            let s = self.search.lock().unwrap();
            s.gen != gen || !s.searching || s.frozen
        };
        if keep || self.tx.receiver_count() > 0 { return; }
        self.stop(gen).await;
    }

    fn reply_key(name: &str, s: &EngineSettings, fen: &str) -> String {
        format!("{name}|{}|{}|{}|{}|{}", s.helper_depth, s.strong_cp, s.helper_nodes, s.strong_pct, position_key(fen))
    }

    /// Replies & Strong for the positions after the candidate moves (`fens`,
    /// cleaned) of `parent`: the opponent's legal replies, and how many are
    /// within the threshold of the best. A position not counted yet is queued
    /// for the next free helper, unless `cached_only` (a paused engine), and
    /// the Engine panel asks again for the progress. Stockfish searches every
    /// reply to the helper's depth; Lc0 runs a short search and counts the
    /// replies it explored.
    pub async fn replies(self: &Arc<Self>, parent: &str, fens: &[String], cached_only: bool) -> Result<ReplyAnswer, String> {
        let settings = self.settings.lock().await.clone();
        if !settings.enabled {
            return Err("this engine is switched off".to_string());
        }
        // With Replies & Strong off, only what is known already: the deeper
        // analyses, for the moves' evaluations.
        let cached_only = cached_only || !settings.replies;
        if !cached_only { self.ensure_started().await?; }
        let name = self.ident_now().await;
        // The positions after the moves, analysed before (perhaps before a
        // restart): into memory, where the counts below look.
        if let Some(n) = &name {
            for fen in fens { let _ = self.lookup_own(n, &position_key(fen)).await; }
        }
        let state = |fen: &str, state, count, pct, error| ReplyState { fen: fen.to_string(), state, count, pct, error, line: None, line_depth: None, line_nodes: None, at_least: false };
        let Some(name) = name else {
            return Ok(ReplyAnswer { lines: fens.iter().map(|f| state(f, "none", None, None, None)).collect(), pending: 0 });
        };
        let parent = position_key(parent);
        let now = std::time::Instant::now();
        let mut lines = Vec::with_capacity(fens.len());
        let pending = {
            let mut q = self.reply_queue.lock().unwrap();
            q.parents.insert(parent.clone(), now);
            for fen in fens {
                let legal = legal_moves(fen);
                // The position after the move analysed deeper than the helper
                // counts — the move was played and the panel analysed it: its
                // best line gives the move's evaluation, and its lines the
                // strong replies, by the threshold the marks there use.
                let deep = self.remembered.lock().unwrap().get(&format!("{name}|{}", position_key(fen)))
                    .filter(|d| !d.lines.is_empty() && match self.kind {
                        Kind::Stockfish => d.depth >= settings.helper_depth,
                        Kind::Lc0 => d.nodes > settings.helper_nodes,
                    });
                let deep = deep.map(|d| {
                    let strong = strong_lines(self.kind, &settings, fen, &d.lines);
                    // All lines strong: there may be more beyond them.
                    let exact = strong < d.lines.len() as u32 || d.lines.len() as u32 >= legal;
                    (d, strong, exact)
                });
                let with_deep = |mut st: ReplyState| {
                    if let Some((d, strong, exact)) = &deep {
                        st.line = d.lines.first().cloned();
                        st.line_depth = Some(d.depth);
                        st.line_nodes = Some(d.nodes);
                        let deep_count = ReplyCount { replies: legal, strong: (*strong).max(1), depth: d.depth, nodes: d.nodes };
                        match &st.count {
                            // The helper's count, unless the deeper lines prove more.
                            Some(c) if !*exact => {
                                if c.strong < *strong { st.count = Some(deep_count); st.at_least = true; }
                            }
                            _ if *exact => { st.state = "done"; st.count = Some(deep_count); st.pct = None; }
                            // No count: the deeper lines give a lower bound.
                            _ if st.state == "none" => { st.state = "done"; st.count = Some(deep_count); st.at_least = true; }
                            _ => {}
                        }
                    }
                    st
                };
                if deep.as_ref().is_some_and(|(_, _, exact)| *exact) {
                    lines.push(with_deep(state(fen, "done", None, None, None)));
                    continue;
                }
                // Stockfish counts from its lines alone — the helper's are as
                // many as the panel's — so every line strong is "5+", not a
                // reason to count again.
                if self.kind == Kind::Stockfish {
                    if let Some((d, strong, _)) = &deep {
                        let mut st = state(fen, "done", Some(ReplyCount { replies: legal, strong: (*strong).max(1), depth: d.depth, nodes: d.nodes }), None, None);
                        st.line = d.lines.first().cloned();
                        st.line_depth = Some(d.depth);
                        st.line_nodes = Some(d.nodes);
                        st.at_least = true;
                        lines.push(st);
                        continue;
                    }
                }
                let key = Self::reply_key(&name, &settings, fen);
                if let Some(c) = self.reply_cache.lock().unwrap().get(&key).cloned() {
                    lines.push(with_deep(state(fen, "done", Some(c), None, None)));
                    continue;
                }
                if legal == 0 {
                    lines.push(state(fen, "done", Some(ReplyCount { replies: 0, strong: 0, depth: 0, nodes: 0 }), None, None));
                    continue;
                }
                if let Some(j) = q.jobs.get_mut(&key) {
                    match &j.state {
                        // A failure is reported for a while, then tried again.
                        ReplyProgress::Failed(_, at) if at.elapsed() > Duration::from_secs(30) => { q.jobs.remove(&key); }
                        ReplyProgress::Failed(e, _) => { lines.push(with_deep(state(fen, "failed", None, None, Some(e.clone())))); continue; }
                        ReplyProgress::Waiting => { j.asked = now; lines.push(with_deep(state(fen, "waiting", None, None, None))); continue; }
                        ReplyProgress::Counting(p) => { j.asked = now; lines.push(with_deep(state(fen, "counting", None, Some(*p), None))); continue; }
                    }
                }
                if cached_only {
                    lines.push(with_deep(state(fen, "none", None, None, None)));
                    continue;
                }
                q.jobs.insert(key, ReplyJob {
                    fen: fen.clone(), parent: parent.clone(), settings: settings.clone(),
                    state: ReplyProgress::Waiting, asked: now, queued: now, cancel: Arc::new(Notify::new()),
                });
                lines.push(with_deep(state(fen, "waiting", None, None, None)));
            }
            q.jobs.values().filter(|j| j.parent == parent && matches!(j.state, ReplyProgress::Waiting | ReplyProgress::Counting(_))).count()
        };
        self.dispatch();
        Ok(ReplyAnswer { lines, pending })
    }

    /// Drop the counts of positions the panel has left (stopping those under
    /// way), then start waiting counts on free helpers: those on the panel's
    /// list first, then those whose move left it, oldest first.
    fn dispatch(self: &Arc<Self>) {
        let mut q = self.reply_queue.lock().unwrap();
        let fresh = |t: &std::time::Instant| t.elapsed() <= REPLY_ASK_TTL;
        let stale: Vec<String> = q.jobs.iter()
            .filter(|(_, j)| !fresh(&j.asked) && !q.parents.get(&j.parent).is_some_and(fresh))
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale {
            if let Some(j) = q.jobs.remove(&k) { j.cancel.notify_one(); }
        }
        q.parents.retain(|_, t| fresh(t));
        loop {
            let running = q.jobs.values().filter(|j| matches!(j.state, ReplyProgress::Counting(_))).count();
            if running >= q.limit { break; }
            let next = q.jobs.iter()
                .filter(|(_, j)| matches!(j.state, ReplyProgress::Waiting))
                .max_by_key(|(_, j)| (j.asked.elapsed() <= REPLY_ON_LIST, std::cmp::Reverse(j.queued)))
                .map(|(k, _)| k.clone());
            let Some(key) = next else { break };
            let j = q.jobs.get_mut(&key).unwrap();
            j.state = ReplyProgress::Counting(0);
            let (fen, settings, cancel) = (j.fen.clone(), j.settings.clone(), j.cancel.clone());
            tokio::spawn(self.clone().run_reply_job(key, fen, settings, cancel));
        }
    }

    /// One count on a helper; then the next waiting one.
    async fn run_reply_job(self: Arc<Self>, key: String, fen: String, settings: EngineSettings, cancel: Arc<Notify>) {
        let result = self.count_one(&key, &fen, &settings, &cancel).await;
        {
            let mut q = self.reply_queue.lock().unwrap();
            match result {
                Ok(c) => {
                    // Stockfish's count is its lines, remembered (see count_one).
                    if self.kind == Kind::Lc0 { self.reply_cache.lock().unwrap().insert(key.clone(), c); }
                    q.jobs.remove(&key);
                }
                // Stopped: the job is gone already.
                Err(e) if e == STOPPED => {}
                Err(e) => {
                    if let Some(j) = q.jobs.get_mut(&key) { j.state = ReplyProgress::Failed(e, std::time::Instant::now()); }
                }
            }
        }
        self.dispatch();
    }

    fn set_reply_pct(&self, key: &str, pct: u32) {
        if let Some(j) = self.reply_queue.lock().unwrap().jobs.get_mut(key) {
            if matches!(j.state, ReplyProgress::Counting(_)) { j.state = ReplyProgress::Counting(pct.min(99)); }
        }
    }

    /// Count one position on an idle helper (or a new one); the helper goes
    /// back to the pool after a clean count, and is ended after a failure.
    /// An idle helper with the settings now in force, or a new one.
    async fn take_helper(&self, settings: &EngineSettings) -> Result<Helper, String> {
        let path = self.running.lock().await.as_ref().map(|r| r.path.clone()).ok_or("no engine")?;
        let config = format!("{path}|{}|{}|{:?}|{:?}", settings.helper_threads, settings.helper_hash_mb, settings.weights, settings.backend);
        let idle = {
            let mut pool = self.helpers.lock().unwrap();
            pool.retain(|h| h.config == config);
            pool.pop()
        };
        Ok(match idle {
            Some(h) => h,
            None => {
                let mut hs = settings.clone();
                match self.kind {
                    // The helper threads and hash, shared among the helpers.
                    Kind::Stockfish => {
                        hs.threads = 1;
                        hs.hash_mb = (settings.helper_hash_mb / helper_count(self.kind, settings) as u32).max(16);
                    }
                    Kind::Lc0 => {
                        hs.threads = settings.helper_threads;
                        hs.hash_mb = settings.helper_hash_mb;
                        if hs.weights.is_none() { hs.weights = self.networks(Some(&path)).into_iter().next(); }
                    }
                }
                let (child, mut stdin, stdout, _) = start(&path, &hs, self.kind).await?;
                if self.kind == Kind::Lc0 {
                    send(&mut stdin, "setoption name VerboseMoveStats value true").await?;
                }
                Helper { _child: child, stdin, stdout, config: config.clone() }
            }
        })
    }

    /// Stockfish's first-sight order of every legal move in `fen` (UCI, best
    /// first): a shallow search on a helper, for the one-click move when the
    /// database has nothing and there is no deeper evaluation — asked for as
    /// soon as the panel shows the position, so it is there by the click.
    pub async fn quick_order(&self, fen: &str) -> Result<Vec<String>, String> {
        if self.kind != Kind::Stockfish { return Err("only Stockfish ranks moves at first sight".to_string()); }
        let settings = self.settings.lock().await.clone();
        if !settings.enabled { return Err("Stockfish is switched off".to_string()); }
        let position = position_key(fen);
        if let Some(o) = self.quick_cache.lock().unwrap().get(&position) { return Ok(o.clone()); }
        let legal = legal_moves(fen);
        if legal == 0 { return Ok(Vec::new()); }
        self.ensure_started().await?;
        let mut h = self.take_helper(&settings).await?;
        send(&mut h.stdin, &format!("position fen {fen}")).await?;
        send(&mut h.stdin, &format!("setoption name MultiPV value {}", legal.min(256))).await?;
        send(&mut h.stdin, &format!("go depth {QUICK_DEPTH}")).await?;
        let mut order: BTreeMap<u32, String> = BTreeMap::new();
        let mut line = String::new();
        let read = async {
            loop {
                line.clear();
                if h.stdout.read_line(&mut line).await.map_err(|e| e.to_string())? == 0 {
                    return Err("the helper ended".to_string());
                }
                let t = line.trim();
                if t.starts_with("bestmove") { return Ok::<(), String>(()); }
                if let Some(l) = parse_info(t).and_then(|i| i.line) {
                    if let Some(m) = l.pv_uci.first() { order.insert(l.multipv, m.clone()); }
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(10), read).await.map_err(|_| "the helper took too long".to_string())??;
        // Restore the helper's usual lines before it goes back to the pool.
        send(&mut h.stdin, &format!("setoption name MultiPV value {HELPER_LINES}")).await?;
        self.helpers.lock().unwrap().push(h);
        let moves: Vec<String> = order.into_values().collect();
        let mut cache = self.quick_cache.lock().unwrap();
        if cache.len() > 5_000 { cache.clear(); }
        cache.insert(position, moves.clone());
        Ok(moves)
    }

    async fn count_one(&self, key: &str, fen: &str, settings: &EngineSettings, cancel: &Notify) -> Result<ReplyCount, String> {
        let legal = legal_moves(fen);
        let mut h = self.take_helper(settings).await?;
        send(&mut h.stdin, &format!("position fen {fen}")).await?;
        match self.kind {
            Kind::Stockfish => {
                // The best HELPER_LINES replies: the strong count is exact up
                // to one fewer, "5+" beyond — enough to find the moves with
                // only one or two good replies, at a fraction of the time
                // every reply takes (4.5 s to depth 24 against 12 s to 20).
                send(&mut h.stdin, &format!("setoption name MultiPV value {}", legal.min(HELPER_LINES))).await?;
                send(&mut h.stdin, &format!("go depth {}", settings.helper_depth.max(1))).await?;
            }
            Kind::Lc0 => {
                send(&mut h.stdin, "setoption name MultiPV value 1").await?;
                send(&mut h.stdin, &format!("go nodes {}", settings.helper_nodes.max(1000))).await?;
            }
        }

        // Stockfish: each reply's last exact score, by line. Lc0: each
        // explored reply's visits and expected score, from the move stats.
        let mut scores: std::collections::HashMap<u32, (u32, i32)> = std::collections::HashMap::new();
        // Stockfish: the lines themselves, kept as the position's result.
        let mut found: BTreeMap<u32, Line> = BTreeMap::new();
        let mut stats: std::collections::HashMap<String, (u64, f64)> = std::collections::HashMap::new();
        let (mut depth, mut nodes) = (0u32, 0u64);
        let reference = self.reply_nodes.load(Ordering::Relaxed);
        let target_depth = settings.helper_depth.max(1);
        let mut shown = 0u32;
        let mut line = String::new();
        // Ok(false): stopped — the panel left the position.
        let read = async {
            let mut stopping = false;
            loop {
                // A line half read when the stop comes stays in `line`, and
                // the next read completes it.
                let got = if stopping {
                    h.stdout.read_line(&mut line).await
                } else {
                    tokio::select! {
                        r = h.stdout.read_line(&mut line) => r,
                        _ = cancel.notified() => {
                            send(&mut h.stdin, "stop").await?;
                            stopping = true;
                            continue;
                        }
                    }
                };
                if got.map_err(|e| e.to_string())? == 0 {
                    return Err("the helper ended".to_string());
                }
                let t = std::mem::take(&mut line);
                let t = t.trim();
                if t.starts_with("bestmove") { return Ok(!stopping); }
                if stopping { continue; }
                if let Some(rest) = t.strip_prefix("info string ") {
                    if let Some((mv, n, q)) = parse_move_stats(rest) { stats.insert(mv, (n, q)); }
                    continue;
                }
                if let Some(info) = parse_info(t) {
                    if let Some(d) = info.depth { depth = depth.max(d); }
                    if let Some(n) = info.nodes { nodes = n; }
                    if let Some(l) = info.line {
                        let score = match (l.mate, l.eval_cp) {
                            (Some(m), _) if m > 0 => 100_000 - m,
                            (Some(m), _) => -100_000 - m,
                            (None, Some(cp)) => cp,
                            _ => continue,
                        };
                        scores.insert(l.multipv, (info.depth.unwrap_or(0), score));
                        found.insert(l.multipv, l);
                    }
                    // Progress: Lc0's nodes of its limit. Stockfish's nodes of
                    // what the last count took, or before any count, by depth:
                    // each depth takes about half as long again as the one
                    // before, and the depth reported is the one under way —
                    // depth 20 of 20 is two thirds of the way, 16 an eighth.
                    let pct = match self.kind {
                        Kind::Lc0 => (nodes.saturating_mul(100) / settings.helper_nodes.max(1000)) as u32,
                        Kind::Stockfish if reference > 0 => (nodes.saturating_mul(100) / reference) as u32,
                        Kind::Stockfish => (100.0 * 1.5f64.powi(depth as i32 - target_depth as i32 - 1)) as u32,
                    };
                    if pct != shown {
                        shown = pct;
                        self.set_reply_pct(key, pct);
                    }
                }
            }
        };
        // On a failure or a timeout the helper is dropped, which ends it.
        let finished = tokio::time::timeout(Duration::from_secs(180), read).await.map_err(|_| "the helper took too long".to_string())??;
        self.helpers.lock().unwrap().push(h);
        if !finished { return Err(STOPPED.to_string()); }

        Ok(match self.kind {
            Kind::Stockfish => {
                let old = self.reply_nodes.load(Ordering::Relaxed);
                self.reply_nodes.store(if old == 0 { nodes } else { (old * 2 + nodes) / 3 }, Ordering::Relaxed);
                // The count is a result of the position like any other: its
                // lines, White-relative as the panel gets them, remembered and
                // kept — the strong replies are counted from them, by the
                // threshold of the moment (see `replies`).
                let white = fen.split_whitespace().nth(1) != Some("b");
                let lines: Vec<Line> = found.into_values().map(|mut l| {
                    if !white {
                        l.eval_cp = l.eval_cp.map(|c| -c);
                        l.mate = l.mate.map(|m| -m);
                        l.wdl = l.wdl.map(|[w, d, b]| [b, d, w]);
                    }
                    l
                }).collect();
                let snap = Snapshot { gen: 0, depth, nodes, nps: 0, lines, done: true, cached: true, engine: None };
                if let Some(ident) = self.running.lock().await.as_ref().map(|r| r.ident.clone()) {
                    let position = position_key(fen);
                    self.remembered.lock().unwrap().offer(&format!("{ident}|{position}"), &snap, self.kind);
                    if let Some(store) = self.store.get() { store.save(self.kind, &ident, &position, &snap); }
                }
                let strong = strong_lines(self.kind, settings, fen, &snap.lines);
                ReplyCount { replies: legal, strong: strong.max(1), depth, nodes }
            }
            Kind::Lc0 => {
                let total: u64 = stats.values().map(|&(n, _)| n).sum();
                // Replies it barely looked at have no reliable score — nor
                // are they strong, or it would have looked.
                let min_visits = (total / 100).max(20);
                let best = stats.values().filter(|&&(n, _)| n >= min_visits).map(|&(_, q)| q).fold(f64::MIN, f64::max);
                let thr = settings.strong_pct as f64 / 100.0 * 2.0; // Q spans -1..1: 1% of expected score is 0.02
                let strong = stats.values().filter(|&&(n, q)| n >= min_visits && q >= best - thr).count() as u32;
                ReplyCount { replies: legal, strong: strong.max(1), depth, nodes: total.max(nodes) }
            }
        })
    }

    /// The deepest remembered result for `fen`, with the engine running now.
    pub async fn remembered(&self, fen: &str) -> Option<Snapshot> {
        let ident = self.ident_now().await?;
        self.lookup(&ident, &position_key(fen)).await
    }

    /// The furthest result known for `position`: remembered in memory, kept
    /// in the database, or — labelled with its engine — one of another
    /// version of the engine, until this one has its own.
    async fn lookup(&self, ident: &str, position: &str) -> Option<Snapshot> {
        if let Some(s) = self.lookup_own(ident, position).await { return Some(s); }
        let store = self.store.get()?.clone();
        store.load_older(self.kind, ident, position).await
    }

    /// This engine's own result for `position` (memory, then the database) —
    /// what the marks and counts of the positions before it may use.
    async fn lookup_own(&self, ident: &str, position: &str) -> Option<Snapshot> {
        let key = format!("{ident}|{position}");
        if let Some(s) = self.remembered.lock().unwrap().get(&key) { return Some(s); }
        let store = self.store.get()?.clone();
        let s = store.load(ident, position).await?;
        self.remembered.lock().unwrap().offer(&key, &s, self.kind);
        Some(s)
    }

    /// The identity results are kept under: the running engine's, or — not
    /// started yet — the one its program (and network) had when it last ran.
    async fn ident_now(&self) -> Option<String> {
        if let Some(r) = self.running.lock().await.as_ref() { return Some(r.ident.clone()); }
        let mut s = self.settings.lock().await.clone();
        let path = s.path.clone().or_else(|| self.found().0.into_iter().next())?;
        if self.kind == Kind::Lc0 && s.weights.is_none() {
            s.weights = self.networks(Some(&path)).into_iter().next();
        }
        let config = identity_config(&path, &s)?;
        self.identities.lock().unwrap().get(&config).cloned()
    }

    /// Give the engine the database to keep its results in.
    pub fn set_store(&self, store: EvalStore) {
        let _ = self.store.set(store);
    }

    /// Forget the results remembered in memory for `ident` (they were
    /// deleted from the database).
    pub fn forget(&self, ident: &str) {
        let prefix = format!("{ident}|");
        let mut r = self.remembered.lock().unwrap();
        r.by_key.retain(|k, _| !k.starts_with(&prefix));
        r.order.retain(|k| !k.starts_with(&prefix));
    }

    pub fn current_gen(&self) -> u64 {
        self.gen.load(Ordering::SeqCst)
    }

    /// Run Stockfish's own benchmark — a fixed set of positions searched to
    /// `depth` — with the given threads and hash, in a separate process, and
    /// report its speed. The analysis engine is stopped first so the two do
    /// not share the processor, and only one benchmark runs at a time.
    pub async fn bench(&self, threads: Option<u32>, hash_mb: Option<u32>, depth: Option<u32>) -> Result<BenchResult, String> {
        let _one = self.benching.try_lock().map_err(|_| "a benchmark is already running".to_string())?;
        self.ensure_started().await?;
        let (path, name) = {
            let r = self.running.lock().await;
            let r = r.as_ref().ok_or("no engine")?;
            (r.path.clone(), r.name.clone())
        };
        let settings = self.settings.lock().await.clone();
        let (args, threads, hash_mb, depth) = match self.kind {
            Kind::Stockfish => {
                if !name.starts_with("Stockfish") {
                    return Err(format!("{name} has no benchmark LPDO knows how to run"));
                }
                let threads = threads.unwrap_or(settings.threads).clamp(1, 256);
                let hash_mb = hash_mb.unwrap_or(settings.hash_mb).clamp(16, 65536);
                let depth = depth.unwrap_or(16).clamp(1, 30);
                (vec!["bench".to_string(), hash_mb.to_string(), threads.to_string(), depth.to_string()], threads, hash_mb, depth)
            }
            // Lc0's standard benchmark: 34 positions, 10 s each. Shorter runs
            // are not comparable — its speed grows as a search goes on (the
            // cache fills, batches grow): 12k nodes/s at 3 s a position
            // against 62k at 10 s on one machine.
            Kind::Lc0 => {
                let weights = settings.weights.clone().or_else(|| self.networks(Some(&path)).into_iter().next())
                    .ok_or("Lc0 has no network")?;
                let mut a = vec!["benchmark".to_string(), format!("--weights={weights}")];
                if let Some(b) = settings.backend.as_deref().filter(|b| valid_backend(b)) { a.push(format!("--backend={b}")); }
                if settings.threads > 0 { a.push(format!("--threads={}", settings.threads)); }
                (a, settings.threads, 0, 0)
            }
        };
        self.stop(self.current_gen()).await;

        let out = tokio::time::timeout(
            Duration::from_secs(20 * 60),
            Command::new(&path)
                .args(&args)
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| "the benchmark took longer than 20 minutes".to_string())?
        .map_err(|e| e.to_string())?;
        // Stockfish writes the summary to stderr.
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let field = |label: &str| -> Option<u64> {
            text.lines()
                .find(|l| l.trim_start().starts_with(label))
                .and_then(|l| l.split(':').nth(1))
                .and_then(|v| v.trim().parse().ok())
        };
        match (field("Nodes searched"), field("Nodes/second"), field("Total time (ms)")) {
            (Some(nodes), Some(nps), Some(ms)) => Ok(BenchResult { engine: name, threads, hash_mb, depth, nodes, nps, ms }),
            _ => Err("the engine's benchmark printed no result".to_string()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct BenchResult {
    pub engine: String,
    pub threads: u32,
    pub hash_mb: u32,
    pub depth: u32,
    pub nodes: u64,
    pub nps: u64,
    pub ms: u64,
}

fn is_executable(p: &Path) -> bool {
    match std::fs::metadata(p) {
        Ok(m) if m.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                m.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}

async fn send(stdin: &mut ChildStdin, line: &str) -> Result<(), String> {
    stdin.write_all(format!("{line}\n").as_bytes()).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

/// How many of an analysis's lines (White-relative, as the panel gets them)
/// are strong for the side to move in `fen`: within the engine's threshold of
/// the best — the rule the Engine panel marks "!" by. Lc0 by expected score
/// (win and half the draws) where the lines have it.
fn strong_lines(kind: Kind, s: &EngineSettings, fen: &str, lines: &[Line]) -> u32 {
    let white = fen.split_whitespace().nth(1) != Some("b");
    let by_wdl = kind == Kind::Lc0 && lines.iter().all(|l| l.wdl.is_some());
    let scores: Vec<f64> = lines.iter().map(|l| {
        if by_wdl {
            let [w, d, b] = l.wdl.unwrap();
            ((if white { w } else { b }) as f64 + d as f64 / 2.0) / 1000.0
        } else {
            let cp = match (l.mate, l.eval_cp) {
                (Some(m), _) if m > 0 => 100_000 - m,
                (Some(m), _) => -100_000 - m,
                (None, Some(cp)) => cp,
                _ => 0,
            } as f64;
            if white { cp } else { -cp }
        }
    }).collect();
    let thr = if by_wdl { s.strong_pct as f64 / 100.0 } else if kind == Kind::Lc0 { 10.0 } else { s.strong_cp as f64 };
    let best = scores.iter().cloned().fold(f64::MIN, f64::max);
    scores.iter().filter(|&&x| x >= best - thr - 1e-9).count() as u32
}

/// How many helpers count Replies & Strong at once. Stockfish: one
/// single-threaded helper per helper thread, each counting one candidate —
/// four candidates take about a third of the time they take one after
/// another with four threads (Lazy SMP gains little on such short searches).
/// Lc0: one, as its work is on the graphics card.
fn helper_count(kind: Kind, s: &EngineSettings) -> usize {
    match kind {
        Kind::Stockfish => s.helper_threads.max(1) as usize,
        Kind::Lc0 => 1,
    }
}

/// Spawn the engine and run the UCI handshake. Returns the process, its
/// pipes and the name it reports.
async fn start(path: &str, settings: &EngineSettings, kind: Kind) -> Result<(Child, ChildStdin, BufReader<ChildStdout>, String), String> {
    let mut child = Command::new(path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);

    let handshake = async {
        send(&mut stdin, "uci").await?;
        let mut name = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            if stdout.read_line(&mut line).await.map_err(|e| e.to_string())? == 0 {
                return Err("the program ended during the UCI handshake — is it a chess engine?".to_string());
            }
            let t = line.trim();
            if let Some(n) = t.strip_prefix("id name ") { name = n.to_string(); }
            if t == "uciok" { break; }
        }
        // Win/draw/loss with every line: Lc0's own view of a position, and
        // Stockfish's estimate of it.
        send(&mut stdin, "setoption name UCI_ShowWDL value true").await?;
        match kind {
            Kind::Stockfish => {
                send(&mut stdin, &format!("setoption name Threads value {}", settings.threads)).await?;
                send(&mut stdin, &format!("setoption name Hash value {}", settings.hash_mb)).await?;
            }
            Kind::Lc0 => {
                if let Some(w) = &settings.weights {
                    send(&mut stdin, &format!("setoption name WeightsFile value {w}")).await?;
                }
                if let Some(b) = settings.backend.as_deref().filter(|b| valid_backend(b)) {
                    send(&mut stdin, &format!("setoption name Backend value {b}")).await?;
                }
                if settings.threads > 0 {
                    send(&mut stdin, &format!("setoption name Threads value {}", settings.threads)).await?;
                }
                // Lc0 ends a search early once the best move cannot be
                // overtaken in the nodes left ("smart pruning"): right for
                // playing, wrong for analysis, where the other lines matter
                // too and the node limit should mean what it says.
                if !settings.smart_pruning {
                    send(&mut stdin, "setoption name SmartPruningFactor value 0").await?;
                }
            }
        }
        send(&mut stdin, "isready").await?;
        loop {
            line.clear();
            if stdout.read_line(&mut line).await.map_err(|e| e.to_string())? == 0 {
                return Err("the engine ended before it was ready".to_string());
            }
            if line.trim() == "readyok" { break; }
        }
        Ok::<String, String>(name)
    };
    let name = tokio::time::timeout(kind.handshake(), handshake)
        .await
        .map_err(|_| "no answer to the UCI handshake — is it a chess engine?".to_string())??;
    Ok((child, stdin, stdout, if name.is_empty() { path.to_string() } else { name }))
}

/// Read the engine's output for as long as it runs, folding `info` lines
/// into the current search and broadcasting a snapshot per update.
async fn read_engine(
    mut stdout: BufReader<ChildStdout>,
    search: Arc<std::sync::Mutex<Search>>,
    idle: Arc<Notify>,
    tx: broadcast::Sender<Snapshot>,
    remembered: Arc<std::sync::Mutex<Remembered>>,
    kind: Kind,
    pid: Option<u32>,
    store: Arc<std::sync::OnceLock<EvalStore>>,
) {
    let mut line = String::new();
    loop {
        line.clear();
        match stdout.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let t = line.trim();
        let snapshot = {
            let mut s = search.lock().unwrap();
            if t.starts_with("bestmove") {
                if !s.searching { continue; }
                s.searching = false;
                s.frozen = false;
                idle.notify_waiters();
            } else if let Some(info) = parse_info(t) {
                // Frozen: what was already in the pipe is past the target.
                if !s.searching || s.frozen { continue; }
                if let Some(d) = info.depth { s.depth = s.depth.max(d); }
                if let Some(n) = info.nodes { s.nodes = n; }
                if let Some(n) = info.nps {
                    // Stockfish's own figure counts the time it was frozen.
                    s.nps = match s.resumed {
                        None => n,
                        Some(None) => { s.resumed = Some(Some((std::time::Instant::now(), s.nodes))); s.nps }
                        Some(Some((at, n0))) if at.elapsed().as_millis() > 0 =>
                            (s.nodes.saturating_sub(n0) as u128 * 1000 / at.elapsed().as_millis()) as u64,
                        Some(Some(_)) => s.nps,
                    };
                }
                match info.line {
                    Some(mut l) => {
                        if l.multipv > s.want { continue; }
                        if !s.white_to_move {
                            l.eval_cp = l.eval_cp.map(|c| -c);
                            l.mate = l.mate.map(|m| -m);
                            // The engine's win is Black's here: swap ends.
                            l.wdl = l.wdl.map(|[w, d, b]| [b, d, w]);
                        }
                        let last_of_set = l.multipv == s.want;
                        s.lines.insert(l.multipv, l);
                        if !last_of_set { continue; } // wait for the rest of this depth
                    }
                    None => continue, // speed-only updates are not worth a snapshot
                }
            } else {
                continue;
            }
            // At its target depth: freeze (the lines of that depth are complete).
            if s.searching && s.stop_at.is_some_and(|d| s.depth >= d) {
                s.frozen = true;
                signal_engine(pid, false);
            }
            let snap = Snapshot {
                gen: s.gen, depth: s.depth, nodes: s.nodes, nps: s.nps,
                lines: s.lines.values().cloned().collect(),
                done: !s.searching || s.frozen,
                cached: false,
                engine: None,
            };
            remembered.lock().unwrap().offer(&s.key, &snap, kind);
            // The search ended or is frozen: keep the furthest result for the
            // position in the database, so it outlives a restart.
            if snap.done {
                if let (Some(store), Some(best)) = (store.get(), remembered.lock().unwrap().get(&s.key)) {
                    store.save(kind, &s.ident, &s.position, &best);
                }
            }
            snap
        };
        let _ = tx.send(snapshot);
    }
    // The engine is gone: end whatever was being watched.
    let snapshot = {
        let mut s = search.lock().unwrap();
        s.searching = false;
        Snapshot { gen: s.gen, depth: s.depth, nodes: s.nodes, nps: s.nps, lines: s.lines.values().cloned().collect(), done: true, cached: false, engine: None }
    };
    idle.notify_waiters();
    let _ = tx.send(snapshot);
}

struct Info {
    depth: Option<u32>,
    nodes: Option<u64>,
    nps: Option<u64>,
    /// A line, when the update carries a principal variation with an exact
    /// score (bound scores during aspiration windows are skipped). The score
    /// is still from the side to move.
    line: Option<Line>,
}

fn parse_info(t: &str) -> Option<Info> {
    let mut it = t.split_whitespace();
    if it.next()? != "info" { return None; }
    let toks: Vec<&str> = it.collect();
    let mut info = Info { depth: None, nodes: None, nps: None, line: None };
    let (mut multipv, mut cp, mut mate, mut bound, mut pv) = (1u32, None, None, false, Vec::new());
    let mut wdl: Option<[u32; 3]> = None;
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            "depth" => { info.depth = toks.get(i + 1).and_then(|v| v.parse().ok()); i += 2; }
            "nodes" => { info.nodes = toks.get(i + 1).and_then(|v| v.parse().ok()); i += 2; }
            "nps" => { info.nps = toks.get(i + 1).and_then(|v| v.parse().ok()); i += 2; }
            "multipv" => { multipv = toks.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(1); i += 2; }
            "wdl" => {
                let n = |k: usize| toks.get(i + k).and_then(|v| v.parse::<u32>().ok());
                if let (Some(w), Some(d), Some(l)) = (n(1), n(2), n(3)) { wdl = Some([w, d, l]); }
                i += 4;
            }
            "score" => {
                match toks.get(i + 1) {
                    Some(&"cp") => cp = toks.get(i + 2).and_then(|v| v.parse().ok()),
                    Some(&"mate") => mate = toks.get(i + 2).and_then(|v| v.parse().ok()),
                    _ => {}
                }
                i += 3;
                if matches!(toks.get(i), Some(&"lowerbound") | Some(&"upperbound")) { bound = true; i += 1; }
            }
            "pv" => { pv = toks[i + 1..].iter().map(|s| s.to_string()).collect(); break; }
            "string" => break, // free text to the end of the line
            _ => i += 1,
        }
    }
    if !pv.is_empty() && !bound && (cp.is_some() || mate.is_some()) {
        info.line = Some(Line { multipv, eval_cp: if mate.is_some() { None } else { cp }, mate, pv_uci: pv, wdl });
    }
    Some(info)
}

/// Physical processor cores. Linux counts distinct (package, core) pairs in
/// /proc/cpuinfo (every logical one where it lists no core ids), macOS asks
/// sysctl; elsewhere, or if that fails, two hardware threads per core are
/// assumed.
pub fn physical_cores() -> u32 {
    let logical = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
    let counted = (|| -> Option<u32> {
        if let Ok(text) = std::fs::read_to_string("/proc/cpuinfo") {
            let mut cores = std::collections::HashSet::new();
            let (mut pkg, mut core) = (None::<String>, None::<String>);
            for line in text.lines().chain(std::iter::once("")) {
                if line.trim().is_empty() {
                    if let (Some(p), Some(c)) = (pkg.take(), core.take()) { cores.insert((p, c)); }
                    continue;
                }
                let (k, v) = line.split_once(':')?;
                match k.trim() {
                    "physical id" => pkg = Some(v.trim().to_string()),
                    "core id" => core = Some(v.trim().to_string()),
                    _ => {}
                }
            }
            // No core ids (ARM, for one): such processors rarely run two
            // threads per core, so count every logical one.
            return Some(if cores.is_empty() { logical } else { cores.len() as u32 });
        }
        let out = std::process::Command::new("sysctl").args(["-n", "hw.physicalcpu"]).output().ok()?;
        String::from_utf8(out.stdout).ok()?.trim().parse().ok()
    })();
    counted.unwrap_or((logical / 2).max(1)).clamp(1, logical)
}

/// The settings of Replies & Strong a configure request may change.
#[derive(Default)]
pub struct ReplySettings {
    pub replies: Option<bool>,
    pub helper_threads: Option<u32>,
    pub helper_hash_mb: Option<u32>,
    pub helper_depth: Option<u32>,
    pub strong_cp: Option<u32>,
    pub helper_nodes: Option<u64>,
    pub strong_pct: Option<f32>,
    pub neutral_cp: Option<u32>,
    pub neutral_pct: Option<f32>,
}

/// One line of Lc0's VerboseMoveStats: `e7e5  (322 ) N:   19041 (+238)
/// (P: 58.57%) (WL: -0.02500) (D: 0.637) (M: 194.4) (Q: -0.02500) …` →
/// the move, its visits and its Q (-1..1, for the side to move). The root's
/// own line ("node") is left out.
fn parse_move_stats(rest: &str) -> Option<(String, u64, f64)> {
    let mv = rest.split_whitespace().next()?;
    if mv == "node" { return None; }
    let n: u64 = rest.split("N:").nth(1)?.split_whitespace().next()?.parse().ok()?;
    let q: f64 = rest.split("(Q:").nth(1)?.trim().split(')').next()?.trim().parse().ok()?;
    Some((mv.to_string(), n, q))
}

/// How many legal moves `fen` has (already validated by `clean_fen`).
fn legal_moves(fen: &str) -> u32 {
    use shakmaty::{fen::Fen, CastlingMode, Position};
    fen.parse::<Fen>()
        .ok()
        .and_then(|f| f.into_position::<shakmaty::Chess>(CastlingMode::Standard).ok())
        .map(|p| p.legal_moves().len() as u32)
        .unwrap_or(1)
}

/// The release number in a Stockfish name: "Stockfish 16" → "16",
/// "Stockfish 17.1" → "17.1". A development build ("Stockfish dev-2026…")
/// has none.
pub fn stockfish_version(name: &str) -> Option<String> {
    let rest = name.strip_prefix("Stockfish ")?;
    let v = rest.split_whitespace().next()?;
    v.chars().next()?.is_ascii_digit().then(|| v.to_string())
}

/// The release number in an Lc0 name: "Lc0 v0.32.1" → "0.32.1"; a
/// development or release-candidate build ("v0.33.0-rc0", "v0.33.0-dev")
/// has none, so it is never called out of date.
pub fn lc0_version(name: &str) -> Option<String> {
    let v = name.strip_prefix("Lc0 ")?.split_whitespace().next()?;
    let v = v.strip_prefix('v').unwrap_or(v);
    (v.chars().next()?.is_ascii_digit() && v.chars().all(|c| c.is_ascii_digit() || c == '.')).then(|| v.to_string())
}

/// Just the switch: whether the engine is on, without starting it.
impl Engine {
    pub async fn enabled(&self) -> bool {
        self.on().await
    }
}

/// `a` is an older release than `b` ("16" < "17.1" < "19").
pub fn older(a: &str, b: &str) -> bool {
    let parts = |v: &str| v.split('.').map(|p| p.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y { return x < y; }
    }
    false
}

/// Replay `sans` from `start` and return the start (rewritten) and the
/// moves as UCI — but only if they end on `fen`'s position. Anything that
/// does not add up is dropped, and the engine gets the bare position.
pub fn history_to_uci(start: &str, sans: &[String], fen: &str) -> Option<(String, Vec<String>)> {
    use shakmaty::{fen::Fen, san::San, uci::UciMove, Position, EnPassantMode, CastlingMode};
    if sans.is_empty() || sans.len() > 1000 { return None; }
    let start_fen: Fen = start.trim().parse().ok()?;
    let mut pos: shakmaty::Chess = start_fen.into_position(CastlingMode::Standard).ok()?;
    let start_clean = Fen::from_position(&pos, EnPassantMode::Legal).to_string();
    let mut uci = Vec::with_capacity(sans.len());
    for s in sans {
        let san: San = s.trim().trim_end_matches(['+', '#', '!', '?']).parse().ok()?;
        let m = san.to_move(&pos).ok()?;
        uci.push(UciMove::from_standard(m).to_string());
        pos.play_unchecked(m);
    }
    let reached = Fen::from_position(&pos, EnPassantMode::Legal).to_string();
    (position_key(&reached) == position_key(fen)).then_some((start_clean, uci))
}

/// A FEN the engine can be given: parsed and written back, so nothing but a
/// position reaches the engine's command line.
pub fn clean_fen(fen: &str) -> Option<String> {
    use shakmaty::fen::Fen;
    let parsed: Fen = fen.trim().parse().ok()?;
    let pos: shakmaty::Chess = parsed.into_position(shakmaty::CastlingMode::Standard).ok()?;
    Some(Fen::from_position(&pos, shakmaty::EnPassantMode::Legal).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The database keeps the furthest result per engine and position, and
    /// finds another version's for a position the engine in use lacks.
    #[tokio::test]
    async fn eval_store_keeps_the_furthest() {
        let conn = duckdb::Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let store = EvalStore::new(crate::jobs::ReadPool::new(vec![conn]));
        let line = |cp| Line { multipv: 1, eval_cp: Some(cp), mate: None, pv_uci: vec!["e2e4".into()], wdl: None };
        let snap = |depth, nodes, cp| Snapshot { gen: 1, depth, nodes, nps: 0, lines: vec![line(cp)], done: true, cached: false, engine: None };
        let pos = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
        store.save(Kind::Stockfish, "Stockfish 19", pos, &snap(30, 1_000, 20));
        store.save(Kind::Stockfish, "Stockfish 19", pos, &snap(25, 9_000, 50)); // shallower: kept out
        store.save(Kind::Stockfish, "Stockfish 19", pos, &snap(30, 2_000, 30)); // same depth, more nodes: kept
        let got = store.load("Stockfish 19", pos).await.unwrap();
        assert_eq!((got.depth, got.nodes, got.lines[0].eval_cp, got.cached), (30, 2_000, Some(30), true));
        assert!(store.load("Stockfish 20", pos).await.is_none());
        let older = store.load_older(Kind::Stockfish, "Stockfish 20", pos).await.unwrap();
        assert_eq!((older.engine.as_deref(), older.depth), (Some("Stockfish 19"), 30));
        assert!(store.load_older(Kind::Lc0, "Lc0 v0.32.1 · t1", pos).await.is_none());
        let listed = store.list().await.unwrap();
        assert_eq!((listed.len(), listed[0].positions), (1, 1));
        assert_eq!(store.delete("Stockfish 19").await.unwrap(), 1);
        assert!(store.load("Stockfish 19", pos).await.is_none());
    }

    #[test]
    fn info_lines_parse() {
        let i = parse_info("info depth 22 seldepth 31 multipv 2 score cp -35 nodes 123456 nps 987654 hashfull 12 tbhits 0 time 125 pv e7e5 g1f3 b8c6").unwrap();
        assert_eq!(i.depth, Some(22));
        assert_eq!(i.nodes, Some(123456));
        let l = i.line.unwrap();
        assert_eq!((l.multipv, l.eval_cp, l.mate), (2, Some(-35), None));
        assert_eq!(l.pv_uci, vec!["e7e5", "g1f3", "b8c6"]);

        let m = parse_info("info depth 30 multipv 1 score mate -3 nodes 1 pv h7h8 a1a8").unwrap().line.unwrap();
        assert_eq!((m.eval_cp, m.mate), (None, Some(-3)));

        // A bound score is an aspiration-window guess, not a result.
        assert!(parse_info("info depth 20 multipv 1 score cp 40 lowerbound nodes 5 pv e2e4").unwrap().line.is_none());
        assert!(parse_info("info depth 5 currmove e2e4 currmovenumber 1").unwrap().line.is_none());
        assert!(parse_info("info string NNUE evaluation using nn-xyz.nnue").unwrap().line.is_none());
        assert!(parse_info("bestmove e2e4").is_none());
    }

    #[test]
    fn only_a_position_reaches_the_engine() {
        assert_eq!(
            clean_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1").as_deref(),
            Some("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
        );
        assert!(clean_fen("8/8/8/8/8/8/8/8 w - - 0 1\ngo infinite").is_none());
        assert!(clean_fen("not a fen").is_none());
    }

    #[test]
    fn physical_cores_are_counted() {
        let logical = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
        let physical = physical_cores();
        println!("physical {physical} of {logical} logical");
        assert!(physical >= 1 && physical <= logical);
    }

    #[test]
    fn lc0_move_stats_parse() {
        let l = "e7e5  (322 ) N:   19041 (+238) (P: 58.57%) (WL: -0.02500) (D: 0.637) (M: 194.4) (Q: -0.02500) (U: 0.01468) (S: -0.01069) (V: -0.0087) ";
        assert_eq!(parse_move_stats(l), Some(("e7e5".to_string(), 19041, -0.025)));
        assert_eq!(parse_move_stats("node  (  20) N:   20295 (+256) (P: 100.0%) (Q: -0.03299)"), None);
    }

    #[test]
    fn stockfish_versions_compare() {
        assert_eq!(stockfish_version("Stockfish 16").as_deref(), Some("16"));
        assert_eq!(stockfish_version("Stockfish 17.1").as_deref(), Some("17.1"));
        assert_eq!(stockfish_version("Stockfish dev-20260922-0a215d6c"), None);
        assert_eq!(stockfish_version("Lc0 v0.31.2"), None);
        assert!(older("16", "19"));
        assert!(older("17", "17.1"));
        assert!(!older("19", "19"));
        assert!(!older("19.1", "19"));
        assert_eq!(lc0_version("Lc0 v0.32.1").as_deref(), Some("0.32.1"));
        assert_eq!(lc0_version("Lc0 v0.33.0-rc0"), None);
        assert!(older("0.32.1", "0.33.0"));
    }

    #[test]
    fn history_must_lead_to_the_position() {
        let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let sans: Vec<String> = ["e4", "e5", "Nf3", "Nc6+"].iter().map(|s| s.to_string()).collect();
        let fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
        let (s, uci) = history_to_uci(start, &sans, fen).unwrap();
        assert_eq!(s, start);
        assert_eq!(uci, vec!["e2e4", "e7e5", "g1f3", "b8c6"]);
        // Moves that end somewhere else are not used.
        assert!(history_to_uci(start, &sans[..3], fen).is_none());
        assert!(history_to_uci(start, &["e5".to_string()], fen).is_none());
    }

    /// The real thing, where it is installed: `cargo test -- --ignored real_stockfish`.
    #[tokio::test]
    #[ignore]
    async fn real_stockfish() {
        let dir = std::env::temp_dir().join(format!("lpdo-sf-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let engine = Engine::new(&dir);
        let status = engine.status().await;
        assert!(status.available, "{:?} — searched {:?}", status.error, status.searched);
        println!("engine: {:?} at {:?}", status.name, status.path);
        // After 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? White mates: Qxf7#.
        let fen = clean_fen("r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4").unwrap();
        let (gen, _, mut rx) = engine.analyse(&fen, None, 3, None, false).await.unwrap();
        let mut last = None;
        while let Ok(Ok(s)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            if s.gen != gen { continue; }
            let deep = s.depth >= 12 && s.lines.len() == 3;
            last = Some(s);
            if deep { break; }
        }
        let s = last.expect("snapshots");
        println!("depth {} nps {} lines {:?}", s.depth, s.nps, s.lines.iter().map(|l| (l.mate, l.eval_cp, l.pv_uci.first().cloned())).collect::<Vec<_>>());
        assert_eq!(s.lines[0].pv_uci[0], "h5f7");
        assert_eq!(s.lines[0].mate, Some(1));
        engine.stop(gen).await;
        let b = engine.bench(Some(1), Some(16), Some(8)).await.unwrap();
        println!("bench: {b:?}");
        assert!(b.nodes > 0 && b.nps > 0);
        engine.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Lc0 where it is built: `LC0=/path/to/lc0 LC0_NET=/path/to/net.pb.gz
    /// cargo test -- --ignored real_lc0`.
    #[tokio::test]
    #[ignore]
    async fn real_lc0() {
        let (Ok(bin), Ok(net)) = (std::env::var("LC0"), std::env::var("LC0_NET")) else {
            panic!("set LC0 and LC0_NET");
        };
        let dir = std::env::temp_dir().join(format!("lpdo-lc0-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("networks")).unwrap();
        let net_copy = dir.join("networks").join(Path::new(&net).file_name().unwrap());
        std::fs::copy(&net, &net_copy).unwrap();
        std::fs::write(dir.join("lc0.json"), serde_json::json!({ "path": bin }).to_string()).unwrap();

        let engine = Engine::new_kind(&dir, Kind::Lc0);
        let status = engine.status().await;
        assert!(status.available, "{:?}", status.error);
        assert_eq!(status.networks, vec![net_copy.to_string_lossy().to_string()]);
        println!("engine: {:?}, network {:?}", status.name, status.weights);

        // After 1.e4: Black to move, so the engine's view is flipped to White's.
        let fen = clean_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1").unwrap();
        let (gen, _, mut rx) = engine.analyse(&fen, None, 3, None, false).await.unwrap();
        let mut last = None;
        let until = std::time::Instant::now() + Duration::from_secs(20);
        while std::time::Instant::now() < until {
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Ok(s)) if s.gen == gen => { let enough = s.nodes > 100_000 && s.lines.len() == 3; last = Some(s); if enough { break; } }
                Ok(Ok(_)) => {}
                _ => break,
            }
        }
        let s = last.expect("snapshots");
        for l in &s.lines {
            println!("  {:?} wdl(W,D,B) {:?} cp {:?}", l.pv_uci.first(), l.wdl, l.eval_cp);
        }
        println!("depth {} nodes {} nps {}", s.depth, s.nodes, s.nps);
        let wdl = s.lines[0].wdl.expect("wdl");
        assert_eq!(wdl.iter().sum::<u32>(), 1000);
        engine.stop(gen).await;
        engine.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A stand-in engine: a shell script that speaks just enough UCI.
    #[cfg(unix)]
    #[tokio::test]
    async fn analyses_through_a_uci_engine() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("lpdo-engine-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-engine");
        std::fs::write(&script, r#"#!/bin/sh
while read cmd rest; do
  case "$cmd" in
    uci) echo "id name FakeFish 1"; echo "uciok";;
    isready) echo "readyok";;
    go) echo "info depth 1 multipv 1 score cp 30 nodes 10 nps 100 pv e7e5 g1f3";
        echo "info depth 2 multipv 1 score cp 25 nodes 20 nps 100 pv e7e5 g1f3 b8c6";;
    stop) echo "bestmove e7e5";;
    quit) exit 0;;
  esac
done
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("engine.json"), serde_json::json!({ "path": script }).to_string()).unwrap();

        let engine = Engine::new(&dir);
        let status = engine.status().await;
        assert!(status.available, "{:?}", status.error);
        assert_eq!(status.name.as_deref(), Some("FakeFish 1"));

        // Black to move: the engine's +25 for Black is -25 for White.
        let fen = clean_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1").unwrap();
        let (gen, remembered, mut rx) = engine.analyse(&fen, None, 1, None, false).await.unwrap();
        assert!(remembered.is_none());
        let mut last = None;
        while let Ok(Ok(s)) = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            if s.gen == gen { let d = s.depth; last = Some(s); if d == 2 { break; } }
        }
        let s = last.expect("a snapshot");
        assert_eq!(s.depth, 2);
        assert_eq!(s.lines[0].eval_cp, Some(-25));
        assert_eq!(s.lines[0].pv_uci, vec!["e7e5", "g1f3", "b8c6"]);

        engine.stop(gen).await;
        let done = loop {
            match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
                Ok(Ok(s)) if s.done => break true,
                Ok(Ok(_)) => continue,
                _ => break false,
            }
        };
        assert!(done, "stopping ends the search");

        // The same position again: the deepest result comes back at once.
        let (_, remembered, _rx) = engine.analyse(&fen, None, 1, None, false).await.unwrap();
        let r = remembered.expect("remembered");
        assert!(r.cached && r.depth == 2, "{r:?}");

        // Choosing an engine outside the standard locations is refused.
        assert!(engine.configure(Some("/bin/sh".into()), None, None).await.is_err());
        engine.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
