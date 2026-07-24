mod local;
mod prep;
mod shortlist;

use fide_client::{ActivitySummary, FidePlayer, RatingPoint, RecentGame};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
            local::append_pgn_file,
            local::write_pgn_file,
            local::write_temp_pgn_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
