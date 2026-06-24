//! Lichess Broadcasts feed driver (#40 B2). Monthly `.pgn.zst` files of
//! over-the-board tournament games relayed on Lichess. The generic runner in
//! `crate::sources` handles the download loop and ledger; the `.zst` is
//! decompressed at import time (`importer::extract_pgn`).

use std::path::Path;

use anyhow::Result;

use crate::sources::FeedItem;

const LIST_URL: &str = "https://database.lichess.org/broadcast/list.txt";
const FILE_PREFIX: &str = "lichess_db_broadcast_";
const FILE_SUFFIX: &str = ".pgn.zst";

/// List the available monthly broadcast files. The `from`/`to` issue-number
/// params are unused — month selection is driven by the source's date window in
/// the runner. The index lists full URLs, newest first.
pub async fn list_items(_from: Option<u32>, _to: Option<u32>) -> Result<Vec<FeedItem>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let body = client.get(LIST_URL).send().await?.error_for_status()?.text().await?;

    let mut items = Vec::new();
    for line in body.lines() {
        let url = line.trim();
        if url.is_empty() {
            continue;
        }
        let filename = url.rsplit('/').next().unwrap_or(url).to_string();
        // lichess_db_broadcast_YYYY-MM.pgn.zst → "YYYY-MM"
        let month = match filename.strip_prefix(FILE_PREFIX).and_then(|s| s.strip_suffix(FILE_SUFFIX)) {
            Some(m) if is_month(m) => m.to_string(),
            _ => continue, // ignore counts.txt / sha256sums.txt / unexpected lines
        };
        items.push(FeedItem {
            external_id: month.clone(),
            published: Some(format!("{month}-01")),
            url: url.to_string(),
            filename,
            db_id: None,
            // A month covers [YYYY-MM-01, YYYY-MM-31]; the upper bound is a safe
            // overestimate for the window-overlap check (never wrongly skips).
            covers: Some((format!("{month}-01"), format!("{month}-31"))),
        });
    }
    Ok(items)
}

/// Download one monthly `.pgn.zst` to `dest`.
pub async fn fetch_item(item: &FeedItem, dest: &Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()?;
    let resp = client.get(&item.url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status());
    }
    let bytes = resp.bytes().await?;
    std::fs::write(dest, &bytes)?;
    Ok(())
}

/// True for a `YYYY-MM` string.
fn is_month(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 7
        && b[4] == b'-'
        && b[0..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
}
