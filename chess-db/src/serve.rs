use axum::{
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use duckdb::Connection;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::sync::Arc;
use tokio_stream::StreamExt;
use tower_http::cors::CorsLayer;
use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::zobrist::{Zobrist64, ZobristHash};
use shakmaty::{Chess, EnPassantMode, Position};
use anyhow::Result;

use crate::jobs::{ConnActor, JobManager, ReadPool};

type ApiResult<T> = std::result::Result<Json<T>, (StatusCode, String)>;

fn db_err<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

// ── Server state ────────────────────────────────────────────────────────────
//
// The server owns the database read-write. Query handlers read through a pool
// of cloned connections (concurrent under DuckDB MVCC); quick mutations and
// long-running jobs run on a single writer connection so all writes serialize.
// The connection actors live in `crate::jobs`.

#[derive(Clone)]
pub struct AppState {
    /// Pool of read connections for query handlers.
    pub reads: ReadPool,
    /// The single writer connection — quick mutations run here, serialized with
    /// jobs.
    pub writer: ConnActor,
    /// Long-running mutation jobs (import, download, normalise, …).
    pub jobs: Arc<JobManager>,
}

// ── Response types ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct StatusInfo {
    pub issues: i64,
    pub downloaded: i64,
    pub imported: i64,
    pub games: i64,
    pub players: i64,
    pub positions: i64,
    pub deleted_games: i64,
    /// ISO timestamp of the most recently imported TWIC issue, or null if none.
    pub last_twic_imported: Option<String>,
}

#[derive(Serialize)]
pub struct CollectionInfo {
    pub id: i32,
    pub name: String,
    pub game_count: i64,
}

#[derive(Serialize)]
pub struct PlayerInfo {
    pub id: u32,
    pub name: String,
    pub fide_id: Option<u32>,
    pub game_count: i64,
}

#[derive(Serialize)]
pub struct GameSummary {
    pub id: u32,
    pub white: String,
    pub black: String,
    pub white_elo: Option<i16>,
    pub black_elo: Option<i16>,
    pub event: Option<String>,
    pub date: Option<String>,
    pub result: Option<String>,
    pub eco: Option<String>,
    pub move_count: Option<i16>,
    pub opening_line: Option<String>,
    pub visibility: Option<String>,
    /// Soft-delete timestamp; only populated when `include_deleted=true` is requested.
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pgn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub move_number: Option<i16>,
}

#[derive(Serialize)]
pub struct GameDetail {
    pub id: u32,
    pub white: String,
    pub black: String,
    /// Authoritative FIDE IDs from the joined player rows. Prefer these over
    /// the WhiteFideId/BlackFideId tag inside `pgn`, which can carry stale or
    /// sentinel values (e.g. ChessBase's `-1` = unknown).
    pub white_fide_id: Option<u32>,
    pub black_fide_id: Option<u32>,
    pub white_elo: Option<i16>,
    pub black_elo: Option<i16>,
    pub event: Option<String>,
    pub date: Option<String>,
    pub result: Option<String>,
    pub eco: Option<String>,
    pub move_count: Option<i16>,
    pub pgn: Option<String>,
    pub visibility: Option<String>,
    pub collections: Vec<String>,
    /// ISO timestamp when this game was soft-deleted; NULL = alive.
    pub deleted_at: Option<String>,
}


#[derive(Serialize)]
pub struct PositionGame {
    pub id: u32,
    pub white: String,
    pub black: String,
    pub white_elo: Option<i16>,
    pub black_elo: Option<i16>,
    pub event: Option<String>,
    pub date: Option<String>,
    pub result: Option<String>,
    pub move_number: i16,
}

/// Serialisable wrapper around `db::queries::MoveStats` for the REST layer.
#[derive(Serialize)]
pub struct MoveStats {
    pub mv: String,
    pub games: i64,
    pub w_pct: f64,
    pub d_pct: f64,
    pub l_pct: f64,
    pub elo_p25: Option<f64>,
    pub elo_p50: Option<f64>,
    pub elo_p75: Option<f64>,
    pub perf: Option<f64>,
    pub perf_se: Option<f64>,
    pub elite: Option<String>,
    pub last_played: Option<String>,
}

impl From<crate::db::queries::MoveStats> for MoveStats {
    fn from(s: crate::db::queries::MoveStats) -> Self {
        Self {
            mv: s.mv, games: s.games,
            w_pct: s.w_pct, d_pct: s.d_pct, l_pct: s.l_pct,
            elo_p25: s.elo_p25, elo_p50: s.elo_p50, elo_p75: s.elo_p75,
            perf: s.perf, perf_se: s.perf_se, elite: s.elite,
            last_played: s.last_played,
        }
    }
}

#[derive(Serialize)]
pub struct OpeningLine {
    pub line: String,
    pub games: i64,
    pub w_pct: f64,
    pub d_pct: f64,
    pub l_pct: f64,
    pub last_played: Option<String>,
}

#[derive(Serialize)]
pub struct PlayerStats {
    pub total: i64,
    pub as_white: i64,
    pub as_black: i64,
    pub white_w_pct: f64,
    pub white_d_pct: f64,
    pub white_l_pct: f64,
    pub black_w_pct: f64,
    pub black_d_pct: f64,
    pub black_l_pct: f64,
    pub top_openings_white: Vec<OpeningLine>,
    pub top_openings_black: Vec<OpeningLine>,
}

impl From<crate::db::queries::PlayerStats> for PlayerStats {
    fn from(s: crate::db::queries::PlayerStats) -> Self {
        Self {
            total: s.total, as_white: s.as_white, as_black: s.as_black,
            white_w_pct: s.white_w_pct, white_d_pct: s.white_d_pct, white_l_pct: s.white_l_pct,
            black_w_pct: s.black_w_pct, black_d_pct: s.black_d_pct, black_l_pct: s.black_l_pct,
            top_openings_white: s.top_openings_white.into_iter().map(|o| OpeningLine {
                line: o.line, games: o.games, w_pct: o.w_pct, d_pct: o.d_pct,
                l_pct: o.l_pct, last_played: o.last_played,
            }).collect(),
            top_openings_black: s.top_openings_black.into_iter().map(|o| OpeningLine {
                line: o.line, games: o.games, w_pct: o.w_pct, d_pct: o.d_pct,
                l_pct: o.l_pct, last_played: o.last_played,
            }).collect(),
        }
    }
}

// ── Query parameter structs ───────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct PlayersQuery {
    name: Option<String>,
    fide_id: Option<u32>,
}

#[derive(Deserialize, Default)]
struct GamesQuery {
    // player (either color)
    player_id: Option<u32>,
    name: Option<String>,
    fide_id: Option<u32>,
    color: Option<String>,
    opponent: Option<String>,
    // color-specific
    white: Option<String>,
    black: Option<String>,
    white_fide_id: Option<u32>,
    black_fide_id: Option<u32>,
    // metadata filters
    event: Option<String>,
    eco: Option<String>,
    first_moves: Option<String>,
    from: Option<String>,
    to: Option<String>,
    fen: Option<String>,
    // scope filters (grouping)
    collection_id: Option<i32>,
    /// "public" or "private". Applied as `g.source_id IN (SELECT id FROM sources WHERE visibility = ?)`.
    visibility: Option<String>,
    /// Include soft-deleted games in the result (default: false).
    #[serde(default)]
    include_deleted: bool,
    // output options
    #[serde(default)]
    count: bool,
    #[serde(default)]
    pgn: bool,
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}

fn default_limit() -> i64 { 100 }

#[derive(Deserialize, Default)]
struct PositionQuery {
    fen: Option<String>,
    #[serde(default)]
    count: bool,
}

#[derive(Deserialize)]
struct PositionMovesQuery {
    fen: Option<String>,
    first_moves: Option<String>,
    player_id: Option<u32>,
    name: Option<String>,
    fide_id: Option<u32>,
    color: Option<String>,
    white: Option<String>,
    black: Option<String>,
    white_fide_id: Option<u32>,
    black_fide_id: Option<u32>,
    from: Option<String>,
    to: Option<String>,
    /// "public" or "private". Same semantics as on GamesQuery — when set,
    /// restricts the popularity aggregation to games of that visibility.
    visibility: Option<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Normalise a player name for searching against the `name_normalized` column.
/// Matches the normalisation applied at import time: lowercase, commas → space,
/// collapse whitespace. So "Svrcek, Jozef" and "Svrcek Jozef" both become
/// "svrcek jozef" and will match the same rows.
fn normalize_name(name: &str) -> String {
    name.to_lowercase()
        .replace(',', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Strip move numbers from a human-readable move sequence.
/// "1.e4 e6 2.d4 d5" → "e4 e6 d4 d5"
/// "1. e4 e6 2. d4 d5" → "e4 e6 d4 d5"
fn strip_move_numbers(input: &str) -> String {
    input
        .split_whitespace()
        .filter_map(|token| {
            if let Some(dot) = token.find('.') {
                if token[..dot].parse::<u32>().is_ok() {
                    let rest = &token[dot + 1..];
                    return if rest.is_empty() { None } else { Some(rest) };
                }
            }
            Some(token)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Shared query builder ──────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn build_games_sql(
    name: Option<&str>,
    fide_id: Option<u32>,
    player_id: Option<u32>,
    color: Option<&str>,
    opponent: Option<&str>,
    white: Option<&str>,
    black: Option<&str>,
    white_fide_id: Option<u32>,
    black_fide_id: Option<u32>,
    event: Option<&str>,
    eco: Option<&str>,
    first_moves: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    fen_hash: Option<i64>,
    collection_id: Option<i32>,
    visibility: Option<&str>,
    include_deleted: bool,
    include_pgn: bool,
    count: bool,
    limit: i64,
    offset: i64,
) -> (String, Vec<Box<dyn duckdb::ToSql>>) {
    let mut params: Vec<Box<dyn duckdb::ToSql>> = Vec::new();

    let event_filter     = if event.is_some()       { "AND g.event LIKE ?"        } else { "" };
    let eco_filter       = if eco.is_some()          { "AND g.eco LIKE ?"          } else { "" };
    let moves_filter     = if first_moves.is_some()  { "AND g.opening_line LIKE ?" } else { "" };
    let date_from_filter = if from.is_some()         { "AND g.date >= ?"           } else { "" };
    let date_to_filter   = if to.is_some()           { "AND g.date <= ?"           } else { "" };
    let pos_join         = if fen_hash.is_some()     { "JOIN positions pos ON pos.game_id = g.id" } else { "" };
    let fen_filter       = if fen_hash.is_some()     { "AND pos.zobrist_hash = ?"  } else { "" };
    let source_filter     = ""; // legacy; source_id is going away
    let collection_filter = if collection_id.is_some() { "AND EXISTS (SELECT 1 FROM game_collections gc WHERE gc.game_id = g.id AND gc.collection_id = ?)" } else { "" };
    let visibility_filter = if visibility.is_some()    { "AND g.visibility = ?" } else { "" };
    let deleted_filter    = if include_deleted { "" } else { "AND g.deleted_at IS NULL" };
    let pgn_col          = if include_pgn            { ", g.pgn"                   } else { "" };
    let move_num_col     = if fen_hash.is_some()     { ", pos.move_number"         } else { "" };

    let sql = if let Some(pid) = player_id {
        let color_filter = match color.unwrap_or("any") {
            "white" => { params.push(Box::new(pid)); "g.white_id = ?" }
            "black" => { params.push(Box::new(pid)); "g.black_id = ?" }
            _       => { params.push(Box::new(pid)); params.push(Box::new(pid)); "(g.white_id = ? OR g.black_id = ?)" }
        };
        let opponent_filter = if let Some(opp) = opponent {
            let norm = format!("{}%", normalize_name(opp));
            match color.unwrap_or("any") {
                "white" => { params.push(Box::new(norm)); "AND pb.name_normalized LIKE ?" }
                "black" => { params.push(Box::new(norm)); "AND pw.name_normalized LIKE ?" }
                _ => {
                    params.push(Box::new(pid));
                    params.push(Box::new(norm.clone()));
                    params.push(Box::new(pid));
                    params.push(Box::new(norm));
                    "AND ((g.white_id = ? AND pb.name_normalized LIKE ?) OR (g.black_id = ? AND pw.name_normalized LIKE ?))"
                }
            }
        } else { "" };
        if let Some(f) = from  { params.push(Box::new(f.to_string())); }
        if let Some(t) = to    { params.push(Box::new(t.to_string())); }
        if let Some(e) = event { params.push(Box::new(format!("%{}%", e))); }
        if let Some(e) = eco   { params.push(Box::new(format!("{}%", e))); }
        if let Some(fm) = first_moves { params.push(Box::new(format!("{}%", strip_move_numbers(fm)))); }
        // Scope params (must match the SQL placeholder order: source, collection, visibility, fen).
        if let Some(cid) = collection_id { params.push(Box::new(cid)); }
        if let Some(v)   = visibility    { params.push(Box::new(v.to_string())); }
        if let Some(hash) = fen_hash  { params.push(Box::new(hash)); }
        if !count { params.push(Box::new(limit)); params.push(Box::new(offset)); }
        if count {
            return (format!(
                "SELECT COUNT(*) FROM games g
                 JOIN players pw ON g.white_id = pw.id
                 JOIN players pb ON g.black_id = pb.id
                 {pos_join}
                 WHERE {color_filter} {opponent_filter} {date_from_filter} {date_to_filter}
                 {event_filter} {eco_filter} {moves_filter} {source_filter} {collection_filter} {visibility_filter} {deleted_filter} {fen_filter}"
            ), params);
        }
        return (format!(
            "SELECT g.id, pw.name, pb.name, g.white_elo, g.black_elo,
                    g.event, g.date, g.result, g.eco, g.move_count, g.opening_line, g.visibility, CAST(g.deleted_at AS VARCHAR){pgn_col}{move_num_col}
             FROM games g
             JOIN players pw ON g.white_id = pw.id
             JOIN players pb ON g.black_id = pb.id
             {pos_join}
             WHERE {color_filter} {opponent_filter} {date_from_filter} {date_to_filter}
             {event_filter} {eco_filter} {moves_filter} {source_filter} {collection_filter} {visibility_filter} {deleted_filter} {fen_filter}
             ORDER BY g.date DESC NULLS LAST LIMIT ? OFFSET ?"
        ), params);
    } else if name.is_some() || fide_id.is_some() {
        let color_filter = match color.unwrap_or("any") {
            "white" => "AND g.white_id = p.id",
            "black" => "AND g.black_id = p.id",
            _       => "AND (g.white_id = p.id OR g.black_id = p.id)",
        };
        let player_filter = if fide_id.is_some() { "AND p.fide_id = ?" } else { "AND p.name_normalized LIKE ?" };
        if let Some(id) = fide_id {
            params.push(Box::new(id));
        } else {
            params.push(Box::new(format!("{}%", normalize_name(name.unwrap()))));
        }
        if let Some(f) = from        { params.push(Box::new(f.to_string())); }
        if let Some(t) = to          { params.push(Box::new(t.to_string())); }
        if let Some(e) = event       { params.push(Box::new(format!("%{}%", e))); }
        if let Some(e) = eco         { params.push(Box::new(format!("{}%", e))); }
        if let Some(fm) = first_moves { params.push(Box::new(format!("{}%", strip_move_numbers(fm)))); }

        if count {
            format!(
                "SELECT COUNT(*) FROM games g
                 JOIN players p  ON (g.white_id = p.id OR g.black_id = p.id)
                 JOIN players pw ON g.white_id = pw.id
                 JOIN players pb ON g.black_id = pb.id
                 {pos_join}
                 WHERE 1=1 {player_filter} {color_filter}
                 {date_from_filter} {date_to_filter} {event_filter} {eco_filter} {moves_filter} {source_filter} {collection_filter} {visibility_filter} {deleted_filter} {fen_filter}"
            )
        } else {
            format!(
                "SELECT g.id, pw.name, pb.name, g.white_elo, g.black_elo,
                        g.event, g.date, g.result, g.eco, g.move_count, g.opening_line, g.visibility, CAST(g.deleted_at AS VARCHAR){pgn_col}{move_num_col}
                 FROM games g
                 JOIN players p  ON (g.white_id = p.id OR g.black_id = p.id)
                 JOIN players pw ON g.white_id = pw.id
                 JOIN players pb ON g.black_id = pb.id
                 {pos_join}
                 WHERE 1=1 {player_filter} {color_filter}
                 {date_from_filter} {date_to_filter} {event_filter} {eco_filter} {moves_filter} {source_filter} {collection_filter} {visibility_filter} {deleted_filter} {fen_filter}
                 ORDER BY g.date DESC NULLS LAST LIMIT ? OFFSET ?"
            )
        }
    } else {
        let mut conditions: Vec<String> = Vec::new();
        if let Some(id) = white_fide_id {
            conditions.push("pw.fide_id = ?".into());
            params.push(Box::new(id));
        } else if let Some(w) = white {
            conditions.push("pw.name_normalized LIKE ?".into());
            params.push(Box::new(format!("%{}%", normalize_name(w))));
        }
        if let Some(id) = black_fide_id {
            conditions.push("pb.fide_id = ?".into());
            params.push(Box::new(id));
        } else if let Some(b) = black {
            conditions.push("pb.name_normalized LIKE ?".into());
            params.push(Box::new(format!("%{}%", normalize_name(b))));
        }
        if let Some(f) = from        { params.push(Box::new(f.to_string())); }
        if let Some(t) = to          { params.push(Box::new(t.to_string())); }
        if let Some(e) = event       { params.push(Box::new(format!("%{}%", e))); }
        if let Some(e) = eco         { params.push(Box::new(format!("{}%", e))); }
        if let Some(fm) = first_moves { params.push(Box::new(format!("{}%", strip_move_numbers(fm)))); }

        let where_clause = if conditions.is_empty() { "1=1".to_string() } else { conditions.join(" AND ") };

        if count {
            format!(
                "SELECT COUNT(*) FROM games g
                 JOIN players pw ON g.white_id = pw.id
                 JOIN players pb ON g.black_id = pb.id
                 {pos_join}
                 WHERE {where_clause}
                 {date_from_filter} {date_to_filter} {event_filter} {eco_filter} {moves_filter} {source_filter} {collection_filter} {visibility_filter} {deleted_filter} {fen_filter}"
            )
        } else {
            format!(
                "SELECT g.id, pw.name, pb.name, g.white_elo, g.black_elo,
                        g.event, g.date, g.result, g.eco, g.move_count, g.opening_line, g.visibility, CAST(g.deleted_at AS VARCHAR){pgn_col}{move_num_col}
                 FROM games g
                 JOIN players pw ON g.white_id = pw.id
                 JOIN players pb ON g.black_id = pb.id
                 {pos_join}
                 WHERE {where_clause}
                 {date_from_filter} {date_to_filter} {event_filter} {eco_filter} {moves_filter} {source_filter} {collection_filter} {visibility_filter} {deleted_filter} {fen_filter}
                 ORDER BY g.date DESC NULLS LAST LIMIT ? OFFSET ?"
            )
        }
    };

    // Scope filters apply to all branches; pushed in the same order they appear
    // in the SQL templates: collection, visibility — between moves_filter and fen_filter.
    if let Some(cid) = collection_id { params.push(Box::new(cid)); }
    if let Some(v)   = visibility    { params.push(Box::new(v.to_string())); }

    if let Some(hash) = fen_hash {
        params.push(Box::new(hash));
    }
    if !count {
        params.push(Box::new(limit));
        params.push(Box::new(offset));
    }

    (sql, params)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async fn collections_handler(State(state): State<AppState>) -> ApiResult<Vec<CollectionInfo>> {
    state.reads.run(|conn| {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.name, COUNT(gc.game_id)
             FROM collections c
             LEFT JOIN game_collections gc ON gc.collection_id = c.id
             GROUP BY c.id, c.name
             ORDER BY COUNT(gc.game_id) DESC, c.name",
        ).map_err(db_err)?;
        let rows = stmt.query_map([], |row| {
            Ok(CollectionInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                game_count: row.get(2)?,
            })
        }).map_err(db_err)?;
        let result: Vec<CollectionInfo> = rows.filter_map(|r| r.ok()).collect();
        Ok(Json(result))
    }).await
}

async fn status_handler(State(state): State<AppState>) -> ApiResult<StatusInfo> {
    state.reads.run(|conn| {
        Ok(Json(StatusInfo {
            issues:     conn.query_row("SELECT COUNT(*) FROM issues", [], |r| r.get(0)).unwrap_or(0),
            downloaded: conn.query_row("SELECT COUNT(*) FROM issues WHERE downloaded = TRUE", [], |r| r.get(0)).unwrap_or(0),
            imported:   conn.query_row("SELECT COUNT(*) FROM issues WHERE imported = TRUE", [], |r| r.get(0)).unwrap_or(0),
            games:      conn.query_row("SELECT COUNT(*) FROM games WHERE deleted_at IS NULL", [], |r| r.get(0)).unwrap_or(0),
            players:    conn.query_row("SELECT COUNT(*) FROM players", [], |r| r.get(0)).unwrap_or(0),
            positions:  conn.query_row("SELECT COUNT(*) FROM positions", [], |r| r.get(0)).unwrap_or(0),
            deleted_games: conn.query_row("SELECT COUNT(*) FROM games WHERE deleted_at IS NOT NULL", [], |r| r.get(0)).unwrap_or(0),
            last_twic_imported: conn.query_row(
                "SELECT CAST(MAX(imported_at) AS VARCHAR) FROM issues WHERE imported = TRUE AND imported_at IS NOT NULL",
                [],
                |r| r.get(0),
            ).unwrap_or(None),
        }))
    }).await
}

async fn players_handler(
    State(state): State<AppState>,
    Query(q): Query<PlayersQuery>,
) -> ApiResult<Vec<PlayerInfo>> {
    state.reads.run(move |conn| {
        let mut params: Vec<Box<dyn duckdb::ToSql>> = Vec::new();

        let sql = if let Some(id) = q.fide_id {
            params.push(Box::new(id));
            "SELECT id, name, fide_id, game_count FROM players WHERE fide_id = ? LIMIT 50".to_string()
        } else if let Some(ref name) = q.name {
            params.push(Box::new(format!("{}%", normalize_name(name))));
            "SELECT id, name, fide_id, game_count FROM players WHERE name_normalized LIKE ? ORDER BY game_count DESC LIMIT 50".to_string()
        } else {
            "SELECT id, name, fide_id, game_count FROM players ORDER BY game_count DESC LIMIT 50".to_string()
        };

        let params_ref: Vec<&dyn duckdb::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt.query_map(params_ref.as_slice(), |row| {
            Ok(PlayerInfo { id: row.get(0)?, name: row.get(1)?, fide_id: row.get(2)?, game_count: row.get(3)? })
        }).map_err(db_err)?;
        Ok(Json(rows.flatten().collect()))
    }).await
}

async fn games_handler(
    State(state): State<AppState>,
    Query(q): Query<GamesQuery>,
) -> ApiResult<serde_json::Value> {
    if let Some(ref name) = q.name {
        if name.trim().len() < 2 {
            return Err((StatusCode::BAD_REQUEST, "name must be at least 2 characters".into()));
        }
    }

    let fen_hash: Option<i64> = if let Some(ref fen_str) = q.fen {
        let parsed = fen_str.parse::<Fen>()
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        let board: Chess = parsed.into_position(shakmaty::CastlingMode::Standard)
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        let hash: Zobrist64 = board.zobrist_hash(EnPassantMode::Legal);
        Some(hash.0 as i64)
    } else {
        None
    };

    state.reads.run(move |conn| {
        let (sql, params) = build_games_sql(
            q.name.as_deref(), q.fide_id, q.player_id, q.color.as_deref(), q.opponent.as_deref(),
            q.white.as_deref(), q.black.as_deref(), q.white_fide_id, q.black_fide_id,
            q.event.as_deref(), q.eco.as_deref(), q.first_moves.as_deref(),
            q.from.as_deref(), q.to.as_deref(),
            fen_hash,
            q.collection_id, q.visibility.as_deref(),
            q.include_deleted,
            q.pgn, q.count, q.limit, q.offset,
        );
        let params_ref: Vec<&dyn duckdb::ToSql> = params.iter().map(|p| p.as_ref()).collect();

        if q.count {
            let n: i64 = conn.query_row(&sql, params_ref.as_slice(), |r| r.get(0)).map_err(db_err)?;
            return Ok(Json(serde_json::json!({ "count": n })));
        }

        // Column layout: 0-10 fixed, visibility at 11, deleted_at at 12,
        // then optional pgn (13), then optional move_number.
        let pgn_col: i32      = if q.pgn              { 13 } else { -1 };
        let move_num_col: i32 = if fen_hash.is_some() { if q.pgn { 14 } else { 13 } } else { -1 };

        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt.query_map(params_ref.as_slice(), |row| {
            Ok(GameSummary {
                id: row.get(0)?, white: row.get(1)?, black: row.get(2)?,
                white_elo: row.get(3)?, black_elo: row.get(4)?,
                event: row.get(5)?, date: row.get(6)?, result: row.get(7)?,
                eco: row.get(8)?, move_count: row.get(9)?, opening_line: row.get(10)?,
                visibility: row.get(11)?,
                deleted_at: row.get(12)?,
                pgn:         if pgn_col      >= 0 { row.get(pgn_col as usize)?      } else { None },
                move_number: if move_num_col >= 0 { Some(row.get(move_num_col as usize)?) } else { None },
            })
        }).map_err(db_err)?;

        let games: Vec<GameSummary> = rows.flatten().collect();
        Ok(Json(serde_json::to_value(&games).map_err(db_err)?))
    }).await
}

async fn game_by_id_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
) -> ApiResult<GameDetail> {
    state.reads.run(move |conn| {
        let sql = "
            SELECT g.id, pw.name, pb.name, pw.fide_id, pb.fide_id,
                   g.white_elo, g.black_elo,
                   g.event, g.date, g.result, g.eco, g.move_count, g.pgn,
                   g.visibility,
                   CAST(g.deleted_at AS VARCHAR)
            FROM games g
            JOIN players pw ON g.white_id = pw.id
            JOIN players pb ON g.black_id = pb.id
            WHERE g.id = ?";
        let mut detail = conn.query_row(sql, duckdb::params![id], |row| {
            Ok(GameDetail {
                id: row.get(0)?, white: row.get(1)?, black: row.get(2)?,
                white_fide_id: row.get(3)?, black_fide_id: row.get(4)?,
                white_elo: row.get(5)?, black_elo: row.get(6)?,
                event: row.get(7)?, date: row.get(8)?, result: row.get(9)?,
                eco: row.get(10)?, move_count: row.get(11)?, pgn: row.get(12)?,
                visibility: row.get(13)?,
                collections: Vec::new(),
                deleted_at: row.get(14)?,
            })
        }).map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;

        let mut cstmt = conn.prepare(
            "SELECT c.name FROM game_collections gc
             JOIN collections c ON c.id = gc.collection_id
             WHERE gc.game_id = ? ORDER BY c.name"
        ).map_err(db_err)?;
        let rows = cstmt.query_map(duckdb::params![id], |r| r.get::<_, String>(0)).map_err(db_err)?;
        detail.collections = rows.filter_map(|r| r.ok()).collect();

        Ok(Json(detail))
    }).await
}

async fn position_handler(
    State(state): State<AppState>,
    Query(q): Query<PositionQuery>,
) -> ApiResult<serde_json::Value> {
    let fen_str = q.fen.ok_or_else(|| (StatusCode::BAD_REQUEST, "fen parameter required".to_string()))?;

    let parsed_fen: Fen = fen_str.parse()
        .map_err(|e: shakmaty::fen::ParseFenError| db_err(e.to_string()))?;
    let board: Chess = parsed_fen
        .into_position(shakmaty::CastlingMode::Standard)
        .map_err(|e| db_err(e.to_string()))?;
    let hash: Zobrist64 = board.zobrist_hash(EnPassantMode::Legal);
    let hash_i64: i64 = hash.0 as i64;

    let count = q.count;
    state.reads.run(move |conn| {
        if count {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM positions p
                 JOIN games g ON g.id = p.game_id
                 WHERE p.zobrist_hash = ? AND g.deleted_at IS NULL",
                duckdb::params![hash_i64], |r| r.get(0),
            ).map_err(db_err)?;
            return Ok(Json(serde_json::json!({ "count": n })));
        }

        let sql = "
            SELECT g.id, pw.name, pb.name, g.white_elo, g.black_elo,
                   g.event, g.date, g.result, p.move_number
            FROM positions p
            JOIN games g    ON p.game_id = g.id
            JOIN players pw ON g.white_id = pw.id
            JOIN players pb ON g.black_id = pb.id
            WHERE p.zobrist_hash = ? AND g.deleted_at IS NULL
            ORDER BY g.date DESC NULLS LAST
            LIMIT 100";

        let mut stmt = conn.prepare(sql).map_err(db_err)?;
        let rows = stmt.query_map(duckdb::params![hash_i64], |row| {
            Ok(PositionGame {
                id: row.get(0)?, white: row.get(1)?, black: row.get(2)?,
                white_elo: row.get(3)?, black_elo: row.get(4)?,
                event: row.get(5)?, date: row.get(6)?, result: row.get(7)?,
                move_number: row.get(8)?,
            })
        }).map_err(db_err)?;

        let games: Vec<PositionGame> = rows.flatten().collect();
        Ok(Json(serde_json::to_value(&games).map_err(db_err)?))
    }).await
}

async fn position_moves_handler(
    State(state): State<AppState>,
    Query(q): Query<PositionMovesQuery>,
) -> ApiResult<Vec<MoveStats>> {
    if q.fen.is_some() && q.first_moves.is_some() {
        return Err((StatusCode::BAD_REQUEST, "fen and first_moves are mutually exclusive".into()));
    }

    let hash_i64: i64 = if let Some(ref fen_str) = q.fen {
        let parsed: Fen = fen_str.parse()
            .map_err(|e: shakmaty::fen::ParseFenError| (StatusCode::BAD_REQUEST, e.to_string()))?;
        let board: Chess = parsed.into_position(shakmaty::CastlingMode::Standard)
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        board.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64
    } else if let Some(ref fm) = q.first_moves {
        let mut pos = Chess::default();
        for token in strip_move_numbers(fm).split_whitespace() {
            let san: San = token.parse()
                .map_err(|_| (StatusCode::BAD_REQUEST, format!("invalid move: {}", token)))?;
            let mv = san.to_move(&pos)
                .map_err(|_| (StatusCode::BAD_REQUEST, format!("illegal move: {}", token)))?;
            pos.play_unchecked(mv);
        }
        pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64
    } else {
        Chess::default().zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64
    };

    let name_pattern = q.name.as_deref().map(|n| format!("%{}%", normalize_name(n)));
    let white_pattern = q.white.as_deref().map(|n| format!("%{}%", normalize_name(n)));
    let black_pattern = q.black.as_deref().map(|n| format!("%{}%", normalize_name(n)));
    state.reads.run(move |conn| {
        let stats = crate::db::queries::position_moves(
            conn, hash_i64,
            q.player_id,
            name_pattern.as_deref(),
            q.fide_id,
            q.color.as_deref().unwrap_or("any"),
            white_pattern.as_deref(),
            black_pattern.as_deref(),
            q.white_fide_id,
            q.black_fide_id,
            q.from.as_deref(),
            q.to.as_deref(),
            q.visibility.as_deref(),
        ).map_err(db_err)?;
        Ok(Json(stats.into_iter().map(MoveStats::from).collect()))
    }).await
}

async fn delete_game_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
) -> std::result::Result<StatusCode, (StatusCode, String)> {
    state.writer.run(move |conn| {
        // Fetch player IDs before deleting so we can update their counts.
        let players: Option<(u32, u32)> = conn.query_row(
            "SELECT white_id, black_id FROM games WHERE id = ?",
            duckdb::params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).ok();

        if players.is_none() {
            return Err((StatusCode::NOT_FOUND, format!("game {} not found", id)));
        }
        crate::dedup::hard_delete_game(conn, id).map_err(db_err)?;

        if let Some((white_id, black_id)) = players {
            crate::db::queries::recalculate_game_count_for(conn, white_id).map_err(db_err)?;
            if black_id != white_id {
                crate::db::queries::recalculate_game_count_for(conn, black_id).map_err(db_err)?;
            }
        }

        Ok(StatusCode::NO_CONTENT)
    }).await
}

async fn merge_players_handler(
    State(state): State<AppState>,
    AxumPath((keep_id, drop_id)): AxumPath<(u32, u32)>,
) -> std::result::Result<StatusCode, (StatusCode, String)> {
    if keep_id == drop_id {
        return Err((StatusCode::BAD_REQUEST, "keep and drop IDs must differ".to_string()));
    }
    state.writer.run(move |conn| {
        // Verify both players exist
        let keep_exists: bool = conn
            .query_row("SELECT COUNT(*) FROM players WHERE id = ?", duckdb::params![keep_id], |r| r.get::<_, i64>(0))
            .map(|c| c > 0)
            .map_err(db_err)?;
        let drop_exists: bool = conn
            .query_row("SELECT COUNT(*) FROM players WHERE id = ?", duckdb::params![drop_id], |r| r.get::<_, i64>(0))
            .map(|c| c > 0)
            .map_err(db_err)?;
        if !keep_exists {
            return Err((StatusCode::NOT_FOUND, format!("player {} not found", keep_id)));
        }
        if !drop_exists {
            return Err((StatusCode::NOT_FOUND, format!("player {} not found", drop_id)));
        }

        // Reassign all games, then delete the dropped player
        conn.execute("UPDATE games SET white_id = ? WHERE white_id = ?", duckdb::params![keep_id, drop_id])
            .map_err(db_err)?;
        conn.execute("UPDATE games SET black_id = ? WHERE black_id = ?", duckdb::params![keep_id, drop_id])
            .map_err(db_err)?;
        conn.execute("DELETE FROM players WHERE id = ?", duckdb::params![drop_id])
            .map_err(db_err)?;

        crate::db::queries::recalculate_game_count_for(conn, keep_id).map_err(db_err)?;

        Ok(StatusCode::NO_CONTENT)
    }).await
}

async fn player_stats_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
) -> ApiResult<PlayerStats> {
    state.reads.run(move |conn| {
        let stats = crate::db::queries::player_stats(conn, id).map_err(db_err)?;
        Ok(Json(PlayerStats::from(stats)))
    }).await
}

// ── Jobs (long-running mutations) ─────────────────────────────────────────────

#[derive(Deserialize)]
struct JobRequest {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    params: serde_json::Value,
}

async fn create_job_handler(
    State(state): State<AppState>,
    Json(req): Json<JobRequest>,
) -> ApiResult<serde_json::Value> {
    let id = state.jobs.submit(req.kind, req.params);
    Ok(Json(serde_json::json!({ "job_id": id })))
}

async fn list_jobs_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::to_value(state.jobs.list()).unwrap_or_default())
}

async fn get_job_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<serde_json::Value> {
    match state.jobs.snapshot(&id) {
        Some(s) => Ok(Json(serde_json::to_value(s).map_err(db_err)?)),
        None => Err((StatusCode::NOT_FOUND, format!("job {} not found", id))),
    }
}

async fn cancel_job_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> std::result::Result<StatusCode, (StatusCode, String)> {
    if state.jobs.cancel(&id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, format!("job {} not found", id)))
    }
}

/// Server-Sent Events stream of a job's progress: replays buffered events, then
/// streams live ones. The client closes the stream when it sees done/error.
async fn job_events_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> std::result::Result<Sse<impl tokio_stream::Stream<Item = std::result::Result<Event, Infallible>>>, (StatusCode, String)> {
    let slot = state
        .jobs
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, format!("job {} not found", id)))?;
    let (buffered, rx) = slot.subscribe();
    let live = tokio_stream::wrappers::BroadcastStream::new(rx).filter_map(|r| r.ok());
    let stream = tokio_stream::iter(buffered)
        .chain(live)
        .map(|ev| Ok(Event::default().json_data(&ev).unwrap_or_default()));
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

// ── Quick mutations (synchronous, run on the writer) ──────────────────────────

#[derive(Deserialize)]
struct VisibilityBody { visibility: String }
#[derive(Deserialize)]
struct CollectionBody { name: String }
#[derive(Deserialize)]
struct MovesBody { moves: String }

fn msg(text: String) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "message": text }))
}

async fn soft_delete_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
) -> ApiResult<serde_json::Value> {
    state.writer.run(move |conn| {
        let row: Option<(u32, u32, Option<String>)> = conn.query_row(
            "SELECT white_id, black_id, CAST(deleted_at AS VARCHAR) FROM games WHERE id = ?",
            duckdb::params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).ok();
        let (white_id, black_id, already) = row
            .ok_or((StatusCode::NOT_FOUND, format!("game {} not found", id)))?;
        if already.is_some() {
            return Ok(msg(format!("Game {} already soft-deleted.", id)));
        }
        conn.execute("UPDATE games SET deleted_at = CAST(NOW() AS TIMESTAMP) WHERE id = ?", duckdb::params![id]).map_err(db_err)?;
        crate::db::queries::recalculate_game_count_for(conn, white_id).map_err(db_err)?;
        if black_id != white_id {
            crate::db::queries::recalculate_game_count_for(conn, black_id).map_err(db_err)?;
        }
        Ok(msg(format!("Game {} soft-deleted.", id)))
    }).await
}

async fn restore_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
) -> ApiResult<serde_json::Value> {
    state.writer.run(move |conn| {
        let row: Option<(u32, u32, Option<String>)> = conn.query_row(
            "SELECT white_id, black_id, CAST(deleted_at AS VARCHAR) FROM games WHERE id = ?",
            duckdb::params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).ok();
        let (white_id, black_id, was_deleted) = row
            .ok_or((StatusCode::NOT_FOUND, format!("game {} not found", id)))?;
        if was_deleted.is_none() {
            return Ok(msg(format!("Game {} is not deleted.", id)));
        }
        conn.execute("UPDATE games SET deleted_at = NULL WHERE id = ?", duckdb::params![id]).map_err(db_err)?;
        crate::db::queries::recalculate_game_count_for(conn, white_id).map_err(db_err)?;
        if black_id != white_id {
            crate::db::queries::recalculate_game_count_for(conn, black_id).map_err(db_err)?;
        }
        Ok(msg(format!("Game {} restored.", id)))
    }).await
}

async fn set_visibility_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
    Json(body): Json<VisibilityBody>,
) -> ApiResult<serde_json::Value> {
    let v = body.visibility.trim().to_lowercase();
    if v != "public" && v != "private" {
        return Err((StatusCode::BAD_REQUEST, format!("visibility must be 'public' or 'private', got {:?}", body.visibility)));
    }
    state.writer.run(move |conn| {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM games WHERE id = ?)", duckdb::params![id], |r| r.get(0),
        ).unwrap_or(false);
        if !exists {
            return Err((StatusCode::NOT_FOUND, format!("game {} not found", id)));
        }
        conn.execute("UPDATE games SET visibility = ? WHERE id = ?", duckdb::params![v, id]).map_err(db_err)?;
        Ok(msg(format!("Game {} set to {}.", id, v)))
    }).await
}

async fn add_collection_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
    Json(body): Json<CollectionBody>,
) -> ApiResult<serde_json::Value> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "collection name must not be empty".into()));
    }
    state.writer.run(move |conn| {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM games WHERE id = ?)", duckdb::params![id], |r| r.get(0),
        ).unwrap_or(false);
        if !exists {
            return Err((StatusCode::NOT_FOUND, format!("game {} not found", id)));
        }
        let collection_id = crate::importer::upsert_collection(conn, &name).map_err(db_err)?;
        conn.execute(
            "INSERT INTO game_collections (game_id, collection_id) VALUES (?, ?)
             ON CONFLICT (game_id, collection_id) DO NOTHING",
            duckdb::params![id, collection_id],
        ).map_err(db_err)?;
        Ok(msg(format!("Game {} added to collection {:?}.", id, name)))
    }).await
}

async fn remove_collection_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
    Json(body): Json<CollectionBody>,
) -> ApiResult<serde_json::Value> {
    let name = body.name.trim().to_string();
    state.writer.run(move |conn| {
        let collection_id: Option<i32> = conn.query_row(
            "SELECT id FROM collections WHERE name = ?", duckdb::params![name], |r| r.get(0),
        ).ok();
        let Some(cid) = collection_id else {
            return Ok(msg(format!("Collection {:?} does not exist.", name)));
        };
        let removed = conn.execute(
            "DELETE FROM game_collections WHERE game_id = ? AND collection_id = ?",
            duckdb::params![id, cid],
        ).map_err(db_err)?;
        if removed == 0 {
            return Ok(msg(format!("Game {} was not in collection {:?}.", id, name)));
        }
        // Drop the collection if it is now empty (the filter list refetches on
        // every mutation, so an empty collection would otherwise linger).
        let remaining: i64 = conn.query_row(
            "SELECT COUNT(*) FROM game_collections WHERE collection_id = ?", duckdb::params![cid], |r| r.get(0),
        ).unwrap_or(0);
        if remaining == 0 {
            conn.execute("DELETE FROM collections WHERE id = ?", duckdb::params![cid]).map_err(db_err)?;
        }
        Ok(msg(format!("Game {} removed from collection {:?}.", id, name)))
    }).await
}

async fn set_moves_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
    Json(body): Json<MovesBody>,
) -> ApiResult<serde_json::Value> {
    state.writer.run(move |conn| {
        crate::do_set_moves(conn, id, &body.moves, &crate::reporter::Reporter::silent())
            .map_err(db_err)?;
        Ok(msg(format!("Game {} moves updated.", id)))
    }).await
}

#[derive(Deserialize)]
struct HeadersBody { tags: serde_json::Value }

async fn set_headers_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
    Json(body): Json<HeadersBody>,
) -> ApiResult<serde_json::Value> {
    // do_set_headers parses a JSON array of {name,value} from a string.
    let tags_json = serde_json::to_string(&body.tags).map_err(db_err)?;
    state.writer.run(move |conn| {
        crate::do_set_headers(conn, id, &tags_json, &crate::reporter::Reporter::silent())
            .map_err(db_err)?;
        Ok(msg(format!("Game {} headers updated.", id)))
    }).await
}

#[derive(Deserialize)]
struct FideIdBody { fide_id: u32 }

async fn set_fide_id_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<u32>,
    Json(body): Json<FideIdBody>,
) -> ApiResult<serde_json::Value> {
    state.writer.run(move |conn| {
        crate::do_set_fide_id(conn, id, body.fide_id).map_err(db_err)?;
        Ok(msg(format!("Player {} FIDE ID set to {}.", id, body.fide_id)))
    }).await
}

async fn purge_handler(State(state): State<AppState>) -> ApiResult<serde_json::Value> {
    state.writer.run(move |conn| {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM games WHERE deleted_at IS NOT NULL", [], |r| r.get(0),
        ).unwrap_or(0);
        if count == 0 {
            return Ok(msg("No soft-deleted games to purge.".into()));
        }
        conn.execute_batch(
            "DELETE FROM positions
                WHERE game_id IN (SELECT id FROM games WHERE deleted_at IS NOT NULL);
             DELETE FROM game_collections
                WHERE game_id IN (SELECT id FROM games WHERE deleted_at IS NOT NULL);
             DELETE FROM games WHERE deleted_at IS NOT NULL;",
        ).map_err(db_err)?;
        Ok(msg(format!("Purged {} soft-deleted game(s).", count)))
    }).await
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub async fn run(conn: Connection, port: u16) -> Result<()> {
    // The passed connection opened the database read-write. Clone it into a pool
    // of read connections (concurrent SELECTs via DuckDB in-process MVCC); the
    // original becomes the single writer that runs all mutations and jobs.
    const READ_POOL_SIZE: usize = 4;
    let mut readers = Vec::with_capacity(READ_POOL_SIZE);
    for _ in 0..READ_POOL_SIZE {
        readers.push(conn.try_clone()?);
    }
    let reads = ReadPool::new(readers);
    let writer = ConnActor::new(conn);
    let jobs = Arc::new(JobManager::new(writer.clone(), tokio::runtime::Handle::current()));
    let state = AppState { reads, writer, jobs };

    let app = Router::new()
        .route("/status",                              get(status_handler))
        .route("/collections",                         get(collections_handler))
        .route("/players",                             get(players_handler))
        .route("/players/{id}/stats",                  get(player_stats_handler))
        .route("/players/{keep_id}/merge/{drop_id}",   post(merge_players_handler))
        .route("/games",                               get(games_handler))
        .route("/games/{id}",                          get(game_by_id_handler).delete(delete_game_handler))
        .route("/games/{id}/soft-delete",              post(soft_delete_handler))
        .route("/games/{id}/restore",                  post(restore_handler))
        .route("/games/{id}/visibility",               post(set_visibility_handler))
        .route("/games/{id}/collections",              post(add_collection_handler))
        .route("/games/{id}/collections/remove",       post(remove_collection_handler))
        .route("/games/{id}/moves",                    post(set_moves_handler))
        .route("/games/{id}/headers",                  post(set_headers_handler))
        .route("/players/{id}/fide-id",                post(set_fide_id_handler))
        .route("/purge",                               post(purge_handler))
        .route("/position",                            get(position_handler))
        .route("/position/moves",                      get(position_moves_handler))
        // Long-running mutation jobs with streamed progress.
        .route("/jobs",                                get(list_jobs_handler).post(create_job_handler))
        .route("/jobs/{id}",                           get(get_job_handler))
        .route("/jobs/{id}/events",                    get(job_events_handler))
        .route("/jobs/{id}/cancel",                    post(cancel_job_handler))
        .with_state(state)
        // Allow the bundled webview (a cross-origin caller, e.g. tauri://localhost)
        // to reach this local server. In dev the Vite proxy makes calls same-origin;
        // in a packaged app the frontend hits http://127.0.0.1:7777 directly.
        .layer(CorsLayer::permissive());

    let addr = format!("127.0.0.1:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("chess-db server listening on http://{}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}
