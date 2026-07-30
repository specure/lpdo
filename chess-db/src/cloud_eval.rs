//! chessdb.cn cloud-evaluation proxy (#221).
//!
//! Fetches crowd-sourced engine evaluations for a position and caches them by
//! Zobrist hash, so the GUI's engine panel can show a multi-move table without
//! hammering the free community service. No auth. We stay polite: cache
//! aggressively (evals are stable database values), identify with a User-Agent,
//! and rely on the client to debounce position changes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

const BASE: &str = "https://www.chessdb.cn/cdb.php";
const CACHE_TTL: Duration = Duration::from_secs(6 * 3600);
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
}

#[derive(Clone, Serialize)]
pub struct CloudEval {
    /// `"ok"` (moves present), `"unknown"` (not in the cloud DB yet), or
    /// `"offline"` (couldn't reach chessdb.cn).
    pub status: String,
    pub moves: Vec<CloudMove>,
}

struct Shared {
    client: reqwest::Client,
    cache: Mutex<HashMap<i64, (Instant, CloudEval)>>,
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
        if t.elapsed() < CACHE_TTL {
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
