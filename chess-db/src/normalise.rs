use anyhow::{Context, Result};
use duckdb::Connection;
use crate::reporter::Reporter;
use regex::Regex;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

const RATINGS_BASE: &str = "https://ratings.fide.com";

/// Default batch normalisation cache service (one request resolves many FIDE IDs).
/// Public URL; the *key* is the secret (see `resolve_service`).
const NORMALISE_SERVICE_URL: &str = "https://normalise.lpdo.com/normalise";

/// FIDE IDs per cache request. Matches the service's per-request cap (MAX_IDS in
/// lpdo-normalise-service), so a large backlog (e.g. 300k+ players from Megabase +
/// TWIC) is covered in `ceil(N / 20000)` calls — ~15 requests, not hundreds. Must
/// stay <= the deployed service's cap or those chunks would be rejected (then the
/// run soft-falls back to FIDE for everyone).
const SERVICE_CHUNK: usize = 20_000;

// ── Result type sent from worker threads back to the main thread ──────────────

enum LookupResult {
    Found    { id: u32, fide_id: u32, name: String, canonical: String },
    NotFound { id: u32, fide_id: u32, name: String },
    Error    { id: u32, fide_id: u32, name: String, msg: String },
}

// ── Public entry point ────────────────────────────────────────────────────────

pub fn normalise_players(
    conn: &Connection,
    dry_run: bool,
    delay_ms: u64,
    batch_size: usize,
    batch_pause_ms: u64,
    workers: usize,
    error_threshold: usize,
    error_pause_ms: u64,
    // When true, hitting `error_threshold` consecutive errors stops the run
    // immediately instead of pausing for `error_pause_ms`. Used by the wizard.
    stop_on_errors: bool,
    limit: Option<usize>,
    // Batch cache service: when a URL+key resolve (flag > env > compile-time), a
    // single pre-pass resolves most names; the rest fall back to FIDE lookups.
    service_url: Option<String>,
    service_key: Option<String>,
    no_service: bool,
    reporter: &Reporter,
) -> Result<()> {
    // Total backlog (ignores --limit). Used for "left pending" accounting.
    let pending_total: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM players
             WHERE fide_id IS NOT NULL AND (name_normalised = FALSE OR name_normalised IS NULL)",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize;

    let service = resolve_service(service_url.as_deref(), service_key.as_deref(), no_service);

    // The cache service is a single cheap call, so --limit must NOT throttle it:
    // with the service enabled we select ALL pending players (the limit is applied
    // later, only to the FIDE misses). Without the service every selected player is
    // a slow FIDE lookup, so apply --limit at the query for efficiency.
    let select_limit = if service.is_some() { None } else { limit };
    let mut pending: Vec<(u32, u32, String)> = {
        // `select_limit` is a usize we control, so inlining it is injection-safe.
        let limit_clause = match select_limit {
            Some(n) => format!(" LIMIT {}", n),
            None => String::new(),
        };
        let sql = format!(
            "SELECT id, fide_id, name FROM players
             WHERE fide_id IS NOT NULL AND (name_normalised = FALSE OR name_normalised IS NULL)
             ORDER BY fide_id{}",
            limit_clause,
        );
        let mut stmt = conn.prepare(&sql)?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .filter_map(|r| r.ok())
            .collect()
    };

    if pending.is_empty() {
        reporter.done("All players with FIDE IDs are already normalised.");
        return Ok(());
    }

    // Counters shared across the cache phase and the FIDE worker phase.
    let mut updated          = 0usize;
    let mut not_found        = 0usize;
    let mut errors           = 0usize;
    let mut completed        = 0usize;   // overall progress (cache + FIDE)
    let mut consecutive_errs = 0usize;
    let mut aborted          = false;
    let mut fide_done        = 0usize;   // FIDE-phase count, for batch pacing only

    // ── Cache lookup: ONE request for ALL pending IDs (never limited) ──────────
    // A service failure is soft: `cache` stays empty and everyone goes via FIDE.
    let mut cache: HashMap<u32, String> = HashMap::new();
    if let Some((url, key)) = &service {
        let fide_ids: Vec<u32> = pending.iter().map(|(_, fide_id, _)| *fide_id).collect();
        match build_client().and_then(|c| fetch_cache_names(&c, url, key, &fide_ids)) {
            Ok(map) => cache = map,
            Err(e) => reporter.log(format!(
                "⚠ Cache service unavailable ({}); using FIDE lookups instead.", e,
            )),
        }
    }

    // Split into cache hits and misses (order preserved).
    let mut hits:   Vec<(u32, u32, String)> = Vec::new();
    let mut misses: Vec<(u32, u32, String)> = Vec::new();
    for row in pending.drain(..) {
        if cache.contains_key(&row.1) { hits.push(row); } else { misses.push(row); }
    }

    // --limit caps only the slow FIDE lookups (the misses). Cache hits are free.
    if let Some(n) = limit {
        misses.truncate(n);
    }

    // What we process now = all cache hits + the (capped) misses. Anything beyond
    // that is left pending for a later run.
    let total = hits.len() + misses.len();
    let deferred = pending_total.saturating_sub(total);

    reporter.log(format!(
        "Normalising{}: {} from cache, {} via FIDE lookup (workers={}, delay={}ms).",
        if dry_run { " (dry-run)" } else { "" },
        hits.len(), misses.len(), workers, delay_ms,
    ));
    if deferred > 0 {
        reporter.log(format!(
            "⚠ FIDE lookups capped at {}; {} player(s) left pending. Re-run to continue, \
             or run `chess-db players normalise` from the command line for the full set.",
            misses.len(), deferred,
        ));
    }

    let pb = reporter.bar_with_eta(total as u64);

    // ── Apply cache hits ───────────────────────────────────────────────────────
    // Throttle the streamed progress events: emitting one per player (100k+)
    // floods the sidecar pipe so the GUI bar lags far behind the (near-instant)
    // cache work. Report roughly every 1% instead, plus a final tick.
    let report_every = (total / 100).max(1);
    for (id, fide_id, name) in &hits {
        if let Some(canonical) = cache.get(fide_id) {
            apply_canonical(conn, *id, name, canonical, dry_run);
            updated += 1;
            completed += 1;
            pb.inc(1);
            if completed % report_every == 0 {
                reporter.progress(completed as u64, total as u64, format!("Cached {} / {} players", completed, total));
            }
        }
    }
    if updated > 0 {
        reporter.progress(completed as u64, total as u64, format!("Cached {} / {} players", completed, total));
    }

    // The FIDE worker loop processes the (capped) misses.
    let to_normalise = misses;

    // ── Channels ─────────────────────────────────────────────────────────────
    // work_tx  → workers consume (id, fide_id, name) items
    // result_tx → main thread collects LookupResult values

    let (work_tx, work_rx) = std::sync::mpsc::channel::<(u32, u32, String)>();
    let work_rx = Arc::new(Mutex::new(work_rx));

    let (result_tx, result_rx) = std::sync::mpsc::channel::<LookupResult>();

    // Shared pause flag: main thread sets TRUE during batch pause; workers spin-wait.
    let paused = Arc::new(AtomicBool::new(false));
    // Shared abort flag: main thread sets TRUE to make workers stop pulling work
    // (used by --stop-on-errors when the error threshold is reached).
    let abort = Arc::new(AtomicBool::new(false));

    // ── Spawn worker threads ──────────────────────────────────────────────────

    let mut handles = Vec::new();
    for _ in 0..workers {
        let rx     = Arc::clone(&work_rx);
        let tx     = result_tx.clone();
        let delay  = delay_ms;
        let paused = Arc::clone(&paused);
        let abort  = Arc::clone(&abort);

        let handle = std::thread::spawn(move || {
            let client = match build_client() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Worker failed to build HTTP client: {}", e);
                    return;
                }
            };
            let mut first = true;
            loop {
                if abort.load(Ordering::Relaxed) { break; }
                // Wait out any batch pause before taking the next item.
                while paused.load(Ordering::Relaxed) {
                    if abort.load(Ordering::Relaxed) { break; }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }

                let item = {
                    let guard = rx.lock().unwrap();
                    guard.recv()
                };
                match item {
                    Err(_) => break,  // channel closed — all work done
                    Ok((id, fide_id, name)) => {
                        if abort.load(Ordering::Relaxed) { break; }  // don't start a new lookup after abort
                        if !first {
                            std::thread::sleep(std::time::Duration::from_millis(delay));
                        }
                        first = false;

                        let result = match lookup_name(&client, fide_id as u64) {
                            Ok(Some(canonical)) => LookupResult::Found { id, fide_id, name, canonical },
                            Ok(None)            => LookupResult::NotFound { id, fide_id, name },
                            Err(e)              => LookupResult::Error { id, fide_id, name, msg: e.to_string() },
                        };
                        if tx.send(result).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        handles.push(handle);
    }
    drop(result_tx); // main thread doesn't send results

    // ── Feed work items ───────────────────────────────────────────────────────

    for item in to_normalise {
        work_tx.send(item).ok();
    }
    drop(work_tx); // signal workers: no more work

    // ── Collect results on main thread ────────────────────────────────────────
    // Counters were declared before the cache pre-pass so both phases share them.

    for result in result_rx {
        // Batch pause: after every batch_size FIDE lookups (not counting the cache
        // pre-pass). Set the pause flag so workers also stop requesting during the break.
        if fide_done > 0 && fide_done % batch_size == 0 {
            pb.set_message(format!(
                "{}✓ {}? {}✗  — pausing {}s…",
                updated, not_found, errors,
                batch_pause_ms / 1000
            ));
            paused.store(true, Ordering::Relaxed);
            std::thread::sleep(std::time::Duration::from_millis(batch_pause_ms));
            paused.store(false, Ordering::Relaxed);
        }

        match result {
            LookupResult::Found { id, fide_id, name, canonical } => {
                consecutive_errs = 0;
                let changed = apply_canonical(conn, id, &name, &canonical, dry_run);
                if changed {
                    pb.suspend(|| println!(
                        "  [{}] fide_id={} \"{}\" → \"{}\"",
                        id, fide_id, name, canonical
                    ));
                } else {
                    pb.suspend(|| println!(
                        "  [{}] fide_id={} \"{}\" — already normalised",
                        id, fide_id, name
                    ));
                }
                updated += 1;
            }
            LookupResult::NotFound { id, fide_id, name } => {
                consecutive_errs = 0;
                pb.suspend(|| println!(
                    "  [{}] fide_id={} \"{}\" — not found on FIDE (marking as checked)",
                    id, fide_id, name
                ));
                if !dry_run {
                    let _ = conn.execute(
                        "UPDATE players SET name_normalised = TRUE WHERE id = ?",
                        duckdb::params![id],
                    );
                }
                not_found += 1;
            }
            LookupResult::Error { id, fide_id, name, msg } => {
                consecutive_errs += 1;
                pb.suspend(|| println!(
                    "  [{}] fide_id={} \"{}\" — error: {}",
                    id, fide_id, name, msg
                ));
                errors += 1;

                // Too many consecutive network errors. Either stop immediately
                // (--stop-on-errors, used by the wizard) or take a long break
                // and retry (the CLI default).
                if error_threshold > 0 && consecutive_errs >= error_threshold {
                    if stop_on_errors {
                        reporter.log(format!(
                            "⚠ Stopping after {} consecutive errors (FIDE may be unreachable or rate-limiting).",
                            consecutive_errs,
                        ));
                        abort.store(true, Ordering::Relaxed);
                        aborted = true;
                        break;
                    }
                    let pause_h = error_pause_ms / 3_600_000;
                    let pause_m = (error_pause_ms % 3_600_000) / 60_000;
                    pb.suspend(|| println!(
                        "  ⚠ {} consecutive errors — pausing {}h{}m before retrying…",
                        consecutive_errs, pause_h, pause_m
                    ));
                    consecutive_errs = 0;
                    paused.store(true, Ordering::Relaxed);
                    std::thread::sleep(std::time::Duration::from_millis(error_pause_ms));
                    paused.store(false, Ordering::Relaxed);
                    pb.suspend(|| println!("  Resuming after error pause."));
                }
            }
        }

        completed += 1;
        fide_done += 1;
        pb.set_message(format!("{}✓ {}? {}✗", updated, not_found, errors));
        pb.inc(1);
        // Per-player tick so the GUI log streams progress like the other tools.
        reporter.progress(
            completed as u64,
            total as u64,
            format!("Checked {} / {} players", completed, total),
        );
    }

    for handle in handles {
        let _ = handle.join();
    }

    pb.finish_and_clear();
    if aborted {
        // Surface as an error so the wizard step does not mark itself complete.
        reporter.error(format!(
            "Stopped after {} consecutive errors — {} updated, {} not found, {} error(s) so far. \
             Try again later, or run `chess-db players normalise` from the command line.",
            error_threshold, updated, not_found, errors,
        ));
    } else {
        reporter.done(format!(
            "Normalised {} player(s): {} updated, {} not found, {} error(s).",
            completed, updated, not_found, errors,
        ));
    }
    Ok(())
}

// ── Apply a canonical name (shared by the cache pre-pass and the FIDE loop) ────

/// Set a player's canonical name. Returns `true` if the stored name actually
/// changed (vs. already being canonical). Always marks `name_normalised = TRUE`.
/// Honours `dry_run` (no writes). Mirrors the contract in `players::import`.
fn apply_canonical(conn: &Connection, id: u32, current_name: &str, canonical: &str, dry_run: bool) -> bool {
    let changed = current_name != canonical;
    if dry_run {
        return changed;
    }
    if changed {
        let name_normalized = canonical
            .to_lowercase()
            .replace(',', " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let _ = conn.execute(
            "UPDATE players SET name = ?, name_normalized = ?, name_normalised = TRUE WHERE id = ?",
            duckdb::params![canonical, name_normalized, id],
        );
    } else {
        let _ = conn.execute(
            "UPDATE players SET name_normalised = TRUE WHERE id = ?",
            duckdb::params![id],
        );
    }
    changed
}

// ── Batch cache service ────────────────────────────────────────────────────────

/// Resolve the cache service URL + key, or `None` to disable it.
///   URL: `--service-url` flag → compiled-in `NORMALISE_SERVICE_URL`.
///   key: `--service-key` flag → env `CHESSVAULT_NORMALISE_API_KEY` →
///        compile-time `option_env!("CHESSVAULT_NORMALISE_API_KEY")`.
/// The service is enabled only when a non-empty key resolves (the public URL on
/// its own does nothing), so contributor builds without the secret are FIDE-only.
fn resolve_service(service_url: Option<&str>, service_key: Option<&str>, no_service: bool) -> Option<(String, String)> {
    if no_service {
        return None;
    }
    let url = service_url
        .map(|s| s.to_string())
        .unwrap_or_else(|| NORMALISE_SERVICE_URL.to_string());
    let key = service_key
        .map(|s| s.to_string())
        .or_else(|| std::env::var("CHESSVAULT_NORMALISE_API_KEY").ok())
        .or_else(|| option_env!("CHESSVAULT_NORMALISE_API_KEY").map(|s| s.to_string()));
    match key {
        Some(k) if !k.trim().is_empty() && !url.trim().is_empty() => Some((url, k)),
        _ => None,
    }
}

/// POST the FIDE IDs to the cache service (chunked) and merge the returned
/// `fide_id → canonical name` map. Any HTTP/parse error propagates so the caller
/// can fall back to FIDE lookups.
fn fetch_cache_names(
    client: &reqwest::blocking::Client,
    url: &str,
    key: &str,
    fide_ids: &[u32],
) -> Result<HashMap<u32, String>> {
    #[derive(serde::Deserialize)]
    struct Resp {
        // serde_json parses the JSON string keys back into u32.
        names: HashMap<u32, String>,
    }

    let mut out = HashMap::new();
    for chunk in fide_ids.chunks(SERVICE_CHUNK) {
        // reqwest's `json` feature isn't enabled — serialise the body by hand.
        let body = serde_json::to_string(&serde_json::json!({ "fide_ids": chunk }))
            .context("serialise cache request")?;
        let resp = client
            .post(url)
            .header("Authorization", format!("Bearer {}", key))
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .context("cache service request failed")?;
        if !resp.status().is_success() {
            anyhow::bail!("cache service returned HTTP {}", resp.status());
        }
        let text = resp.text().context("read cache response")?;
        let parsed: Resp = serde_json::from_str(&text).context("parse cache response")?;
        out.extend(parsed.names);
    }
    Ok(out)
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

fn build_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) chess-db/0.1")
        .build()
        .context("failed to build HTTP client")
}

fn lookup_name(client: &reqwest::blocking::Client, fide_id: u64) -> Result<Option<String>> {
    let html = client
        .get(format!("{}/incl_search_l.php", RATINGS_BASE))
        .query(&[
            ("search", fide_id.to_string().as_str()),
            ("simple", "1"),
        ])
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Referer", format!("{}/search.phtml", RATINGS_BASE))
        .send()
        .context("FIDE search request failed")?
        .text()
        .context("read FIDE response")?;

    Ok(extract_name_for_id(&html, fide_id))
}

fn extract_name_for_id(html: &str, fide_id: u64) -> Option<String> {
    let row_re    = Regex::new(r"(?s)<tr\b[^>]*>(.*?)</tr>").ok()?;
    let fideid_re = Regex::new(r#"(?s)<td[^>]*data-label="FIDEID"[^>]*>\s*(\d+)\s*</td>"#).ok()?;
    let name_re   = Regex::new(r#"class="found_name"[^>]*>([^<]+)<"#).ok()?;

    for row_cap in row_re.captures_iter(html) {
        let row = &row_cap[1];
        let id: u64 = match fideid_re.captures(row).and_then(|c| c[1].parse().ok()) {
            Some(id) => id,
            None => continue,
        };
        if id != fide_id {
            continue;
        }
        let name = match name_re.captures(row).map(|c| c[1].trim().to_string()) {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        return Some(name);
    }
    None
}
