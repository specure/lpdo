// Reverse player normalisation: assign FIDE IDs to players FROM their names
// (#152). The forward path (normalise.rs) is fide_id → canonical name; this is
// the opposite — name → fide_id — for FIDE-less sources like Ajedrez (0% FIDE).
//
// Policy (#152): assign a FIDE ID only on a SINGLE EXACT match after canonical
// name normalisation. Ambiguous (several candidate fide_ids) is treated exactly
// like not-found — never guess, because a wrong FIDE ID corrupts stats worse
// than a missing one. Outcomes (matched + unresolved) are recorded in the
// `name_resolution` ledger so the same name isn't re-queried, with `checked_at`
// dating negatives so they can be revisited as FIDE grows.
//
// Phases, cheapest first:
//   1. local   — invert the FIDE IDs already in this DB (no network).
//   2. cache   — the shared lpdo-normalise-service /resolve endpoint.
//   3. fide    — (optional) live FIDE name search for recent-import misses.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use duckdb::Connection;

use crate::reporter::Reporter;

/// Names per `/resolve` request. Mirrors the forward service's chunking.
const RESOLVE_CHUNK: usize = 20_000;

/// A `/resolve` outcome for one name.
#[derive(serde::Deserialize)]
struct ResolveOutcome {
    status: String, // "matched" | "unresolved"
    fide_id: Option<u32>,
}

// Names are compared on the DB's existing `name_normalized` column (computed at
// import: lowercase, commas → spaces, whitespace collapsed). The client sends
// that value to /resolve; the service applies the identical normalization when
// building its reverse index, so keys line up without re-normalizing here.

/// Outcome counts for a reverse-resolution run.
#[derive(Default, Debug, Clone, Copy)]
pub struct ResolveStats {
    /// Distinct names newly resolved to a single fide_id this run.
    pub matched_names: usize,
    /// Player rows that were assigned a fide_id (a name can cover many rows).
    pub assigned_players: usize,
    /// Names checked and left unresolved (none / ambiguous).
    pub unresolved_names: usize,
}

/// Phase 1 — local inversion (no network). A normalized name that maps to
/// exactly one fide_id among the players that ALREADY have a fide_id is assigned
/// to every fide-less player sharing that name. Captures the common case where a
/// pre-2013 Ajedrez player also appears in a modern FIDE-keyed source (TWIC) in
/// the same DB. The newly-assigned rows then share a fide_id with the original,
/// which `dedup_players` later merges.
pub fn resolve_local(conn: &Connection, reporter: &Reporter) -> Result<ResolveStats> {
    // Record single-exact matches into the ledger (idempotent). Local inversion
    // only ever adds positives — a name that's ambiguous *here* may still resolve
    // via the shared cache, so we don't write a local negative.
    let matched_names = conn.execute(
        "INSERT OR REPLACE INTO name_resolution (name_normalized, fide_id, source, checked_at)
         SELECT name_normalized, MIN(fide_id), 'local', CURRENT_DATE
         FROM players
         WHERE fide_id IS NOT NULL AND name_normalized <> ''
         GROUP BY name_normalized
         HAVING COUNT(DISTINCT fide_id) = 1",
        [],
    )?;

    // Assign to fide-less players from the ledger's positive entries. Reset
    // name_normalised so the forward `normalise` then canonicalises the name.
    let assigned_players = conn.execute(
        "UPDATE players
         SET fide_id = nr.fide_id, name_normalised = FALSE
         FROM name_resolution nr
         WHERE players.name_normalized = nr.name_normalized
           AND players.fide_id IS NULL
           AND nr.fide_id IS NOT NULL",
        [],
    )?;

    let stats = ResolveStats { matched_names, assigned_players, unresolved_names: 0 };
    reporter.log(format!(
        "Local inversion: {} name(s) uniquely resolvable → {} player row(s) assigned a FIDE ID.",
        matched_names, assigned_players,
    ));
    Ok(stats)
}

/// How many players still lack a fide_id (the reverse-resolution backlog).
pub fn pending_count(conn: &Connection) -> Result<usize> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM players WHERE fide_id IS NULL AND name_normalized <> ''",
        [],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

/// Phase 2 — shared-cache inversion via the lpdo-normalise-service `/resolve`
/// endpoint. Sends the distinct normalized names of still-FIDE-less players that
/// we haven't already recorded a fresh answer for, and records each outcome in
/// the ledger (matched → assign; unresolved → negative cache). `service` is the
/// (base_url, key) from `resolve_service`; the `/resolve` path is derived from it.
fn resolve_via_cache(
    conn: &Connection,
    service: &(String, String),
    dry_run: bool,
    reporter: &Reporter,
) -> Result<ResolveStats> {
    // Distinct FIDE-less names with no fresh ledger answer yet. A prior negative
    // (unresolved) is re-tried only if it predates the staleness window, so names
    // added to FIDE later still get picked up (#152).
    let names: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT p.name_normalized
             FROM players p
             LEFT JOIN name_resolution nr ON nr.name_normalized = p.name_normalized
             WHERE p.fide_id IS NULL AND p.name_normalized <> ''
               AND (nr.name_normalized IS NULL
                    OR (nr.fide_id IS NULL AND nr.checked_at < CURRENT_DATE - INTERVAL 90 DAY))",
        )?;
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect()
    };
    if names.is_empty() {
        return Ok(ResolveStats::default());
    }

    let (url, key) = service;
    let resolve_url = derive_resolve_url(url);
    let client = crate::normalise::build_client()?;
    reporter.log(format!(
        "Querying the shared cache for {} unresolved name(s)…",
        names.len()
    ));

    let mut stats = ResolveStats::default();
    for chunk in names.chunks(RESOLVE_CHUNK) {
        let outcomes = resolve_chunk(&client, &resolve_url, key, chunk)
            .context("cache /resolve request failed")?;
        for name in chunk {
            match outcomes.get(name) {
                Some(o) if o.status == "matched" && o.fide_id.is_some() => {
                    let fide_id = o.fide_id.unwrap();
                    stats.matched_names += 1;
                    if !dry_run {
                        record_resolution(conn, name, Some(fide_id), "cache")?;
                        stats.assigned_players += assign_name(conn, name, fide_id)?;
                    }
                }
                _ => {
                    stats.unresolved_names += 1;
                    if !dry_run {
                        record_resolution(conn, name, None, "cache")?;
                    }
                }
            }
        }
    }
    reporter.log(format!(
        "Cache: {} name(s) resolved → {} player row(s) assigned; {} left unresolved.",
        stats.matched_names, stats.assigned_players, stats.unresolved_names,
    ));
    Ok(stats)
}

/// POST one batch of names to `/resolve`; returns each name's outcome.
fn resolve_chunk(
    client: &reqwest::blocking::Client,
    url: &str,
    key: &str,
    names: &[String],
) -> Result<HashMap<String, ResolveOutcome>> {
    #[derive(serde::Deserialize)]
    struct Resp {
        resolved: HashMap<String, ResolveOutcome>,
    }
    let body = serde_json::to_string(&serde_json::json!({ "names": names }))
        .context("serialise resolve request")?;
    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .context("resolve request failed")?;
    if !resp.status().is_success() {
        anyhow::bail!("resolve service returned HTTP {}", resp.status());
    }
    let text = resp.text().context("read resolve response")?;
    let parsed: Resp = serde_json::from_str(&text).context("parse resolve response")?;
    Ok(parsed.resolved)
}

/// The forward URL ends in `/normalise`; the reverse endpoint is `/resolve` on
/// the same host. Swap the trailing path segment.
fn derive_resolve_url(normalise_url: &str) -> String {
    match normalise_url.rsplit_once('/') {
        Some((base, _)) => format!("{base}/resolve"),
        None => "https://normalise.lpdo.com/resolve".to_string(),
    }
}

/// Upsert a ledger entry: matched (`Some(fide_id)`) or negative (`None`).
fn record_resolution(conn: &Connection, name: &str, fide_id: Option<u32>, source: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO name_resolution (name_normalized, fide_id, source, checked_at)
         VALUES (?, ?, ?, CURRENT_DATE)",
        duckdb::params![name, fide_id, source],
    )?;
    Ok(())
}

/// Assign `fide_id` to every still-FIDE-less player with this normalized name.
/// Returns the number of player rows updated.
fn assign_name(conn: &Connection, name: &str, fide_id: u32) -> Result<usize> {
    let n = conn.execute(
        "UPDATE players SET fide_id = ?, name_normalised = FALSE
         WHERE name_normalized = ? AND fide_id IS NULL",
        duckdb::params![fide_id, name],
    )?;
    Ok(n)
}

/// Orchestrate reverse resolution: local inversion first (free), then the shared
/// cache (unless disabled / no key). The optional live-FIDE name search for
/// recent-import misses is a later add-on (#152). Assigned players get
/// `name_normalised = FALSE` so a subsequent forward `normalise` canonicalises
/// their names.
pub fn resolve_fide(
    conn: &Connection,
    dry_run: bool,
    service_url: Option<String>,
    service_key: Option<String>,
    no_service: bool,
    reporter: &Reporter,
) -> Result<ResolveStats> {
    let before = pending_count(conn)?;
    reporter.log(format!("{} player(s) without a FIDE ID.", before));

    let mut total = if dry_run {
        // Dry run: report what local inversion *would* resolve without writing.
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM (
                SELECT name_normalized FROM players
                WHERE fide_id IS NOT NULL AND name_normalized <> ''
                GROUP BY name_normalized HAVING COUNT(DISTINCT fide_id) = 1)",
            [],
            |r| r.get(0),
        )?;
        ResolveStats { matched_names: n as usize, assigned_players: 0, unresolved_names: 0 }
    } else {
        resolve_local(conn, reporter)?
    };

    match crate::normalise::resolve_service(service_url.as_deref(), service_key.as_deref(), no_service) {
        Some(service) => {
            let c = resolve_via_cache(conn, &service, dry_run, reporter)?;
            total.matched_names += c.matched_names;
            total.assigned_players += c.assigned_players;
            total.unresolved_names += c.unresolved_names;
        }
        None => reporter.log("Shared cache disabled (no key / --no-service) — local inversion only."),
    }

    let after = pending_count(conn)?;
    reporter.done(format!(
        "Resolved FIDE IDs: {} name(s) matched, {} player row(s) assigned ({} → {} still without a FIDE ID).",
        total.matched_names, total.assigned_players, before, after,
    ));
    Ok(total)
}

/// Export the resolution ledger (#152) — the accumulated name → outcome answers,
/// INCLUDING negatives — so the work is shareable across clients/runs and the
/// same name isn't re-queried. Columns: name_normalized, fide_id (empty =
/// unresolved), source, checked_at. Returns the row count.
pub fn export_resolutions(conn: &Connection, path: &Path) -> Result<usize> {
    let rows: Vec<(String, Option<u32>, Option<String>, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT name_normalized, fide_id, source, CAST(checked_at AS VARCHAR)
             FROM name_resolution ORDER BY name_normalized",
        )?;
        stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .filter_map(|r| r.ok())
        .collect()
    };
    let mut wtr = csv::Writer::from_path(path)
        .with_context(|| format!("cannot write {}", path.display()))?;
    wtr.write_record(["name_normalized", "fide_id", "source", "checked_at"])?;
    for (name, fide_id, source, checked) in &rows {
        wtr.write_record([
            name.as_str(),
            &fide_id.map(|v| v.to_string()).unwrap_or_default(),
            source.as_deref().unwrap_or(""),
            checked.as_deref().unwrap_or(""),
        ])?;
    }
    wtr.flush()?;
    Ok(rows.len())
}

/// Import a resolution ledger produced by `export_resolutions`. Positive answers
/// win (upsert + assign to matching FIDE-less players); negatives never clobber
/// an existing answer (`DO NOTHING`), so a local match is preserved. After
/// loading, one pass assigns fide_ids to still-FIDE-less players by name.
pub fn import_resolutions(conn: &Connection, path: &Path, reporter: &Reporter) -> Result<()> {
    let mut rdr = csv::Reader::from_path(path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    let mut positives = 0usize;
    let mut negatives = 0usize;
    for rec in rdr.records() {
        let rec = rec.context("CSV parse error")?;
        let name = rec.get(0).unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let fide_id: Option<u32> = rec
            .get(1)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .and_then(|v| v.parse().ok());
        let source = rec.get(2).map(|s| s.trim()).filter(|s| !s.is_empty());
        let checked = rec.get(3).map(|s| s.trim()).filter(|s| !s.is_empty());
        let src = source.unwrap_or("import");
        if let Some(id) = fide_id {
            // Positive: upsert (positives win).
            conn.execute(
                "INSERT INTO name_resolution (name_normalized, fide_id, source, checked_at)
                 VALUES (?, ?, ?, COALESCE(TRY_CAST(? AS DATE), CURRENT_DATE))
                 ON CONFLICT (name_normalized) DO UPDATE SET
                   fide_id = excluded.fide_id, source = excluded.source, checked_at = excluded.checked_at",
                duckdb::params![name, id, src, checked],
            )?;
            positives += 1;
        } else {
            // Negative: don't clobber an existing (possibly positive) answer.
            conn.execute(
                "INSERT INTO name_resolution (name_normalized, fide_id, source, checked_at)
                 VALUES (?, NULL, ?, COALESCE(TRY_CAST(? AS DATE), CURRENT_DATE))
                 ON CONFLICT (name_normalized) DO NOTHING",
                duckdb::params![name, src, checked],
            )?;
            negatives += 1;
        }
    }

    // Assign fide_ids to still-FIDE-less players from the ledger's positives.
    let assigned = conn.execute(
        "UPDATE players SET fide_id = nr.fide_id, name_normalised = FALSE
         FROM name_resolution nr
         WHERE players.name_normalized = nr.name_normalized
           AND players.fide_id IS NULL AND nr.fide_id IS NOT NULL",
        [],
    )?;
    reporter.done(format!(
        "Imported resolution ledger: {} positive, {} negative → {} player row(s) assigned a FIDE ID.",
        positives, negatives, assigned,
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        conn
    }

    #[test]
    fn local_inversion_assigns_single_exact_and_skips_ambiguous() {
        let conn = setup();
        // fide'd rows: Carlsen(1)=100 (unique); Smith(2)=200, Smith(3)=201 (ambiguous).
        // fide-less rows: Carlsen(4), Smith(5), Nobody(6).
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
             (1,'Carlsen, Magnus','carlsen magnus',100,FALSE),
             (2,'Smith, John','smith john',200,FALSE),
             (3,'Smith, John','smith john',201,FALSE),
             (4,'Carlsen, Magnus','carlsen magnus',NULL,FALSE),
             (5,'Smith, John','smith john',NULL,FALSE),
             (6,'Nobody, X','nobody x',NULL,FALSE);",
        )
        .unwrap();

        let stats = resolve_local(&conn, &Reporter::silent()).unwrap();
        assert_eq!(stats.assigned_players, 1, "only the unique Carlsen row is assigned");

        let f = |id: u32| -> Option<u32> {
            conn.query_row("SELECT fide_id FROM players WHERE id=?", duckdb::params![id], |r| r.get(0)).unwrap()
        };
        assert_eq!(f(4), Some(100), "unique-name fide-less player gets the fide_id");
        assert_eq!(f(5), None, "ambiguous name is never guessed");
        assert_eq!(f(6), None, "no fide'd match → unchanged");

        // Ledger recorded the single-exact match (positive), not the ambiguous one.
        let carlsen: Option<u32> = conn
            .query_row("SELECT fide_id FROM name_resolution WHERE name_normalized='carlsen magnus'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(carlsen, Some(100));
        let smith_ct: i64 = conn
            .query_row("SELECT COUNT(*) FROM name_resolution WHERE name_normalized='smith john'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(smith_ct, 0, "ambiguous name not recorded as a local positive");
    }
}
