use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use tokio::io::AsyncWriteExt;
use duckdb::Connection;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::sync::Arc;
use tokio_stream::StreamExt;
use tower_http::cors::CorsLayer;
use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::zobrist::Zobrist64;
use shakmaty::{Chess, EnPassantMode, Position};
use anyhow::Result;

use crate::jobs::{ConnActor, JobManager, JobSnapshot, ReadPool};

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
    /// Absolute path of the open database file — reported via `/status` so the
    /// GUI shows the server's real path (e.g. `/var/lib/lpdo/.chess-db/chess.db`)
    /// instead of guessing `~/.chess-db`.
    pub db_path: std::path::PathBuf,
    /// Live phase of the wizard's first-run setup pipeline (#40 C4). Authoritative
    /// while the server is up; the on-disk sentinel covers restarts/crashes.
    pub setup: Arc<std::sync::Mutex<SetupPhase>>,
}

/// Phase of the wizard-driven first-run setup pipeline. `Idle` covers both
/// "never set up" and "finished" — `/status` disambiguates by game count.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SetupPhase {
    /// No setup pipeline running (fresh, or finished).
    Idle,
    /// The fast import→dedup→index→normalise pipeline is queued/running.
    Running,
    /// A pipeline job failed (or was interrupted) — the DB may be incomplete;
    /// the user is offered "Reset & start over".
    Failed,
}

impl SetupPhase {
    /// The readiness string reported to the client. `Idle` resolves to `ready`
    /// when the DB has games, else `empty` (a fresh, un-set-up database).
    fn status_str(self, games: i64) -> &'static str {
        match self {
            SetupPhase::Running => "preparing",
            SetupPhase::Failed => "failed",
            SetupPhase::Idle if games > 0 => "ready",
            SetupPhase::Idle => "empty",
        }
    }
}

// ── Response types ────────────────────────────────────────────────────────────

/// API contract version. Bump ONLY on a breaking change to the HTTP API, so a
/// client can detect a server too old to talk to (separate from the human
/// `version`, which a client compares against GitHub to notify about updates —
/// including bugfix releases that don't change the API).
pub const API_VERSION: u32 = 1;

#[derive(Serialize)]
pub struct StatusInfo {
    /// Server build version (the chess-db crate version), for the client's
    /// update-available notification.
    pub version: String,
    /// API contract version (see `API_VERSION`).
    pub api_version: u32,
    /// Absolute path of the database file the server has open, so the GUI shows
    /// the real path rather than guessing `~/.chess-db`.
    pub db_path: String,
    /// Directory containing the database (and the `twic/` cache).
    pub data_dir: String,
    /// Number of TWIC issues actually imported (id < 1e6, imported = TRUE).
    /// Excludes both local PGN imports and TWIC ids that were registered but
    /// never downloaded, so it reads as "TWIC issues you have".
    pub issues: i64,
    /// Number of local PGN files imported (id ≥ 1e6) — e.g. Megabase, Bundesliga.
    /// These live in the same `issues` table but are not TWIC issues.
    pub local_imports: i64,
    pub games: i64,
    pub players: i64,
    pub positions: i64,
    pub deleted_games: i64,
    /// Number of the most recently imported TWIC issue (e.g. 1649), or null if
    /// none have been imported. Excludes local PGN imports (issue ids ≥ 1e6).
    pub last_twic_issue: Option<i64>,
    /// Publication date of `last_twic_issue` (TWIC's own date, e.g. "2026-06-15"),
    /// or null if not yet known. Null until a `download` backfills it.
    pub last_twic_published: Option<String>,
    /// ISO timestamp at which `last_twic_issue` was imported, or null if none.
    pub last_twic_imported: Option<String>,
    /// Readiness of the first-run setup pipeline (#40 C4): "empty" (fresh, no
    /// games), "preparing" (import/maintenance pipeline running), "failed"
    /// (interrupted/errored — offer Reset), or "ready" (has games, nothing
    /// pending). The live queue (`/jobs`) carries the per-step detail.
    pub setup_status: String,
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
    /// Restrict the player list to players with games in this collection, and
    /// report each player's game count *within* it — mirrors the Games page's
    /// Collection filter (#—).
    collection_id: Option<i32>,
}

#[derive(Deserialize, Default)]
struct GamesQuery {
    // player (either color)
    player_id: Option<u32>,
    name: Option<String>,
    fide_id: Option<u32>,
    color: Option<String>,
    opponent: Option<String>,
    /// Second resolved player id (Games page's Player 2 via autocomplete).
    opponent_id: Option<u32>,
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
    /// Restrict to a collection by name (the CLI's `search games --collection`
    /// sends this). Resolved to its id in the handler, reusing the collection_id
    /// predicate; an unknown name matches no games.
    collection: Option<String>,
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
    /// Restrict the popularity aggregation to a collection (matches the game list).
    collection_id: Option<i32>,
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
    // Second resolved player (Games page's Player 2 via autocomplete). When set
    // alongside `player_id`, matches games between the two by id (indexed) —
    // either colour, or colour-specific per `color`.
    opponent_id: Option<u32>,
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
        let c = color.unwrap_or("any");
        // Player 1 = pid (+ colour). Player 2 = an autocomplete-resolved id
        // (indexed, either colour) or a free-text opponent name.
        let players_filter: String = if let Some(oid) = opponent_id {
            match c {
                "white" => { params.push(Box::new(pid)); params.push(Box::new(oid));
                             "g.white_id = ? AND g.black_id = ?".into() }
                "black" => { params.push(Box::new(pid)); params.push(Box::new(oid));
                             "g.black_id = ? AND g.white_id = ?".into() }
                _       => { params.push(Box::new(pid)); params.push(Box::new(oid));
                             params.push(Box::new(oid)); params.push(Box::new(pid));
                             "((g.white_id = ? AND g.black_id = ?) OR (g.white_id = ? AND g.black_id = ?))".into() }
            }
        } else {
            let color_filter = match c {
                "white" => { params.push(Box::new(pid)); "g.white_id = ?" }
                "black" => { params.push(Box::new(pid)); "g.black_id = ?" }
                _       => { params.push(Box::new(pid)); params.push(Box::new(pid)); "(g.white_id = ? OR g.black_id = ?)" }
            };
            let opponent_filter = if let Some(opp) = opponent {
                let norm = format!("{}%", normalize_name(opp));
                match c {
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
            format!("{color_filter} {opponent_filter}")
        };
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
                 WHERE {players_filter} {date_from_filter} {date_to_filter}
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
             WHERE {players_filter} {date_from_filter} {date_to_filter}
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

async fn sources_handler(State(state): State<AppState>) -> ApiResult<Vec<crate::sources::SourceStatus>> {
    state.reads.run(|conn| {
        crate::sources::list_status(conn).map(Json).map_err(db_err)
    }).await
}

#[derive(serde::Deserialize)]
struct SetEnabledBody {
    enabled: bool,
    /// Record the attribution acknowledgment in the same step (sent when enabling).
    #[serde(default)]
    credit_acked: bool,
    /// Kick off an immediate download+import for a feed on enable (#195). The
    /// wizard sends `false` — its own first-run pipeline handles the initial load.
    #[serde(default = "default_true")]
    sync: bool,
}
fn default_true() -> bool { true }

/// Enable or disable a source synchronously (#191). This is a quick mutation, not
/// a queued job, so it never piles up "Disable X" cards in the activity panel and
/// applies the moment the writer is free (instant when idle). Disabling also
/// cancels that source's in-flight sync/download/import right away — done before
/// the state write so the source actually stops instead of running on behind the
/// writer. The write still serializes on the single writer, so during a long
/// import of *another* source the persisted flag lands once that import drains;
/// the GUI reflects the choice optimistically in the meantime.
async fn set_source_enabled_handler(
    State(state): State<AppState>,
    AxumPath(key): AxumPath<String>,
    Json(body): Json<SetEnabledBody>,
) -> ApiResult<serde_json::Value> {
    if !body.enabled {
        for j in state.jobs.list() {
            let touches_this = j.params.get("source").and_then(|v| v.as_str()) == Some(key.as_str());
            let is_sync = matches!(
                j.job_type.as_str(),
                "sources_sync" | "sources_download" | "sources_import" | "download" | "import"
            );
            let active = matches!(j.status.as_str(), "queued" | "running" | "waiting");
            if touches_this && is_sync && active {
                state.jobs.cancel(&j.id);
            }
        }
    }

    // The state write is tiny but serializes behind any running import on the
    // single writer. On the interactive (Maintenance) path we fire it and don't
    // block the HTTP response — so the toggle never sits greyed for the duration
    // of *another* source's import; the GUI reflects the choice optimistically.
    // On the wizard path (sync=false) the writer is idle and the caller reads the
    // enabled set immediately afterward (startSetup), so we AWAIT to guarantee the
    // write is committed first.
    //
    // Apply this BEFORE dispatching the sync below: `submit` enqueues the sync
    // body on the SAME single writer (JobManager::submit → writer.spawn_fn), so a
    // sync dispatched first would make this tiny flag write wait behind the whole
    // (for a fresh TWIC enable, ~1500-issue) import — leaving the source reading
    // as *disabled* until the sync drained. Writing first lands the flag in
    // milliseconds, then the sync runs behind it. Still fire-and-forget, so the
    // HTTP response never blocks behind another source's in-flight import.
    let enabled = body.enabled;
    let acked = body.credit_acked;
    if body.sync {
        let key_w = key.clone();
        state.writer.spawn_fn(move |conn| {
            if acked {
                let _ = crate::sources::acknowledge(conn, &key_w);
            }
            let _ = crate::sources::set_enabled(conn, &key_w, enabled);
        });
    } else {
        let key_w = key.clone();
        state
            .writer
            .run(move |conn| {
                if acked {
                    let _ = crate::sources::acknowledge(conn, &key_w);
                }
                let _ = crate::sources::set_enabled(conn, &key_w, enabled);
            })
            .await;
    }

    // #195: enabling a *feed* kicks off an immediate sync so the user doesn't wait
    // for the scheduler's next tick. Dispatched AFTER the enable write above so the
    // flag is persisted first (see the note there). Skipped for bulk sources
    // (Ajedrez has its own one-shot action, #196), and if a sync is already in
    // flight. NOT gated on the setup sentinel: the wizard's own enables pass
    // sync=false, so an interactive re-enable during first-run (e.g. after
    // disabling a feed mid-onboarding) must still queue a sync — the scheduler is
    // held off during first-run, so this is the only thing that would. On success
    // the sync requests the coalesced maintenance pass, which runs once it drains.
    if body.enabled && body.sync {
        let is_feed = crate::sources::get(&key)
            .map(|s| s.kind == crate::sources::SourceKind::Feed)
            .unwrap_or(false);
        let already_syncing = state.jobs.list().iter().any(|j| {
            matches!(j.job_type.as_str(), "sources_sync" | "sources_download" | "sources_import")
                && j.params.get("source").and_then(|v| v.as_str()) == Some(key.as_str())
                && matches!(j.status.as_str(), "queued" | "running" | "waiting")
        });
        if is_feed {
            if !already_syncing {
                // Download + Import pair in one cluster (see spawn_first_run_pipeline).
                let cluster = state.jobs.next_cluster_id();
                state.jobs.submit_in_cluster(
                    "sources_download".into(),
                    serde_json::json!({ "source": key }),
                    Some(cluster.clone()),
                );
                state.jobs.submit_in_cluster(
                    "sources_import".into(),
                    serde_json::json!({ "source": key }),
                    Some(cluster),
                );
            }
            // Pin the coalesced maintenance the moment a feed is enabled, so the
            // "Prepare database" row appears at the tail of the queue right away —
            // matching the wizard, which requests it up front. It's idempotent and
            // sticky: toggling feeds on/off keeps exactly one pending pass at the
            // end (each sync re-requests it too), and it only runs once the sync
            // queue drains. Placed AFTER submit so a concurrent maybe_run reads the
            // just-queued sync as busy and can't start maintenance early.
            state.jobs.request_maintenance();
        }
    }

    Ok(msg(format!(
        "Source '{}' {}.",
        key,
        if enabled { "enabled" } else { "disabled" }
    )))
}

// ── Update schedule (#194) ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct ScheduleInfo {
    /// Off-peak daily check time, minutes past local midnight (0–1439).
    daily_minute: i64,
    /// Next occurrence of that time (local ISO) — when feeds are next checked.
    next_check: String,
    /// When the local FIDE player list was last refreshed (ISO), or null.
    fide_last_refreshed: Option<String>,
    /// Whether a FIDE-list refresh is currently due (monthly cadence).
    fide_due: bool,
}

#[derive(serde::Deserialize)]
struct SetScheduleBody {
    /// Minutes past local midnight for the daily check (wrapped into 0–1439).
    daily_minute: i64,
}

/// The daily update-check time + next run + FIDE-list refresh status (#194).
async fn get_schedule_handler(State(state): State<AppState>) -> ApiResult<ScheduleInfo> {
    let (daily_minute, fide_last_refreshed, fide_due) = state
        .reads
        .run(|conn| {
            let dm: i64 = conn
                .query_row("SELECT daily_minute FROM schedule WHERE id = 1", [], |r| {
                    Ok(r.get::<_, i32>(0)? as i64)
                })
                .unwrap_or(240);
            let fide: Option<String> = conn
                .query_row(
                    "SELECT CAST(fide_refreshed_at AS VARCHAR) FROM schedule WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .ok()
                .flatten();
            let due = crate::fide::refresh_due(conn).unwrap_or(false);
            Ok::<_, (StatusCode, String)>((dm, fide, due))
        })
        .await?;
    Ok(Json(ScheduleInfo {
        daily_minute,
        next_check: crate::scheduler::next_scheduled(daily_minute)
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string(),
        fide_last_refreshed,
        fide_due,
    }))
}

/// Set the daily update-check time (#194).
async fn set_schedule_handler(
    State(state): State<AppState>,
    Json(body): Json<SetScheduleBody>,
) -> ApiResult<serde_json::Value> {
    let dm = body.daily_minute.rem_euclid(1440);
    state
        .writer
        .run(move |conn| {
            conn.execute(
                "UPDATE schedule SET daily_minute = ? WHERE id = 1",
                duckdb::params![dm as i32],
            )
            .map_err(db_err)?;
            Ok(msg(format!(
                "Daily update check set to {:02}:{:02}.",
                dm / 60,
                dm % 60
            )))
        })
        .await
}

async fn status_handler(State(state): State<AppState>) -> ApiResult<StatusInfo> {
    let db_path = state.db_path.display().to_string();
    let data_dir = state
        .db_path
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let phase = *state.setup.lock().unwrap();
    state.reads.run(move |conn| {
        let games: i64 = conn.query_row("SELECT COUNT(*) FROM games WHERE deleted_at IS NULL", [], |r| r.get(0)).unwrap_or(0);
        Ok(Json(StatusInfo {
            version:     env!("CARGO_PKG_VERSION").to_string(),
            api_version: API_VERSION,
            db_path,
            data_dir,
            // TWIC issues imported. Keyed by source_key now (#40) rather than the
            // legacy id<1e6 convention, so a future feed source can't be
            // miscounted here. `imported` drops ids registered but never
            // downloaded (old issues no longer offered as zips).
            issues:     conn.query_row("SELECT COUNT(*) FROM source_items WHERE source_key = 'twic' AND imported = TRUE", [], |r| r.get(0)).unwrap_or(0),
            local_imports: conn.query_row("SELECT COUNT(*) FROM source_items WHERE source_key = 'manual' AND imported = TRUE", [], |r| r.get(0)).unwrap_or(0),
            games,
            players:    conn.query_row("SELECT COUNT(*) FROM players", [], |r| r.get(0)).unwrap_or(0),
            positions:  conn.query_row("SELECT COUNT(*) FROM positions", [], |r| r.get(0)).unwrap_or(0),
            deleted_games: conn.query_row("SELECT COUNT(*) FROM games WHERE deleted_at IS NOT NULL", [], |r| r.get(0)).unwrap_or(0),
            // Latest imported TWIC issue number (TWIC reuses the issue number as
            // its ledger id, so MAX(id) within the twic source is the latest).
            last_twic_issue: conn.query_row(
                "SELECT MAX(id) FROM source_items WHERE source_key = 'twic' AND imported = TRUE",
                [],
                |r| r.get(0),
            ).unwrap_or(None),
            // Publication date and import timestamp of that same latest issue.
            // ORDER BY id DESC LIMIT 1 picks the row whose id == MAX(id) above,
            // so the number and both dates always correspond.
            last_twic_published: conn.query_row(
                "SELECT CAST(published_at AS VARCHAR) FROM source_items \
                 WHERE source_key = 'twic' AND imported = TRUE \
                 ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            ).unwrap_or(None),
            last_twic_imported: conn.query_row(
                "SELECT CAST(imported_at AS VARCHAR) FROM source_items \
                 WHERE source_key = 'twic' AND imported = TRUE AND imported_at IS NOT NULL \
                 ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            ).unwrap_or(None),
            setup_status: phase.status_str(games).to_string(),
        }))
    }).await
}

async fn players_handler(
    State(state): State<AppState>,
    Query(q): Query<PlayersQuery>,
) -> ApiResult<Vec<PlayerInfo>> {
    state.reads.run(move |conn| {
        let mut params: Vec<Box<dyn duckdb::ToSql>> = Vec::new();

        // Identity predicate on alias `p` (exact FIDE id, name prefix, or none).
        // Its bound param is pushed below AFTER any collection_id, matching the
        // order the SQL references them (collection_id sits in the JOIN).
        let id_pred = if q.fide_id.is_some() {
            "p.fide_id = ?"
        } else if q.name.is_some() {
            "p.name_normalized LIKE ?"
        } else {
            ""
        };

        let sql = if let Some(cid) = q.collection_id {
            // Collection-scoped (mirrors the Games page's Collection filter): keep
            // only players with games in the collection, and count/order by their
            // games *within* it so the count matches the scoped game list.
            params.push(Box::new(cid));
            if let Some(id) = q.fide_id {
                params.push(Box::new(id));
            } else if let Some(ref name) = q.name {
                params.push(Box::new(format!("{}%", normalize_name(name))));
            }
            let where_extra = if id_pred.is_empty() { String::new() } else { format!("AND {id_pred}") };
            format!("
                SELECT p.id, p.name, p.fide_id, COUNT(*) AS game_count
                FROM players p
                JOIN games g ON (g.white_id = p.id OR g.black_id = p.id)
                JOIN game_collections gc ON gc.game_id = g.id AND gc.collection_id = ?
                WHERE 1=1 {where_extra}
                GROUP BY p.id, p.name, p.fide_id
                ORDER BY game_count DESC LIMIT 50")
        } else {
            // Unscoped: the pre-aggregated players.game_count is fastest.
            if let Some(id) = q.fide_id {
                params.push(Box::new(id));
            } else if let Some(ref name) = q.name {
                params.push(Box::new(format!("{}%", normalize_name(name))));
            }
            let where_clause = if id_pred.is_empty() { String::new() } else { format!("WHERE {id_pred}") };
            format!("SELECT p.id, p.name, p.fide_id, p.game_count FROM players p {where_clause} ORDER BY p.game_count DESC LIMIT 50")
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
        // A `collection` name filter resolves to the same collection_id predicate;
        // an explicit collection_id (the GUI) wins. Unknown name → id -1 (matches
        // nothing) so coverage stays well-defined.
        let collection_id = match (q.collection_id, q.collection.as_deref()) {
            (Some(id), _) => Some(id),
            (None, Some(name)) => Some(
                conn.query_row(
                    "SELECT id FROM collections WHERE name = ?",
                    duckdb::params![name],
                    |r| r.get::<_, i32>(0),
                ).unwrap_or(-1),
            ),
            (None, None) => None,
        };
        let (sql, params) = build_games_sql(
            q.name.as_deref(), q.fide_id, q.player_id, q.color.as_deref(), q.opponent.as_deref(),
            q.opponent_id,
            q.white.as_deref(), q.black.as_deref(), q.white_fide_id, q.black_fide_id,
            q.event.as_deref(), q.eco.as_deref(), q.first_moves.as_deref(),
            q.from.as_deref(), q.to.as_deref(),
            fen_hash,
            collection_id, q.visibility.as_deref(),
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
            q.collection_id,
        ).map_err(db_err)?;
        Ok(Json(stats.into_iter().map(MoveStats::from).collect()))
    }).await
}

#[derive(Deserialize)]
struct CloudEvalQuery {
    fen: String,
    /// `refresh=true` bypasses the cache and re-fetches (the panel's reload button).
    #[serde(default)]
    refresh: bool,
}

/// FEN → Zobrist hash (same scheme as the positions index), the cloud-eval cache key.
fn fen_zobrist(fen: &str) -> std::result::Result<i64, (StatusCode, String)> {
    let parsed: Fen = fen.parse()
        .map_err(|e: shakmaty::fen::ParseFenError| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let board: Chess = parsed.into_position(shakmaty::CastlingMode::Standard)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(board.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64)
}

/// Cloud engine evaluation (chessdb.cn) for a FEN — a multi-move table with
/// per-move scores, cached in the daemon (#221).
async fn cloud_eval_handler(
    Query(q): Query<CloudEvalQuery>,
) -> ApiResult<crate::cloud_eval::CloudEval> {
    let zobrist = fen_zobrist(&q.fen)?;
    Ok(Json(crate::cloud_eval::query(&q.fen, zobrist, q.refresh).await))
}

/// Continuation lines for the top chessdb moves — fetched lazily by the client
/// after the move table so the table shows immediately (#221).
async fn cloud_eval_lines_handler(
    Query(q): Query<CloudEvalQuery>,
) -> ApiResult<Vec<crate::cloud_eval::MoveLine>> {
    let zobrist = fen_zobrist(&q.fen)?;
    Ok(Json(crate::cloud_eval::query_lines(&q.fen, zobrist, q.refresh).await))
}

/// Ask chessdb.cn to analyse an as-yet-unknown position (best-effort).
async fn cloud_eval_queue_handler(Query(q): Query<CloudEvalQuery>) -> StatusCode {
    crate::cloud_eval::queue(&q.fen).await;
    StatusCode::OK
}

/// Lichess cloud evaluation (Stockfish) for a FEN — a few deep PV lines with a
/// White-relative eval + engine depth, cached in the daemon (#221).
async fn lichess_eval_handler(
    Query(q): Query<CloudEvalQuery>,
) -> ApiResult<crate::cloud_eval::LichessEval> {
    let zobrist = fen_zobrist(&q.fen)?;
    Ok(Json(crate::cloud_eval::query_lichess(&q.fen, zobrist, q.refresh).await))
}

#[derive(Deserialize)]
struct WatchQuery {
    fen: String,
    /// Optional short human label (e.g. the move list) shown in the activity panel.
    #[serde(default)]
    label: String,
}

/// Start a "deepen watch": queue the position for deeper chessdb analysis and
/// poll in the background, notifying the activity panel when the depth grows (#221).
async fn cloud_watch_add_handler(
    Query(q): Query<WatchQuery>,
) -> ApiResult<crate::cloud_eval::Watch> {
    let zobrist = fen_zobrist(&q.fen)?;
    Ok(Json(crate::cloud_eval::add_watch(&q.fen, zobrist, &q.label).await))
}

/// List active/landed deepen watches.
async fn cloud_watches_handler() -> Json<Vec<crate::cloud_eval::Watch>> {
    Json(crate::cloud_eval::list_watches())
}

/// Dismiss a deepen watch for a position.
async fn cloud_watch_delete_handler(Query(q): Query<CloudEvalQuery>) -> StatusCode {
    match fen_zobrist(&q.fen) {
        Ok(zobrist) => {
            crate::cloud_eval::remove_watch(zobrist);
            StatusCode::OK
        }
        Err((code, _)) => code,
    }
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

#[derive(Deserialize)]
struct ImportUploadQuery {
    collection: Option<String>,
    /// Original filename; only its extension is used (to preserve
    /// .pgn/.zip/.zst/.7z so the importer decompresses correctly).
    filename: Option<String>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    fast: bool,
    on_duplicate: Option<String>,
}

/// Streamed PGN upload (#154). The client streams a (possibly compressed,
/// multi-GB) file straight to the daemon; we spool it to a daemon-owned file in
/// bounded memory — no body-size cap — and start an import job on it. The
/// original extension is preserved so `import-pgn` decompresses .zip/.zst/.7z.
/// Works when the daemon can't read the client's files (hardened system daemon)
/// or is on a different machine. Returns the job id; the client follows
/// `/jobs/{id}/events` as usual. `body` must be the final extractor.
#[derive(Deserialize)]
struct BackupDownloadQuery {
    collection: String,
}

/// Build a `.pgn.zip` backup of a collection and stream it to the client (#121).
/// The hardened daemon can't write to the user's home (ProtectHome), so rather
/// than save server-side (where the user can't reach or "reveal" it) it hands the
/// bytes to the GUI, which saves them to a user-chosen, user-accessible path.
/// Builds into a daemon-owned temp file, streams it, and deletes it once the
/// response body is dropped (fully sent or the client disconnected).
async fn backup_download_handler(
    State(state): State<AppState>,
    Query(q): Query<BackupDownloadQuery>,
) -> std::result::Result<axum::response::Response, (StatusCode, String)> {
    let base = crate::backup_base_name(&q.collection);
    let entry_name = format!("{base}.pgn");
    let filename = format!("{base}.pgn.zip");
    let dir = state
        .db_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let tmp = dir.join(format!(".backup-dl-{base}.pgn.zip"));

    // Build on the read pool (read-only query + local file write).
    let coll = q.collection.clone();
    let tmp_build = tmp.clone();
    let built = state
        .reads
        .run(move |conn| crate::build_backup_zip(conn, &coll, &entry_name, &tmp_build, |_, _| {}))
        .await;
    if let Err(e) = built {
        let _ = std::fs::remove_file(&tmp);
        return Err((StatusCode::BAD_REQUEST, format!("{e:#}")));
    }

    let file = tokio::fs::File::open(&tmp).await.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        (StatusCode::INTERNAL_SERVER_ERROR, format!("open backup: {e}"))
    })?;
    // Known size → the client shows a real % download progress.
    let len = file.metadata().await.map(|m| m.len()).unwrap_or(0);

    // Delete the temp file once the stream is dropped: move a Drop guard into the
    // stream adapter so it lives exactly as long as the response body.
    struct TempCleanup(std::path::PathBuf);
    impl Drop for TempCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let cleanup = TempCleanup(tmp.clone());
    let stream = tokio_util::io::ReaderStream::new(file).map(move |chunk| {
        let _ = &cleanup;
        chunk
    });

    axum::response::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/zip")
        .header(axum::http::header::CONTENT_LENGTH, len)
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(Body::from_stream(stream))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("response: {e}")))
}

async fn import_upload_handler(
    State(state): State<AppState>,
    Query(q): Query<ImportUploadQuery>,
    body: Body,
) -> ApiResult<serde_json::Value> {
    let dir = state
        .db_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Never trust an arbitrary client extension — allow only the ingest types.
    let ext = q
        .filename
        .as_deref()
        .and_then(|f| std::path::Path::new(f).extension())
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| matches!(e.as_str(), "pgn" | "zip" | "zst" | "zstd" | "7z"))
        .unwrap_or_else(|| "pgn".to_string());
    let spool = dir.join(format!("upload-{stamp}.{ext}"));

    // Stream the request body to the spool file (bounded memory).
    let mut file = tokio::fs::File::create(&spool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("create upload spool: {e}")))?;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                // Client aborted / network drop: don't leave a partial spool.
                let _ = tokio::fs::remove_file(&spool).await;
                return Err((StatusCode::BAD_REQUEST, format!("upload stream error: {e}")));
            }
        };
        if let Err(e) = file.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(&spool).await;
            return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("write upload spool: {e}")));
        }
    }
    file.flush()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("flush upload spool: {e}")))?;
    drop(file);

    // A large upload defers dedup to the background: skip inline dedup on the
    // import (no per-game fingerprinting / growing in-memory fingerprint map to
    // slow a multi-million-game load) and instead include one global dedup_games
    // in the coalesced maintenance. A small upload dedups inline as before and
    // needs no whole-DB dedup pass. Sized from the spooled bytes, matching the
    // importer's own bulk-mode estimate (#154).
    let bulk = tokio::fs::metadata(&spool)
        .await
        .map(|m| crate::importer::is_bulk_size(m.len()))
        .unwrap_or(false);

    // Import the uploaded file, then request post-import maintenance (#131),
    // debounced + coalesced by the JobManager to run once after the whole import
    // queue drains — so importing several files, or a file during the wizard's
    // first-run, triggers a single tail pass instead of one per import, and later
    // imports never miss it. Inline position indexing is skipped here (depth 0)
    // so the coalesced index_positions job does that work and shows its progress.
    let import_params = serde_json::json!({
        "path": spool.to_string_lossy(),
        "collection": q.collection.unwrap_or_else(|| "Manual".to_string()),
        // Original filename (spool path is an opaque upload-<stamp>.<ext>), kept
        // so the activity panel can show what's importing, not just where it lands.
        "filename": q.filename,
        "private": q.private,
        "fast": q.fast,
        "skip_dedup": bulk,
        "on_duplicate": q.on_duplicate.unwrap_or_else(|| "skip".to_string()),
        "max_position_depth": 0,
        // Delete the spool once the import finishes (see jobs.rs import_pgn).
        "cleanup": true,
    });
    let id = state.jobs.submit("import_pgn".to_string(), import_params);
    // One coalesced identity-first pass regardless of upload size — `dedup_games`
    // is incremental (#—). A bulk upload still sets `skip_dedup` above so its
    // games are deduped by that single pass rather than inline during import.
    state.jobs.request_maintenance();
    // The client follows the import job for the upload→import handoff; the
    // coalesced maintenance jobs then appear and run on their own in the queue.
    Ok(Json(serde_json::json!({ "job_id": id })))
}

async fn list_jobs_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let mut jobs = serde_json::to_value(state.jobs.list()).unwrap_or_else(|_| serde_json::json!([]));
    // Coalesced maintenance (#131) isn't enqueued until the import queue drains,
    // so while an import is in flight it would otherwise be invisible. Surface a
    // synthetic "queued" pending row so the activity panel shows it's coming.
    // Only here (not in JobManager::list, which the scheduler introspects).
    if state.jobs.maintenance_owed() {
        if let Some(arr) = jobs.as_array_mut() {
            arr.push(serde_json::json!({
                "id": "maintenance-pending",
                "type": "maintenance_pending",
                "status": "queued",
                "value": 0,
                "total": 0,
                "message": "Runs after the import finishes",
                "interruptible": false,
                "cancellable": false,
                "params": {},
            }));
        }
    }
    Json(jobs)
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
    // The synthetic "maintenance-pending" row isn't a real job — cancelling it
    // means "don't run the coalesced maintenance", i.e. clear the owed flags.
    if id == "maintenance-pending" {
        state.jobs.clear_maintenance();
        return Ok(StatusCode::NO_CONTENT);
    }
    if state.jobs.cancel(&id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, format!("job {} not found", id)))
    }
}

/// "Retry now" for a job paused waiting for the network (#206): re-run it at once
/// instead of waiting out the retry timer. No-op unless it's currently waiting.
async fn retry_job_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> std::result::Result<StatusCode, (StatusCode, String)> {
    if state.jobs.retry_now(&id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::CONFLICT, format!("job {} is not waiting to retry", id)))
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

// ── First-run setup pipeline (#40 C4) ─────────────────────────────────────────

/// Start the wizard's first-run pipeline. For each enabled source (deep-history
/// first) enqueue a `download` then a `--fast` `import` with inline dedup skipped
/// — a single global `dedup_games` runs at the end, followed by
/// `index_positions --fast` and `normalise`. All are existing job types, so the
/// activity-indicator queue *is* the progress view. Fast mode is safe because the
/// database is empty/disposable; a sentinel marks the load so an interruption
/// recovers cleanly (startup safety-net + reset).
async fn setup_start_handler(State(state): State<AppState>) -> ApiResult<serde_json::Value> {
    let sources = state
        .reads
        .run(crate::sources::enabled_sources_ordered)
        .await
        .map_err(db_err)?;

    // Finishing the wizard opens the background auto-sync gate (#40 C4), whether
    // or not any source was chosen — so sources enabled later (Sources screen) or
    // an "empty database" setup both get normal auto-sync afterwards. Runs before
    // the pipeline jobs are queued so it isn't stuck behind them on the writer.
    state
        .writer
        .run(|c| {
            let _ = c.execute("UPDATE schedule SET setup_completed = TRUE WHERE id = 1", []);
        })
        .await;

    if sources.is_empty() {
        // "Empty database" choice — nothing to import or prepare.
        return Ok(Json(serde_json::json!({ "job_ids": [] })));
    }

    crate::jobs::write_setup_sentinel(&state.db_path);
    *state.setup.lock().unwrap() = SetupPhase::Running;

    let ids = spawn_first_run_pipeline(&state, &sources);
    Ok(Json(serde_json::json!({ "job_ids": ids })))
}

/// Enqueue the first-run pipeline — a `download` + fast `import` per enabled
/// source (deep-history first) — then request the coalesced identity-first
/// maintenance tail and spawn the watcher that settles the setup phase. Returns
/// the job ids.
///
/// Shared by the wizard's `/setup/start` and the startup resume (#134). Safe to
/// re-run: imports are idempotent (the ledger skips already-imported issues), so
/// a resumed pipeline continues a partly-loaded source instead of restarting it.
///
/// The coalesced tail (#131/#167) is requested rather than enqueued at a fixed
/// position: first-run is a large import, so it gets the FULL identity-first
/// pipeline (resolve-fide → dedup_players → normalise → dedup_games → index).
/// Coalescing means a source enabled mid-wizard, or an own-PGN import, is covered
/// by the same one pass that runs once every import drains — no maintenance
/// stranded ahead of later imports.
fn spawn_first_run_pipeline(
    state: &AppState,
    sources: &[&'static crate::sources::CatalogSource],
) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    // One cluster for the whole batch: if the first source's sync pauses offline,
    // the others wait behind it rather than each running and pausing too (#206).
    let cluster = state.jobs.next_cluster_id();
    for s in sources {
        // A Download + Import pair per source (#244): separate activity entries
        // with their own durations, so the network phase and the DB phase are
        // individually measurable. FIFO keeps each import behind its download;
        // the shared cluster keeps everything behind an offline-paused download
        // (#206).
        ids.push(state.jobs.submit_in_cluster(
            "sources_download".into(),
            serde_json::json!({ "source": s.key }),
            Some(cluster.clone()),
        ));
        ids.push(state.jobs.submit_in_cluster(
            "sources_import".into(),
            serde_json::json!({ "source": s.key }),
            Some(cluster.clone()),
        ));
        keys.push(s.key.to_string());
    }
    // First-run requests the one identity-first maintenance pass, coalesced with
    // each sync's own request. There's a single pass now that `dedup_games` is
    // incremental (#—) — no light/full distinction to force here.
    state.jobs.request_maintenance();
    spawn_setup_watcher(state.clone(), ids.clone(), keys);
    ids
}

/// A first-run load makes no forward progress across this many restarts before we
/// stop auto-resuming it and fall back to `Failed` (offer a Reset) — a backstop
/// against a job that panics mid-load on every boot (#134). "Progress" is the
/// imported-issue count growing, so ordinary multi-session resumes (a user who
/// closes the laptop night after night) never trip it; only a genuinely stuck
/// load does.
const SETUP_RESUME_CAP: u32 = 3;

/// The attempt number for a resume, given the `(attempts, imported)` recorded on
/// the last boot and the imported count observed now: forward progress resets the
/// counter to 0, no progress increments it. A return `>= SETUP_RESUME_CAP` means
/// give up (see [`resume_interrupted_setup`]).
fn next_setup_attempt(prev_attempts: u32, prev_imported: u64, imported_now: u64) -> u32 {
    if imported_now > prev_imported { 0 } else { prev_attempts + 1 }
}

/// Resume an interrupted first-run load (#134). The wizard sets `setup_completed`
/// up front and marks the load with a sentinel that it clears on success; booting
/// with the sentinel still present means the pipeline died mid-load. Rather than
/// dead-end at `Failed` (whose only offered action is a destructive Reset that
/// re-downloads everything), re-derive the remaining work from the durable ledger
/// and resume it. A progress-aware attempt cap (`SETUP_RESUME_CAP`) prevents a
/// poison job from boot→crash→boot forever.
///
/// Runs once at startup, before the HTTP server accepts requests. The unopenable-
/// database case is already handled earlier (the `main.rs` safety-net wipes it and
/// clears the sentinel); reaching here means the DB opened, so a resume is safe.
async fn resume_interrupted_setup(state: &AppState) {
    let sources = state
        .reads
        .run(crate::sources::enabled_sources_ordered)
        .await
        .unwrap_or_default();
    if sources.is_empty() {
        // Nothing enabled to resume (e.g. an "empty database" setup that should
        // never have left a sentinel) — clear it and carry on idle.
        crate::jobs::remove_setup_sentinel(&state.db_path);
        return;
    }

    // Stale-sentinel self-heal (#143). If the DB already holds games and no enabled
    // source still owes work — every one has a recorded run and nothing downloaded
    // is left unimported — the first-run finished and this sentinel is stale (a
    // wizard that didn't clear it, or a DB populated out-of-band). Clear it and go
    // Idle rather than resuming (which would needlessly re-import) or showing
    // "preparing" on a healthy populated database. This also un-arms the startup
    // auto-delete and restores the snapshot guard's fast path for this DB.
    let owed: i64 = state
        .reads
        .run(|c| {
            c.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM sources WHERE enabled = TRUE AND last_run IS NULL)
                  + (SELECT COUNT(*) FROM source_items si JOIN sources s ON s.key = si.source_key
                     WHERE s.enabled = TRUE AND si.downloaded = TRUE AND si.imported = FALSE)",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| anyhow::anyhow!(e))
        })
        .await
        .unwrap_or(0);
    let has_games: bool = state
        .reads
        .run(|c| -> anyhow::Result<bool> {
            Ok(c.query_row("SELECT 1 FROM games LIMIT 1", [], |_| Ok(())).is_ok())
        })
        .await
        .unwrap_or(false);
    if has_games && owed == 0 {
        crate::jobs::remove_setup_sentinel(&state.db_path);
        *state.setup.lock().unwrap() = SetupPhase::Idle;
        eprintln!("First-run setup already complete (populated database, nothing pending) — cleared a stale setup marker.");
        return;
    }

    let imported_now: u64 = state
        .reads
        .run(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM source_items WHERE imported = TRUE",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n as u64)
            .map_err(|e| anyhow::anyhow!(e))
        })
        .await
        .unwrap_or(0);

    let (prev_attempts, prev_imported) = crate::jobs::read_setup_sentinel(&state.db_path);
    let attempts = next_setup_attempt(prev_attempts, prev_imported, imported_now);

    if attempts >= SETUP_RESUME_CAP {
        eprintln!(
            "First-run setup has not progressed across {SETUP_RESUME_CAP} restarts \
             ({imported_now} issue(s) imported) — not auto-resuming. Reset from the app to retry."
        );
        *state.setup.lock().unwrap() = SetupPhase::Failed;
        return;
    }

    crate::jobs::set_setup_sentinel(&state.db_path, attempts, imported_now);
    eprintln!(
        "Resuming interrupted first-run setup ({} issue(s) imported so far).",
        imported_now
    );
    *state.setup.lock().unwrap() = SetupPhase::Running;
    let _ = spawn_first_run_pipeline(state, &sources);
}

/// Watch the first-run pipeline and settle the setup phase: on success, record
/// each source's sync run (so the scheduler won't re-import it), clear the
/// sentinel and return to `Idle`; on any job error, mark `Failed`, cancel the
/// rest, and leave the sentinel so the user is offered a reset.
fn spawn_setup_watcher(state: AppState, ids: Vec<String>, source_keys: Vec<String>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let snaps: Vec<Option<JobSnapshot>> =
                ids.iter().map(|id| state.jobs.snapshot(id)).collect();
            // A job failed → setup failed: stop the rest, keep the sentinel so the
            // user is offered "Reset & start over".
            if snaps.iter().any(|s| matches!(s, Some(sn) if sn.status == "error")) {
                for id in &ids { state.jobs.cancel(id); }
                *state.setup.lock().unwrap() = SetupPhase::Failed;
                break;
            }
            // A job vanished (registry cleared by a restart) → stop; the startup
            // safety-net handles the partially-set-up database.
            if snaps.iter().any(Option::is_none) {
                break;
            }
            // All jobs terminal → success. A `cancelled` job (e.g. the user
            // disabled that source mid-setup, #191) counts as done-enough: setup
            // settles for the sources that remain instead of spinning forever
            // waiting for a job that will never reach `done`.
            if snaps.iter().all(|s| matches!(s, Some(sn) if sn.status == "done" || sn.status == "cancelled")) {
                let keys = source_keys.clone();
                state.writer.run(move |conn| {
                    for k in &keys {
                        let _ = crate::sources::record_run(conn, k, "ok");
                    }
                }).await;
                crate::jobs::remove_setup_sentinel(&state.db_path);
                *state.setup.lock().unwrap() = SetupPhase::Idle;
                break;
            }
        }
    });
}

/// Reset to a fresh empty database — clean recovery from an interrupted/failed
/// first-run load. Cancels in-flight jobs, then drops + recreates the database on
/// an empty schema. The user re-runs the wizard afterwards.
async fn setup_reset_handler(State(state): State<AppState>) -> ApiResult<serde_json::Value> {
    // Reset must run with the writer idle: it swaps every connection at once, and
    // a write job running mid-swap could error into the #82 recovery reopen and
    // race this reset's reopen (two gates competing for the same actors). The
    // Reset action is only offered on the failed/idle state, so this is a guard
    // against a stray call, not a normal path.
    if state.jobs.list().iter().any(|j| j.status == "running") {
        return Err((
            StatusCode::CONFLICT,
            "An operation is still running — wait for it to finish or cancel it before resetting."
                .to_string(),
        ));
    }
    // Cancel anything still queued so it doesn't run ahead of the reopen.
    for j in state.jobs.list() {
        if j.status == "queued" {
            state.jobs.cancel(&j.id);
        }
    }
    let writer = state.writer.clone();
    let reads = state.reads.clone();
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || crate::jobs::reset_connections(&writer, &reads, db_path))
        .await
        .map_err(db_err)?;
    *state.setup.lock().unwrap() = SetupPhase::Idle;
    Ok(Json(serde_json::json!({ "ok": true })))
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

/// Delete stale `upload-*` spool + staged-decompression entries a manual import
/// (`/import/upload`, #154) leaked. A clean import removes its own spool (jobs.rs)
/// and its staged file (a `Drop` guard), but a hard crash or kill skips both, so
/// they leak — some are multi-GB. Safe to run at startup: no import is in flight,
/// so every `upload-*` entry is orphaned. Covers `upload-<stamp>.{pgn,zip,zst,7z}`,
/// the `.import-tmp.pgn` staged `.zip` decode, and the `.7z-import-tmp` directory
/// (all share the `upload-` prefix; the DB's own `chess.db*` files never match).
fn sweep_orphan_uploads(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut removed = 0u32;
    for entry in rd.flatten() {
        if !entry.file_name().to_string_lossy().starts_with("upload-") {
            continue;
        }
        let path = entry.path();
        let ok = if path.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if ok {
            removed += 1;
        }
    }
    if removed > 0 {
        eprintln!("Removed {removed} orphaned upload file(s) left by a previously-interrupted import.");
    }
}

pub async fn run(conn: Connection, port: u16, db_path: std::path::PathBuf) -> Result<()> {
    // Clear any upload spool/temp files leaked by an import that crashed or was
    // killed before its own cleanup ran — none are in use at startup.
    if let Some(dir) = db_path.parent() {
        sweep_orphan_uploads(dir);
    }

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
    let jobs = Arc::new(JobManager::new(
        writer.clone(),
        reads.clone(),
        tokio::runtime::Handle::current(),
        db_path.clone(),
    ));

    // Server-owned update scheduler: submits the `update` job when due, and skips
    // its work while a first-run setup is in progress (db_path lets it check the
    // sentinel).
    crate::scheduler::spawn(jobs.clone(), reads.clone(), db_path.clone());

    let setup = Arc::new(std::sync::Mutex::new(SetupPhase::Idle));
    let state = AppState { reads, writer, jobs, db_path, setup };

    // A leftover sentinel means a prior first-run setup didn't finish cleanly. The
    // unbootable case was already handled by the startup safety-net (which wipes +
    // clears it); reaching here with the sentinel present means the DB opened but
    // the load was interrupted. Resume it from the durable ledger (#134) rather
    // than dead-ending at Failed — deep-history sources (Ajedrez) that were still
    // downloading when the machine shut down continue instead of vanishing. The
    // resume caps repeated no-progress attempts and falls back to Failed itself.
    if crate::jobs::setup_sentinel_present(&state.db_path) {
        resume_interrupted_setup(&state).await;
    }

    let app = Router::new()
        .route("/status",                              get(status_handler))
        .route("/collections",                         get(collections_handler))
        .route("/sources",                             get(sources_handler))
        .route("/sources/{key}/enabled",               post(set_source_enabled_handler))
        .route("/schedule",                            get(get_schedule_handler).post(set_schedule_handler))
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
        // First-run setup pipeline (#40 C4): start the fast import→prepare queue,
        // and reset to a clean empty DB if it was interrupted/failed.
        .route("/setup/start",                         post(setup_start_handler))
        .route("/setup/reset",                         post(setup_reset_handler))
        .route("/position",                            get(position_handler))
        .route("/position/moves",                      get(position_moves_handler))
        .route("/cloud-eval",                          get(cloud_eval_handler))
        .route("/cloud-eval/lines",                    get(cloud_eval_lines_handler))
        .route("/cloud-eval/queue",                    post(cloud_eval_queue_handler))
        .route("/cloud-eval/watch",                    post(cloud_watch_add_handler).delete(cloud_watch_delete_handler))
        .route("/cloud-eval/watches",                  get(cloud_watches_handler))
        .route("/lichess-eval",                        get(lichess_eval_handler))
        // Long-running mutation jobs with streamed progress.
        .route("/jobs",                                get(list_jobs_handler).post(create_job_handler))
        // Streamed PGN upload (#154): disable the default body-size cap so a
        // multi-GB file streams straight to a spool + import job.
        .route("/import/upload", post(import_upload_handler).layer(DefaultBodyLimit::disable()))
        .route("/backup/download", get(backup_download_handler))
        .route("/jobs/{id}",                           get(get_job_handler))
        .route("/jobs/{id}/events",                    get(job_events_handler))
        .route("/jobs/{id}/cancel",                    post(cancel_job_handler))
        .route("/jobs/{id}/retry",                     post(retry_job_handler))
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

#[cfg(test)]
mod games_sql_tests {
    use super::build_games_sql;

    // Games page: Player 1 + Player 2 both resolved to ids (autocomplete).
    fn sql(player_id: Option<u32>, opponent_id: Option<u32>, opponent: Option<&str>, color: &str) -> String {
        build_games_sql(
            None, None, player_id, Some(color), opponent, opponent_id,
            None, None, None, None, // white/black + fide
            None, None, None, None, None, // event, eco, first_moves, from, to
            None, None, None, // fen_hash, collection_id, visibility
            false, false, false, // include_deleted, include_pgn, count
            100, 0,
        ).0
    }

    #[test]
    fn two_player_ids_any_colour_match_either_way() {
        let s = sql(Some(1), Some(2), None, "any");
        assert!(
            s.contains("(g.white_id = ? AND g.black_id = ?) OR (g.white_id = ? AND g.black_id = ?)"),
            "{s}"
        );
    }

    #[test]
    fn two_player_ids_colour_specific() {
        assert!(sql(Some(1), Some(2), None, "white").contains("g.white_id = ? AND g.black_id = ?"));
        assert!(sql(Some(1), Some(2), None, "black").contains("g.black_id = ? AND g.white_id = ?"));
    }

    #[test]
    fn opponent_name_path_is_unchanged_without_opponent_id() {
        let s = sql(Some(1), None, Some("carlsen"), "any");
        assert!(s.contains("name_normalized LIKE"), "{s}");
        // Not the id-based two-player predicate.
        assert!(!s.contains("g.black_id = ? AND g.white_id = ?"), "{s}");
    }
}

#[cfg(test)]
mod setup_resume_tests {
    use super::{next_setup_attempt, SETUP_RESUME_CAP};

    // Forward progress (more issues imported than last boot) resets the counter,
    // so a user resuming a big load across several sessions never trips the cap.
    #[test]
    fn progress_resets_the_attempt_counter() {
        assert_eq!(next_setup_attempt(2, 100, 250), 0);
        assert_eq!(next_setup_attempt(0, 0, 1), 0);
    }

    // No new issues imported → increment; enough no-progress boots reach the cap.
    #[test]
    fn no_progress_climbs_to_the_cap() {
        assert_eq!(next_setup_attempt(0, 100, 100), 1);
        assert_eq!(next_setup_attempt(1, 100, 100), 2);
        // A fresh count lower than recorded (e.g. a wipe) is not progress.
        assert_eq!(next_setup_attempt(1, 100, 50), 2);
        // Give-up boundary.
        assert!(next_setup_attempt(SETUP_RESUME_CAP - 1, 100, 100) >= SETUP_RESUME_CAP);
    }
}

#[cfg(test)]
mod sweep_orphan_uploads_tests {
    use super::sweep_orphan_uploads;
    use std::fs;

    // Every `upload-*` form (spool, staged decode, 7z temp dir) is removed, while
    // the database and its WAL — which never carry the prefix — are left alone.
    #[test]
    fn removes_upload_leftovers_but_keeps_the_database() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lpdo-sweep-test-{stamp}"));
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join("upload-1.pgn"), b"x").unwrap();
        fs::write(dir.join("upload-2.zip"), b"x").unwrap();
        fs::write(dir.join("upload-3.import-tmp.pgn"), b"x").unwrap();
        fs::create_dir_all(dir.join("upload-4.7z-import-tmp")).unwrap();
        fs::write(dir.join("upload-4.7z-import-tmp").join("inner.pgn"), b"x").unwrap();
        fs::write(dir.join("chess.db"), b"db").unwrap();
        fs::write(dir.join("chess.db.wal"), b"wal").unwrap();

        sweep_orphan_uploads(&dir);

        assert!(!dir.join("upload-1.pgn").exists());
        assert!(!dir.join("upload-2.zip").exists());
        assert!(!dir.join("upload-3.import-tmp.pgn").exists());
        assert!(!dir.join("upload-4.7z-import-tmp").exists());
        assert!(dir.join("chess.db").exists(), "database must survive");
        assert!(dir.join("chess.db.wal").exists(), "WAL must survive");

        let _ = fs::remove_dir_all(&dir);
    }
}
