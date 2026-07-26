mod local;
mod pgn_index;
mod prep;
mod shortlist;

use fide_client::{ActivitySummary, FidePlayer, RatingPoint, RecentGame};
use tauri::{Emitter, Manager};

// The GUI is a pure HTTP client: it talks to the LPDO server over
// 127.0.0.1:7777 — the OS-managed system daemon (`lpdo-server` on Linux, the
// WinSW service on Windows, the launchd daemon on macOS), which the service
// manager keeps running. It does NOT spawn or manage its own `chess-db serve`
// (see #79). When no server is reachable, the frontend shows a "server not
// running / install the server" state.

#[tauri::command]
async fn fide_player(fide_id: u64) -> Result<Option<FidePlayer>, String> {
    tokio::task::spawn_blocking(move || {
        fide_client::player(fide_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fide_activity(fide_id: u64) -> Result<ActivitySummary, String> {
    tokio::task::spawn_blocking(move || {
        fide_client::activity_last_12_months(fide_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fide_recent_games(fide_id: u64) -> Result<Vec<RecentGame>, String> {
    tokio::task::spawn_blocking(move || {
        fide_client::recent_games(fide_id, false)
            .map(|(games, _)| games)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fide_rating_history(fide_id: u64) -> Result<Vec<RatingPoint>, String> {
    tokio::task::spawn_blocking(move || {
        fide_client::rating_history(fide_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The first argument that looks like a PGN file the browser can open (a
/// double-clicked `.pgn`/`.zip`/`.zst`/`.gz` via the file association). Skips the
/// binary path in `argv[0]`.
fn pgn_arg(argv: &[String]) -> Option<String> {
    argv.iter().skip(1).find(|a| is_openable_pgn(a)).cloned()
}

fn is_openable_pgn(arg: &str) -> bool {
    let lower = arg.to_lowercase();
    [".pgn", ".zip", ".zst", ".zstd", ".gz", ".gzip"].iter().any(|ext| lower.ends_with(ext))
}

/// The PGN file this process was launched with (file association / `lpdo file.pgn`),
/// if any. The frontend reads this once on startup to open it.
#[tauri::command]
fn take_launch_file() -> Option<String> {
    pgn_arg(&std::env::args().collect::<Vec<_>>())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second `lpdo file.pgn` (double-click while
        // running) forwards its argv here instead of opening a new window, and we
        // emit the file to the frontend + focus the window (#104/#210).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = pgn_arg(&argv) {
                let _ = app.emit("open-pgn-file", path);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pgn_index::PgnCache::default())
        .invoke_handler(tauri::generate_handler![
            fide_player,
            fide_activity,
            fide_recent_games,
            fide_rating_history,
            prep::fetch_participant_list,
            prep::fetch_team_list,
            prep::fetch_tournament_meta,
            prep::get_shortlist,
            prep::add_individual_tournament,
            prep::add_team_tournament,
            prep::remove_tournament,
            prep::get_individual_prep,
            prep::get_team_schedule,
            prep::get_team_prep,
            local::list_directory,
            local::read_pgn_file,
            local::upload_pgn_file,
            local::download_backup,
            local::append_pgn_file,
            local::write_pgn_file,
            local::write_temp_pgn_file,
            pgn_index::pgn_open,
            pgn_index::pgn_query,
            pgn_index::pgn_game,
            pgn_index::pgn_close,
            take_launch_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
