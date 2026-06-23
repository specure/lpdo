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
}

/// The curated, compiled-in catalog. Phase A ships TWIC only; bulk sources land
/// in Phase B (#40).
pub static CATALOG: &[CatalogSource] = &[CatalogSource {
    key: "twic",
    name: "The Week in Chess",
    kind: SourceKind::Feed,
    description: "Weekly archive of recent tournament games, published since 1994.",
    homepage: "https://theweekinchess.com/",
    credit: "Games courtesy of Mark Crowther — The Week in Chess (theweekinchess.com).",
    collection: "TWIC",
}];

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
}

/// Acquisition strategy for a feed source. Enum dispatch keeps it object-safe
/// and dependency-free; add a variant per new feed.
pub enum Feed {
    Twic,
}

impl Feed {
    pub fn for_key(key: &str) -> Option<Feed> {
        match key {
            "twic" => Some(Feed::Twic),
            _ => None,
        }
    }

    /// Enumerate the items the feed currently offers within an optional range
    /// (range semantics are the feed's own; TWIC treats them as issue numbers).
    pub async fn list_items(&self, from: Option<u32>, to: Option<u32>) -> Result<Vec<FeedItem>> {
        match self {
            Feed::Twic => crate::twic::list_items(from, to).await,
        }
    }

    /// Download one item to `dest`.
    pub async fn fetch_item(&self, item: &FeedItem, dest: &Path) -> Result<()> {
        match self {
            Feed::Twic => crate::twic::fetch_item(item, dest).await,
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
    let items = feed.list_items(from, to).await?;
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
    pub last_run: Option<String>,
    pub last_status: Option<String>,
    /// Items imported for this source.
    pub items: i64,
}

/// Keys of enabled **feed** sources, in catalog order.
pub fn enabled_feeds(conn: &Connection) -> Result<Vec<&'static CatalogSource>> {
    let enabled: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT key FROM sources WHERE enabled = TRUE")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect()
    };
    Ok(CATALOG
        .iter()
        .filter(|s| s.kind == SourceKind::Feed && enabled.contains(s.key))
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
            last_run,
            last_status,
            items,
        });
    }
    Ok(out)
}
