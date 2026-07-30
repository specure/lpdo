//! chessdb.cn cloud-evaluation proxy (#221).
//!
//! Fetches crowd-sourced engine evaluations for a position and caches them by
//! Zobrist hash, so the GUI's engine panel can show a multi-move table without
//! hammering the free community service. No auth. We stay polite: cache
//! aggressively (evals are stable database values), identify with a User-Agent,
//! and rely on the client to debounce position changes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

const BASE: &str = "https://www.chessdb.cn/cdb.php";
const CACHE_TTL: Duration = Duration::from_secs(6 * 3600);
/// chessdb keeps *deepening* positions in the background, so a freshly-seen
/// position can return a shallow, partial move list that grows minutes later.
/// Cache those only briefly so the panel picks up the fuller answer on revisit,
/// rather than pinning the first (possibly 1-move) response for hours.
const CHESSDB_TTL: Duration = Duration::from_secs(15 * 60);
const CACHE_CAP: usize = 8192;

#[derive(Clone, Serialize)]
pub struct CloudMove {
    pub san: String,
    pub uci: String,
    /// Centipawns from the side to move (higher = better for the mover).
    #[serde(rename = "scoreCp")]
    pub score_cp: i32,
    /// Signed mate distance when the position is decided: `+N` = the side to move
    /// mates in N, `-N` = gets mated in N. `None` for a normal score.
    pub mate: Option<i32>,
    /// Practical win% (0–100), if chessdb reports it.
    pub winrate: Option<f64>,
    pub rank: i32,
    /// chessdb's raw note, e.g. `"! (20-04)"` — a quality mark (`!` = a strong /
    /// "power" move) plus, for a normal position, `(opponent's legal moves -
    /// opponent's strong moves)` after this move. Low second number ⇒ forcing.
    pub note: String,
}

#[derive(Clone, Serialize)]
pub struct CloudEval {
    /// `"ok"` (moves present), `"unknown"` (not in the cloud DB yet), or
    /// `"offline"` (couldn't reach chessdb.cn).
    pub status: String,
    pub moves: Vec<CloudMove>,
}

/// An order-independent hash of the position's move evaluations: sorted
/// `(uci, score, mate)`. chessdb's per-move scores are stable across queries (only
/// the returned move *order* and the PV-length "depth" are noisy), so this changes
/// only when chessdb genuinely revises the position — the watch's trigger.
fn eval_signature(eval: &CloudEval) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut items: Vec<(&str, i32, Option<i32>)> =
        eval.moves.iter().map(|m| (m.uci.as_str(), m.score_cp, m.mate)).collect();
    items.sort();
    let mut h = DefaultHasher::new();
    items.hash(&mut h);
    h.finish()
}

struct Shared {
    client: reqwest::Client,
    cache: Mutex<HashMap<i64, (Instant, CloudEval)>>,
    lichess_cache: Mutex<HashMap<i64, (Instant, LichessEval)>>,
    /// Active "deepen watches" keyed by Zobrist — background pollers that notify
    /// (via the activity panel) when chessdb's depth for a position grows.
    watches: Mutex<HashMap<i64, Watch>>,
    /// Whether the single background poll loop has been spawned yet.
    poller_started: AtomicBool,
}

fn shared() -> &'static Shared {
    static S: OnceLock<Shared> = OnceLock::new();
    S.get_or_init(|| Shared {
        client: reqwest::Client::builder()
            .user_agent(concat!("LPDO/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(15))
            .build()
            .expect("build reqwest client"),
        cache: Mutex::new(HashMap::new()),
        lichess_cache: Mutex::new(HashMap::new()),
        watches: Mutex::new(HashMap::new()),
        poller_started: AtomicBool::new(false),
    })
}

/// Parse chessdb's `note` (e.g. `"! (W-0003)"` / `"* (20-04)"`) for a mate
/// distance. `W-N` = win (mate for the side to move) in N; `L-N` = mated in N.
fn parse_mate(note: &str) -> Option<i32> {
    let inner = note.split('(').nth(1)?.trim_end_matches(')');
    let (kind, num) = inner.split_once('-')?;
    let n: i32 = num.trim().parse().ok()?;
    match kind.trim() {
        "W" => Some(n.max(1)),      // 0 → mate is immediate; show at least 1
        "L" => Some(-(n.max(1))),
        _ => None,
    }
}

/// Query chessdb.cn's `queryall` for a position (cached by Zobrist hash).
pub async fn query(fen: &str, zobrist: i64) -> CloudEval {
    let s = shared();
    if let Some((t, eval)) = s.cache.lock().unwrap().get(&zobrist) {
        if t.elapsed() < CHESSDB_TTL {
            return eval.clone();
        }
    }

    let eval = match s
        .client
        .get(BASE)
        .query(&[("action", "queryall"), ("board", fen), ("json", "1")])
        .send()
        .await
    {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(v) => parse_queryall(&v),
            Err(_) => CloudEval { status: "unknown".into(), moves: vec![] },
        },
        // Network failure — don't cache; the panel shows "offline".
        Err(_) => return CloudEval { status: "offline".into(), moves: vec![] },
    };

    let mut cache = s.cache.lock().unwrap();
    if cache.len() >= CACHE_CAP {
        cache.clear(); // crude cap — evals are cheap to refetch
    }
    cache.insert(zobrist, (Instant::now(), eval.clone()));
    eval
}

fn parse_queryall(v: &serde_json::Value) -> CloudEval {
    if v.get("status").and_then(|s| s.as_str()) != Some("ok") {
        return CloudEval { status: "unknown".into(), moves: vec![] };
    }
    let moves = v
        .get("moves")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let note = m.get("note").and_then(|n| n.as_str()).unwrap_or("");
                    Some(CloudMove {
                        san: m.get("san")?.as_str()?.to_string(),
                        uci: m.get("uci").and_then(|u| u.as_str()).unwrap_or("").to_string(),
                        score_cp: m.get("score")?.as_i64()? as i32,
                        mate: parse_mate(note),
                        winrate: m.get("winrate").and_then(|w| w.as_str()).and_then(|w| w.parse().ok()),
                        rank: m.get("rank").and_then(|r| r.as_i64()).unwrap_or(0) as i32,
                        note: note.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    CloudEval { status: "ok".into(), moves }
}

/// Ask chessdb.cn to analyse an as-yet-unknown position (best-effort).
pub async fn queue(fen: &str) {
    let s = shared();
    let _ = s
        .client
        .get(BASE)
        .query(&[("action", "queue"), ("board", fen), ("json", "1")])
        .send()
        .await;
}

// ── Deepen watches (#221) ───────────────────────────────────────────────────
// After you queue a position for deeper crowd analysis, a watch polls chessdb in
// the background and flips to "updated" the moment its move *evaluations* change
// (the real, measurable effect of the crowd's work — see eval_signature). Watches
// live in memory (they keep running with the GUI closed, as long as the daemon is
// up) and surface in the activity panel. No DB involvement — pure API poller.

const WATCH_POLL: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize)]
pub struct Watch {
    /// Zobrist key — also lets the client match a watch to the board on screen.
    pub zobrist: i64,
    pub fen: String,
    /// Short human label supplied by the client (e.g. the move list).
    pub label: String,
    /// `"watching"` (still polling) or `"updated"` (chessdb revised the evals).
    pub status: String,
    /// Wall-clock seconds from starting the watch to the evaluation changing.
    pub elapsed_secs: Option<u64>,
    /// When the watch started — for computing `elapsed_secs`. Not serialized.
    #[serde(skip)]
    started: Instant,
    /// Eval signature at start; the watch fires when this changes. Not serialized.
    #[serde(skip)]
    baseline_sig: u64,
}

/// Start (or refresh) a watch for a position. Queues the position for deeper
/// analysis and captures the current evaluation signature as the baseline.
pub async fn add_watch(fen: &str, zobrist: i64, label: &str) -> Watch {
    queue(fen).await; // nudge chessdb to work on it
    // Fresh baseline (also (re)populates the shared cache so the panel matches).
    shared().cache.lock().unwrap().remove(&zobrist);
    let baseline_sig = eval_signature(&query(fen, zobrist).await);
    let watch = Watch {
        zobrist,
        fen: fen.to_string(),
        label: label.to_string(),
        status: "watching".into(),
        elapsed_secs: None,
        started: Instant::now(),
        baseline_sig,
    };
    let s = shared();
    s.watches.lock().unwrap().insert(zobrist, watch.clone());
    ensure_poller();
    watch
}

pub fn list_watches() -> Vec<Watch> {
    let mut v: Vec<Watch> = shared().watches.lock().unwrap().values().cloned().collect();
    v.sort_by(|a, b| a.zobrist.cmp(&b.zobrist));
    v
}

/// Remove a watch (dismiss). No-op if it doesn't exist.
pub fn remove_watch(zobrist: i64) {
    shared().watches.lock().unwrap().remove(&zobrist);
}

/// Spawn the single background poll loop the first time a watch is created.
fn ensure_poller() {
    let s = shared();
    if s.poller_started.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(WATCH_POLL).await;
            // Snapshot the positions still being watched, then poll them without
            // holding the lock across awaits.
            let pending: Vec<(i64, String)> = shared()
                .watches
                .lock()
                .unwrap()
                .values()
                .filter(|w| w.status == "watching")
                .map(|w| (w.zobrist, w.fen.clone()))
                .collect();
            for (zobrist, fen) in pending {
                // Refresh with a full query() (cache-busted) so the panel's move
                // table reflects any change, then compare the eval signature.
                shared().cache.lock().unwrap().remove(&zobrist);
                let fresh = query(&fen, zobrist).await;
                // Only a real, non-empty result can signal a change — a transient
                // failure (offline / unknown) must not fire a spurious update.
                if fresh.status != "ok" || fresh.moves.is_empty() {
                    continue;
                }
                let sig = eval_signature(&fresh);
                let mut watches = shared().watches.lock().unwrap();
                if let Some(w) = watches.get_mut(&zobrist) {
                    if sig != w.baseline_sig && w.status != "updated" {
                        w.status = "updated".into();
                        w.elapsed_secs = Some(w.started.elapsed().as_secs());
                    }
                }
            }
        }
    });
}

// ── Lichess cloud evaluation (Stockfish) ───────────────────────────────────
// Different strength/shape from chessdb: a few deep PV lines with a White-relative
// eval + engine depth. Only cached (popular) positions exist — no "queue". Moves
// stay UCI here; the client renders them as SAN (it has the position).

const LICHESS_URL: &str = "https://lichess.org/api/cloud-eval";

#[derive(Clone, Serialize)]
pub struct LichessLine {
    /// Centipawns from White's perspective (Lichess convention).
    #[serde(rename = "evalCp")]
    pub eval_cp: Option<i32>,
    /// Mate distance from White's perspective (`-1` = Black mates in 1).
    pub mate: Option<i32>,
    #[serde(rename = "pvUci")]
    pub pv_uci: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct LichessEval {
    /// `"ok"`, `"unknown"` (not in Lichess's cloud cache), or `"offline"`.
    pub status: String,
    pub depth: i32,
    pub knodes: i64,
    pub lines: Vec<LichessLine>,
}

pub async fn query_lichess(fen: &str, zobrist: i64) -> LichessEval {
    let s = shared();
    if let Some((t, eval)) = s.lichess_cache.lock().unwrap().get(&zobrist) {
        if t.elapsed() < CACHE_TTL {
            return eval.clone();
        }
    }

    let eval = match s
        .client
        .get(LICHESS_URL)
        // Ask for everything: Lichess caches roughly one PV line per analysed
        // reply — up to the number of legal moves on heavily-worked positions
        // (e.g. ~30 in a Ruy Lopez), fewer otherwise — and ignores oversized
        // requests, so a big number returns "all cached".
        .query(&[("fen", fen), ("multiPv", "100")])
        .send()
        .await
    {
        Ok(resp) if resp.status() == reqwest::StatusCode::NOT_FOUND => {
            LichessEval { status: "unknown".into(), depth: 0, knodes: 0, lines: vec![] }
        }
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(v) => parse_lichess(&v),
            Err(_) => LichessEval { status: "unknown".into(), depth: 0, knodes: 0, lines: vec![] },
        },
        Err(_) => return LichessEval { status: "offline".into(), depth: 0, knodes: 0, lines: vec![] },
    };

    let mut cache = s.lichess_cache.lock().unwrap();
    if cache.len() >= CACHE_CAP {
        cache.clear();
    }
    cache.insert(zobrist, (Instant::now(), eval.clone()));
    eval
}

fn parse_lichess(v: &serde_json::Value) -> LichessEval {
    let mut lines: Vec<LichessLine> = v
        .get("pvs")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .map(|pv| LichessLine {
                    eval_cp: pv.get("cp").and_then(|c| c.as_i64()).map(|c| c as i32),
                    mate: pv.get("mate").and_then(|m| m.as_i64()).map(|m| m as i32),
                    pv_uci: pv
                        .get("moves")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .split_whitespace()
                        .map(String::from)
                        .collect(),
                })
                .collect()
        })
        .unwrap_or_default();
    // Lichess can return duplicate PV lines (the same root move repeated) when
    // multiPv exceeds what's meaningfully cached. Keep one line per distinct first
    // move; the response is sorted best-first, so this keeps the best of each.
    let mut seen = std::collections::HashSet::new();
    lines.retain(|l| l.pv_uci.first().map(|m| seen.insert(m.clone())).unwrap_or(false));
    LichessEval {
        status: "ok".into(),
        depth: v.get("depth").and_then(|d| d.as_i64()).unwrap_or(0) as i32,
        knodes: v.get("knodes").and_then(|k| k.as_i64()).unwrap_or(0),
        lines,
    }
}
