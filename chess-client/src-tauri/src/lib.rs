mod local;
mod prep;
mod shortlist;

use fide_client::{ActivitySummary, FidePlayer, RatingPoint, RecentGame};
use std::collections::HashMap;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

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

struct ServerState {
    child: Mutex<Option<Child>>,
}

/// PIDs of in-flight `run_chess_db` operations, keyed by event_id. The
/// frontend's `cancel_chess_db` command looks the PID up and sends SIGTERM
/// to stop a long-running download / import.
#[derive(Default)]
struct OperationsState {
    pids: Mutex<HashMap<String, u32>>,
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
fn get_binary_path(app: &tauri::AppHandle) -> std::path::PathBuf {
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
        app.path()
            .resource_dir()
            .expect("resource dir not found")
            .join("binaries")
            .join("chess-db")
    }
}

/// Subcommands that need exclusive write access to the DuckDB file. The held
/// `serve` child must be paused before running these and respawned afterwards.
fn needs_db_write_lock(args: &[String]) -> bool {
    matches!(
        args.first().map(String::as_str),
        // `backup` is read-only over the DB, but chess-db's main() opens the
        // file read-write before dispatching — which conflicts with serve's
        // read-only handle. Pause serve for it like any other writer.
        Some("import" | "import-pgn" | "download" | "index-positions"
            | "games" | "players" | "dedup" | "backup"),
    )
}

fn spawn_serve(app: &tauri::AppHandle) {
    let binary_path = get_binary_path(app);
    let mut cmd = Command::new(&binary_path);
    cmd.args(["serve", "--port", "7777"]);
    die_with_parent(&mut cmd);
    match cmd.spawn() {
        Ok(child) => {
            *app.state::<ServerState>().child.lock().unwrap() = Some(child);
        }
        Err(e) => eprintln!("chess-db: failed to start server at {}: {e}", binary_path.display()),
    }
}

/// Block until chess-db serve accepts TCP connections on :7777, or `timeout`
/// elapses. Used after a writer subprocess so UI re-fetches don't race against
/// the still-binding server.
fn wait_for_serve_ready(timeout: std::time::Duration) {
    use std::net::TcpStream;
    use std::time::Instant;
    let addr: std::net::SocketAddr = "127.0.0.1:7777".parse().unwrap();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(100)).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[tauri::command]
async fn run_chess_db(
    app: tauri::AppHandle,
    args: Vec<String>,
    event_id: String,
) -> Result<(), String> {
    let binary_path = get_binary_path(&app);
    let needs_lock = needs_db_write_lock(&args);

    // Release the DB file: kill the held serve child so the writer can take
    // the lock. Respawn serve after the writer exits.
    if needs_lock {
        if let Some(mut child) = app.state::<ServerState>().child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    let app_for_task = app.clone();
    let event_id_for_task = event_id.clone();
    let event_id_for_cleanup = event_id.clone();

    // For writers: hold "done"/"error" terminal events until after serve is
    // respawned so the UI's done-handler doesn't fire a re-fetch against a
    // dead serve. Non-writers emit straight through.
    type TerminalEvent = serde_json::Value;
    let result: Result<(Option<TerminalEvent>, std::process::ExitStatus), String> =
        tokio::task::spawn_blocking(move || {
            use std::io::BufRead;
            use std::sync::Arc;
            let event_name = format!("chess-db:{}", event_id_for_task);
            let mut cmd = Command::new(&binary_path);
            cmd.arg("--json")
                .args(&args)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            die_with_parent(&mut cmd);
            let mut child = cmd.spawn().map_err(|e| e.to_string())?;

            // Register the PID so cancel_chess_db can SIGTERM it. We register
            // before reading streams so a cancel arriving very early still has
            // a target. The matching deregister happens after wait() below.
            let child_pid = child.id();
            app_for_task
                .state::<OperationsState>()
                .pids
                .lock()
                .unwrap()
                .insert(event_id_for_task.clone(), child_pid);

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let app_arc = Arc::new(app_for_task);

            // Drain stderr in a side thread, emitting each line as a JSON error event
            // so subprocess failures (DB-lock conflicts, panics, etc.) are visible.
            let stderr_handle = stderr.map(|err| {
                let app = Arc::clone(&app_arc);
                let event_name = event_name.clone();
                std::thread::spawn(move || {
                    let reader = std::io::BufReader::new(err);
                    for line in reader.lines().map_while(Result::ok) {
                        if line.is_empty() { continue; }
                        let payload = serde_json::json!({ "type": "error", "message": line }).to_string();
                        let _ = app.emit(&event_name, &payload);
                    }
                })
            });

            // Stream stdout; intercept terminal events when needs_lock so we
            // can re-emit them only after serve is respawned.
            let mut held_terminal: Option<TerminalEvent> = None;
            if let Some(stdout) = stdout {
                let reader = std::io::BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    if line.is_empty() { continue; }
                    if needs_lock {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                            let kind = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if kind == "done" || kind == "error" {
                                held_terminal = Some(parsed);
                                continue;
                            }
                        }
                    }
                    let _ = app_arc.emit(&event_name, &line);
                }
            }

            let status = child.wait().map_err(|e| e.to_string())?;
            if let Some(h) = stderr_handle { let _ = h.join(); }
            // Deregister PID — cancel_chess_db is a no-op after this point.
            app_arc
                .state::<OperationsState>()
                .pids
                .lock()
                .unwrap()
                .remove(&event_id_for_task);
            Ok((held_terminal, status))
        })
        .await
        .map_err(|e| e.to_string())?;

    // Belt-and-braces cleanup: if the blocking task failed mid-way (e.g. wait
    // errored after we already registered the PID), the inner deregister won't
    // have run. Removing here covers every exit path.
    app.state::<OperationsState>()
        .pids
        .lock()
        .unwrap()
        .remove(&event_id_for_cleanup);

    let (held_terminal, status) = match result {
        Ok(r) => r,
        Err(e) => {
            // Spawn fail or wait fail — still respawn serve.
            if needs_lock { spawn_serve(&app); }
            return Err(e);
        }
    };

    // Respawn serve BEFORE emitting any terminal event so the UI's re-fetches
    // (triggered by done/error handlers) hit a live server. spawn_serve() returns
    // when the process exists; wait until it has bound the port too.
    if needs_lock {
        spawn_serve(&app);
        wait_for_serve_ready(std::time::Duration::from_secs(10));
    }

    // Emit the (possibly buffered) terminal event, or synthesise one.
    let event_name = format!("chess-db:{}", event_id);
    let terminal_payload = held_terminal.unwrap_or_else(|| {
        if status.success() {
            serde_json::json!({ "type": "done", "message": "Done." })
        } else {
            serde_json::json!({
                "type": "error",
                "message": format!("chess-db exited with status {}", status),
            })
        }
    });
    let _ = app.emit(&event_name, &terminal_payload.to_string());

    Ok(())
}

/// Cancel an in-flight `run_chess_db` operation by sending SIGTERM to the
/// child process. The PID is looked up from OperationsState (registered in
/// run_chess_db right after spawn). After SIGTERM the child exits, the
/// reader threads finish, and `run_chess_db` proceeds to its terminal-event
/// emit just like a natural completion — the frontend gets an "exited with
/// status N" error event which surfaces in the progress log.
#[tauri::command]
fn cancel_chess_db(app: tauri::AppHandle, event_id: String) -> Result<(), String> {
    let pid = app
        .state::<OperationsState>()
        .pids
        .lock()
        .unwrap()
        .get(&event_id)
        .copied();

    if let Some(pid) = pid {
        // SAFETY: libc::kill is safe to call with any PID; if the PID is
        // already gone (race with natural exit) it returns ESRCH which we
        // ignore. SIGTERM lets the process clean up; the parent's
        // PR_SET_PDEATHSIG (Linux) means hard kill on parent death too.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(OperationsState::default())
        .manage(ServerState {
            child: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            spawn_serve(app.app_handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fide_player,
            fide_activity,
            fide_recent_games,
            fide_rating_history,
            run_chess_db,
            cancel_chess_db,
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
