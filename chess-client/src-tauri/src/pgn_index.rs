//! In-process PGN browsing for large local files (#104), with an LRU cache.
//!
//! Wraps the [`chess_pgn`] engine as Tauri commands. `pgn_open` returns
//! immediately and indexes the file on a background thread; `pgn_query` /
//! `pgn_game` serve whatever is indexed so far (the frontend polls the growing
//! index); `pgn_close` releases the view.
//!
//! Indexes are **cached by path** so flipping back and forth between files
//! doesn't re-index (#104 slice 2.6): a closed file keeps its index (and keeps
//! finishing in the background), so reopening is instant. The cache is bounded by
//! an LRU over both a file count and a memory budget; a currently-open file is
//! never evicted, and a file changed on disk is rebuilt.
//!
//! Header-only browse by design — no position search / dedup / normalisation
//! (that stays in the database; import a file for the full engine).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use chess_pgn::{PgnIndex, Query, QueryResult, DEFAULT_BATCH};
use serde::Serialize;
use tauri::State;

/// Most files kept cached at once (LRU beyond this).
const MAX_FILES: usize = 5;
/// Preferred cache memory budget; the effective budget is
/// `min(this, available RAM − 20% of total RAM)` so a constrained machine scales
/// down (and drops to ~0 under real memory pressure).
const MEM_TARGET: u64 = 1024 * 1024 * 1024; // 1 GiB

/// Path-keyed LRU cache of open/recent indexes.
pub struct PgnCache {
    inner: Mutex<Inner>,
    mem_budget: u64,
}

struct Inner {
    /// Cached indexes (unordered; LRU is tracked by `last_used`).
    entries: Vec<Entry>,
    /// Active view sessions → the file they're looking at.
    sessions: HashMap<u64, PathBuf>,
    next_session: u64,
    /// Monotonic logical clock for LRU ordering.
    tick: u64,
}

struct Entry {
    path: PathBuf, // canonicalised
    index: Arc<PgnIndex>,
    mtime: Option<SystemTime>,
    size: u64,
    last_used: u64,
    /// Open views on this file — an entry with `active > 0` is never evicted.
    active: usize,
}

impl Default for PgnCache {
    fn default() -> Self {
        Self::new()
    }
}

impl PgnCache {
    pub fn new() -> Self {
        PgnCache {
            inner: Mutex::new(Inner {
                entries: Vec::new(),
                sessions: HashMap::new(),
                next_session: 0,
                tick: 0,
            }),
            mem_budget: mem_budget(),
        }
    }

    /// Resolve a session to its index (bumping LRU), without holding the cache
    /// lock during the query itself.
    fn index_for(&self, session: u64) -> Result<Arc<PgnIndex>, String> {
        let mut inner = self.inner.lock().unwrap();
        inner.tick += 1;
        let now = inner.tick;
        let path = inner.sessions.get(&session).cloned().ok_or("pgn session not found")?;
        let entry = inner.entries.iter_mut().find(|e| e.path == path).ok_or("pgn session not found")?;
        entry.last_used = now;
        Ok(entry.index.clone())
    }
}

#[derive(Serialize)]
pub struct PgnOpened {
    /// Session handle to pass to `pgn_query` / `pgn_game` / `pgn_close`.
    session: u64,
}

/// Open a PGN file (reusing a cached index if the file is unchanged), starting a
/// background index if it's new. Returns at once; the frontend polls `pgn_query`.
#[tauri::command]
pub fn pgn_open(state: State<'_, PgnCache>, path: String) -> Result<PgnOpened, String> {
    let canon = dunce::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    let meta = std::fs::metadata(&canon).map_err(|e| format!("{path}: {e}"))?;
    let size = meta.len();
    let mtime = meta.modified().ok();

    let mut inner = state.inner.lock().unwrap();
    inner.tick += 1;
    let now = inner.tick;

    // Reuse a cached index for this path when the file is unchanged — or when a
    // view is still open on it (don't yank an index out from under an open view
    // just because the file changed on disk mid-session).
    let mut reused = false;
    if let Some(pos) = inner.entries.iter().position(|e| e.path == canon) {
        let valid = inner.entries[pos].size == size && inner.entries[pos].mtime == mtime;
        if valid || inner.entries[pos].active > 0 {
            let e = &mut inner.entries[pos];
            e.last_used = now;
            e.active += 1;
            reused = true;
        } else {
            // Changed on disk and nobody's viewing it — drop the stale index.
            inner.entries[pos].index.cancel();
            inner.entries.remove(pos);
        }
    }

    if !reused {
        let index = PgnIndex::open(&canon).map_err(|e| format!("{}: {e}", canon.display()))?;
        let bg = index.clone();
        // Keep indexing even after a later close, so returning to the file is
        // instant; eviction cancels it if it falls off the LRU.
        std::thread::spawn(move || {
            let _ = bg.index(DEFAULT_BATCH);
        });
        inner.entries.push(Entry { path: canon.clone(), index, mtime, size, last_used: now, active: 1 });
    }

    let session = inner.next_session;
    inner.next_session += 1;
    inner.sessions.insert(session, canon);

    evict(&mut inner, state.mem_budget);
    Ok(PgnOpened { session })
}

/// Filter + paginate whatever is indexed so far.
#[tauri::command]
pub fn pgn_query(state: State<'_, PgnCache>, session: u64, query: Query) -> Result<QueryResult, String> {
    Ok(state.index_for(session)?.query(&query))
}

/// Read one game's raw PGN text back by its id (index in file order).
#[tauri::command]
pub fn pgn_game(state: State<'_, PgnCache>, session: u64, id: u32) -> Result<String, String> {
    state.index_for(session)?.game_pgn(id).map_err(|e| e.to_string())
}

/// Release a view. The index stays cached (LRU) so reopening is instant.
#[tauri::command]
pub fn pgn_close(state: State<'_, PgnCache>, session: u64) {
    let mut inner = state.inner.lock().unwrap();
    if let Some(path) = inner.sessions.remove(&session) {
        if let Some(e) = inner.entries.iter_mut().find(|e| e.path == path) {
            e.active = e.active.saturating_sub(1);
        }
    }
}

/// Evict least-recently-used *inactive* entries until under both caps. Active
/// entries (open views) are kept even if that means exceeding a cap.
fn evict(inner: &mut Inner, mem_budget: u64) {
    loop {
        let total: u64 = inner.entries.iter().map(|e| e.index.estimated_bytes()).sum();
        if inner.entries.len() <= MAX_FILES && total <= mem_budget {
            break;
        }
        let victim = inner
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.active == 0)
            .min_by_key(|(_, e)| e.last_used)
            .map(|(i, _)| i);
        match victim {
            Some(i) => {
                inner.entries[i].index.cancel();
                inner.entries.remove(i);
            }
            None => break, // everything is in use — can't shrink further
        }
    }
}

/// Effective cache memory budget: `min(1 GiB, available − 20% of total RAM)`,
/// i.e. cache into currently-free RAM but always leave 20% of total free. Under
/// memory pressure the subtraction goes to zero (saturating) → **no caching**
/// beyond the open file. On non-Linux (no `/proc/meminfo`) it's the flat 1 GiB.
fn mem_budget() -> u64 {
    match mem_info() {
        Some((total, available)) => {
            let reserve = total / 5; // keep 20% of total RAM free
            MEM_TARGET.min(available.saturating_sub(reserve))
        }
        None => MEM_TARGET,
    }
}

/// `(MemTotal, MemAvailable)` in bytes from `/proc/meminfo`. `None` if it can't be
/// read (non-Linux, or a field is missing) → caller uses the default.
fn mem_info() -> Option<(u64, u64)> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let mut total = None;
    let mut available = None;
    for line in meminfo.lines() {
        // e.g. "MemTotal:       32791234 kB"
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total = rest.split_whitespace().next()?.parse::<u64>().ok().map(|kb| kb * 1024);
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            available = rest.split_whitespace().next()?.parse::<u64>().ok().map(|kb| kb * 1024);
        }
    }
    Some((total?, available?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tiny_index(tag: &str) -> Arc<PgnIndex> {
        let path = std::env::temp_dir().join(format!("pgn-cache-test-{tag}.pgn"));
        let mut f = std::fs::File::create(&path).unwrap();
        write!(f, "[White \"A\"]\n[Black \"B\"]\n[Result \"1-0\"]\n\n1. e4 1-0\n\n").unwrap();
        let idx = PgnIndex::open(&path).unwrap();
        idx.index_blocking().unwrap();
        idx
    }

    fn entry(path: &str, idx: Arc<PgnIndex>, last_used: u64, active: usize) -> Entry {
        Entry { path: PathBuf::from(path), index: idx, mtime: None, size: 0, last_used, active }
    }

    fn empty_inner() -> Inner {
        Inner { entries: Vec::new(), sessions: HashMap::new(), next_session: 0, tick: 0 }
    }

    #[test]
    fn evicts_lru_inactive_over_the_file_cap() {
        let mut inner = empty_inner();
        // Six entries (cap is five). Entry 1 is an open view; the rest are idle.
        for i in 0..6u64 {
            let active = usize::from(i == 1);
            inner.entries.push(entry(&format!("/f{i}"), tiny_index(&format!("e{i}")), i, active));
        }
        // No memory pressure, so only the file cap bites: the LRU idle entry (f0,
        // last_used 0) is evicted; the open one is untouched.
        evict(&mut inner, u64::MAX);
        assert_eq!(inner.entries.len(), 5);
        assert!(inner.entries.iter().all(|e| e.path != PathBuf::from("/f0")));
        assert!(inner.entries.iter().any(|e| e.path == PathBuf::from("/f1")));
    }

    #[test]
    fn never_evicts_active_entries() {
        let mut inner = empty_inner();
        // Seven open views; even a zero budget can't shrink below what's in use.
        for i in 0..7u64 {
            inner.entries.push(entry(&format!("/f{i}"), tiny_index(&format!("a{i}")), i, 1));
        }
        evict(&mut inner, 0);
        assert_eq!(inner.entries.len(), 7);
    }

    #[test]
    fn mem_budget_never_exceeds_the_target() {
        assert!(mem_budget() <= MEM_TARGET);
    }
}
