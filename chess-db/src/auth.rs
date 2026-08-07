//! Access token for a server reachable beyond loopback (#247).
//!
//! The API has no authentication and several destructive endpoints (purge,
//! setup reset, soft-delete, job cancel). That is acceptable while the server
//! binds to 127.0.0.1 — the OS confines callers to this machine — but the
//! moment it listens on a LAN address, anyone on the network could wipe the
//! database. So a non-loopback bind REQUIRES a token, and the two ship together
//! (see `serve::run`).
//!
//! Design notes:
//! - The token lives in `<db-dir>/access-token` (0600 on Unix), generated on
//!   first LAN bind. Sharing it with a client is copy/paste; there is no user
//!   database and no accounts.
//! - Compared in constant time so a wrong token cannot be recovered by timing.
//! - `/status` stays open: clients probe it to distinguish "server down" from
//!   "wrong token", and it exposes only version/counters.
//! - Loopback deployments are entirely unaffected: no token file is created and
//!   no header is required, so existing installs keep working unchanged.
//! - NOT a substitute for TLS. Phase 1 is explicitly LAN-scoped; the token
//!   crosses the wire in the clear and must not be exposed to the internet.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Header carrying the token. A bare custom header (not `Authorization`) keeps
/// it clear this is a shared key, not a user credential.
pub const TOKEN_HEADER: &str = "x-lpdo-token";

/// Where the token is kept: beside the database, so it inherits the data
/// directory's ownership/permissions (root-owned service dirs on Linux/Windows).
pub fn token_path(db: &Path) -> PathBuf {
    db.parent()
        .unwrap_or_else(|| Path::new("."))
        .join("access-token")
}

/// Read the token, or create one if absent. Returns the token string.
pub fn load_or_create(db: &Path) -> Result<String> {
    let path = token_path(db);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    let token = generate();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    std::fs::write(&path, format!("{token}\n"))
        .with_context(|| format!("writing access token to {}", path.display()))?;
    restrict_permissions(&path);
    Ok(token)
}

/// 160 bits of randomness, hex-encoded. Sourced from the OS RNG via `getrandom`
/// (already in the dependency tree) — never a time-seeded PRNG, which would make
/// tokens guessable from the server's start time.
fn generate() -> String {
    let mut bytes = [0u8; 20];
    getrandom::fill(&mut bytes).expect("OS randomness unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {
    // Windows: the token inherits the ACL of the service data directory
    // (C:\ProgramData\LPDO), which is already administrator-owned.
}

/// Constant-time comparison — a byte-by-byte early return would leak the token
/// prefix to an attacker measuring response times.
pub fn matches(expected: &str, provided: &str) -> bool {
    let (a, b) = (expected.as_bytes(), provided.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// True when `addr` keeps the server confined to this machine, i.e. no token is
/// required. Anything else (0.0.0.0, a LAN IP, ::) is reachable by other hosts.
pub fn is_loopback_bind(addr: &str) -> bool {
    let host = match addr.rsplit_once(':') {
        // Strip an IPv6 bracket form: [::1]:7777
        Some((h, _)) => h.trim_start_matches('[').trim_end_matches(']'),
        None => addr,
    };
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        // Not an IP literal: only "localhost" is unambiguously loopback.
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_detection_gates_the_token_requirement() {
        for a in ["127.0.0.1:7777", "localhost:7777", "[::1]:7777", "127.0.0.53:7777"] {
            assert!(is_loopback_bind(a), "{a} is loopback");
        }
        for a in ["0.0.0.0:7777", "192.168.1.10:7777", "[::]:7777", "lpdo.local:7777"] {
            assert!(!is_loopback_bind(a), "{a} is NOT loopback");
        }
    }

    #[test]
    fn token_comparison_is_exact_and_length_safe() {
        assert!(matches("abc123", "abc123"));
        assert!(!matches("abc123", "abc124"));
        assert!(!matches("abc123", "abc1234"), "length mismatch rejected");
        assert!(!matches("abc123", ""), "empty rejected");
    }

    #[test]
    fn generated_tokens_are_long_and_unique() {
        let (a, b) = (generate(), generate());
        assert_eq!(a.len(), 40, "160 bits hex-encoded");
        assert_ne!(a, b, "each token is freshly random");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn load_or_create_persists_and_reuses_the_same_token() {
        let dir = std::env::temp_dir().join(format!("lpdo-token-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("chess.db");

        let first = load_or_create(&db).unwrap();
        let second = load_or_create(&db).unwrap();
        assert_eq!(first, second, "an existing token is reused, not regenerated");
        assert!(token_path(&db).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
