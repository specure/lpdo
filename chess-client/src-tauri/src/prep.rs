use chess_results_client as cr;
use serde::Serialize;

use crate::shortlist;

// ── Serialisable return types ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct TournamentMeta {
    pub id: String,
    pub name: String,
    pub kind: TournamentKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TournamentKind {
    Individual,
    Team,
}

#[derive(Debug, Serialize)]
pub struct IndividualPrepResult {
    pub round: u32,
    pub datetime: Option<String>,
    pub opponent_name: Option<String>,
    pub opponent_rating: Option<i32>,
    pub opponent_fide_id: Option<u64>,
    pub opponent_snr: Option<u32>,
    pub my_color: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TeamScheduleRoundDto {
    pub round: u32,
    pub date: Option<String>,
    pub time: Option<String>,
    pub is_played: bool,
}

#[derive(Debug, Serialize)]
pub struct TeamPrepResult {
    pub round: u32,
    pub datetime: Option<String>,
    pub my_team: String,
    pub opponent_team: String,
    pub my_team_rank: Option<u32>,
    pub opp_team_rank: Option<u32>,
    pub my_elo_avg: Option<u32>,
    pub opp_elo_avg: Option<u32>,
    pub color: Option<String>,
    pub opponents: Vec<LikelyOpponent>,
}

#[derive(Debug, Serialize)]
pub struct LikelyOpponent {
    pub snr: u32,
    pub name: String,
    pub rating: Option<i32>,
    pub probability: f64,
    pub fide_id: Option<u64>,
    pub tournament_points: Option<String>,
    pub performance: Option<i32>,
}

// ── Private helpers ───────────────────────────────────────────────────────────

fn team_name_matches(stored: &str, search: &str) -> bool {
    let a = stored.to_lowercase();
    let b = search.to_lowercase();
    a.contains(&b) || b.contains(&a)
}

fn team_color(is_home: bool, board: u32, home_black_board1: bool) -> &'static str {
    // home_black_board1: home has Black on odd boards (1, 3, …), White on even boards.
    let home_has_black = if home_black_board1 { board % 2 == 1 } else { board % 2 == 0 };
    match (is_home, home_has_black) {
        (true, true) => "Black",
        (true, false) => "White",
        (false, true) => "White",
        (false, false) => "Black",
    }
}

struct OpponentWeight {
    snr: u32,
    name: String,
    rating: Option<i32>,
    probability: f64,
}

fn compute_opponent_likelihood(
    history: &[cr::TeamRoundInfo],
    opp_team_name: &str,
    my_board: u32,
) -> Vec<OpponentWeight> {
    let mut weights: std::collections::HashMap<u32, (String, Option<i32>, u32)> =
        std::collections::HashMap::new();

    for round in history {
        for matchup in &round.matchups {
            let opp_is_home = team_name_matches(&matchup.home_team_name, opp_team_name);
            let opp_is_away = team_name_matches(&matchup.away_team_name, opp_team_name);
            if !opp_is_home && !opp_is_away {
                continue;
            }
            for board in &matchup.boards {
                let diff = (board.board as i32 - my_board as i32).unsigned_abs();
                let w: u32 = match diff {
                    0 => 2,
                    1 => 1,
                    _ => continue,
                };
                let (snr, name, rating) = if opp_is_home {
                    (board.home_snr, &board.home_name, board.home_rating)
                } else {
                    (board.away_snr, &board.away_name, board.away_rating)
                };
                let entry = weights.entry(snr).or_insert_with(|| (name.clone(), rating, 0));
                entry.2 += w;
            }
        }
    }

    let total: u32 = weights.values().map(|(_, _, w)| w).sum();
    if total == 0 {
        return Vec::new();
    }

    let mut result: Vec<OpponentWeight> = weights
        .into_iter()
        .map(|(snr, (name, rating, weight))| OpponentWeight {
            snr,
            name,
            rating,
            probability: 100.0 * weight as f64 / total as f64,
        })
        .collect();

    result.sort_by(|a, b| b.probability.partial_cmp(&a.probability).unwrap());
    result
}

fn join_datetime(date: Option<String>, time: Option<String>) -> Option<String> {
    match (date, time) {
        (Some(d), Some(t)) => Some(format!("{} {}", d, t)),
        (Some(d), None) => Some(d),
        _ => None,
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ParticipantDto {
    pub snr: u32,
    pub name: String,
    pub rating: Option<i32>,
}

/// Fetch the participant list for an individual tournament.
#[tauri::command]
pub async fn fetch_participant_list(tournament_id: String) -> Result<Vec<ParticipantDto>, String> {
    tokio::task::spawn_blocking(move || {
        let players = cr::fetch_participant_list(&tournament_id).map_err(|e| e.to_string())?;
        Ok(players
            .into_iter()
            .map(|p| ParticipantDto { snr: p.snr, name: p.name, rating: p.rating })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
pub struct TeamDto {
    pub name: String,
    pub rtg_avg: Option<u32>,
}

/// Fetch the list of teams for a team tournament.
#[tauri::command]
pub async fn fetch_team_list(tournament_id: String) -> Result<Vec<TeamDto>, String> {
    tokio::task::spawn_blocking(move || {
        let teams = cr::fetch_team_list(&tournament_id).map_err(|e| e.to_string())?;
        Ok(teams
            .into_iter()
            .map(|t| TeamDto { name: t.name, rtg_avg: t.rtg_avg })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch tournament name and auto-detect type (Individual / Team).
/// Returns an error if the format is not supported.
#[tauri::command]
pub async fn fetch_tournament_meta(url: String) -> Result<TournamentMeta, String> {
    tokio::task::spawn_blocking(move || {
        let id = cr::parse_tournament_id(&url)
            .ok_or_else(|| "Could not parse a tournament ID from the URL".to_string())?;
        let name = cr::fetch_tournament_name(&id).map_err(|e| e.to_string())?;
        let kind = cr::detect_tournament_kind(&id).map_err(|_| {
            "Tournament format not supported. Only standard individual and team tournaments on chess-results.com are supported.".to_string()
        })?;
        let kind = match kind {
            cr::TournamentKind::Individual => TournamentKind::Individual,
            cr::TournamentKind::Team => TournamentKind::Team,
        };
        Ok(TournamentMeta { id, name, kind })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return the full shortlist.
#[tauri::command]
pub async fn get_shortlist(app: tauri::AppHandle) -> Vec<shortlist::ShortlistEntry> {
    shortlist::load(&app)
}

/// Add an individual tournament to the shortlist. Returns the updated list.
#[tauri::command]
pub async fn add_individual_tournament(
    app: tauri::AppHandle,
    url: String,
    tournament_id: String,
    name: String,
    my_snr: u32,
    my_name: String,
    my_fide_id: Option<u64>,
) -> Result<Vec<shortlist::ShortlistEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let mut entries = shortlist::load(&app);
        if entries.iter().any(|e| e.id() == tournament_id) {
            return Err(format!("Tournament {} is already in your shortlist", tournament_id));
        }
        // Fall back to scraping the participant's individual info page if the
        // caller didn't provide a FIDE id. Failure is non-fatal: stored as None.
        let resolved_fide_id = my_fide_id
            .or_else(|| cr::fetch_player_fide_id(&tournament_id, my_snr));
        entries.push(shortlist::ShortlistEntry::Individual {
            id: tournament_id,
            name,
            url,
            my_snr,
            my_name,
            my_fide_id: resolved_fide_id,
        });
        shortlist::save(&app, &entries)?;
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Add a team tournament to the shortlist. Returns the updated list.
#[tauri::command]
pub async fn add_team_tournament(
    app: tauri::AppHandle,
    url: String,
    tournament_id: String,
    name: String,
    my_team_name: String,
    home_black_board1: bool,
) -> Result<Vec<shortlist::ShortlistEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let mut entries = shortlist::load(&app);
        if entries.iter().any(|e| e.id() == tournament_id) {
            return Err(format!("Tournament {} is already in your shortlist", tournament_id));
        }
        entries.push(shortlist::ShortlistEntry::Team {
            id: tournament_id,
            name,
            url,
            my_team_name,
            home_black_board1,
        });
        shortlist::save(&app, &entries)?;
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove a tournament from the shortlist by its ID. Returns the updated list.
#[tauri::command]
pub async fn remove_tournament(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<shortlist::ShortlistEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let mut entries = shortlist::load(&app);
        let before = entries.len();
        entries.retain(|e| e.id() != id);
        if entries.len() == before {
            return Err(format!("Tournament {} not found in shortlist", id));
        }
        shortlist::save(&app, &entries)?;
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch prep data for an individual tournament round.
/// If `round` is None, defaults to the first unplayed round.
#[tauri::command]
pub async fn get_individual_prep(
    app: tauri::AppHandle,
    tournament_id: String,
    round: Option<u32>,
) -> Result<IndividualPrepResult, String> {
    tokio::task::spawn_blocking(move || {
        let entries = shortlist::load(&app);
        let entry = entries
            .iter()
            .find(|e| e.id() == tournament_id)
            .ok_or_else(|| format!("Tournament {} not found in shortlist", tournament_id))?;

        let my_snr = match entry {
            shortlist::ShortlistEntry::Individual { my_snr, .. } => *my_snr,
            _ => return Err("Not an individual tournament".to_string()),
        };

        let pairings =
            cr::fetch_my_pairings(&tournament_id, my_snr).map_err(|e| e.to_string())?;

        let target_round = round.unwrap_or_else(|| {
            pairings
                .iter()
                .find(|p| p.result.is_none())
                .map(|p| p.round)
                .unwrap_or_else(|| pairings.iter().map(|p| p.round).max().unwrap_or(1))
        });

        let pairing = pairings.iter().find(|p| p.round == target_round);

        let (date, time) = cr::fetch_round_datetime(&tournament_id, target_round);
        let datetime = join_datetime(date, time);

        let (opponent_name, opponent_rating, opponent_snr, my_color) = pairing
            .map(|p| {
                (
                    Some(p.opponent_name.clone()),
                    p.opponent_rating,
                    Some(p.opponent_snr),
                    Some(p.my_color.clone()),
                )
            })
            .unwrap_or((None, None, None, None));

        let opponent_fide_id =
            opponent_snr.and_then(|snr| cr::fetch_player_fide_id(&tournament_id, snr));

        Ok(IndividualPrepResult {
            round: target_round,
            datetime,
            opponent_name,
            opponent_rating,
            opponent_fide_id,
            opponent_snr,
            my_color,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch the round schedule for a team tournament (dates + played status).
#[tauri::command]
pub async fn get_team_schedule(
    tournament_id: String,
) -> Result<Vec<TeamScheduleRoundDto>, String> {
    tokio::task::spawn_blocking(move || {
        let rounds =
            cr::fetch_team_schedule(&tournament_id).map_err(|e| e.to_string())?;
        Ok(rounds
            .into_iter()
            .map(|r| TeamScheduleRoundDto {
                round: r.round,
                date: r.date,
                time: r.time,
                is_played: r.is_played,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch board-probability ranked opponent list for a team tournament round.
/// Also fetches tournament stats and FIDE IDs for each likely opponent.
#[tauri::command]
pub async fn get_team_prep(
    app: tauri::AppHandle,
    tournament_id: String,
    round: u32,
    my_board: u32,
) -> Result<TeamPrepResult, String> {
    tokio::task::spawn_blocking(move || {
        let entries = shortlist::load(&app);
        let entry = entries
            .iter()
            .find(|e| e.id() == tournament_id)
            .ok_or_else(|| format!("Tournament {} not found in shortlist", tournament_id))?;

        let (my_team_name, home_black_board1) = match entry {
            shortlist::ShortlistEntry::Team {
                my_team_name,
                home_black_board1,
                ..
            } => (my_team_name.clone(), *home_black_board1),
            _ => return Err("Not a team tournament".to_string()),
        };

        let round_info =
            cr::fetch_team_round(&tournament_id, round).map_err(|e| e.to_string())?;
        let standings = cr::fetch_team_standings(&tournament_id);

        let matchup = round_info
            .matchups
            .iter()
            .find(|m| {
                team_name_matches(&m.home_team_name, &my_team_name)
                    || team_name_matches(&m.away_team_name, &my_team_name)
            })
            .ok_or_else(|| {
                format!(
                    "Could not find team '{}' in round {} pairings",
                    my_team_name, round
                )
            })?;

        let i_am_home = team_name_matches(&matchup.home_team_name, &my_team_name);
        let opp_team_name = if i_am_home {
            matchup.away_team_name.clone()
        } else {
            matchup.home_team_name.clone()
        };

        let find_standing =
            |tname: &str| standings.iter().find(|s| team_name_matches(&s.name, tname));
        let my_standing = find_standing(&my_team_name);
        let opp_standing = find_standing(&opp_team_name);

        let my_team_rank = my_standing.map(|s| s.rank).filter(|&r| r > 0);
        let opp_team_rank = opp_standing.map(|s| s.rank).filter(|&r| r > 0);
        let my_elo_avg = my_standing.and_then(|s| s.rtg_avg);
        let opp_elo_avg = opp_standing.and_then(|s| s.rtg_avg);

        let datetime = join_datetime(round_info.date, round_info.time);
        let color = Some(team_color(i_am_home, my_board, home_black_board1).to_string());

        // Fetch schedule and history for likelihood computation
        let schedule = cr::fetch_team_schedule(&tournament_id).unwrap_or_default();
        let played_rounds: Vec<u32> = schedule
            .iter()
            .filter(|r| r.is_played && r.round < round)
            .map(|r| r.round)
            .collect();

        let mut history = Vec::new();
        for r in &played_rounds {
            if let Ok(ri) = cr::fetch_team_round(&tournament_id, *r) {
                history.push(ri);
            }
        }

        let likelihoods = compute_opponent_likelihood(&history, &opp_team_name, my_board);

        // Fetch tournament stats and FIDE ID per opponent
        let opponents: Vec<LikelyOpponent> = likelihoods
            .into_iter()
            .map(|l| {
                let tstats = cr::fetch_player_tournament_stats(&tournament_id, l.snr);
                let fide_id = cr::fetch_player_fide_id(&tournament_id, l.snr);
                LikelyOpponent {
                    snr: l.snr,
                    name: l.name,
                    rating: l.rating,
                    probability: l.probability,
                    fide_id,
                    tournament_points: tstats.points,
                    performance: tstats.performance,
                }
            })
            .collect();

        Ok(TeamPrepResult {
            round,
            datetime,
            my_team: my_team_name,
            opponent_team: opp_team_name,
            my_team_rank,
            opp_team_rank,
            my_elo_avg,
            opp_elo_avg,
            color,
            opponents,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
