//! `chess-db service` — manage the server as a background service.
//!
//! On Linux this is a **systemd user service** (`lpdo-server.service`): it runs
//! on login, restarts on failure, and owns the database read-write so the server
//! is always available and runs the in-process update scheduler — independent of
//! the desktop app. Windows/macOS keep the app-managed model for now.

use crate::ServiceCommands;
use anyhow::Result;

#[cfg(target_os = "linux")]
const UNIT_NAME: &str = "lpdo-server.service";

#[cfg(target_os = "linux")]
pub fn run(cmd: &ServiceCommands) -> Result<()> {
    match cmd {
        ServiceCommands::Install => install(),
        ServiceCommands::Uninstall => uninstall(),
        ServiceCommands::Status => status(),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn run(_cmd: &ServiceCommands) -> Result<()> {
    println!("`chess-db service` is supported on Linux (systemd) only for now.");
    println!("On Windows/macOS the desktop app manages the server itself.");
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
