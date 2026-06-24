//! TWIC (The Week in Chess) feed driver. The generic download loop and ledger
//! bookkeeping live in `crate::sources`; this module only knows TWIC-specific
//! details: the index page, the zip URL/naming, and issue-number identifiers.

pub mod index;

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;

use crate::sources::FeedItem;

/// List the TWIC issues available to download within `[from, to]` (issue
/// numbers), each with its publication date if the index exposes one. TWIC
/// reuses the issue number as the ledger id for back-compat.
pub async fn list_items(from: Option<u32>, to: Option<u32>) -> Result<Vec<FeedItem>> {
    let range = match index::fetch_issue_range().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!(
                "Warning: could not fetch the TWIC issue list from theweekinchess.com ({}). \
                 Falling back to defaults (920–1700). Use --from/--to to override.",
                e
            );
            index::IssueRange { first: 920, latest: 1700, published: Vec::new() }
        }
    };

    let pub_dates: HashMap<u32, String> = range.published.iter().cloned().collect();

    // from <= 1 means "from the earliest available"; default `to` is the latest.
    let start = match from {
        Some(f) if f > 1 => f,
        _ => range.first,
    };
    let end = to.unwrap_or(range.latest);
    if start > end {
        return Ok(Vec::new());
    }

    let items = (start..=end)
        .map(|issue| FeedItem {
            external_id: issue.to_string(),
            published: pub_dates.get(&issue).cloned(),
            url: format!("https://theweekinchess.com/zips/twic{issue}g.zip"),
            filename: format!("twic{issue}g.zip"),
            db_id: Some(issue as i32),
            // A TWIC issue can carry correction games from older dates, so its
            // coverage isn't a clean range — always download, filter per game.
            covers: None,
        })
        .collect();
    Ok(items)
}

/// Download a single TWIC issue zip to `dest`.
pub async fn fetch_item(item: &FeedItem, dest: &Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let resp = client.get(&item.url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status());
    }
    let bytes = resp.bytes().await?;
    std::fs::write(dest, &bytes)?;
    Ok(())
}
