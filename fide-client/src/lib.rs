use anyhow::{Context, Result};
use chrono::Datelike;
use regex::Regex;
use serde::{Deserialize, Serialize};

const RATINGS_BASE: &str = "https://ratings.fide.com";

// ── Recent game from FIDE individual calculations ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentGame {
    pub period: String,
    pub event: Option<String>,
    pub opponent: String,
    pub opponent_rating: Option<i32>,
    /// True when FIDE capped the opponent's rating to 400 points below the player's rating
    #[serde(default)]
    pub opponent_rating_capped: bool,
    /// "W" = player was White, "B" = player was Black
    pub color: String,
    /// "1", "½", "0"
    pub result: String,
    /// "STD", "RPD", "BLZ"
    pub rating_type: String,
}

// ── Cache ─────────────────────────────────────────────────────────────────────
//
// Single per-player JSON file at ~/.local/share/chess/fide_cache/{fide_id}.json
// holding three independently-stamped sections: recent games, player profile,
// and 12-month activity. FIDE rating periods are monthly, so YYYY-MM is the
// natural cache key — values written this calendar month are served from disk
// without hitting ratings.fide.com.
//
// Backwards compatibility: the old cache schema only had `fetched_month` +
// `games`. The new fields use `#[serde(default)]` so old files load cleanly,
// and recent_games keeps its existing on-disk layout untouched.

#[derive(Serialize, Deserialize, Default)]
struct FideCache {
    /// Recent-games cache (legacy layout, flat at the top level).
    #[serde(default)]
    fetched_month: String,
    #[serde(default)]
    games: Vec<RecentGame>,

    /// Player profile cache. `value` is `Option<FidePlayer>` so that
    /// "no player with this FIDE ID" is also remembered for a month.
    #[serde(default)]
    player: Option<MonthlyValue<Option<FidePlayer>>>,

    /// 12-month activity cache.
    #[serde(default)]
    activity: Option<MonthlyValue<ActivitySummary>>,
}

#[derive(Serialize, Deserialize, Clone)]
struct MonthlyValue<T> {
    fetched_month: String,
    value: T,
}

fn current_month() -> String {
    let now = chrono::Local::now();
    format!("{}-{:02}", now.year(), now.month())
}

fn cache_path(fide_id: u64) -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| {
        d.join("chess")
         .join("fide_cache")
         .join(format!("{}.json", fide_id))
    })
}

fn load_cache(fide_id: u64) -> Option<FideCache> {
    let path = cache_path(fide_id)?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_cache(fide_id: u64, cache: &FideCache) {
    if let Some(path) = cache_path(fide_id) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(cache) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// Fetch rated games from the last 3 calendar months from a player's FIDE profile.
/// Returns `(games, is_cached)`. Falls back to disk cache when FIDE is unavailable.
/// Returns `Err` only when both live fetch and cache are unavailable.
pub fn recent_games(fide_id: u64, force_refresh: bool) -> Result<(Vec<RecentGame>, bool)> {
    let cached = load_cache(fide_id);

    if !force_refresh {
        if let Some(ref c) = cached {
            if c.fetched_month == current_month() {
                return Ok((c.games.clone(), true));
            }
        }
    }

    let live = fetch_from_fide(fide_id);
    match live {
        Ok(games) if !games.is_empty() => {
            // Preserve other cached sections (player/activity) when updating games.
            let mut cache = cached.unwrap_or_default();
            cache.fetched_month = current_month();
            cache.games = games.clone();
            save_cache(fide_id, &cache);
            Ok((games, false))
        }
        other => {
            let reason = match other {
                Err(e) => format!("FIDE fetch failed: {}", e),
                _      => "FIDE returned no calculation data".to_string(),
            };
            if let Some(c) = cached {
                eprintln!("  [fide] {} — falling back to {} cached game(s)", reason, c.games.len());
                Ok((c.games.clone(), true))
            } else {
                Err(anyhow::anyhow!("{}", reason))
            }
        }
    }
}

fn fetch_from_fide(fide_id: u64) -> Result<Vec<RecentGame>> {
    let client = build_ratings_client()?;
    let now = chrono::Local::now();

    let mut games: Vec<RecentGame> = Vec::new();
    for months_back in 0..3u32 {
        let m = now - chrono::Months::new(months_back);
        let period_date = format!("{}-{:02}-01", m.year(), m.month());
        let period_label = format!("{}-{:02}", m.year(), m.month());

        for t in 0u8..3 {
            let type_label = match t { 0 => "STD", 1 => "RPD", _ => "BLZ" };
            let url = format!(
                "{}/a_indv_calculations.php?id_number={}&rating_period={}&t={}",
                RATINGS_BASE, fide_id, period_date, t
            );
            let html = match client
                .get(&url)
                .header("X-Requested-With", "XMLHttpRequest")
                .header("Referer", format!("{}/profile/{}", RATINGS_BASE, fide_id))
                .send()
            {
                Ok(r) => match r.text() { Ok(h) => h, Err(_) => continue },
                Err(_) => continue,
            };
            if html.trim().is_empty() { continue; }

            let batch = parse_period_games(&html, &period_label, type_label);
            games.extend(batch);
        }
    }

    // Sort most-recent period first
    games.sort_by(|a, b| b.period.cmp(&a.period));
    Ok(games)
}

/// Parse individual game rows from `a_indv_calculations.php` HTML fragment.
fn parse_period_games(html: &str, period: &str, rating_type: &str) -> Vec<RecentGame> {
    let tag_re   = Regex::new(r"<[^>]+>").unwrap();
    let row_re   = Regex::new(r"(?s)<tr[^>]*bgcolor=#efefef[^>]*>(.*?)</tr>").unwrap();
    let td_re    = Regex::new(r"(?s)<td[^>]*>(.*?)</td>").unwrap();
    let event_re = Regex::new(r#"(?s)rtng_line01[^>]*>.*?href=[^>]+>([^<]+)<"#).unwrap();

    // ── Event positions ──────────────────────────────────────────────────
    let mut event_positions: Vec<(usize, String)> = Vec::new();
    for cap in event_re.captures_iter(html) {
        let name = cap[1].trim().to_string();
        if !name.is_empty() {
            event_positions.push((cap.get(0).unwrap().start(), name));
        }
    }

    // ── Game rows ────────────────────────────────────────────────────────
    let mut games = Vec::new();
    for row_cap in row_re.captures_iter(html) {
        let row_start  = row_cap.get(0).unwrap().start();
        let row_html   = &row_cap[1];

        // Assign event = most recent event block that precedes this row
        let event = event_positions
            .iter()
            .rfind(|(pos, _)| *pos < row_start)
            .map(|(_, n)| n.clone());

        // Extract cells
        let cells: Vec<String> = td_re.captures_iter(row_html)
            .map(|c| decode_cell(&tag_re, &c[1]))
            .collect();

        if cells.len() < 6 { continue; }

        let opponent = cells[0].clone();
        if opponent.is_empty() { continue; }

        // Color: determined by span class in first <td>
        let first_raw = td_re.captures(row_html).map(|c| c[1].to_string()).unwrap_or_default();
        let color = if first_raw.contains("black_note") { "W" }
                    else if first_raw.contains("white_note") { "B" }
                    else { "?" };

        // Rating cell may contain a capped floor value marked with "*" (e.g. "2038 *")
        // when the rating difference exceeds 400 points — take only the first token.
        let rating_cell = cells.get(3).map(|s| s.as_str()).unwrap_or("");
        let rating_capped = rating_cell.contains('*');
        let rating = rating_cell.split_whitespace().next().and_then(|r| r.parse::<i32>().ok());
        let score  = cells.get(5).map(|s| s.trim()).unwrap_or("");
        let result = if score.starts_with("1.0") { "1" }
                     else if score.starts_with("0.5") { "½" }
                     else if score.starts_with("0.0") { "0" }
                     else { continue };   // skip unrated / forfeit rows

        games.push(RecentGame {
            period: period.to_string(),
            event,
            opponent,
            opponent_rating: rating,
            opponent_rating_capped: rating_capped,
            color: color.to_string(),
            result: result.to_string(),
            rating_type: rating_type.to_string(),
        });
    }
    games
}

fn decode_cell(tag_re: &Regex, raw: &str) -> String {
    tag_re.replace_all(raw, "")
        .replace("&nbsp;", " ")
        .replace("&amp;",  "&")
        .replace("&lt;",   "<")
        .replace("&gt;",   ">")
        .replace('\u{a0}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_ratings_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0")
        .build()
        .context("failed to build ratings HTTP client")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FidePlayer {
    #[serde(alias = "fideid")]
    pub fide_id: Option<u64>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub federation: Option<String>,
    #[serde(alias = "rating")]
    pub rating: Option<i32>,
    pub rapid_rating: Option<i32>,
    pub blitz_rating: Option<i32>,
    pub birthyear: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RatingPoint {
    pub period: String,
    pub rating: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActivitySummary {
    pub classical: u32,
    pub rapid: u32,
    pub blitz: u32,
}

impl ActivitySummary {
    pub fn total(&self) -> u32 {
        self.classical + self.rapid + self.blitz
    }
}

/// Fetch game counts per type for the last 12 months from the FIDE chart endpoint.
/// Cached for one calendar month — FIDE updates the chart monthly.
pub fn activity_last_12_months(fide_id: u64) -> Result<ActivitySummary> {
    let cached = load_cache(fide_id);

    if let Some(MonthlyValue { ref fetched_month, ref value }) =
        cached.as_ref().and_then(|c| c.activity.as_ref())
    {
        if fetched_month == &current_month() {
            return Ok(value.clone());
        }
    }

    match fetch_activity_live(fide_id) {
        Ok(summary) => {
            let mut cache = cached.unwrap_or_default();
            cache.activity = Some(MonthlyValue {
                fetched_month: current_month(),
                value: summary.clone(),
            });
            save_cache(fide_id, &cache);
            Ok(summary)
        }
        Err(e) => {
            // Fall back to a stale cached value if FIDE is unavailable.
            if let Some(MonthlyValue { value, .. }) = cached.and_then(|c| c.activity) {
                eprintln!("  [fide] activity fetch failed: {} — falling back to cached value", e);
                Ok(value)
            } else {
                Err(e)
            }
        }
    }
}

fn fetch_activity_live(fide_id: u64) -> Result<ActivitySummary> {
    #[derive(Deserialize)]
    struct Row {
        date_2: String,
        #[serde(default, deserialize_with = "de_u32")]
        period_games: u32,
        #[serde(default, deserialize_with = "de_u32")]
        rapid_games: u32,
        #[serde(default, deserialize_with = "de_u32")]
        blitz_games: u32,
    }

    fn de_u32<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<u32, D::Error> {
        let s: Option<serde_json::Value> = Option::deserialize(d)?;
        Ok(s.and_then(|v| match v {
            serde_json::Value::String(s) => s.parse().ok(),
            serde_json::Value::Number(n) => n.as_u64().map(|x| x as u32),
            _ => None,
        }).unwrap_or(0))
    }

    let cutoff = {
        let now = chrono::Local::now();
        let y = now - chrono::Months::new(12);
        format!("{}-{:02}", y.year(), y.month())
    };

    let client = build_ratings_client()?;
    let rows: Vec<Row> = client
        .post(format!("{}/a_chart_data.phtml?event={}&period=2", RATINGS_BASE, fide_id))
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Referer", format!("{}/profile/{}/chart", RATINGS_BASE, fide_id))
        .send()
        .context("fetch chart data")?
        .json()
        .context("parse chart data")?;

    let mut summary = ActivitySummary::default();
    for row in rows {
        if let Some(ym) = parse_date2_to_ym(&row.date_2) {
            if ym >= cutoff {
                summary.classical += row.period_games;
                summary.rapid    += row.rapid_games;
                summary.blitz    += row.blitz_games;
            }
        }
    }
    Ok(summary)
}

fn parse_date2_to_ym(date2: &str) -> Option<String> {
    let parts: Vec<&str> = date2.splitn(2, '-').collect();
    if parts.len() != 2 { return None; }
    let month_num = match parts[1] {
        "Jan" => "01", "Feb" => "02", "Mar" => "03", "Apr" => "04",
        "May" => "05", "Jun" => "06", "Jul" => "07", "Aug" => "08",
        "Sep" => "09", "Oct" => "10", "Nov" => "11", "Dec" => "12",
        _ => return None,
    };
    Some(format!("{}-{}", parts[0], month_num))
}

pub fn search(name: &str) -> Result<Vec<FidePlayer>> {
    let client = build_ratings_client()?;
    let html = client
        .get(format!("{}/incl_search_l.php", RATINGS_BASE))
        .query(&[("search", name), ("simple", "1")])
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Referer", format!("{}/search.phtml", RATINGS_BASE))
        .send()
        .context("FIDE search request failed")?
        .text()
        .context("read FIDE search response")?;
    Ok(parse_search_results(&html))
}

fn parse_search_results(html: &str) -> Vec<FidePlayer> {
    let row_re    = Regex::new(r"(?s)<tr\b[^>]*>(.*?)</tr>").unwrap();
    let fideid_re = Regex::new(r#"(?s)<td[^>]*data-label="FIDEID"[^>]*>\s*(\d+)\s*</td>"#).unwrap();
    let name_re   = Regex::new(r#"class="found_name"[^>]*>([^<]+)<"#).unwrap();
    let title_re  = Regex::new(r#"(?s)<td[^>]*data-label="title"[^>]*>\s*([A-Z]{2,4})\s*</td>"#).unwrap();
    let fed_re    = Regex::new(r#"alt="([A-Z]{3})""#).unwrap();
    let rtg_re    = Regex::new(r#"(?s)<td[^>]*data-label="Rtg"[^>]*>\s*(\d+)\s*</td>"#).unwrap();
    let byear_re  = Regex::new(r#"(?s)<td[^>]*data-label="B-Year"[^>]*>\s*(\d{4})\s*</td>"#).unwrap();

    let mut players = Vec::new();

    for row_cap in row_re.captures_iter(html) {
        let row = &row_cap[1];

        let fide_id: u64 = match fideid_re.captures(row) {
            Some(c) => match c[1].parse() { Ok(id) => id, Err(_) => continue },
            None => continue,
        };

        let name = match name_re.captures(row) {
            Some(c) => c[1].trim().to_string(),
            None => continue,
        };
        if name.is_empty() { continue; }

        let title      = title_re.captures(row).map(|c| c[1].trim().to_string());
        let federation = fed_re.captures(row).map(|c| c[1].to_string());
        let ratings: Vec<i32> = rtg_re.captures_iter(row)
            .filter_map(|c| c[1].parse::<i32>().ok().filter(|&r| r > 0))
            .collect();
        let rating       = ratings.first().copied();
        let rapid_rating = ratings.get(1).copied();
        let blitz_rating = ratings.get(2).copied();
        let birthyear  = byear_re.captures(row)
            .and_then(|c| c[1].parse::<i32>().ok());

        players.push(FidePlayer {
            fide_id: Some(fide_id),
            name: Some(name),
            title,
            federation,
            rating,
            rapid_rating,
            blitz_rating,
            birthyear,
        });
    }

    players
}

/// Look up a single FIDE player by ID. Cached for one calendar month — FIDE
/// rating periods are monthly so the data is stable until the next update.
/// `None` (player not found) is also remembered so we don't keep retrying.
pub fn player(fide_id: u64) -> Result<Option<FidePlayer>> {
    let cached = load_cache(fide_id);

    if let Some(MonthlyValue { ref fetched_month, ref value }) =
        cached.as_ref().and_then(|c| c.player.as_ref())
    {
        if fetched_month == &current_month() {
            return Ok(value.clone());
        }
    }

    match fetch_player_live(fide_id) {
        Ok(player) => {
            let mut cache = cached.unwrap_or_default();
            cache.player = Some(MonthlyValue {
                fetched_month: current_month(),
                value: player.clone(),
            });
            save_cache(fide_id, &cache);
            Ok(player)
        }
        Err(e) => {
            if let Some(MonthlyValue { value, .. }) = cached.and_then(|c| c.player) {
                eprintln!("  [fide] player lookup failed: {} — falling back to cached value", e);
                Ok(value)
            } else {
                Err(e)
            }
        }
    }
}

fn fetch_player_live(fide_id: u64) -> Result<Option<FidePlayer>> {
    let client = build_ratings_client()?;
    let html = client
        .get(format!("{}/incl_search_l.php", RATINGS_BASE))
        .query(&[("search", fide_id.to_string().as_str()), ("simple", "1")])
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Referer", format!("{}/search.phtml", RATINGS_BASE))
        .send()
        .context("FIDE player lookup request failed")?
        .text()
        .context("read FIDE player lookup response")?;
    Ok(parse_search_results(&html).into_iter().find(|p| p.fide_id == Some(fide_id)))
}

/// Fetch the full standard rating history for a player. Returns one
/// `RatingPoint` per rating period (`YYYY-MM`) in chronological order.
/// Empty if the endpoint declines to return data.
pub fn rating_history(fide_id: u64) -> Result<Vec<RatingPoint>> {
    #[derive(Deserialize)]
    struct Row {
        date_2: String,
        #[serde(default, deserialize_with = "de_rating")]
        rating: i32,
    }
    fn de_rating<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<i32, D::Error> {
        // FIDE serialises rating as a string in this endpoint; sometimes as a
        // number for newer rows. Accept both, treat null/missing as 0.
        let v: Option<serde_json::Value> = Option::deserialize(d)?;
        Ok(v.and_then(|x| match x {
            serde_json::Value::String(s) => s.parse().ok(),
            serde_json::Value::Number(n) => n.as_i64().map(|x| x as i32),
            _ => None,
        }).unwrap_or(0))
    }

    let client = build_ratings_client()?;
    let resp = client
        // period=0 → all of standard-rating history. Same endpoint and headers
        // pattern as `fetch_activity_live`; without the AJAX header the
        // server returns an empty body.
        .post(format!("{}/a_chart_data.phtml?event={}&period=0", RATINGS_BASE, fide_id))
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Referer", format!("{}/profile/{}/chart", RATINGS_BASE, fide_id))
        .send()
        .context("FIDE chart request failed")?;

    if !resp.status().is_success() {
        return Ok(vec![]);
    }
    let rows: Vec<Row> = resp.json().context("parse chart data")?;

    let mut points = Vec::new();
    for row in rows {
        if let Some(period) = parse_date2_to_ym(&row.date_2) {
            if row.rating > 0 {
                points.push(RatingPoint { period, rating: row.rating });
            }
        }
    }
    Ok(points)
}
