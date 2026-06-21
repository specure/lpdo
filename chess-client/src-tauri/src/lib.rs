mod local;
mod prep;
mod shortlist;

use fide_client::{ActivitySummary, FidePlayer, RatingPoint, RecentGame};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, State};

/// On Linux, configure the spawned process to receive SIGTERM when its parent
/// dies for any reason (clean exit, panic, SIGKILL, terminal close). Without
/// this, orphaned chess-db children keep the DuckDB lock and hold the binary
/// file open, breaking the next `npm run tauri dev`.
#[cfg(target_os = "linux")]
fn die_with_parent(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            // PR_SET_PDEATHSIG = 1
            if libc::prctl(1, libc::SIGTERM, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn die_with_parent(_cmd: &mut Command) {}

/// On Windows, prevent the spawned console-subsystem `chess-db serve` sidecar
/// from allocating its own console window that would flash up over the GUI.
/// No-op on other platforms.
#[cfg(windows)]
fn no_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_console_window(_cmd: &mut Command) {}

struct ServerState {
    child: Mutex<Option<Child>>,
}

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

#[cfg_attr(dev, allow(unused_variables))]
fn get_binary_path(_app: &tauri::AppHandle) -> std::path::PathBuf {
    #[cfg(dev)]
    {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest_dir.join("binaries").join(format!(
            "chess-db-{}",
            env!("TAURI_ENV_TARGET_TRIPLE")
        ))
    }
    #[cfg(not(dev))]
    {
        // Tauri installs externalBin sidecars *alongside the main executable*
        // (e.g. /usr/bin/chess-db next to /usr/bin/lpdo on Linux; next to the
        // .exe on Windows), not in the resource directory.
        let dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        dir.join(format!("chess-db{}", std::env::consts::EXE_SUFFIX))
    }
}

/// Whether a server is already accepting connections on the well-known port —
/// e.g. the installed `lpdo-server` daemon. If so the app connects to it instead
/// of spawning (and killing) its own.
fn server_running() -> bool {
    use std::net::TcpStream;
    let addr: std::net::SocketAddr = "127.0.0.1:7777".parse().unwrap();
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok()
}

fn spawn_serve(app: &tauri::AppHandle) {
    let binary_path = get_binary_path(app);
    let mut cmd = Command::new(&binary_path);
    cmd.args(["serve", "--port", "7777"]);
    die_with_parent(&mut cmd);
    no_console_window(&mut cmd);
    match cmd.spawn() {
        Ok(child) => {
            *app.state::<ServerState>().child.lock().unwrap() = Some(child);
        }
        Err(e) => eprintln!("chess-db: failed to start server at {}: {e}", binary_path.display()),
    }
}

/// True when this app spawned the server (and will kill it on exit); false when
/// connected to an external daemon. The close-guard uses this to skip its
/// "operation in progress" warning when closing won't stop the server.
#[tauri::command]
fn server_is_managed(state: State<'_, ServerState>) -> bool {
    state.child.lock().unwrap().is_some()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerState {
            child: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Connect to an already-running server (e.g. the installed
            // lpdo-server daemon) if present; otherwise spawn our own and manage
            // its lifecycle (kept in ServerState, killed on exit).
            if server_running() {
                println!("lpdo: connecting to the existing server on 127.0.0.1:7777");
            } else {
                spawn_serve(app.app_handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fide_player,
            fide_activity,
            fide_recent_games,
            fide_rating_history,
            server_is_managed,
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
            local::append_pgn_file,
            local::write_pgn_file,
            local::write_temp_pgn_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app_handle
                    .state::<ServerState>()
                    .child
                    .lock()
                    .unwrap()
                    .take()
                {
                    let _ = child.kill();
                }
            }
        });
}
