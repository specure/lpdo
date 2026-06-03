use anyhow::Result;
use regex::Regex;

pub struct IssueRange {
    pub first: u32,
    pub latest: u32,
}

/// Fetch the TWIC index page and return the first and latest available issue numbers.
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

    let re = Regex::new(r"twic(\d+)g\.zip")?;
    let mut issues: Vec<u32> = re
        .captures_iter(&html)
        .filter_map(|c| c[1].parse::<u32>().ok())
        .collect();

    issues.sort_unstable();
    issues.dedup();

    Ok(IssueRange {
        first: issues.first().copied().unwrap_or(920),
        latest: issues.last().copied().unwrap_or(1200),
    })
}
