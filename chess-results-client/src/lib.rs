use anyhow::{Context, Result};
use regex::Regex;

const BASE: &str = "https://chess-results.com";

// ── Types ─────────────────────────────────────────────────────────────────────

pub struct TeamInfo {
    pub num: u32,
    pub name: String,
    pub rtg_avg: Option<u32>,
}

pub struct TeamStanding {
    pub num: u32,
    pub name: String,
    pub rank: u32,
    pub rtg_avg: Option<u32>,
}

pub struct TeamBoardPairing {
    pub board: u32,
    pub home_snr: u32,
    pub home_name: String,
    pub home_rating: Option<i32>,
    pub away_snr: u32,
    pub away_name: String,
    pub away_rating: Option<i32>,
    pub result: Option<String>,
}

pub struct TeamMatchup {
    pub home_team_name: String,
    pub away_team_name: String,
    pub boards: Vec<TeamBoardPairing>,
}

pub struct TeamRoundInfo {
    pub round: u32,
    pub date: Option<String>,
    pub time: Option<String>,
    pub matchups: Vec<TeamMatchup>,
}

pub struct TeamScheduleRound {
    pub round: u32,
    pub date: Option<String>,
    pub time: Option<String>,
    pub is_played: bool,
}

pub struct TournamentPlayer {
    pub snr: u32,
    pub name: String,
    pub rating: Option<i32>,
}

pub struct PlayerTournamentStats {
    pub points: Option<String>,     // e.g. "4.5"
    pub performance: Option<i32>,   // e.g. 1708
    pub games_played: usize,
}

pub struct RoundPairing {
    pub round: u32,
    pub board: u32,
    pub opponent_snr: u32,
    pub opponent_name: String,
    pub opponent_rating: Option<i32>,
    /// "White" or "Black"
    pub my_color: String,
    /// None = not yet played; Some("HP") = bye; Some("1"/"0"/"½") = result
    pub result: Option<String>,
}

/// The detected kind of a tournament.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TournamentKind {
    Individual,
    Team,
}

// ── HTTP client ───────────────────────────────────────────────────────────────

fn build_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) lpdo/0.1")
        .build()
        .context("failed to build HTTP client")
}

fn fetch(id: &str, params: &str) -> Result<String> {
    let client = build_client()?;
    client
        .get(format!("{}/tnr{}.aspx?{}", BASE, id, params))
        .send()
        .context("HTTP request failed")?
        .text()
        .context("read response body")
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Parse tournament ID from a URL or bare ID string.
pub fn parse_tournament_id(input: &str) -> Option<String> {
    let re = Regex::new(r"tnr(\d+)").unwrap();
    if let Some(cap) = re.captures(input) {
        return Some(cap[1].to_string());
    }
    // Accept a bare number
    if input.trim().chars().all(|c| c.is_ascii_digit()) {
        return Some(input.trim().to_string());
    }
    None
}

/// Fetch the tournament name from the starting rank page.
pub fn fetch_tournament_name(id: &str) -> Result<String> {
    let html = fetch(id, "art=0")?;
    Ok(parse_tournament_name(&html))
}

/// Fetch only the participant list from the starting rank page.
pub fn fetch_participant_list(id: &str) -> Result<Vec<TournamentPlayer>> {
    let html = fetch(id, "art=0")?;
    Ok(parse_player_list(&html))
}

/// Fetch the tournament name and the player list from the starting rank page.
pub fn fetch_tournament(id: &str) -> Result<(String, Vec<TournamentPlayer>)> {
    let html = fetch(id, "art=0")?;
    let name = parse_tournament_name(&html);
    let players = parse_player_list(&html);
    Ok((name, players))
}

/// Detect whether a tournament is Individual, Team, or unsupported.
/// Tries art=3 (team round) first; falls back to art=9 (individual pairings).
/// Returns Err if the format cannot be determined.
pub fn detect_tournament_kind(id: &str) -> Result<TournamentKind> {
    // Try team round page — team tournaments have matchup headers with "Bo."
    if let Ok(html) = fetch(id, "art=3&rd=1") {
        if html.contains(r#"class="CRc">Bo.</th>"#) || html.contains("Bo.</th>") {
            return Ok(TournamentKind::Team);
        }
    }
    // Try individual pairings page — individual tournaments have CRg rows with color divs
    if let Ok(html) = fetch(id, "art=9&snr=1") {
        if html.contains("FarbewT") || html.contains("FarbewB") || html.contains("FarBewT") || html.contains("FarBewB") {
            return Ok(TournamentKind::Individual);
        }
        // Also accept if we get a proper player pairing table
        if html.contains(r#"class="CRg"#) && html.contains(r#"class="CRdb""#) {
            return Ok(TournamentKind::Individual);
        }
    }
    anyhow::bail!("Tournament format not supported or could not be detected")
}

/// Fetch all round pairings for a specific player (by their start number).
pub fn fetch_my_pairings(id: &str, my_snr: u32) -> Result<Vec<RoundPairing>> {
    let html = fetch(id, &format!("art=9&snr={}", my_snr))?;
    Ok(parse_my_pairings(&html))
}

/// Fetch date and time for a round from the board pairings page.
/// Returns (date "YYYY-MM-DD", time "HH:MM").
pub fn fetch_round_datetime(id: &str, round: u32) -> (Option<String>, Option<String>) {
    let html = match fetch(id, &format!("art=2&rd={}", round)) {
        Ok(h) => h,
        Err(_) => return (None, None),
    };
    // <h3>Round 3 on 2026/04/10 at 18:15</h3>
    let re = Regex::new(r"Round \d+ on (\d{4}/\d{2}/\d{2}) at (\d{2}:\d{2})").unwrap();
    if let Some(cap) = re.captures(&html) {
        return (Some(cap[1].replace('/', "-")), Some(cap[2].to_string()));
    }
    (None, None)
}

/// Fetch points, performance rating and games played from a player's tournament profile.
pub fn fetch_player_tournament_stats(id: &str, snr: u32) -> PlayerTournamentStats {
    let html = match fetch(id, &format!("art=9&snr={}", snr)) {
        Ok(h) => h,
        Err(_) => return PlayerTournamentStats { points: None, performance: None, games_played: 0 },
    };
    // Info table cells: <td class="CR">Punkte</td><td class="CR">4,5</td>
    let pts_re  = Regex::new(r#"(?i)<td[^>]*class="CR"[^>]*>\s*(?:Punkte|Pts\.?|Points)\s*</td>\s*<td[^>]*class="CR"[^>]*>\s*([^<]+?)\s*</td>"#).unwrap();
    let perf_re = Regex::new(r#"(?i)<td[^>]*class="CR"[^>]*>\s*(?:Eloperformance|Performance[^<]*)\s*</td>\s*<td[^>]*class="CR"[^>]*>\s*(\d+)\s*</td>"#).unwrap();
    let points = pts_re.captures(&html).map(|c| c[1].trim().replace(',', "."));
    let performance = perf_re.captures(&html).and_then(|c| c[1].trim().parse::<i32>().ok());
    let pairings = parse_my_pairings(&html);
    let games_played = pairings.iter().filter(|p| p.result.is_some()).count();
    PlayerTournamentStats { points, performance, games_played }
}

/// Fetch a player's FIDE ID from their individual info page.
pub fn fetch_player_fide_id(id: &str, snr: u32) -> Option<u64> {
    let html = fetch(id, &format!("art=9&snr={}", snr)).ok()?;
    // <tr><td class="CR">Fide-ID</td><td class="CR">1689991</td></tr>
    let re = Regex::new(r#"(?s)Fide-ID</td><td[^>]*>(\d+)</td>"#).unwrap();
    re.captures(&html)
        .and_then(|c| c[1].parse::<u64>().ok())
        .filter(|&fide_id| fide_id > 0)
}

/// Fetch list of teams from team composition page (art=8).
/// Returns empty if tournament is individual (no RtgAvg markers).
pub fn fetch_team_list(id: &str) -> Result<Vec<TeamInfo>> {
    let html = fetch(id, "art=8")?;
    Ok(parse_team_list(&html))
}

/// Fetch team standings: rank (art=46) + EloDS/RtgAvg (art=8) merged by SNo.
pub fn fetch_team_standings(id: &str) -> Vec<TeamStanding> {
    let teams = fetch(id, "art=8").ok()
        .map(|h| parse_team_list(&h))
        .unwrap_or_default();
    let ranks = fetch(id, "art=46").ok()
        .map(|h| parse_team_ranks(&h))
        .unwrap_or_default();
    teams.into_iter().map(|t| {
        let rank = ranks.get(&t.num).copied().unwrap_or(0);
        TeamStanding { num: t.num, name: t.name, rank, rtg_avg: t.rtg_avg }
    }).collect()
}

/// Fetch all board pairings for a specific team round.
pub fn fetch_team_round(id: &str, round: u32) -> Result<TeamRoundInfo> {
    let html = fetch(id, &format!("art=3&rd={}", round))?;
    Ok(parse_team_round(&html, round))
}

/// Fetch the team schedule (round dates + played status).
pub fn fetch_team_schedule(id: &str) -> Result<Vec<TeamScheduleRound>> {
    let html = fetch(id, "art=2")?;
    Ok(parse_team_schedule(&html))
}

// ── Parsers ───────────────────────────────────────────────────────────────────

fn parse_tournament_name(html: &str) -> String {
    // <h2>58. Clubmeisterschaft des SCDonaustadt 2026 </h2>
    let re = Regex::new(r"<h2>([^<]+)</h2>").unwrap();
    for cap in re.captures_iter(html) {
        let name = cap[1].trim().to_string();
        if !name.is_empty() && name.len() > 5 {
            return name;
        }
    }
    String::from("Unknown tournament")
}

fn parse_player_list(html: &str) -> Vec<TournamentPlayer> {
    // Row: <tr class="CRg2 AUT"><td class="CRc">9</td>...<a ...snr=9>Svrcek, Jozef</a>...<td class="CRr">1914</td>
    let row_re = Regex::new(r#"(?s)<tr class="CRg[12][^"]*"[^>]*>(.*?)</tr>"#).unwrap();
    let snr_re = Regex::new(r#"(?:&amp;|[?&])snr=(\d+)"#).unwrap();
    let name_re = Regex::new(r#"(?i)class="CRdb"[^>]*>([^<]+)</a>"#).unwrap();
    let rtg_re = Regex::new(r#"<td class="CRr">(\d+)</td>"#).unwrap();

    let mut players = Vec::new();
    for row_cap in row_re.captures_iter(html) {
        let row = &row_cap[1];
        let snr: u32 = match snr_re.captures(row) {
            Some(c) => match c[1].parse() { Ok(n) => n, Err(_) => continue },
            None => continue,
        };
        let name = match name_re.captures(row) {
            Some(c) => decode_html(c[1].trim()),
            None => continue,
        };
        if name.is_empty() { continue; }
        let rating = rtg_re.captures(row)
            .and_then(|c| c[1].parse::<i32>().ok())
            .filter(|&r| r > 0);
        players.push(TournamentPlayer { snr, name, rating });
    }
    players
}

fn parse_my_pairings(html: &str) -> Vec<RoundPairing> {
    // Row: <tr class="CRg2"><td class="CRc">3</td><td class="CRc">6</td><td class="CRc">28</td>
    //       <td class="CR">ACM</td><td class="CR"><a ...snr=28>Wu, Lucas</a></td>
    //       <td class="CRr">1431</td><td class="CRc">1,5</td>
    //       <td class="CR"><table><tr><td><div class="FarbewT"></div></td><td class="CR"></td></tr></table></td>
    let row_re   = Regex::new(r#"(?s)<tr class="CRg[12]"[^>]*>(.*?)</tr>"#).unwrap();
    // CRc cells that contain only digits (round / board / snr) — excludes "1,5" style points
    let crc_re   = Regex::new(r#"<td class="CRc">(\d+)</td>"#).unwrap();
    let name_re  = Regex::new(r#"(?i)class="CRdb"[^>]*>([^<]+)</a>"#).unwrap();
    let rtg_re   = Regex::new(r#"<td class="CRr">(\d+)</td>"#).unwrap();
    let color_re = Regex::new(r#"class="(Farbe[ws]T)""#).unwrap();
    // Text immediately after the color div closing tag in the result nested table
    let res_re   = Regex::new(r#"(?s)Farbe[ws]T"[^>]*></div></td><td[^>]*>([^<]*)</td>"#).unwrap();

    let mut pairings = Vec::new();
    for row_cap in row_re.captures_iter(html) {
        let row = &row_cap[1];

        // First three digit-only CRc cells are: round, board, opponent_snr
        let crc_vals: Vec<u32> = crc_re.captures_iter(row)
            .filter_map(|c| c[1].parse().ok())
            .collect();
        if crc_vals.len() < 3 { continue; }
        let (round, board, opponent_snr) = (crc_vals[0], crc_vals[1], crc_vals[2]);
        if round == 0 || opponent_snr == 0 { continue; }

        let opponent_name = match name_re.captures(row) {
            Some(c) => decode_html(c[1].trim()),
            None => continue,
        };
        if opponent_name.is_empty() { continue; }

        let opponent_rating = rtg_re.captures(row)
            .and_then(|c| c[1].parse::<i32>().ok())
            .filter(|&r| r > 0);

        let my_color = match color_re.captures(row) {
            Some(c) => if c[1].contains('w') { "White" } else { "Black" }.to_string(),
            None => "?".to_string(),
        };

        let result = res_re.captures(row).map(|c| {
            let r = c[1].trim();
            decode_html(r)
        }).filter(|r| !r.is_empty());

        pairings.push(RoundPairing {
            round, board, opponent_snr, opponent_name, opponent_rating, my_color, result,
        });
    }
    pairings
}

fn parse_team_list(html: &str) -> Vec<TeamInfo> {
    // "6. Sc Donaustadt (RtgAvg:2078 / ..."
    let re = Regex::new(r"(\d+)\.\s+([^(<]+)\(RtgAvg:(\d+)").unwrap();
    re.captures_iter(html)
        .filter_map(|c| {
            let num: u32 = c[1].parse().ok()?;
            let rtg_avg = c[3].parse::<u32>().ok();
            Some(TeamInfo { num, name: decode_html(c[2].trim()), rtg_avg })
        })
        .collect()
}

fn parse_team_ranks(html: &str) -> std::collections::HashMap<u32, u32> {
    // Standings table rows alternate classes CRg1/CRg2.
    // Columns: Rk. | SNo | Team | G | + | = | - | TB1 | TB2 | TB3
    // We take only the FIRST two numeric cells from each row as (rank, sno).
    let row_re  = Regex::new(r#"(?s)<tr class="CRg[12][^"]*"[^>]*>(.*?)</tr>"#).unwrap();
    let cell_re = Regex::new(r#"<td[^>]*>(\d+)</td>"#).unwrap();
    let mut ranks = std::collections::HashMap::new();
    for row_cap in row_re.captures_iter(html) {
        let row = &row_cap[1];
        let nums: Vec<u32> = cell_re.captures_iter(row)
            .filter_map(|c| c[1].parse().ok())
            .collect();
        // First number = rank, second = sno
        if nums.len() >= 2 {
            let (rank, sno) = (nums[0], nums[1]);
            if rank >= 1 && rank <= 99 && sno > 0 {
                ranks.entry(sno).or_insert(rank);
            }
        }
    }
    ranks
}

fn parse_team_schedule(html: &str) -> Vec<TeamScheduleRound> {
    // Round header: "Round N on YYYY/MM/DD at HH:MM"
    let round_re = Regex::new(r"Round (\d+) on (\d{4}/\d{2}/\d{2}) at (\d{2}:\d{2})").unwrap();
    // Match row score cells: <td class="CRc">SCORE</td><td class="CRc">:</td>
    // Played if score cell (before ":") is non-empty
    let score_re = Regex::new(r#"<td class="CRc">([^<]+)</td><td class="CRc">:</td>"#).unwrap();

    let caps: Vec<_> = round_re.captures_iter(html).collect();
    let mut results = Vec::new();

    for (i, cap) in caps.iter().enumerate() {
        let round: u32 = cap[1].parse().unwrap_or(0);
        let date = Some(cap[2].replace('/', "-"));
        let time = Some(cap[3].to_string());

        let start = cap.get(0).unwrap().end();
        let end = if i + 1 < caps.len() {
            caps[i + 1].get(0).unwrap().start()
        } else {
            html.len()
        };

        let section = &html[start..end];
        let is_played = score_re.captures_iter(section)
            .any(|c| !c[1].trim().is_empty());

        results.push(TeamScheduleRound { round, date, time, is_played });
    }
    results
}

fn parse_team_round(html: &str, round: u32) -> TeamRoundInfo {
    let dt_re = Regex::new(r"Round \d+ on (\d{4}/\d{2}/\d{2}) at (\d{2}:\d{2})").unwrap();
    let (date, time) = dt_re.captures(html)
        .map(|c| (Some(c[1].replace('/', "-")), Some(c[2].to_string())))
        .unwrap_or((None, None));

    // Matchup header: Bo. / team_num / HOME_NAME / Rtg / - / team_num / AWAY_NAME / ...
    let hdr_re = Regex::new(
        r#"<th class="CRc">Bo\.</th><th[^>]*>\d+</th><th class="CR">([^<]+)</th>.*?<th class="CRc">-</th><th[^>]*>\d+</th><th class="CR">([^<]+)</th>"#
    ).unwrap();

    let hdr_caps: Vec<_> = hdr_re.captures_iter(html).collect();
    let mut matchups = Vec::new();

    for (i, hdr) in hdr_caps.iter().enumerate() {
        let home_name = decode_html(hdr[1].trim());
        let away_name = decode_html(hdr[2].trim());

        let start = hdr.get(0).unwrap().end();
        let end = if i + 1 < hdr_caps.len() {
            hdr_caps[i + 1].get(0).unwrap().start()
        } else {
            html.len()
        };

        let boards = parse_team_boards(&html[start..end]);
        matchups.push(TeamMatchup { home_team_name: home_name, away_team_name: away_name, boards });
    }

    TeamRoundInfo { round, date, time, matchups }
}

fn parse_team_boards(section: &str) -> Vec<TeamBoardPairing> {
    // Board label: <td class="CRc">MATCH.BOARD</td>
    let label_re = Regex::new(r#"<td class="CRc">\d+\.(\d+)</td>"#).unwrap();
    let snr_re   = Regex::new(r#"(?:&amp;|[?&])snr=(\d+)"#).unwrap();
    let name_re  = Regex::new(r#"(?i)class="CRdb"[^>]*>([^<]+)</a>"#).unwrap();
    let rtg_re   = Regex::new(r#"<td class="CRr">(\d+)</td>"#).unwrap();
    // Result: e.g. "1 - 0", "0 - 1", "½ - ½"
    let res_re   = Regex::new(r#"<td class="CRc">((?:\d|½)\s*-\s*(?:\d|½))</td>"#).unwrap();

    // Collect board label positions to slice the section board-by-board
    let labels: Vec<(usize, u32)> = label_re.captures_iter(section)
        .filter_map(|c| {
            let board: u32 = c[1].parse().ok()?;
            Some((c.get(0).unwrap().start(), board))
        })
        .collect();

    let mut boards = Vec::new();
    for (i, (pos, board)) in labels.iter().enumerate() {
        let end = if i + 1 < labels.len() { labels[i + 1].0 } else { section.len() };
        let chunk = &section[*pos..end];

        let snrs: Vec<u32> = snr_re.captures_iter(chunk)
            .filter_map(|c| c[1].parse().ok())
            .collect();
        let names: Vec<String> = name_re.captures_iter(chunk)
            .map(|c| decode_html(c[1].trim()))
            .collect();
        let rtgs: Vec<Option<i32>> = rtg_re.captures_iter(chunk)
            .map(|c| c[1].parse::<i32>().ok().filter(|&r| r > 0))
            .collect();
        let result = res_re.captures(chunk)
            .map(|c| decode_html(c[1].trim()));

        if snrs.len() < 2 || names.len() < 2 { continue; }

        boards.push(TeamBoardPairing {
            board: *board,
            home_snr: snrs[0],
            home_name: names[0].clone(),
            home_rating: rtgs.get(0).copied().flatten(),
            away_snr: snrs[1],
            away_name: names[1].clone(),
            away_rating: rtgs.get(1).copied().flatten(),
            result,
        });
    }
    boards
}

fn decode_html(s: &str) -> String {
    s.replace("&amp;", "&")
     .replace("&lt;", "<")
     .replace("&gt;", ">")
     .replace("&nbsp;", " ")
     .replace("&frac12;", "½")
     .replace("&uuml;", "ü")
     .replace("&ouml;", "ö")
     .replace("&auml;", "ä")
     .replace("&Ouml;", "Ö")
     .replace("&Uuml;", "Ü")
     .replace("&Auml;", "Ä")
     .replace("&szlig;", "ß")
     .replace('\u{a0}', " ")
     .split_whitespace()
     .collect::<Vec<_>>()
     .join(" ")
}
