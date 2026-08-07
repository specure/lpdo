//! Multi-source import: the curated catalog, the feed runner, and per-database
//! source state (#40).
//!
//! The **catalog** ([`CATALOG`]) is compiled into the binary — it is the list of
//! known sources a user picks from. Each entry carries display metadata plus its
//! *kind*; the acquisition logic for feeds lives in [`Feed`] (enum dispatch, so
//! no `dyn`/`async_trait`). Per-database state — which sources are enabled, their
//! last sync outcome — lives in the `sources` table and is read/written here.
//!
//! A source maps 1:1 to a collection (its [`CatalogSource::collection`]); games
//! it imports are grouped there, so "filter by source" reuses the collection UI.

use std::collections::HashSet;
use std::path::Path;

use anyhow::{anyhow, Result};
use duckdb::Connection;

use crate::reporter::Reporter;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    /// Periodically-published, incremental archive (e.g. TWIC). Schedulable.
    Feed,
    /// One or a few large static files fetched by URL. Constructed in Phase B.
    #[allow(dead_code)]
    Bulk,
}

/// A known source in the curated catalog (compiled in).
pub struct CatalogSource {
    pub key: &'static str,
    pub name: &'static str,
    pub kind: SourceKind,
    pub description: &'static str,
    pub homepage: &'static str,
    /// Attribution shown before the first download.
    pub credit: &'static str,
    /// Collection that games from this source are grouped into (1:1).
    pub collection: &'static str,
    /// Seeded into the `sources` table for a *new* row (existing rows are left
    /// as-is). `default_from`/`default_to` are the initial date window (B1).
    pub default_enabled: bool,
    pub default_from: Option<&'static str>,
    pub default_to: Option<&'static str>,
    pub default_exclude_undated: bool,
    /// Display-only: the approximate date the source's earliest data begins, for
    /// the coverage timeline. Feeds import ALL games (no `default_from` cutoff),
    /// but we still want the bar drawn from ~when the first issue exists rather
    /// than the far left. Falls back to `from_date` in the UI when None.
    pub coverage_from: Option<&'static str>,
}

/// The curated, compiled-in catalog. TWIC (weekly) + Lichess Broadcasts (monthly)
/// are feeds; bulk sources land in Phase B3 (#40).
pub static CATALOG: &[CatalogSource] = &[
    CatalogSource {
        key: "twic",
        name: "The Week in Chess",
        kind: SourceKind::Feed,
        description: "Weekly archive of recent tournament games, published since 1994.",
        homepage: "https://theweekinchess.com/",
        credit: "Games courtesy of Mark Crowther — The Week in Chess (theweekinchess.com).",
        collection: "TWIC",
        // Seeded DISABLED so a fresh install imports nothing until the user picks
        // sources in the setup wizard (#40 C4). Previously enabled-by-default,
        // which made the daemon auto-import TWIC before onboarding — that guard is
        // `default_enabled: false`, NOT the window, so the window below is safe.
        default_enabled: false,
        // No lower bound — take every TWIC game. Its earliest downloadable issue
        // is ~#920 (mid-2012), and a weekly issue can carry games dated to earlier
        // weeks/months (tournaments span time), so any date floor would needlessly
        // throw away the oldest issue's earlier-dated games. Ajedrez still caps at
        // 2012-12-31 (its quality declines after), so ~2012-06 → 2012-12-31 is a
        // deliberate OVERLAP: Ajedrez already holds ~99% of TWIC's games there, but
        // the residual TWIC-only games are worth importing — dedup removes the
        // duplicates. From 2013 on TWIC is the higher-quality half (~99% FIDE-
        // identified, clean names); pre-2013 deep history is Ajedrez's job.
        // (Supersedes the old 2013-01-01 handoff, #148.) Seeds NEW rows only;
        // existing installs keep whatever window they have.
        default_from: None,
        default_to: None,
        default_exclude_undated: false,
        // TWIC's earliest downloadable issue (#920) is ~June 2012.
        coverage_from: Some("2012-06-01"),
    },
    CatalogSource {
        key: "lichess-broadcasts",
        name: "Lichess Broadcasts",
        kind: SourceKind::Feed,
        description: "Over-the-board tournament games relayed live on Lichess, packaged monthly.",
        homepage: "https://database.lichess.org/",
        credit: "Lichess Broadcasts — lichess.org, CC BY-SA 4.0.",
        collection: "Lichess Broadcasts",
        // Off by default. No game-date cutoff — import every broadcast game (a
        // monthly file can carry games dated in an earlier month). Lichess's
        // broadcast archive begins Jan 2020, so that's just where its data starts;
        // overlap with TWIC is auto-deduped. The timeline draws it from Jan 2020
        // via coverage_from below.
        default_enabled: false,
        default_from: None,
        default_to: None,
        default_exclude_undated: false,
        coverage_from: Some("2020-01-01"),
    },
    CatalogSource {
        key: "ajedrez-otb",
        name: "Ajedrez Data — OTB",
        kind: SourceKind::Bulk,
        description: "Free public-domain archive of over-the-board games — the deep historical base (one large download + occasional increments).",
        homepage: "https://ajedrezdata.com/",
        credit: "Ajedrez Data (ajedrezdata.com) — public-domain game scores, distributed without annotations.",
        collection: "Ajedrez OTB",
        // Off by default. The deep-history base — open start (games go back to the
        // 1990s), bounded ABOVE at 2012-12-31 for a clean 2013 quality handoff
        // (#148): pre-2013 is where Ajedrez is the best available source; TWIC takes
        // 2013-01-01 onward with more games at ~99% FIDE + clean names, so we hand
        // off rather than import ~2.3M lower-quality overlapping games. NEW rows only.
        default_enabled: false,
        default_from: None,
        default_to: Some("2012-12-31"),
        default_exclude_undated: false,
        // Deep-history base: drawn from the far left (no coverage_from marker).
        coverage_from: None,
    },
];

pub fn get(key: &str) -> Option<&'static CatalogSource> {
    CATALOG.iter().find(|s| s.key == key)
}

/// An item a feed offers for download (e.g. one TWIC issue).
pub struct FeedItem {
    /// Source-native identifier (a TWIC issue number as a string).
    pub external_id: String,
    /// ISO publication date, if the feed exposes one.
    pub published: Option<String>,
    /// Where to download it from.
    pub url: String,
    /// Local filename to save it as.
    pub filename: String,
    /// Preferred ledger id. TWIC reuses the issue number for back-compat; `None`
    /// makes the runner allocate a synthetic id (>=1e6).
    pub db_id: Option<i32>,
    /// Inclusive ISO date range this item covers, if known (e.g. a Lichess month).
    /// Lets the runner skip downloading a whole file that lies outside the
    /// source's date window. `None` = unknown → always download (TWIC).
    pub covers: Option<(String, String)>,
}

/// Acquisition strategy for a feed source. Enum dispatch keeps it object-safe
/// and dependency-free; add a variant per new feed.
pub enum Feed {
    Twic,
    Lichess,
    Ajedrez,
}

impl Feed {
    pub fn for_key(key: &str) -> Option<Feed> {
        match key {
            "twic" => Some(Feed::Twic),
            "lichess-broadcasts" => Some(Feed::Lichess),
            "ajedrez-otb" => Some(Feed::Ajedrez),
            _ => None,
        }
    }

    /// Enumerate the items the feed currently offers within an optional range
    /// (range semantics are the feed's own; TWIC treats them as issue numbers,
    /// the others ignore them and let the date window select).
    pub async fn list_items(&self, from: Option<u32>, to: Option<u32>) -> Result<Vec<FeedItem>> {
        match self {
            Feed::Twic => crate::twic::list_items(from, to).await,
            Feed::Lichess => crate::lichess::list_items(from, to).await,
            Feed::Ajedrez => crate::ajedrez::list_items(from, to).await,
        }
    }

    /// Download one item to `dest`.
    pub async fn fetch_item(&self, item: &FeedItem, dest: &Path) -> Result<()> {
        match self {
            Feed::Twic => crate::twic::fetch_item(item, dest).await,
            Feed::Lichess => crate::lichess::fetch_item(item, dest).await,
            Feed::Ajedrez => crate::ajedrez::fetch_item(item, dest).await,
        }
    }
}

/// Register an item in the ledger if absent, and keep its publication date current.
fn register_item(conn: &Connection, source_key: &str, item: &FeedItem, next_synth: &mut i32) -> Result<()> {
    // Dedupe on the STABLE (source_key, external_id), not the surrogate id.
    // Bulk sources (e.g. Ajedrez) have no natural db_id, so each run allocates a
    // fresh synthetic id — an `ON CONFLICT (id)` guard never fires, and every
    // re-sync would insert a DUPLICATE row for the same file. Stopping and
    // re-running an import a few times then multiplied the "issues to import"
    // (2 files × 3 runs = 6) and re-imported the same games. Skip a file already
    // registered; only allocate an id for a genuinely new one.
    let already: i64 = conn.query_row(
        "SELECT COUNT(*) FROM source_items WHERE source_key = ? AND external_id = ?",
        duckdb::params![source_key, item.external_id],
        |r| r.get(0),
    )?;
    if already == 0 {
        let id = match item.db_id {
            Some(id) => id,
            None => {
                let id = *next_synth;
                *next_synth += 1;
                id
            }
        };
        conn.execute(
            "INSERT INTO source_items (id, source_key, external_id, filename, published_at)
             VALUES (?, ?, ?, ?, CAST(? AS DATE))
             ON CONFLICT (id) DO NOTHING",
            duckdb::params![id, source_key, item.external_id, item.filename, item.published],
        )?;
    }
    if item.published.is_some() {
        conn.execute(
            "UPDATE source_items SET published_at = CAST(? AS DATE)
             WHERE source_key = ? AND external_id = ?",
            duckdb::params![item.published, source_key, item.external_id],
        )?;
    }
    Ok(())
}

fn mark_downloaded(conn: &Connection, source_key: &str, item: &FeedItem) -> Result<()> {
    conn.execute(
        "UPDATE source_items SET downloaded = TRUE, fetched_at = NOW(), filename = ?
         WHERE source_key = ? AND external_id = ?",
        duckdb::params![item.filename, source_key, item.external_id],
    )?;
    Ok(())
}

/// Download new items for a feed source into `dir`, recording them in the ledger.
/// Mirrors the old `twic::download` loop but source-agnostic: each item is
/// independent, transient fetch failures skip just that item, already-imported
/// items are never re-fetched, and an existing local file is reused.
pub async fn download_feed(
    conn: &Connection,
    src: &CatalogSource,
    from: Option<u32>,
    to: Option<u32>,
    dir: &Path,
    reporter: &Reporter,
) -> Result<()> {
    let feed = Feed::for_key(src.key).ok_or_else(|| anyhow!("'{}' is not a feed source", src.key))?;

    reporter.log(format!("Fetching {} item list…", src.name));
    let mut items = feed.list_items(from, to).await?;

    // Skip downloading whole files that lie entirely outside the source's date
    // window (e.g. Lichess months before `from_date`). Items with no known
    // coverage (TWIC issues) are always kept and filtered per-game at import.
    let win = window(conn, src.key)?;
    if !win.is_unbounded() {
        let before = items.len();
        items.retain(|it| match &it.covers {
            Some((s, e)) => win.overlaps_range(s, e),
            None => true,
        });
        let dropped = before - items.len();
        if dropped > 0 {
            reporter.log(format!("Skipping {dropped} file(s) outside the date window."));
        }
    }

    if items.is_empty() {
        reporter.done("Nothing to download.");
        return Ok(());
    }

    // Items already imported never need their file again.
    let imported: HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT external_id FROM source_items WHERE source_key = ? AND imported = TRUE")?;
        stmt.query_map(duckdb::params![src.key], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect()
    };
    let mut next_synth: i32 = {
        let max_id: Option<i64> = conn
            .query_row("SELECT MAX(id) FROM source_items", [], |r| r.get(0))
            .unwrap_or(None);
        (max_id.unwrap_or(0) as i32).max(1_000_000) + 1
    };

    std::fs::create_dir_all(dir)?;
    let total = items.len() as u64;
    let pb = reporter.bar(total);
    let mut completed = 0u64;

    let client_label = src.name;
    for item in &items {
        if reporter.is_cancelled() {
            reporter.log("Download cancelled.");
            pb.finish_and_clear();
            return Ok(());
        }
        register_item(conn, src.key, item, &mut next_synth)?;

        if imported.contains(&item.external_id) {
            pb.inc(1);
            completed += 1;
            reporter.progress(completed, total, format!("{} (already imported)", item.external_id));
            continue;
        }

        let dest = dir.join(&item.filename);
        if dest.exists() {
            mark_downloaded(conn, src.key, item)?;
            pb.inc(1);
            completed += 1;
            reporter.progress(completed, total, item.external_id.clone());
            continue;
        }

        pb.set_message(item.external_id.clone());
        match feed.fetch_item(item, &dest).await {
            Ok(()) => mark_downloaded(conn, src.key, item)?,
            // A connectivity failure means we're offline — abort so the job runner
            // pauses and retries the whole sync rather than skipping every item and
            // "succeeding" with nothing (#206). Already-downloaded items are kept,
            // so the retry resumes from here.
            Err(e) if crate::net::is_offline_error(&e) => {
                pb.finish_and_clear();
                return Err(e.context("download interrupted — no network connection"));
            }
            // A single item failing for a NON-connectivity reason (a corrupt or
            // missing file) must never abort the whole run; log a warning and skip.
            Err(e) => {
                let msg = format!("Skipping {} {} ({})", client_label, item.external_id, e);
                pb.println(&msg);
                reporter.log(&msg);
            }
        }
        pb.inc(1);
        completed += 1;
        reporter.progress(completed, total, item.external_id.clone());
    }

    pb.finish_with_message("Download complete");
    reporter.done("Download complete");
    Ok(())
}

// ── Per-database source state (the `sources` table) ───────────────────────────

#[derive(serde::Serialize)]
pub struct SourceStatus {
    pub key: String,
    pub name: String,
    pub kind: SourceKind,
    /// Catalog metadata, for the GUI source catalog (Phase C).
    pub description: String,
    pub homepage: String,
    pub credit: String,
    pub collection: String,
    pub enabled: bool,
    pub credit_acked: bool,
    /// Configured game-date window (inclusive ISO bounds; null = unbounded) (B1).
    pub from_date: Option<String>,
    pub to_date: Option<String>,
    pub exclude_undated: bool,
    /// Display-only start for the coverage timeline (catalog `coverage_from`);
    /// null → the UI falls back to `from_date`.
    pub coverage_from: Option<String>,
    pub last_run: Option<String>,
    pub last_status: Option<String>,
    /// Items imported for this source.
    pub items: i64,
    /// Total games imported from this source across all its items (sum of the
    /// per-item counts; pre-dedup). Drives the per-source games metric (#176).
    pub imported_games: i64,
    /// The most recently imported item for this source — the TWIC issue / Lichess
    /// month / Ajedrez part last ingested, with its date and how many games it
    /// brought. Drives the per-source "latest update" home tile (#176).
    pub last_import: Option<LastImport>,
}

/// Summary of the most recent imported item for a source.
#[derive(serde::Serialize)]
pub struct LastImport {
    /// Source-native id: a TWIC issue number, a Lichess `YYYY-MM`, an Ajedrez part.
    pub external_id: String,
    /// The item's own publication date, if the feed exposes one (ISO).
    pub published_at: Option<String>,
    /// When we ingested it (ISO timestamp).
    pub imported_at: Option<String>,
    /// Games this item contributed.
    pub game_count: i64,
}

/// Enabled catalog sources that have a download driver, in catalog order — the
/// sources the update job syncs. (Includes Bulk-kind sources like Ajedrez: the
/// kind is only a UI label for cadence; both kinds use the same machinery.)
pub fn enabled_feeds(conn: &Connection) -> Result<Vec<&'static CatalogSource>> {
    let enabled: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT key FROM sources WHERE enabled = TRUE")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect()
    };
    Ok(CATALOG
        .iter()
        .filter(|s| enabled.contains(s.key) && Feed::for_key(s.key).is_some())
        .collect())
}

/// Enabled sources that have a driver, ordered **deep-history (Bulk) first, then
/// feeds** — the order the wizard's first-run pipeline downloads and imports them
/// (a historical base beneath the live feeds, #40 C4). Same membership as
/// [`enabled_feeds`], just ordered for the pipeline/queue display.
pub fn enabled_sources_ordered(conn: &Connection) -> Result<Vec<&'static CatalogSource>> {
    let mut v = enabled_feeds(conn)?;
    v.sort_by_key(|s| match s.kind {
        SourceKind::Bulk => 0,
        SourceKind::Feed => 1,
    });
    Ok(v)
}

/// Enabled feed sources due for an (initial or periodic) sync: never synced
/// (`last_run IS NULL`) OR last synced before `threshold` (the most recent daily
/// scheduled time). This is the per-source ongoing-refresh model (#160): enabling
/// a source opts it into background refresh; there is no global update toggle.
pub fn feeds_due_for_resync(conn: &Connection, threshold: &str) -> Result<Vec<&'static CatalogSource>> {
    let due: HashSet<String> = {
        let mut stmt = conn.prepare(
            "SELECT key FROM sources
             WHERE enabled = TRUE
               AND (last_run IS NULL OR last_run < CAST(? AS TIMESTAMP))",
        )?;
        stmt.query_map([threshold], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect()
    };
    // Feed-kind only: bulk sources (Ajedrez) are a one-time deep-history import
    // with their own on-demand action (#196), never a recurring subscription, so
    // they must not be picked up by the daily scheduler.
    Ok(CATALOG
        .iter()
        .filter(|s| due.contains(s.key) && s.kind == SourceKind::Feed && Feed::for_key(s.key).is_some())
        .collect())
}

/// Enable or disable a source, creating its state row on first use.
pub fn set_enabled(conn: &Connection, key: &str, enabled: bool) -> Result<()> {
    if get(key).is_none() {
        return Err(anyhow!("unknown source '{}'", key));
    }
    conn.execute(
        "INSERT INTO sources (key, enabled) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled",
        duckdb::params![key, enabled],
    )?;
    Ok(())
}

/// Record that the user acknowledged a source's attribution/license (the
/// one-time gate before enabling it in the GUI, #40 C1).
pub fn acknowledge(conn: &Connection, key: &str) -> Result<()> {
    if get(key).is_none() {
        return Err(anyhow!("unknown source '{}'", key));
    }
    conn.execute(
        "INSERT INTO sources (key, credit_acked) VALUES (?, TRUE)
         ON CONFLICT (key) DO UPDATE SET credit_acked = TRUE",
        duckdb::params![key],
    )?;
    Ok(())
}

/// Record the outcome of a source's sync.
///
/// `last_run` is stamped in LOCAL wall-clock time (bound from Rust), NOT
/// DuckDB's NOW(): the scheduler's daily-refresh threshold is computed in local
/// time (scheduler::most_recent_scheduled), while the bundled DuckDB (no ICU
/// timezone data) evaluates NOW() in UTC. Mixing the two made every feed stay
/// "due" from the scheduled time until UTC caught up with local — on a UTC+2
/// machine the daily update looped back-to-back from 04:00 to 06:00 every day.
pub fn record_run(conn: &Connection, key: &str, status: &str) -> Result<()> {
    let now_local = chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    conn.execute(
        "INSERT INTO sources (key, last_run, last_status)
         VALUES (?, CAST(? AS TIMESTAMP), ?)
         ON CONFLICT (key) DO UPDATE
             SET last_run = excluded.last_run, last_status = excluded.last_status",
        duckdb::params![key, now_local, status],
    )?;
    Ok(())
}

/// Status of every catalog source for display (CLI `sources list`, API).
pub fn list_status(conn: &Connection) -> Result<Vec<SourceStatus>> {
    let mut out = Vec::with_capacity(CATALOG.len());
    for s in CATALOG {
        let win = window(conn, s.key)?;
        let row: Option<(bool, bool, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT enabled, credit_acked, CAST(last_run AS VARCHAR), last_status
                 FROM sources WHERE key = ?",
                duckdb::params![s.key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        let (items, imported_games): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(game_count), 0)
                 FROM source_items WHERE source_key = ? AND imported = TRUE",
                duckdb::params![s.key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or((0, 0));
        // The source's newest DATA — the latest published item (TWIC issue /
        // Lichess month / Ajedrez part). Ordered by publication date, NOT import
        // time: feeds are fetched newest-first, so "most recently imported" would
        // count *backwards* (2026-03 → … → 2020-01) during an initial import and
        // then stick at the oldest month. Falls back to import time / id when a
        // published date is missing.
        let last_import: Option<LastImport> = conn
            .query_row(
                "SELECT external_id, CAST(published_at AS VARCHAR), CAST(imported_at AS VARCHAR),
                        COALESCE(game_count, 0)
                 FROM source_items
                 WHERE source_key = ? AND imported = TRUE
                 ORDER BY published_at DESC NULLS LAST, imported_at DESC NULLS LAST, id DESC
                 LIMIT 1",
                duckdb::params![s.key],
                |r| {
                    Ok(LastImport {
                        external_id: r.get(0)?,
                        published_at: r.get(1)?,
                        imported_at: r.get(2)?,
                        game_count: r.get(3)?,
                    })
                },
            )
            .ok();
        let (enabled, credit_acked, last_run, last_status) =
            row.unwrap_or((false, false, None, None));
        out.push(SourceStatus {
            key: s.key.to_string(),
            name: s.name.to_string(),
            kind: s.kind,
            description: s.description.to_string(),
            homepage: s.homepage.to_string(),
            credit: s.credit.to_string(),
            collection: s.collection.to_string(),
            enabled,
            credit_acked,
            from_date: win.from,
            to_date: win.to,
            exclude_undated: win.exclude_undated,
            coverage_from: s.coverage_from.map(String::from),
            last_run,
            last_status,
            items,
            imported_games,
            last_import,
        });
    }
    Ok(out)
}

// ── Per-source date window (B1) ───────────────────────────────────────────────

/// Inclusive game-date bounds for a source, plus whether undated games are
/// dropped. Bounds are ISO `YYYY-MM-DD` strings; `None` = unbounded.
#[derive(Clone, Default)]
pub struct DateWindow {
    pub from: Option<String>,
    pub to: Option<String>,
    pub exclude_undated: bool,
}

impl DateWindow {
    /// True if this window filters nothing — the importer can skip per-game checks.
    pub fn is_unbounded(&self) -> bool {
        self.from.is_none() && self.to.is_none() && !self.exclude_undated
    }

    /// A plain-English one-liner for progress logs, or None when unbounded. Avoids
    /// the cryptic `…..2024-08-01` an open-ended `{from}..{to}` render produced.
    pub fn describe(&self) -> Option<String> {
        if self.is_unbounded() {
            return None;
        }
        let range = match (self.from.as_deref(), self.to.as_deref()) {
            (Some(f), Some(t)) => format!("games dated {f} to {t}"),
            (Some(f), None) => format!("games dated {f} onward"),
            (None, Some(t)) => format!("games dated up to {t}"),
            // Only reachable via exclude_undated (else is_unbounded caught it).
            (None, None) => "dated games".to_string(),
        };
        Some(if self.exclude_undated {
            format!("{range} (undated games excluded)")
        } else {
            range
        })
    }

    /// Whether the inclusive ISO date range `[start, end]` overlaps this window
    /// at all — used to decide if a whole file is worth downloading.
    pub fn overlaps_range(&self, start: &str, end: &str) -> bool {
        if let Some(f) = &self.from {
            if end < f.as_str() {
                return false;
            }
        }
        if let Some(t) = &self.to {
            if start > t.as_str() {
                return false;
            }
        }
        true
    }

    /// Whether a game with the given PGN date passes the window.
    pub fn admits(&self, date: Option<&str>) -> bool {
        match date_key(date) {
            None => !self.exclude_undated,
            Some(key) => {
                if let Some(f) = &self.from {
                    if key < *f {
                        return false;
                    }
                }
                if let Some(t) = &self.to {
                    if key > *t {
                        return false;
                    }
                }
                true
            }
        }
    }
}

/// Reduce a PGN date to a comparable `YYYY-MM-DD` key, or `None` if no 4-digit
/// year is present (treated as undated). Unknown month/day default to `01` so a
/// partial date sorts to the start of its known period. Tolerates `.` or `-`.
pub fn date_key(date: Option<&str>) -> Option<String> {
    let s = date?.trim().replace('.', "-");
    let b = s.as_bytes();
    if b.len() < 4 || !b[0..4].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let part = |range: std::ops::Range<usize>| -> String {
        match s.get(range) {
            Some(p) if p.len() == 2 && p.bytes().all(|c| c.is_ascii_digit()) && p != "00" => {
                p.to_string()
            }
            _ => "01".to_string(),
        }
    };
    Some(format!("{}-{}-{}", &s[0..4], part(5..7), part(8..10)))
}

/// Read a source's configured date window (unbounded if the row is absent).
pub fn window(conn: &Connection, key: &str) -> Result<DateWindow> {
    Ok(conn
        .query_row(
            "SELECT CAST(from_date AS VARCHAR), CAST(to_date AS VARCHAR), exclude_undated
             FROM sources WHERE key = ?",
            duckdb::params![key],
            |r| {
                Ok(DateWindow {
                    from: r.get::<_, Option<String>>(0)?,
                    to: r.get::<_, Option<String>>(1)?,
                    exclude_undated: r.get::<_, Option<bool>>(2)?.unwrap_or(false),
                })
            },
        )
        .unwrap_or_default())
}

/// Set a source's date window. `from`/`to` of `None` clear that bound.
pub fn set_window(
    conn: &Connection,
    key: &str,
    from: Option<&str>,
    to: Option<&str>,
    exclude_undated: bool,
) -> Result<()> {
    if get(key).is_none() {
        return Err(anyhow!("unknown source '{}'", key));
    }
    conn.execute(
        "INSERT INTO sources (key, from_date, to_date, exclude_undated)
         VALUES (?, CAST(? AS DATE), CAST(? AS DATE), ?)
         ON CONFLICT (key) DO UPDATE SET
           from_date = CAST(excluded.from_date AS DATE),
           to_date = CAST(excluded.to_date AS DATE),
           exclude_undated = excluded.exclude_undated",
        duckdb::params![key, from, to, exclude_undated],
    )?;
    Ok(())
}

#[cfg(test)]
mod window_tests {
    use super::*;

    fn win(from: Option<&str>, to: Option<&str>, excl: bool) -> DateWindow {
        DateWindow { from: from.map(String::from), to: to.map(String::from), exclude_undated: excl }
    }

    #[test]
    fn describe_reads_as_plain_english() {
        assert_eq!(win(None, None, false).describe(), None); // unbounded → nothing
        assert_eq!(win(None, Some("2024-08-01"), false).describe().as_deref(), Some("games dated up to 2024-08-01"));
        assert_eq!(win(Some("2020-01-01"), None, false).describe().as_deref(), Some("games dated 2020-01-01 onward"));
        assert_eq!(win(Some("2020-01-01"), Some("2024-08-01"), false).describe().as_deref(), Some("games dated 2020-01-01 to 2024-08-01"));
        assert_eq!(win(None, Some("2024-08-01"), true).describe().as_deref(), Some("games dated up to 2024-08-01 (undated games excluded)"));
        assert_eq!(win(None, None, true).describe().as_deref(), Some("dated games (undated games excluded)"));
    }

    #[test]
    fn date_key_handles_full_partial_and_undated() {
        assert_eq!(date_key(Some("2025-07-12")).as_deref(), Some("2025-07-12"));
        assert_eq!(date_key(Some("2025.07.12")).as_deref(), Some("2025-07-12")); // dotted
        assert_eq!(date_key(Some("2025-??-??")).as_deref(), Some("2025-01-01")); // year only
        assert_eq!(date_key(Some("2025-07-??")).as_deref(), Some("2025-07-01")); // year+month
        assert_eq!(date_key(Some("2025-00-00")).as_deref(), Some("2025-01-01")); // zero parts
        assert_eq!(date_key(Some("????-??-??")), None);                          // undated
        assert_eq!(date_key(Some("")), None);
        assert_eq!(date_key(None), None);
    }

    #[test]
    fn admits_respects_bounds() {
        let w = DateWindow { from: Some("2026-01-01".into()), to: None, exclude_undated: false };
        assert!(!w.admits(Some("2025-12-31")));
        assert!(w.admits(Some("2026-01-01"))); // inclusive
        assert!(w.admits(Some("2030-05-05")));

        let w = DateWindow { from: None, to: Some("2025-12-31".into()), exclude_undated: false };
        assert!(w.admits(Some("2025-12-31"))); // inclusive
        assert!(!w.admits(Some("2026-01-01")));
        assert!(w.admits(Some("1850-01-01")));

        // Partial 2025 date passes a 2025 cap (treated as 2025-01-01).
        assert!(w.admits(Some("2025-??-??")));
    }

    #[test]
    fn admits_handles_undated_per_flag() {
        let keep = DateWindow { from: Some("2026-01-01".into()), to: None, exclude_undated: false };
        assert!(keep.admits(Some("????-??-??")), "undated kept when not excluded");
        let drop = DateWindow { from: Some("2026-01-01".into()), to: None, exclude_undated: true };
        assert!(!drop.admits(None), "undated dropped when excluded");
    }

    #[test]
    fn unbounded_admits_everything() {
        let w = DateWindow::default();
        assert!(w.is_unbounded());
        assert!(w.admits(Some("1500-01-01")));
        assert!(w.admits(None));
    }
}

#[cfg(test)]
mod register_tests {
    use super::*;
    use duckdb::Connection;

    fn bulk_item(ext: &str) -> FeedItem {
        FeedItem {
            external_id: ext.to_string(),
            published: None,
            url: format!("https://example.test/{ext}.7z"),
            filename: format!("{ext}.7z"),
            db_id: None, // bulk source: synthetic id allocated per run
            covers: None,
        }
    }

    // Re-syncing a bulk source (no natural db_id) must NOT create duplicate
    // source_items rows for the same file. Each run allocated a fresh synthetic
    // id, so the old `ON CONFLICT (id)` guard never fired and stopping/restarting
    // an import multiplied the ledger (2 files × 3 runs = 6) and re-imported the
    // same games.
    #[test]
    fn reregistering_a_bulk_item_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let item = bulk_item("AJ-OTB-PGN-000");

        // Three download passes, each seeding next_synth from MAX(id)+1 like the
        // real runner does.
        for _ in 0..3 {
            let mut next_synth: i32 = {
                let max_id: Option<i64> = conn
                    .query_row("SELECT MAX(id) FROM source_items", [], |r| r.get(0))
                    .unwrap_or(None);
                (max_id.unwrap_or(0) as i32).max(1_000_000) + 1
            };
            register_item(&conn, "ajedrez-otb", &item, &mut next_synth).unwrap();
        }

        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM source_items WHERE source_key = 'ajedrez-otb' AND external_id = 'AJ-OTB-PGN-000'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1, "the same bulk file must register exactly once across re-syncs");
    }

    // #176: list_status surfaces the most recently imported item per source, with
    // its game count — the data the per-source "latest update" home tile shows.
    #[test]
    fn list_status_reports_the_latest_imported_item() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        set_enabled(&conn, "twic", true).unwrap();
        conn.execute_batch(
            "INSERT INTO source_items (id, source_key, external_id, imported, game_count, imported_at, published_at) VALUES
               (1, 'twic', '1648', TRUE,  100, TIMESTAMP '2026-06-08 10:00:00', DATE '2026-06-08'),
               (2, 'twic', '1649', TRUE,  200, TIMESTAMP '2026-06-15 10:00:00', DATE '2026-06-15'),
               -- Newest PUBLISHED but imported EARLIEST (feeds fetch newest-first):
               -- the latest-update tile must show this, not the last-imported one.
               (4, 'twic', '1651', TRUE,  50,  TIMESTAMP '2026-06-01 10:00:00', DATE '2026-06-22'),
               (3, 'twic', '1650', FALSE, 0,   NULL, NULL);",
        )
        .unwrap();

        let twic = list_status(&conn).unwrap().into_iter().find(|s| s.key == "twic").unwrap();
        assert_eq!(twic.items, 3, "only imported items count");
        assert_eq!(twic.imported_games, 350, "sum of imported items' game counts");
        let li = twic.last_import.expect("has a last import");
        assert_eq!(li.external_id, "1651", "newest item by publication date, not import time");
        assert_eq!(li.game_count, 50);
        assert_eq!(li.published_at.as_deref(), Some("2026-06-22"));
    }
}

#[cfg(test)]
mod auto_sync_tests {
    use super::*;
    use duckdb::Connection;

    fn keys(conn: &Connection, threshold: &str) -> Vec<&'static str> {
        feeds_due_for_resync(conn, threshold).unwrap().iter().map(|s| s.key).collect()
    }

    // A completed sync must satisfy the scheduler's LOCAL-time daily threshold
    // immediately. record_run once stamped last_run via DuckDB's NOW() (UTC in
    // the bundled build) while the threshold is local wall-clock — so on a
    // UTC+N machine every feed stayed "due" for N hours past the scheduled
    // time, and the daily update looped back-to-back until UTC caught up.
    #[test]
    fn record_run_satisfies_a_just_passed_local_threshold() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        set_enabled(&conn, "twic", true).unwrap();

        // Threshold = one minute ago in LOCAL time, exactly as the scheduler
        // formats it (most_recent_scheduled + fmt_dt).
        let threshold = (chrono::Local::now().naive_local() - chrono::Duration::minutes(1))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        assert_eq!(keys(&conn, &threshold), vec!["twic"], "never-synced feed is due");

        record_run(&conn, "twic", "ok").unwrap();
        assert!(
            keys(&conn, &threshold).is_empty(),
            "a just-synced feed must not remain due against a local-time threshold"
        );
    }

    // #196: a bulk source (Ajedrez) is a one-shot deep-history import, never a
    // recurring subscription — the daily scheduler must never pick it up, even
    // enabled and never synced.
    #[test]
    fn bulk_sources_are_never_auto_synced() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let future = "2999-01-01 00:00:00";

        set_enabled(&conn, "ajedrez-otb", true).unwrap();
        assert!(keys(&conn, future).is_empty(), "bulk Ajedrez is not a scheduler candidate");

        // A feed enabled alongside it still is.
        set_enabled(&conn, "twic", true).unwrap();
        assert_eq!(keys(&conn, future), vec!["twic"], "feeds still auto-sync; bulk stays excluded");
    }

    #[test]
    fn feeds_due_covers_never_synced_and_stale() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let past = "2000-01-01 00:00:00";
        let future = "2999-01-01 00:00:00";

        // Fresh seed enables nothing (#40 C4), so nothing is due to sync.
        assert!(keys(&conn, future).is_empty(), "fresh install has nothing to auto-sync");

        // Enabling TWIC makes it due immediately (never synced), regardless of the
        // threshold — the initial sync on enable (#160).
        set_enabled(&conn, "twic", true).unwrap();
        assert_eq!(keys(&conn, past), vec!["twic"], "never-synced is always due");

        // After a successful sync it's due again only once the daily scheduled
        // time (the threshold) passes its last_run — the periodic refresh.
        record_run(&conn, "twic", "ok").unwrap();
        assert!(keys(&conn, past).is_empty(), "just-synced is not due yet");
        assert_eq!(keys(&conn, future), vec!["twic"], "due again once the scheduled time passes");

        // A failed/cancelled run also sets last_run, so it isn't retried until the
        // next scheduled time (not immediately).
        record_run(&conn, "twic", "error: boom").unwrap();
        assert!(keys(&conn, past).is_empty(), "errored source not retried before the next scheduled time");

        // Disabled sources are never due, even with the threshold in the future.
        set_enabled(&conn, "twic", false).unwrap();
        assert!(keys(&conn, future).is_empty(), "disabled source never syncs");
    }
}
