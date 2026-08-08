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
//! - The token lives in `<db-dir>/access-token`, generated on first LAN bind and
//!   readable only by the service account and administrators (0600 on Unix, an
//!   explicit inheritance-protected DACL on Windows — see
//!   [`restrict_permissions`]). Sharing it with a client is copy/paste; there is
//!   no user database and no accounts.
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

/// Where the token is kept: beside the database, in the service's data
/// directory. The file's own permissions are set explicitly (see
/// [`restrict_permissions`]) — inheriting the directory's is not enough, least
/// of all on Windows where `%ProgramData%` grants `BUILTIN\Users` read access.
pub fn token_path(db: &Path) -> PathBuf {
    db.parent()
        .unwrap_or_else(|| Path::new("."))
        .join("access-token")
}

/// Read the token, or create one if absent. Returns the token string.
///
/// Permissions are re-applied on EVERY call, not only when the file is created:
/// tokens written by an older build (which left Windows files at the inherited,
/// world-readable ACL) must get tightened when that install upgrades, and a
/// hand-copied file picks up the right permissions too.
pub fn load_or_create(db: &Path) -> Result<String> {
    let path = token_path(db);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            restrict_permissions(&path);
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

/// Restrict the token file to the service account and administrators.
/// Best-effort: a failure must not stop the server from starting (an
/// over-permissive token file is bad, an unstartable server is worse), and the
/// LAN warning at startup already tells the operator to treat the file as a
/// password.
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

/// Windows equivalent of 0600: an explicit DACL granting Full Control to
/// LocalSystem (the service account) and the local Administrators group, and to
/// nobody else.
///
/// Inheritance must be severed explicitly — without
/// `PROTECTED_DACL_SECURITY_INFORMATION` the ACEs inherited from
/// `%ProgramData%` survive, and those grant `BUILTIN\Users` read access, which
/// is precisely the exposure this closes. Reading the token consequently needs
/// elevation (an elevated `Get-Content`), mirroring `sudo cat` on Linux — the
/// setup guide says so.
///
/// SDDL, decoded: `D:` DACL, `P` protected (no inheritance from the parent),
/// `AI` auto-inherit-ok for anything below, then two allow-ACEs of Full Access
/// for `SY` (LocalSystem) and `BA` (BUILTIN\Administrators). The `SY`/`BA`
/// aliases resolve to SIDs, so this is correct on localized Windows where the
/// account *names* differ.
#[cfg(windows)]
fn restrict_permissions(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    };

    const SDDL: &str = "D:PAI(A;;FA;;;SY)(A;;FA;;;BA)";

    // Escape hatch. This code runs before the database is even opened, and the
    // service restarts on failure — so a defect here (the first cut of it read a
    // self-relative descriptor as absolute and died on an access violation) puts
    // the server in an endless restart loop that can only be broken by editing
    // the service descriptor by hand. `LPDO_SKIP_TOKEN_ACL=1` lets an operator
    // get a server back up without a new build, at the cost of the token
    // keeping the directory's inherited permissions.
    if std::env::var_os("LPDO_SKIP_TOKEN_ACL").is_some() {
        eprintln!("LPDO_SKIP_TOKEN_ACL set — leaving the access token's inherited permissions alone.");
        return;
    }

    let sddl: Vec<u16> = SDDL.encode_utf16().chain(std::iter::once(0)).collect();
    let mut psd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: `sddl` is a NUL-terminated UTF-16 literal; the call either fills
    // `psd` with a LocalAlloc'd descriptor (freed below) or returns 0 and
    // leaves it null.
    let built = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1 as u32,
            &mut psd,
            std::ptr::null_mut(),
        )
    };
    if built == 0 || psd.is_null() {
        return;
    }

    // SetNamedSecurityInfoW wants the DACL, not the descriptor — and it must be
    // read with GetSecurityDescriptorDacl, NOT by casting to SECURITY_DESCRIPTOR
    // and taking `.Dacl`. ConvertStringSecurityDescriptorToSecurityDescriptorW
    // returns a SELF-RELATIVE descriptor, where that field is a byte offset, not
    // a pointer; reading it as a pointer hands SetNamedSecurityInfoW a wild
    // address and kills the process (an access violation, so no panic message
    // and no log line — it just dies, and WinSW restarts it forever).
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut present: i32 = 0;
    let mut defaulted: i32 = 0;
    // SAFETY: psd is a valid descriptor from the call above; the three out
    // params are live locals. The accessor handles both descriptor layouts.
    let got = unsafe { GetSecurityDescriptorDacl(psd, &mut present, &mut dacl, &mut defaulted) };
    if got == 0 || present == 0 || dacl.is_null() {
        // SAFETY: freeing the descriptor allocated above, still owned here.
        unsafe { LocalFree(psd.cast()) };
        return;
    }

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    // SAFETY: `wide` is a NUL-terminated path; `dacl` belongs to the live
    // descriptor; owner/group/SACL are not being changed, hence the nulls.
    let rc = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null_mut(),
        )
    };
    if rc != ERROR_SUCCESS {
        eprintln!(
            "warning: could not restrict permissions on {} (error {rc}) — \
             check that only administrators can read it",
            path.display()
        );
    }
    // SAFETY: psd was allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW,
    // which documents LocalFree as the matching deallocator. Done after the
    // SetNamedSecurityInfoW call, which borrows the descriptor's DACL.
    unsafe { LocalFree(psd.cast()) };
}

#[cfg(not(any(unix, windows)))]
fn restrict_permissions(_path: &Path) {}

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

    /// The token must not be world-readable, and — since older builds left it
    /// permissive — an ALREADY EXISTING file must get tightened on the next
    /// load, not only on creation. (Unix asserts the mode; the Windows DACL
    /// equivalent can only be verified on Windows, with `icacls`.)
    #[cfg(unix)]
    #[test]
    fn existing_token_permissions_are_tightened_on_load() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("lpdo-token-perm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("chess.db");
        let path = token_path(&db);

        // A token file as an older build would have left it: world-readable.
        std::fs::write(&path, "deadbeef\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let token = load_or_create(&db).unwrap();
        assert_eq!(token, "deadbeef", "the existing token is preserved");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "permissions tightened on load, not just creation");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
