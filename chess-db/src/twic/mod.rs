pub mod index;

use anyhow::Result;
use duckdb::Connection;
use crate::reporter::Reporter;
use std::path::Path;

pub async fn download(
    conn: &Connection,
    from: u32,
    to: Option<u32>,
    dir: &Path,
    reporter: &Reporter,
) -> Result<()> {
    reporter.log("Fetching TWIC issue list...");
    let range = match index::fetch_issue_range().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!(
                "Warning: could not fetch issue list from theweekinchess.com ({}). \
                 Falling back to defaults (920–1700). Use --from/--to to override.",
                e
            );
            index::IssueRange { first: 920, latest: 1700, published: Vec::new() }
        }
    };

    reporter.log(format!(
        "TWIC archive spans issues {} – {}",
        range.first, range.latest
    ));

    let start = if from <= 1 { range.first } else { from };
    let end = to.unwrap_or(range.latest);

    if start > end {
        reporter.done(format!("Nothing to download (from {} > to {}).", start, end));
        return Ok(());
    }

    reporter.log(format!("Downloading issues {} to {}...", start, end));

    let total = (end - start + 1) as u64;
    let pb = reporter.bar(total);
    let mut completed = 0u64;

    // Register issues in DB
    for issue_id in start..=end {
        let filename = format!("twic{}g.zip", issue_id);
        conn.execute(
            "INSERT INTO issues (id, filename) VALUES (?, ?) ON CONFLICT DO NOTHING",
            duckdb::params![issue_id as i32, filename],
        )
        .ok();
    }

    // Record publication dates for every issue the index lists (not just the
    // requested range) — this also backfills `published_at` on rows imported
    // before we tracked it. No-op for issues not present in the table.
    for (issue_id, date) in &range.published {
        conn.execute(
            "UPDATE issues SET published_at = CAST(? AS DATE) WHERE id = ?",
            duckdb::params![date, *issue_id as i32],
        )
        .ok();
    }

    // Issues we've already imported never need their zip again — the importer
    // only ever processes `downloaded = TRUE AND imported = FALSE`. Skipping them
    // here means a pruned zip cache doesn't trigger a pointless re-download of
    // every past issue (we keep the `downloaded` flag but not the files forever).
    let already_imported: std::collections::HashSet<u32> = {
        let mut stmt = conn.prepare("SELECT id FROM issues WHERE imported = TRUE")?;
        stmt.query_map([], |r| r.get::<_, i32>(0))?
            .filter_map(|r| r.ok())
            .map(|i| i as u32)
            .collect()
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    for issue_id in start..=end {
        // Cooperative cancellation: when run as a server job, the job manager
        // sets this flag; stop cleanly between issues.
        if reporter.is_cancelled() {
            reporter.log("Download cancelled.");
            pb.finish_and_clear();
            return Ok(());
        }

        // Already imported → done; don't re-fetch even if the local zip is gone.
        if already_imported.contains(&issue_id) {
            pb.inc(1);
            completed += 1;
            reporter.progress(completed, total, format!("issue {} (already imported)", issue_id));
            continue;
        }

        let filename = format!("twic{}g.zip", issue_id);
        let dest = dir.join(&filename);

        pb.set_message(format!("issue {}", issue_id));

        // Skip already downloaded
        if dest.exists() {
            conn.execute(
                "UPDATE issues SET downloaded = TRUE, filename = ? WHERE id = ?",
                duckdb::params![filename, issue_id as i32],
            )
            .ok();
            pb.inc(1);
            completed += 1;
            reporter.progress(completed, total, format!("issue {}", issue_id));
            continue;
        }

        let url = format!(
            "https://theweekinchess.com/zips/twic{}g.zip",
            issue_id
        );

        // Each issue is independent: a transient failure (reset connection,
        // truncated body, disk write error) must skip just that issue and move
        // on, never abort the whole multi-hundred-issue run. Failures are
        // logged as warnings — not `reporter.error`, which the GUI treats as a
        // terminal event and would stop the visible download mid-way.
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                Ok(bytes) => match std::fs::write(&dest, &bytes) {
                    Ok(()) => {
                        conn.execute(
                            "UPDATE issues SET downloaded = TRUE, fetched_at = NOW() WHERE id = ?",
                            duckdb::params![issue_id as i32],
                        )
                        .ok();
                    }
                    Err(e) => {
                        let msg = format!("Skipping issue {} (could not save: {})", issue_id, e);
                        pb.println(&msg);
                        reporter.log(&msg);
                    }
                },
                Err(e) => {
                    let msg = format!("Skipping issue {} (download interrupted: {})", issue_id, e);
                    pb.println(&msg);
                    reporter.log(&msg);
                }
            },
            Ok(resp) => {
                let msg = format!("Skipping issue {} (HTTP {})", issue_id, resp.status());
                pb.println(&msg);
                reporter.log(&msg);
            }
            Err(e) => {
                let msg = format!("Skipping issue {} (request failed: {})", issue_id, e);
                pb.println(&msg);
                reporter.log(&msg);
            }
        }

        pb.inc(1);
        completed += 1;
        reporter.progress(completed, total, format!("issue {}", issue_id));
    }

    pb.finish_with_message("Download complete");
    reporter.done("Download complete");
    Ok(())
}
