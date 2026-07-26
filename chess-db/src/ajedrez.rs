//! Ajedrez Data feed driver (#40 B3). A free, **public-domain** historical
//! over-the-board database published as a base `.7z` plus monthly increments,
//! served over plain HTTP (Contabo S3). We **probe the numbered series**
//! (`AJ-OTB-PGN-000`, `-001`, …) so new increments are picked up without an app
//! update. The `.7z` is decompressed at import (`importer::extract_pgn`).
//!
//! The hardcoded base URL is the bundled-manifest stopgap; resolving current
//! URLs server-side is the job of the manifest service (#94).

use std::io::Write;
use std::path::Path;

use anyhow::Result;

use crate::sources::FeedItem;

/// `{n}` is replaced with the zero-padded part number.
const OTB_URL_TEMPLATE: &str =
    "https://usc1.contabostorage.com/716916dc83654e5eb4d2059cde9bd53d:ajedrez/AJ-OTB-PGN-{n}.7z";
/// Safety cap on the probe (the series is a handful of files).
const MAX_PARTS: u32 = 64;

fn otb_url(n: u32) -> String {
    OTB_URL_TEMPLATE.replace("{n}", &format!("{n:03}"))
}

/// List the OTB `.7z` files that currently exist by probing `000, 001, …` until
/// the first gap. The `from`/`to` issue-number params are unused.
pub async fn list_items(_from: Option<u32>, _to: Option<u32>) -> Result<Vec<FeedItem>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let mut items = Vec::new();
    for n in 0..MAX_PARTS {
        let url = otb_url(n);
        match client.head(&url).send().await {
            Ok(r) if r.status().is_success() => {} // part exists — fall through to push it
            // A real HTTP response that isn't 2xx (e.g. 404) → the series ended.
            Ok(_) => break,
            // Connectivity failure → we're OFFLINE. Propagate rather than treating
            // it as "no more parts" (which would return an empty list and make the
            // sync silently "succeed" with nothing) so the job runner pauses and
            // retries (#206).
            Err(e) if crate::net::is_offline_reqwest(&e) => {
                return Err(anyhow::Error::from(e)
                    .context("checking for Ajedrez parts — no network connection"));
            }
            // Any other transient error → stop the series (conservative, as before).
            Err(_) => break,
        }
        let id = format!("AJ-OTB-PGN-{n:03}");
        items.push(FeedItem {
            external_id: id.clone(),
            published: None,
            url,
            filename: format!("{id}.7z"),
            db_id: None,
            // Per-file date ranges aren't published, so always download and let
            // the per-game date window filter at import.
            covers: None,
        });
    }
    Ok(items)
}

/// Stream one `.7z` to `dest` (these are hundreds of MB — write chunks straight
/// to disk rather than buffering the whole body in memory).
pub async fn fetch_item(item: &FeedItem, dest: &Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()?;
    let mut resp = client.get(&item.url).send().await?.error_for_status()?;
    let mut file = std::fs::File::create(dest)?;
    while let Some(chunk) = resp.chunk().await? {
        file.write_all(&chunk)?;
    }
    Ok(())
}
