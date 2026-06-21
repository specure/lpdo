use anyhow::Result;
use regex::Regex;

pub struct IssueRange {
    pub first: u32,
    pub latest: u32,
    /// (issue number, ISO publication date) pairs parsed from the index table,
    /// e.g. (1649, "2026-06-15"). Empty if the table layout couldn't be parsed.
    pub published: Vec<(u32, String)>,
}

/// Fetch the TWIC index page and return the first/latest available issue numbers
/// plus each issue's publication date.
pub async fn fetch_issue_range() -> Result<IssueRange> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let html = client
        .get("https://theweekinchess.com/twic")
        .send()
        .await?
        .text()
        .await?;

    // Issue numbers come from the PGN zip links — authoritative for which issues
    // actually exist to download.
    let re = Regex::new(r"twic(\d+)g\.zip")?;
    let mut issues: Vec<u32> = re
        .captures_iter(&html)
        .filter_map(|c| c[1].parse::<u32>().ok())
        .collect();

    issues.sort_unstable();
    issues.dedup();

    // Publication dates come from the archive table rows, where each issue's
    // number cell is immediately followed by its ISO date cell:
    //   <td>1649</td>
    //   <td>2026-06-15</td>
    let re_pub = Regex::new(r"<td>(\d+)</td>\s*<td>(\d{4}-\d{2}-\d{2})</td>")?;
    let published: Vec<(u32, String)> = re_pub
        .captures_iter(&html)
        .filter_map(|c| Some((c[1].parse::<u32>().ok()?, c[2].to_string())))
        .collect();

    Ok(IssueRange {
        first: issues.first().copied().unwrap_or(920),
        latest: issues.last().copied().unwrap_or(1200),
        published,
    })
}
