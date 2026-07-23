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
        // Complement the Ajedrez deep-history base: by default TWIC contributes
        // only games from 2024-08-01 onward — where Ajedrez's coverage ends — so a
        // fresh install doesn't import ~30 years of games Ajedrez already has (#126).
        // (Files still download: TWIC items expose no coverage range, so they can't
        // be skipped by date — but only in-window games are imported/deduped/
        // indexed, which is the expensive part.) Seeds NEW rows only; existing
        // installs keep whatever window they already have. The wizard may widen
        // this when no deep-history base is chosen (see #127).
        default_from: Some("2024-08-01"),
        default_to: None,
        default_exclude_undated: false,
    },
    CatalogSource {
        key: "lichess-broadcasts",
        name: "Lichess Broadcasts",
        kind: SourceKind::Feed,
        description: "Over-the-board tournament games relayed live on Lichess, packaged monthly.",
        homepage: "https://database.lichess.org/",
        credit: "Lichess Broadcasts — lichess.org, CC BY-SA 4.0.",
        collection: "Lichess Broadcasts",
        // Off by default; live-tail role → from 2026-01-01 (its games only).
        default_enabled: false,
        default_from: Some("2026-01-01"),
        default_to: None,
        default_exclude_undated: false,
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
        // 1990s), but bounded at its known coverage end (~2024-08-01, per the
        // source's own note that it covers games played until August 2024) so TWIC
        // can complement it from there without a large duplicate overlap (#126).
        // Seeds NEW rows only; the partition cap is applied via the wizard/UI.
        default_enabled: false,
        default_from: None,
        default_to: Some("2024-08-01"),
        default_exclude_undated: false,
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
            Err(e) => {
                // One item failing must never abort the whole run; log a warning
                // (not reporter.error, which the GUI treats as terminal).
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
    pub last_run: Option<String>,
    pub last_status: Option<String>,
    /// Items imported for this source.
    pub items: i64,
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

/// Enabled sources that have never recorded a sync run (`last_run IS NULL`) — the
/// ones the scheduler auto-imports in the background once they're enabled (#40
/// C3). A source that synced ok, failed, or was cancelled has `last_run` set, so
/// it is *not* auto-retried (manual "Sync now" stays available); a sync
/// interrupted by a crash/restart never recorded a run, so it resumes.
pub fn auto_sync_candidates(conn: &Connection) -> Result<Vec<&'static CatalogSource>> {
    let pending: HashSet<String> = {
        let mut stmt =
            conn.prepare("SELECT key FROM sources WHERE enabled = TRUE AND last_run IS NULL")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect()
    };
    Ok(CATALOG
        .iter()
        .filter(|s| pending.contains(s.key) && Feed::for_key(s.key).is_some())
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
pub fn record_run(conn: &Connection, key: &str, status: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sources (key, last_run, last_status) VALUES (?, NOW(), ?)
         ON CONFLICT (key) DO UPDATE SET last_run = NOW(), last_status = excluded.last_status",
        duckdb::params![key, status],
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
        let items: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM source_items WHERE source_key = ? AND imported = TRUE",
                duckdb::params![s.key],
                |r| r.get(0),
            )
            .unwrap_or(0);
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
            last_run,
            last_status,
            items,
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
mod auto_sync_tests {
    use super::*;
    use duckdb::Connection;

    fn keys(conn: &Connection) -> Vec<&'static str> {
        auto_sync_candidates(conn).unwrap().iter().map(|s| s.key).collect()
    }

    #[test]
    fn candidates_are_enabled_and_never_run() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();

        // Fresh seed enables nothing now (#40 C4: TWIC seeds disabled), so there
        // are no auto-sync candidates until the user enables a source.
        assert!(keys(&conn).is_empty(), "fresh install has nothing to auto-sync");

        // Enabling TWIC makes it a candidate (enabled, never synced).
        set_enabled(&conn, "twic", true).unwrap();
        assert_eq!(keys(&conn), vec!["twic"], "the enabled, never-synced source");

        // Enabling another joins the set; recording TWIC's run drops it out.
        set_enabled(&conn, "ajedrez-otb", true).unwrap();
        record_run(&conn, "twic", "ok").unwrap();
        assert_eq!(keys(&conn), vec!["ajedrez-otb"], "synced excluded, newly enabled included");

        // A failed (or cancelled) run also sets last_run, so it is NOT
        // auto-retried — manual "Sync now" remains the way to try again.
        record_run(&conn, "ajedrez-otb", "error: boom").unwrap();
        assert!(keys(&conn).is_empty(), "errored source is not auto-retried");

        // Disabled sources are never candidates, even with a NULL last_run.
        set_enabled(&conn, "lichess-broadcasts", false).unwrap();
        assert!(!keys(&conn).contains(&"lichess-broadcasts"));
    }
}
