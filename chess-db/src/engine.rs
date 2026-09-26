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

/// No search runs longer than this unless the client asks again.
const MAX_SEARCH: Duration = Duration::from_secs(300);

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
    /// Stop a search here, 0 for no limit: a depth for Stockfish (its depth
    /// is how far it has searched), a node count for Lc0 (whose "depth" is
    /// only the average length of its playouts, so nodes are the measure).
    pub max_depth: u32,
    pub max_nodes: u64,
    /// Lc0's smart pruning: end a search once the best move cannot be
    /// overtaken. Off by default — the other lines stop improving too.
    pub smart_pruning: bool,
    /// Switched off, the engine is not started (Lc0 then holds no GPU
    /// memory), its tab leaves the Engine panel and analysis is refused.
    pub enabled: bool,
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
            Kind::Stockfish => Self {
                path: None, threads: physical_cores().clamp(1, 64),
                hash_mb: crate::db::default_engine_hash_mb(), weights: None, backend: None,
                max_depth: 40, max_nodes: 0, smart_pruning: false, enabled: true,
            },
            Kind::Lc0 => Self {
                path: None, threads: 0, hash_mb: 0, weights: None, backend: None,
                max_depth: 0, max_nodes: 10_000_000, smart_pruning: false, enabled: true,
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
    /// Switched on in the settings (see EngineSettings::enabled).
    pub enabled: bool,
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
#[derive(Clone, Debug, Serialize, PartialEq)]
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
}

/// What the stdout reader shares with the controller.
struct Search {
    gen: u64,
    /// The position's key in the remembered results, with the engine's name.
    key: String,
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
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    path: String,
    name: String,
}

pub struct Engine {
    kind: Kind,
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
    /// Keep `s` if it is deeper than what is remembered for `key`.
    fn offer(&mut self, key: &str, s: &Snapshot) {
        if s.lines.is_empty() { return; }
        match self.by_key.get(key) {
            Some(old) if old.depth > s.depth || (old.depth == s.depth && old.lines.len() >= s.lines.len()) => return,
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
        let (tx, _) = broadcast::channel(64);
        Arc::new(Self {
            kind,
            data_dir: data_dir.to_path_buf(),
            settings_file,
            settings: Mutex::new(settings),
            running: Mutex::new(None),
            last_error: Mutex::new(None),
            search: Arc::new(std::sync::Mutex::new(Search {
                gen: 0, key: String::new(), white_to_move: true, searching: false, want: 1, depth: 0, nodes: 0, nps: 0,
                lines: BTreeMap::new(),
            })),
            idle: Arc::new(Notify::new()),
            tx,
            gen: AtomicU64::new(0),
            remembered: Arc::new(std::sync::Mutex::new(Remembered::default())),
            latest: Mutex::new(None),
            benching: Mutex::new(()),
        })
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
        let enabled = self.settings.lock().await.enabled;
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
        self.configure_all(path, threads, hash_mb, None, None, None, None, None, None).await
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
    ) -> Result<EngineStatus, String> {
        {
            let mut s = self.settings.lock().await;
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
            if let Some(d) = max_depth { s.max_depth = d.min(245); }
            if let Some(n) = max_nodes { s.max_nodes = n.min(1_000_000_000_000); }
            if let Some(p) = smart_pruning { s.smart_pruning = p; }
            if let Some(e) = enabled { s.enabled = e; }
            if let Some(b) = backend {
                if b.is_empty() { s.backend = None; }
                else if valid_backend(&b) { s.backend = Some(b); }
                else { return Err(format!("{b:?} is not a backend name")); }
            }
            let json = serde_json::to_string_pretty(&*s).map_err(|e| e.to_string())?;
            std::fs::write(&self.settings_file, json)
                .map_err(|e| format!("{}: {e}", self.settings_file.display()))?;
        }
        self.shutdown().await;
        Ok(self.status().await)
    }

    async fn shutdown(&self) {
        if let Some(mut r) = self.running.lock().await.take() {
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
                tokio::spawn(read_engine(stdout, search, idle, tx, remembered));
                *running = Some(Running { child, stdin, path, name });
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
        let gen = self.gen.fetch_add(1, Ordering::SeqCst) + 1;

        let mut running = self.running.lock().await;
        let r = running.as_mut().ok_or("the engine stopped")?;
        // Remembered per engine: Stockfish 16 and 19 disagree.
        let key = format!("{}|{}", r.name, position_key(fen));
        let remembered = self.remembered.lock().unwrap().get(&key).map(|mut s| { s.gen = gen; s });

        // Finish the previous search first, so its closing `bestmove` is not
        // taken for the end of this one.
        let was_searching = self.search.lock().unwrap().searching;
        if was_searching {
            let waiting = self.idle.notified();
            send(&mut r.stdin, "stop").await?;
            let _ = tokio::time::timeout(Duration::from_secs(3), waiting).await;
        }
        {
            let mut s = self.search.lock().unwrap();
            *s = Search {
                gen,
                key,
                white_to_move: fen.split_whitespace().nth(1) != Some("b"),
                searching: true,
                want: lines.clamp(1, 10).min(legal_moves(fen).max(1)),
                depth: 0, nodes: 0, nps: 0,
                lines: BTreeMap::new(),
            };
        }
        send(&mut r.stdin, &format!("setoption name MultiPV value {}", lines.clamp(1, 10))).await?;
        let position = match &history {
            Some((start, moves)) if !moves.is_empty() => format!("position fen {start} moves {}", moves.join(" ")),
            _ => format!("position fen {fen}"),
        };
        send(&mut r.stdin, &position).await?;
        // Stop at the configured threshold; the time cap below is the net
        // under it (and under "no limit").
        let limits = { let s = self.settings.lock().await; (s.max_depth, s.max_nodes) };
        let go = match (self.kind, limits) {
            (Kind::Stockfish, (d, _)) if d > 0 => format!("go depth {d}"),
            (Kind::Lc0, (_, n)) if n > 0 => format!("go nodes {n}"),
            _ => "go infinite".to_string(),
        };
        send(&mut r.stdin, &go).await?;
        drop(running);

        // The cap: an analysis nobody asked about again ends by itself.
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(MAX_SEARCH).await;
            me.stop(gen).await;
        });
        Ok((gen, remembered, rx))
    }

    /// Stop search `gen` if it is still the current one.
    pub async fn stop(&self, gen: u64) {
        let current = {
            let s = self.search.lock().unwrap();
            s.gen == gen && s.searching
        };
        if current {
            if let Some(r) = self.running.lock().await.as_mut() {
                let _ = send(&mut r.stdin, "stop").await;
            }
        }
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
                idle.notify_waiters();
            } else if let Some(info) = parse_info(t) {
                if !s.searching { continue; }
                if let Some(d) = info.depth { s.depth = s.depth.max(d); }
                if let Some(n) = info.nodes { s.nodes = n; }
                if let Some(n) = info.nps { s.nps = n; }
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
            let snap = Snapshot {
                gen: s.gen, depth: s.depth, nodes: s.nodes, nps: s.nps,
                lines: s.lines.values().cloned().collect(),
                done: !s.searching,
                cached: false,
            };
            remembered.lock().unwrap().offer(&s.key, &snap);
            snap
        };
        let _ = tx.send(snapshot);
    }
    // The engine is gone: end whatever was being watched.
    let snapshot = {
        let mut s = search.lock().unwrap();
        s.searching = false;
        Snapshot { gen: s.gen, depth: s.depth, nodes: s.nodes, nps: s.nps, lines: s.lines.values().cloned().collect(), done: true, cached: false }
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
        self.settings.lock().await.enabled
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
        let (gen, _, mut rx) = engine.analyse(&fen, None, 3).await.unwrap();
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
        let (gen, _, mut rx) = engine.analyse(&fen, None, 3).await.unwrap();
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
        let (gen, remembered, mut rx) = engine.analyse(&fen, None, 1).await.unwrap();
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
        let (_, remembered, _rx) = engine.analyse(&fen, None, 1).await.unwrap();
        let r = remembered.expect("remembered");
        assert!(r.cached && r.depth == 2, "{r:?}");

        // Choosing an engine outside the standard locations is refused.
        assert!(engine.configure(Some("/bin/sh".into()), None, None).await.is_err());
        engine.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
