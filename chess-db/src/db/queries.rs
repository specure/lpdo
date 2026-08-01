use anyhow::Result;
use duckdb::Connection;
use serde::Deserialize;
use std::path::Path;

/// Aggregated move statistics for a single move from a given position.
/// `Deserialize` so the CLI proxy can parse the daemon's `/position/moves`
/// JSON (field names match `serve::MoveStats`) and reuse the local renderer (#213).
#[derive(Deserialize)]
pub struct MoveStats {
    pub mv: String,
    pub games: i64,
    pub w_pct: f64,
    pub d_pct: f64,
    pub l_pct: f64,
    pub elo_p25: Option<f64>,
    pub elo_p50: Option<f64>,
    pub elo_p75: Option<f64>,
    /// Performance surplus (avg actual − avg expected) in Elo points.
    /// None when fewer than 5 games have both player and opponent Elo.
    pub perf: Option<f64>,
    pub perf_se: Option<f64>,
    /// Up to 5 highest-rated players (≥2500) who played this move, surnames only.
    pub elite: Option<String>,
    /// Most recent date this move was played (YYYY-MM-DD or partial).
    pub last_played: Option<String>,
}

/// Return aggregated move statistics for all moves played from the position
/// identified by `zobrist_hash`, optionally filtered by player and date.
///
/// `player_id`, `fide_id`, and `name_pattern` match the player on either side
/// (any color), filtered by `color` ("white", "black", or anything else = either).
/// `white_pattern`/`white_fide_id` and `black_pattern`/`black_fide_id` add
/// color-specific AND conditions (used when `--white`/`--black` CLI flags are set).
#[allow(clippy::too_many_arguments)]
pub fn position_moves(
    conn: &Connection,
    zobrist_hash: i64,
    player_id: Option<u32>,
    name_pattern: Option<&str>,  // pre-normalized LIKE pattern, e.g. "%carlsen%"
    fide_id: Option<u32>,
    color: &str,
    white_pattern: Option<&str>,
    black_pattern: Option<&str>,
    white_fide_id: Option<u32>,
    black_fide_id: Option<u32>,
    from: Option<&str>,
    to: Option<&str>,
    visibility: Option<&str>,
    collection_id: Option<i32>,
) -> Result<Vec<MoveStats>> {
    let mut params: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
    params.push(Box::new(zobrist_hash));

    let player_filter = if let Some(pid) = player_id {
        match color {
            "white" => { params.push(Box::new(pid)); "AND g.white_id = ?" }
            "black" => { params.push(Box::new(pid)); "AND g.black_id = ?" }
            _ => { params.push(Box::new(pid)); params.push(Box::new(pid));
                   "AND (g.white_id = ? OR g.black_id = ?)" }
        }
    } else if let Some(id) = fide_id {
        match color {
            "white" => { params.push(Box::new(id)); "AND pw.fide_id = ?" }
            "black" => { params.push(Box::new(id)); "AND pb.fide_id = ?" }
            _ => { params.push(Box::new(id)); params.push(Box::new(id));
                   "AND (pw.fide_id = ? OR pb.fide_id = ?)" }
        }
    } else if let Some(pat) = name_pattern {
        let pat = pat.to_string();
        match color {
            "white" => { params.push(Box::new(pat)); "AND pw.name_normalized LIKE ?" }
            "black" => { params.push(Box::new(pat)); "AND pb.name_normalized LIKE ?" }
            _ => { params.push(Box::new(pat.clone())); params.push(Box::new(pat));
                   "AND (pw.name_normalized LIKE ? OR pb.name_normalized LIKE ?)" }
        }
    } else {
        ""
    };

    // Color-specific filters (--white / --black CLI flags)
    let white_filter = if let Some(wid) = white_fide_id {
        params.push(Box::new(wid));
        "AND pw.fide_id = ?"
    } else if let Some(wp) = white_pattern {
        params.push(Box::new(wp.to_string()));
        "AND pw.name_normalized LIKE ?"
    } else {
        ""
    };

    let black_filter = if let Some(bid) = black_fide_id {
        params.push(Box::new(bid));
        "AND pb.fide_id = ?"
    } else if let Some(bp) = black_pattern {
        params.push(Box::new(bp.to_string()));
        "AND pb.name_normalized LIKE ?"
    } else {
        ""
    };

    let date_from_filter  = if from.is_some()       { "AND g.date >= ?"      } else { "" };
    let date_to_filter    = if to.is_some()         { "AND g.date <= ?"      } else { "" };
    let visibility_filter = if visibility.is_some() { "AND g.visibility = ?" } else { "" };
    let collection_filter = if collection_id.is_some() {
        "AND EXISTS (SELECT 1 FROM game_collections gc WHERE gc.game_id = g.id AND gc.collection_id = ?)"
    } else { "" };
    if let Some(f) = from       { params.push(Box::new(f.to_string())); }
    if let Some(t) = to         { params.push(Box::new(t.to_string())); }
    if let Some(v) = visibility { params.push(Box::new(v.to_string())); }
    if let Some(cid) = collection_id { params.push(Box::new(cid)); }

    let sql = format!("
        WITH pos AS (
            SELECT p.next_move,
                   g.result,
                   CASE WHEN p.move_number % 2 = 0 THEN g.white_elo ELSE g.black_elo END AS player_elo,
                   CASE WHEN p.move_number % 2 = 0 THEN g.black_elo  ELSE g.white_elo END AS opp_elo,
                   CASE WHEN p.move_number % 2 = 0 THEN pw.name      ELSE pb.name     END AS player_name,
                   g.date,
                   CASE
                       WHEN p.move_number % 2 = 0 THEN
                           CASE g.result WHEN '1-0' THEN 1.0 WHEN '1/2-1/2' THEN 0.5 WHEN '0-1' THEN 0.0 END
                       ELSE
                           CASE g.result WHEN '0-1' THEN 1.0 WHEN '1/2-1/2' THEN 0.5 WHEN '1-0' THEN 0.0 END
                   END AS score
            FROM positions p
            JOIN games g    ON p.game_id = g.id
            JOIN players pw ON g.white_id = pw.id
            JOIN players pb ON g.black_id = pb.id
            WHERE p.zobrist_hash = ?
              AND p.next_move IS NOT NULL
              AND g.result IN ('1-0', '0-1', '1/2-1/2')
              AND g.deleted_at IS NULL
              {player_filter}
              {white_filter}
              {black_filter}
              {date_from_filter}
              {date_to_filter}
              {visibility_filter}
              {collection_filter}
        ),
        agg AS (
            SELECT
                next_move,
                COUNT(*) AS games,
                ROUND(100.0 * AVG(CASE WHEN score = 1.0 THEN 1 ELSE 0 END)) AS w_pct,
                ROUND(100.0 * AVG(CASE WHEN score = 0.5 THEN 1 ELSE 0 END)) AS d_pct,
                ROUND(100.0 * AVG(CASE WHEN score = 0.0 THEN 1 ELSE 0 END)) AS l_pct,
                PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY player_elo)
                    FILTER (WHERE player_elo IS NOT NULL AND player_elo > 0) AS elo_p25,
                PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY player_elo)
                    FILTER (WHERE player_elo IS NOT NULL AND player_elo > 0) AS elo_p50,
                PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY player_elo)
                    FILTER (WHERE player_elo IS NOT NULL AND player_elo > 0) AS elo_p75,
                CASE WHEN COUNT(CASE WHEN player_elo IS NOT NULL AND player_elo > 0
                                          AND opp_elo IS NOT NULL AND opp_elo > 0 THEN 1 END) >= 3
                     THEN AVG(CASE WHEN player_elo IS NOT NULL AND player_elo > 0
                                        AND opp_elo IS NOT NULL AND opp_elo > 0
                                   THEN opp_elo + 400.0 * (2.0 * score - 1.0) - player_elo END)
                     END AS perf,
                CASE WHEN COUNT(CASE WHEN player_elo IS NOT NULL AND player_elo > 0
                                          AND opp_elo IS NOT NULL AND opp_elo > 0 THEN 1 END) >= 3
                     THEN STDDEV_SAMP(CASE WHEN player_elo IS NOT NULL AND player_elo > 0
                                                AND opp_elo IS NOT NULL AND opp_elo > 0
                                           THEN opp_elo + 400.0 * (2.0 * score - 1.0) - player_elo END)
                          / SQRT(NULLIF(COUNT(CASE WHEN player_elo IS NOT NULL AND player_elo > 0
                                                       AND opp_elo IS NOT NULL AND opp_elo > 0 THEN 1 END), 0))
                     END AS perf_se,
                MAX(date) AS last_played
            FROM pos
            GROUP BY next_move
        ),
        elite_raw AS (
            SELECT next_move,
                   split_part(player_name, ',', 1) AS surname,
                   MAX(player_elo) AS max_elo
            FROM pos
            WHERE player_elo >= 2500
            GROUP BY next_move, split_part(player_name, ',', 1)
        ),
        elite_agg AS (
            SELECT next_move,
                   array_to_string((LIST(surname ORDER BY max_elo DESC))[1:5], ', ') AS elite
            FROM elite_raw
            GROUP BY next_move
        )
        SELECT agg.next_move, agg.games, agg.w_pct, agg.d_pct, agg.l_pct,
               agg.elo_p25, agg.elo_p50, agg.elo_p75, agg.perf, agg.perf_se,
               elite_agg.elite, agg.last_played
        FROM agg
        LEFT JOIN elite_agg ON agg.next_move = elite_agg.next_move
        ORDER BY agg.games DESC");

    let params_ref: Vec<&dyn duckdb::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_ref.as_slice(), |row| {
        Ok(MoveStats {
            mv:      row.get(0)?,
            games:   row.get(1)?,
            w_pct:   row.get(2)?,
            d_pct:   row.get(3)?,
            l_pct:   row.get(4)?,
            elo_p25: row.get(5)?,
            elo_p50: row.get(6)?,
            elo_p75: row.get(7)?,
            perf:        row.get(8)?,
            perf_se:     row.get(9)?,
            elite:       row.get(10)?,
            last_played: row.get(11)?,
        })
    })?;
    Ok(rows.flatten().collect())
}

pub struct OpeningStats {
    pub line: String,
    pub games: i64,
    pub w_pct: f64,
    pub d_pct: f64,
    pub l_pct: f64,
    pub last_played: Option<String>,
}

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
    pub top_openings_white: Vec<OpeningStats>,
    pub top_openings_black: Vec<OpeningStats>,
}

fn format_opening_line(raw: &str) -> String {
    raw.split_whitespace()
        .enumerate()
        .map(|(i, mv)| {
            if i % 2 == 0 { format!("{}.{}", i / 2 + 1, mv) } else { mv.to_string() }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn query_top_openings(conn: &Connection, player_id: u32, as_white: bool) -> Result<Vec<OpeningStats>> {
    let (id_col, win_result, loss_result) = if as_white {
        ("white_id", "1-0", "0-1")
    } else {
        ("black_id", "0-1", "1-0")
    };
    let sql = format!("
        SELECT opening_line,
               COUNT(*) AS games,
               ROUND(100.0 * SUM(CASE WHEN result = '{win_result}' THEN 1 ELSE 0 END) / COUNT(*)) AS w_pct,
               ROUND(100.0 * SUM(CASE WHEN result = '1/2-1/2'     THEN 1 ELSE 0 END) / COUNT(*)) AS d_pct,
               ROUND(100.0 * SUM(CASE WHEN result = '{loss_result}' THEN 1 ELSE 0 END) / COUNT(*)) AS l_pct,
               MAX(date) AS last_played
        FROM games
        WHERE {id_col} = ?
          AND opening_line IS NOT NULL AND opening_line != ''
        GROUP BY opening_line
        ORDER BY games DESC
        LIMIT 5");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([player_id], |row| {
        let raw: String = row.get(0)?;
        Ok(OpeningStats {
            line:        format_opening_line(&raw),
            games:       row.get(1)?,
            w_pct:       row.get(2)?,
            d_pct:       row.get(3)?,
            l_pct:       row.get(4)?,
            last_played: row.get(5)?,
        })
    })?;
    Ok(rows.flatten().collect())
}

pub fn player_stats(conn: &Connection, player_id: u32) -> Result<PlayerStats> {
    // A player who has only ever played one colour has 0 games of the other,
    // so its denominator is 0 → NULLIF makes the ratio NULL → ROUND(NULL) is
    // NULL. COALESCE pins those to 0 so the non-nullable f64 reads never see a
    // NULL column (which previously surfaced as a 500).
    let row = conn.query_row(
        "SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN white_id = ? THEN 1 ELSE 0 END) AS as_white,
             SUM(CASE WHEN black_id = ? THEN 1 ELSE 0 END) AS as_black,
             COALESCE(ROUND(100.0 * SUM(CASE WHEN white_id = ? AND result = '1-0'     THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN white_id = ? THEN 1 ELSE 0 END), 0)), 0) AS white_w,
             COALESCE(ROUND(100.0 * SUM(CASE WHEN white_id = ? AND result = '1/2-1/2' THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN white_id = ? THEN 1 ELSE 0 END), 0)), 0) AS white_d,
             COALESCE(ROUND(100.0 * SUM(CASE WHEN white_id = ? AND result = '0-1'     THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN white_id = ? THEN 1 ELSE 0 END), 0)), 0) AS white_l,
             COALESCE(ROUND(100.0 * SUM(CASE WHEN black_id = ? AND result = '0-1'     THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN black_id = ? THEN 1 ELSE 0 END), 0)), 0) AS black_w,
             COALESCE(ROUND(100.0 * SUM(CASE WHEN black_id = ? AND result = '1/2-1/2' THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN black_id = ? THEN 1 ELSE 0 END), 0)), 0) AS black_d,
             COALESCE(ROUND(100.0 * SUM(CASE WHEN black_id = ? AND result = '1-0'     THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN black_id = ? THEN 1 ELSE 0 END), 0)), 0) AS black_l
         FROM games WHERE white_id = ? OR black_id = ?",
        duckdb::params![
            player_id, player_id,
            player_id, player_id, player_id, player_id, player_id, player_id,
            player_id, player_id, player_id, player_id,
            player_id, player_id,
            player_id, player_id,
        ],
        |row| Ok(PlayerStats {
            total:         row.get(0)?,
            as_white:      row.get(1)?,
            as_black:      row.get(2)?,
            white_w_pct:   row.get(3)?,
            white_d_pct:   row.get(4)?,
            white_l_pct:   row.get(5)?,
            black_w_pct:   row.get(6)?,
            black_d_pct:   row.get(7)?,
            black_l_pct:   row.get(8)?,
            top_openings_white: vec![],
            top_openings_black: vec![],
        }),
    )?;
    Ok(PlayerStats {
        top_openings_white: query_top_openings(conn, player_id, true)?,
        top_openings_black: query_top_openings(conn, player_id, false)?,
        ..row
    })
}

/// Recalculate and store `game_count` for every player in a single aggregation
/// pass over the games table. Much faster than per-player correlated subqueries.
pub fn recalculate_game_counts(conn: &Connection) -> Result<()> {
    conn.execute_batch("
        UPDATE players
        SET game_count = COALESCE(counts.total, 0)
        FROM (
            SELECT player_id, SUM(cnt) AS total FROM (
                SELECT white_id AS player_id, COUNT(*) AS cnt FROM games WHERE deleted_at IS NULL GROUP BY white_id
                UNION ALL
                SELECT black_id AS player_id, COUNT(*) AS cnt FROM games WHERE deleted_at IS NULL GROUP BY black_id
            ) sub
            GROUP BY player_id
        ) counts
        WHERE players.id = counts.player_id;

        UPDATE players SET game_count = 0 WHERE game_count IS NULL;
    ")?;
    Ok(())
}

/// Recalculate `game_count` for a single player. Excludes soft-deleted games.
pub fn recalculate_game_count_for(conn: &Connection, player_id: u32) -> Result<()> {
    conn.execute(
        "UPDATE players SET game_count = (
             SELECT COUNT(*) FROM games
             WHERE (white_id = ? OR black_id = ?) AND deleted_at IS NULL
         ) WHERE id = ?",
        duckdb::params![player_id, player_id, player_id],
    )?;
    Ok(())
}

pub fn status(conn: &Connection, db_path: &Path) -> Result<()> {
    let issue_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM source_items", [], |r| r.get(0))
        .unwrap_or(0);
    let downloaded: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM source_items WHERE downloaded = TRUE",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let imported: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM source_items WHERE imported = TRUE",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let game_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0))
        .unwrap_or(0);
    let player_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM players", [], |r| r.get(0))
        .unwrap_or(0);
    let position_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM positions", [], |r| r.get(0))
        .unwrap_or(0);

    let db_size = std::fs::metadata(db_path)
        .map(|m| format_size(m.len()))
        .unwrap_or_else(|_| "unknown".to_string());

    println!("=== Chess DB Status ===");
    println!("Database size:     {}", db_size);
    println!("Issues tracked:    {}", issue_count);
    println!("  Downloaded:      {}", downloaded);
    println!("  Imported:        {}", imported);
    println!("Games:             {}", game_count);
    println!("Players:           {}", player_count);
    println!("Positions indexed: {}", position_count);

    Ok(())
}

fn format_size(bytes: u64) -> String {
    const GB: u64 = 1024 * 1024 * 1024;
    const MB: u64 = 1024 * 1024;
    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else {
        format!("{} KB", bytes / 1024)
    }
}
