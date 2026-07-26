//! In-process PGN browsing for large local files (#104).
//!
//! Wraps the [`chess_pgn`] engine as Tauri commands so the client can open a
//! multi-GB PGN with no server and no DuckDB. `pgn_open` returns *immediately*
//! and indexes the file on a background thread; `pgn_query` filters/paginates
//! whatever is indexed so far and reports `complete` (the frontend polls it and
//! watches the count + results grow live, #104 "growing index"). `pgn_game`
//! fetches one game's text for the board; `pgn_close` cancels the indexer and
//! frees the index.
//!
//! Header-only browse by design — no position search / dedup / normalisation
//! (that stays in the database; import a file for the full engine).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chess_pgn::{PgnIndex, Query, QueryResult, DEFAULT_BATCH};
use serde::Serialize;
use tauri::State;

/// Open index sessions, keyed by an opaque id handed back to the frontend.
#[derive(Default)]
pub struct PgnSessions {
    next: AtomicU64,
    open: Mutex<HashMap<u64, Arc<PgnIndex>>>,
}

#[derive(Serialize)]
pub struct PgnOpened {
    /// Session handle to pass to `pgn_query` / `pgn_game` / `pgn_close`.
    session: u64,
}

/// Open a PGN file and start indexing it in the background. Returns at once; the
/// frontend polls `pgn_query` (its `complete` flag + growing `total`) to watch
/// the index fill in.
#[tauri::command]
pub fn pgn_open(state: State<'_, PgnSessions>, path: String) -> Result<PgnOpened, String> {
    let index = PgnIndex::open(Path::new(&path)).map_err(|e| format!("{e}"))?;
    let session = state.next.fetch_add(1, Ordering::Relaxed);
    state.open.lock().unwrap().insert(session, index.clone());
    // Index off-thread; queries (read-lock) run concurrently with the append
    // (write-lock). A later pgn_close cancels this so it stops promptly.
    std::thread::spawn(move || {
        let _ = index.index(DEFAULT_BATCH);
    });
    Ok(PgnOpened { session })
}

/// Filter + paginate whatever is indexed so far. `QueryResult::complete` tells
/// the caller whether more games are still arriving.
#[tauri::command]
pub fn pgn_query(
    state: State<'_, PgnSessions>,
    session: u64,
    query: Query,
) -> Result<QueryResult, String> {
    // Clone the Arc out so the (potentially ~100 ms) scan doesn't hold the map
    // lock — other sessions/opens stay responsive.
    let index = state.open.lock().unwrap().get(&session).cloned().ok_or("pgn session not found")?;
    Ok(index.query(&query))
}

/// Read one game's raw PGN text back by its id (index in file order).
#[tauri::command]
pub fn pgn_game(state: State<'_, PgnSessions>, session: u64, id: u32) -> Result<String, String> {
    let index = state.open.lock().unwrap().get(&session).cloned().ok_or("pgn session not found")?;
    index.game_pgn(id).map_err(|e| e.to_string())
}

/// Cancel the background indexer and free the index when its file view closes.
#[tauri::command]
pub fn pgn_close(state: State<'_, PgnSessions>, session: u64) {
    if let Some(index) = state.open.lock().unwrap().remove(&session) {
        index.cancel();
    }
}
