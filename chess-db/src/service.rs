//! `chess-db service` — manage the server as a background service.
//!
//! On **Linux** this is a systemd *user* service (`lpdo-server.service`); on
//! **macOS** it is a per-user **launchd LaunchAgent** (`com.specure.lpdo.server`).
//! Either way it runs on login, restarts on failure, and owns the database
//! read-write so the server is always available and runs the in-process update
//! scheduler — independent of the desktop app. Both use the default per-user data
//! dir (`~/.chess-db`); no privilege escalation. Windows keeps the app-managed
//! model for now (the MSI/system-service path is tracked separately).
//!
//! Note: on an apt-managed install the **`lpdo-server` .deb** provides a systemd
//! *system* service (data under `/var/lib/lpdo`) instead — that's authoritative
//! there. This per-user install is for the AppImage / `.dmg` / dev / non-packaged
//! case; only one server can hold the DB lock + port 7777, so don't run both.

use crate::ServiceCommands;
use anyhow::Result;

#[cfg(target_os = "linux")]
const UNIT_NAME: &str = "lpdo-server.service";

#[cfg(target_os = "macos")]
const LABEL: &str = "com.specure.lpdo.server";

#[cfg(target_os = "linux")]
pub fn run(cmd: &ServiceCommands) -> Result<()> {
    match cmd {
        ServiceCommands::Install => install(),
        ServiceCommands::Uninstall => uninstall(),
        ServiceCommands::Status => status(),
    }
}

#[cfg(target_os = "macos")]
pub fn run(cmd: &ServiceCommands) -> Result<()> {
    match cmd {
        ServiceCommands::Install => macos::install(),
        ServiceCommands::Uninstall => macos::uninstall(),
        ServiceCommands::Status => macos::status(),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn run(_cmd: &ServiceCommands) -> Result<()> {
    println!("`chess-db service` is supported on Linux (systemd) and macOS (launchd) only.");
    println!("On Windows the desktop app manages the server itself.");
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::UNIT_NAME;
    use anyhow::{bail, Context, Result};
    use std::path::PathBuf;

    fn unit_path() -> Result<PathBuf> {
        let home = dirs::home_dir().context("cannot determine home directory")?;
        Ok(home.join(".config").join("systemd").join("user").join(UNIT_NAME))
    }

    fn systemctl(args: &[&str]) -> Result<()> {
        let ok = std::process::Command::new("systemctl")
            .arg("--user")
            .args(args)
            .status()
            .context("failed to run `systemctl --user` (is systemd available?)")?
            .success();
        if !ok {
            bail!("`systemctl --user {}` failed", args.join(" "));
        }
        Ok(())
    }

    pub fn install() -> Result<()> {
        let exe = std::env::current_exe()
            .context("cannot determine the chess-db executable path")?;
        let path = unit_path()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let unit = format!(
            "[Unit]\n\
             Description=LPDO chess database server\n\
             After=network-online.target\n\
             Wants=network-online.target\n\
             \n\
             [Service]\n\
             Type=simple\n\
             ExecStart={exe} serve\n\
             Restart=on-failure\n\
             RestartSec=5\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n",
            exe = exe.display(),
        );
        std::fs::write(&path, unit).with_context(|| format!("writing {}", path.display()))?;
        println!("Wrote {}", path.display());

        systemctl(&["daemon-reload"])?;
        systemctl(&["enable", "--now", UNIT_NAME])?;
        println!("Enabled and started {UNIT_NAME}.");

        // The in-server scheduler replaces the old update timer; disable it if present.
        if systemctl(&["disable", "--now", "chess-db-update.timer"]).is_ok() {
            println!("Disabled the old chess-db-update.timer (the server now schedules updates).");
        }

        println!();
        println!("The LPDO server now runs in the background and keeps the database up to date.");
        println!("Close the app any time — the server (and a running update) keeps going.");
        println!("Check it with:  chess-db service status");
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        // disable --now stops + disables; ignore failure if it isn't installed.
        let _ = systemctl(&["disable", "--now", UNIT_NAME]);
        let path = unit_path()?;
        if path.exists() {
            std::fs::remove_file(&path)?;
            println!("Removed {}", path.display());
        }
        let _ = systemctl(&["daemon-reload"]);
        println!("LPDO server service removed. (The desktop app will spawn its own server again.)");
        Ok(())
    }

    pub fn status() -> Result<()> {
        // `status` exits nonzero when inactive/failed, which is informational here,
        // not an error — so don't propagate the exit code.
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "status", UNIT_NAME, "--no-pager"])
            .status();
        Ok(())
    }
}

#[cfg(target_os = "linux")]
use linux::{install, status, uninstall};

#[cfg(target_os = "macos")]
mod macos {
    use super::LABEL;
    use anyhow::{bail, Context, Result};
    use std::path::PathBuf;

    fn plist_path() -> Result<PathBuf> {
        let home = dirs::home_dir().context("cannot determine home directory")?;
        Ok(home
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{LABEL}.plist")))
    }

    fn log_dir() -> Result<PathBuf> {
        let home = dirs::home_dir().context("cannot determine home directory")?;
        Ok(home.join("Library").join("Logs").join("LPDO"))
    }

    /// Minimal XML-escaping for text placed inside a plist `<string>` (exe path,
    /// log path). Paths almost never contain these, but escape to be safe.
    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    /// Build the LaunchAgent plist. `RunAtLoad` starts it now + on every login;
    /// `KeepAlive/SuccessfulExit=false` restarts it on failure (the launchd
    /// equivalent of systemd's `Restart=on-failure`).
    fn plist_contents(exe: &str, log_path: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n\
             <dict>\n\
             <key>Label</key>\n\
             <string>{label}</string>\n\
             <key>ProgramArguments</key>\n\
             <array>\n\
             <string>{exe}</string>\n\
             <string>serve</string>\n\
             </array>\n\
             <key>RunAtLoad</key>\n\
             <true/>\n\
             <key>KeepAlive</key>\n\
             <dict>\n\
             <key>SuccessfulExit</key>\n\
             <false/>\n\
             </dict>\n\
             <key>StandardOutPath</key>\n\
             <string>{log}</string>\n\
             <key>StandardErrorPath</key>\n\
             <string>{log}</string>\n\
             </dict>\n\
             </plist>\n",
            label = LABEL,
            exe = xml_escape(exe),
            log = xml_escape(log_path),
        )
    }

    fn launchctl(args: &[&str]) -> Result<()> {
        let ok = std::process::Command::new("launchctl")
            .args(args)
            .status()
            .context("failed to run `launchctl` (is this macOS?)")?
            .success();
        if !ok {
            bail!("`launchctl {}` failed", args.join(" "));
        }
        Ok(())
    }

    pub fn install() -> Result<()> {
        let exe =
            std::env::current_exe().context("cannot determine the chess-db executable path")?;

        let log_dir = log_dir()?;
        std::fs::create_dir_all(&log_dir)
            .with_context(|| format!("creating {}", log_dir.display()))?;
        let log_path = log_dir.join("lpdo-server.log");

        let path = plist_path()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let plist = plist_contents(&exe.to_string_lossy(), &log_path.to_string_lossy());
        std::fs::write(&path, plist).with_context(|| format!("writing {}", path.display()))?;
        println!("Wrote {}", path.display());

        let p = path.to_string_lossy();
        // Reload if it was already loaded (e.g. re-install after an app update
        // moved the exe), ignoring failure when it isn't loaded yet.
        let _ = launchctl(&["unload", "-w", p.as_ref()]);
        launchctl(&["load", "-w", p.as_ref()])?;
        println!("Loaded and started {LABEL}.");

        println!();
        println!("The LPDO server now runs in the background and keeps the database up to date.");
        println!("Close the app any time — the server (and a running update) keeps going.");
        println!("Check it with:  chess-db service status");
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        let path = plist_path()?;
        let p = path.to_string_lossy();
        // unload -w stops + disables; ignore failure if it isn't loaded.
        let _ = launchctl(&["unload", "-w", p.as_ref()]);
        if path.exists() {
            std::fs::remove_file(&path)?;
            println!("Removed {}", path.display());
        }
        println!("LPDO server service removed. (The desktop app will spawn its own server again.)");
        Ok(())
    }

    pub fn status() -> Result<()> {
        // `launchctl list <label>` prints the job dict and exits 0 when loaded,
        // nonzero when not — the latter is informational here, not an error.
        let loaded = std::process::Command::new("launchctl")
            .args(["list", LABEL])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !loaded {
            println!("{LABEL} is not loaded. Run `chess-db service install` to start it.");
        }
        Ok(())
    }
}
