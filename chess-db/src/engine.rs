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

/// Where package managers put Stockfish, besides `$PATH` (a service's PATH is
/// short: Debian installs to /usr/games, which systemd units rarely include).
const KNOWN_LOCATIONS: &[&str] = &[
    "/usr/games/stockfish",
    "/usr/bin/stockfish",
    "/usr/local/bin/stockfish",
    "/opt/homebrew/bin/stockfish",
    "/snap/bin/stockfish",
    "/usr/bin/lc0",
    "/usr/local/bin/lc0",
    "/opt/homebrew/bin/lc0",
];
const PATH_NAMES: &[&str] = &["stockfish", "lc0"];

/// No search runs longer than this unless the client asks again.
const MAX_SEARCH: Duration = Duration::from_secs(300);
const HANDSHAKE: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EngineSettings {
    /// The engine to run. None: the first one found.
    pub path: Option<String>,
    pub threads: u32,
    pub hash_mb: u32,
}

impl Default for EngineSettings {
    fn default() -> Self {
        // Half the cores: the server also answers queries while it analyses.
        let cores = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(2);
        Self { path: None, threads: (cores / 2).clamp(1, 16), hash_mb: 256 }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct EngineStatus {
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
}

/// One line of analysis. Scores are from White's point of view.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Line {
    pub multipv: u32,
    pub eval_cp: Option<i32>,
    pub mate: Option<i32>,
    pub pv_uci: Vec<String>,
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
}

/// What the stdout reader shares with the controller.
struct Search {
    gen: u64,
    white_to_move: bool,
    searching: bool,
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
    settings_file: PathBuf,
    settings: Mutex<EngineSettings>,
    running: Mutex<Option<Running>>,
    last_error: Mutex<Option<String>>,
    search: Arc<std::sync::Mutex<Search>>,
    idle: Arc<Notify>,
    tx: broadcast::Sender<Snapshot>,
    gen: AtomicU64,
}

impl Engine {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        let settings_file = data_dir.join("engine.json");
        let settings = std::fs::read_to_string(&settings_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let (tx, _) = broadcast::channel(64);
        Arc::new(Self {
            settings_file,
            settings: Mutex::new(settings),
            running: Mutex::new(None),
            last_error: Mutex::new(None),
            search: Arc::new(std::sync::Mutex::new(Search {
                gen: 0, white_to_move: true, searching: false, depth: 0, nodes: 0, nps: 0,
                lines: BTreeMap::new(),
            })),
            idle: Arc::new(Notify::new()),
            tx,
            gen: AtomicU64::new(0),
        })
    }

    /// Engines found in the standard locations, in order of preference.
    pub fn found() -> (Vec<String>, Vec<String>) {
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
                for name in PATH_NAMES {
                    consider(dir.join(name));
                    #[cfg(windows)]
                    consider(dir.join(format!("{name}.exe")));
                }
            }
        }
        for loc in KNOWN_LOCATIONS {
            consider(PathBuf::from(loc));
        }
        (found, searched)
    }

    pub async fn status(&self) -> EngineStatus {
        let _ = self.ensure_started().await;
        let settings = self.settings.lock().await.clone();
        let (found, searched) = Self::found();
        let running = self.running.lock().await;
        let error = self.last_error.lock().await.clone();
        EngineStatus {
            available: running.is_some(),
            path: running.as_ref().map(|r| r.path.clone()).or_else(|| settings.path.clone()).or_else(|| found.first().cloned()),
            name: running.as_ref().map(|r| r.name.clone()),
            error: if running.is_some() { None } else { error },
            settings,
            found,
            searched,
            settings_file: self.settings_file.to_string_lossy().to_string(),
            os: std::env::consts::OS.to_string(),
        }
    }

    /// Change the engine or its options. `path` must be one of the engines
    /// found in the standard locations (see the module note); `None` keeps
    /// the current choice.
    pub async fn configure(&self, path: Option<String>, threads: Option<u32>, hash_mb: Option<u32>) -> Result<EngineStatus, String> {
        {
            let mut s = self.settings.lock().await;
            if let Some(p) = path {
                let (found, _) = Self::found();
                if !found.contains(&p) {
                    return Err(format!(
                        "{p} is not one of the engines found in the standard locations. \
                         To use another engine, name it in {} on the server.",
                        self.settings_file.display()
                    ));
                }
                s.path = Some(p);
            }
            if let Some(t) = threads { s.threads = t.clamp(1, 256); }
            if let Some(h) = hash_mb { s.hash_mb = h.clamp(16, 65536); }
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
        let path = match settings.path.clone().or_else(|| Self::found().0.into_iter().next()) {
            Some(p) => p,
            None => {
                let msg = "No chess engine found on the server.".to_string();
                *self.last_error.lock().await = Some(msg.clone());
                return Err(msg);
            }
        };
        match start(&path, &settings).await {
            Ok((child, stdin, stdout, name)) => {
                let search = self.search.clone();
                let idle = self.idle.clone();
                let tx = self.tx.clone();
                tokio::spawn(read_engine(stdout, search, idle, tx));
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

    /// Start analysing `fen` (already validated) with `lines` lines. Returns
    /// the search's number and a receiver of its snapshots.
    pub async fn analyse(self: &Arc<Self>, fen: &str, lines: u32) -> Result<(u64, broadcast::Receiver<Snapshot>), String> {
        self.ensure_started().await?;
        let rx = self.tx.subscribe();
        let gen = self.gen.fetch_add(1, Ordering::SeqCst) + 1;

        let mut running = self.running.lock().await;
        let r = running.as_mut().ok_or("the engine stopped")?;

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
                white_to_move: fen.split_whitespace().nth(1) != Some("b"),
                searching: true,
                depth: 0, nodes: 0, nps: 0,
                lines: BTreeMap::new(),
            };
        }
        send(&mut r.stdin, &format!("setoption name MultiPV value {}", lines.clamp(1, 10))).await?;
        send(&mut r.stdin, &format!("position fen {fen}")).await?;
        send(&mut r.stdin, "go infinite").await?;
        drop(running);

        // The cap: an analysis nobody asked about again ends by itself.
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(MAX_SEARCH).await;
            me.stop(gen).await;
        });
        Ok((gen, rx))
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
async fn start(path: &str, settings: &EngineSettings) -> Result<(Child, ChildStdin, BufReader<ChildStdout>, String), String> {
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
        send(&mut stdin, &format!("setoption name Threads value {}", settings.threads)).await?;
        send(&mut stdin, &format!("setoption name Hash value {}", settings.hash_mb)).await?;
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
    let name = tokio::time::timeout(HANDSHAKE, handshake)
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
                        if !s.white_to_move {
                            l.eval_cp = l.eval_cp.map(|c| -c);
                            l.mate = l.mate.map(|m| -m);
                        }
                        s.lines.insert(l.multipv, l);
                    }
                    None => continue, // speed-only updates are not worth a snapshot
                }
            } else {
                continue;
            }
            Snapshot {
                gen: s.gen, depth: s.depth, nodes: s.nodes, nps: s.nps,
                lines: s.lines.values().cloned().collect(),
                done: !s.searching,
            }
        };
        let _ = tx.send(snapshot);
    }
    // The engine is gone: end whatever was being watched.
    let snapshot = {
        let mut s = search.lock().unwrap();
        s.searching = false;
        Snapshot { gen: s.gen, depth: s.depth, nodes: s.nodes, nps: s.nps, lines: s.lines.values().cloned().collect(), done: true }
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
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            "depth" => { info.depth = toks.get(i + 1).and_then(|v| v.parse().ok()); i += 2; }
            "nodes" => { info.nodes = toks.get(i + 1).and_then(|v| v.parse().ok()); i += 2; }
            "nps" => { info.nps = toks.get(i + 1).and_then(|v| v.parse().ok()); i += 2; }
            "multipv" => { multipv = toks.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(1); i += 2; }
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
        info.line = Some(Line { multipv, eval_cp: if mate.is_some() { None } else { cp }, mate, pv_uci: pv });
    }
    Some(info)
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
        let (gen, mut rx) = engine.analyse(&fen, 3).await.unwrap();
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
        let (gen, mut rx) = engine.analyse(&fen, 1).await.unwrap();
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

        // Choosing an engine outside the standard locations is refused.
        assert!(engine.configure(Some("/bin/sh".into()), None, None).await.is_err());
        engine.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
