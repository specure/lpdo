//! In-process PGN browsing for large local files (#104).
//!
//! Wraps the [`chess_pgn`] engine as Tauri commands so the client can open a
//! multi-GB PGN with no server and no DuckDB: `pgn_open` streams+indexes the
//! file once (bounded memory), `pgn_query` filters/paginates, `pgn_game` fetches
//! one game's text for the board, and `pgn_close` frees the index. Each open file
//! is a session; the index lives in the app process for the session's lifetime.
//!
//! Header-only browse by design — no position search / dedup / normalisation
//! (that stays in the database; import a file for the full engine).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chess_pgn::{GameIndex, Query, QueryResult};
use serde::Serialize;
use tauri::State;

/// Open index sessions, keyed by an opaque id handed back to the frontend.
#[derive(Default)]
pub struct PgnSessions {
    next: AtomicU64,
    open: Mutex<HashMap<u64, GameIndex>>,
}

#[derive(Serialize)]
pub struct PgnOpened {
    /// Session handle to pass to `pgn_query` / `pgn_game` / `pgn_close`.
    session: u64,
    /// Total games in the file.
    count: usize,
}

/// Stream + index a PGN file, returning a session handle and the game count.
/// The (potentially multi-second) build runs on a blocking thread so the UI
/// stays responsive.
#[tauri::command]
pub async fn pgn_open(state: State<'_, PgnSessions>, path: String) -> Result<PgnOpened, String> {
    let index = tauri::async_runtime::spawn_blocking(move || GameIndex::build(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e}"))?;
    let count = index.len();
    let session = state.next.fetch_add(1, Ordering::Relaxed);
    state.open.lock().unwrap().insert(session, index);
    Ok(PgnOpened { session, count })
}

/// Filter + paginate an open index.
#[tauri::command]
pub fn pgn_query(
    state: State<'_, PgnSessions>,
    session: u64,
    query: Query,
) -> Result<QueryResult, String> {
    let open = state.open.lock().unwrap();
    let index = open.get(&session).ok_or("pgn session not found")?;
    Ok(index.query(&query))
}

/// Read one game's raw PGN text back by its id (index in file order).
#[tauri::command]
pub fn pgn_game(state: State<'_, PgnSessions>, session: u64, id: u32) -> Result<String, String> {
    let open = state.open.lock().unwrap();
    let index = open.get(&session).ok_or("pgn session not found")?;
    index.game_pgn(id).map_err(|e| e.to_string())
}

/// Free an index when its file view is closed.
#[tauri::command]
pub fn pgn_close(state: State<'_, PgnSessions>, session: u64) {
    state.open.lock().unwrap().remove(&session);
}
