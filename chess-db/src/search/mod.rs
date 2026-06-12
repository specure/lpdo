use anyhow::Result;
use duckdb::Connection;
use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::zobrist::{Zobrist64, ZobristHash};
use shakmaty::{Chess, EnPassantMode, Position};

/// Strip move numbers from a human-readable move sequence.
/// "1.e4 e6 2.d4 d5" → "e4 e6 d4 d5"
/// "1. e4 e6 2. d4 d5" → "e4 e6 d4 d5"
fn parse_first_moves(input: &str) -> String {
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

fn normalize_name(name: &str) -> String {
    name.to_lowercase()
        .replace(',', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn format_opening_line(line: &str) -> String {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let mut out = String::new();
    for (i, token) in tokens.iter().enumerate() {
        if i > 0 { out.push(' '); }
        if i % 2 == 0 { out.push_str(&format!("{}.", i / 2 + 1)); }
        out.push_str(token);
    }
    out
}

/// Unified game search. Use `name`/`fide_id` to search by player (either color),
/// or `white`/`black`/`white_fide_id`/`black_fide_id` for color-specific search.
/// Optionally filter by `fen` (position reached), which requires the positions table.
#[allow(clippy::too_many_arguments)]
pub fn games(
    conn: &Connection,
    name: Option<&str>,
    fide_id: Option<u32>,
    white: Option<&str>,
    black: Option<&str>,
    white_fide_id: Option<u32>,
    black_fide_id: Option<u32>,
    event: Option<&str>,
    eco: Option<&str>,
    first_moves: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    fen: Option<&str>,
    show_moves: bool,
    limit: u32,
    pgn: bool,
    count_only: bool,
) -> Result<()> {
    // Parse FEN early so we fail fast on invalid input
    let fen_hash: Option<i64> = if let Some(fen_str) = fen {
        let parsed_fen: Fen = fen_str.parse()?;
        let board: Chess = parsed_fen.into_position(shakmaty::CastlingMode::Standard)?;
        let hash: Zobrist64 = board.zobrist_hash(EnPassantMode::Legal);
        Some(hash.0 as i64)
    } else {
        None
    };

    let pos_join    = if fen.is_some() { "JOIN positions pos ON pos.game_id = g.id" } else { "" };
    let fen_filter  = if fen.is_some() { "AND pos.zobrist_hash = ?"                 } else { "" };
    // col 10 = opening_line (always), col 11 = pgn (if pgn=true), col 11/12 = move_number (if fen)
    let pgn_col_sql  = if pgn          { ", g.pgn"          } else { "" };
    let move_col_sql = if fen.is_some() { ", pos.move_number" } else { "" };

    let mut param_vals: Vec<Box<dyn duckdb::ToSql>> = Vec::new();

    // Common metadata filters (appended after the player filter in every path)
    let event_filter     = if event.is_some()       { "AND g.event LIKE ?"        } else { "" };
    let eco_filter       = if eco.is_some()          { "AND g.eco LIKE ?"          } else { "" };
    let moves_filter     = if first_moves.is_some()  { "AND g.opening_line LIKE ?" } else { "" };
    let date_from_filter = if from.is_some()         { "AND g.date >= ?"           } else { "" };
    let date_to_filter   = if to.is_some()           { "AND g.date <= ?"           } else { "" };

    let sql = if name.is_some() || fide_id.is_some() {
        // ── Player mode: match either color ───────────────────────────────────
        let color_filter = "AND (g.white_id = p.id OR g.black_id = p.id)";
        let player_filter = if fide_id.is_some() { "AND p.fide_id = ?" } else { "AND p.name_normalized LIKE ?" };
        if let Some(id) = fide_id {
            param_vals.push(Box::new(id));
        } else {
            param_vals.push(Box::new(format!("%{}%", normalize_name(name.unwrap()))));
        }
        if let Some(f) = from        { param_vals.push(Box::new(f.to_string())); }
        if let Some(t) = to          { param_vals.push(Box::new(t.to_string())); }
        if let Some(e) = event       { param_vals.push(Box::new(format!("%{}%", e))); }
        if let Some(e) = eco         { param_vals.push(Box::new(format!("{}%", e))); }
        if let Some(fm) = first_moves { param_vals.push(Box::new(format!("{}%", parse_first_moves(fm)))); }

        if count_only {
            format!(
                "SELECT COUNT(*) FROM games g
                 JOIN players p  ON (g.white_id = p.id OR g.black_id = p.id)
                 JOIN players pw ON g.white_id = pw.id
                 JOIN players pb ON g.black_id = pb.id
                 {pos_join}
                 WHERE 1=1 {player_filter} {color_filter}
                 {date_from_filter} {date_to_filter} {event_filter} {eco_filter} {moves_filter} {fen_filter}"
            )
        } else {
            format!(
                "SELECT g.id, pw.name, pb.name, g.white_elo, g.black_elo,
                        g.event, g.date, g.result, g.eco, g.move_count, g.opening_line{pgn_col_sql}{move_col_sql}
                 FROM games g
                 JOIN players p  ON (g.white_id = p.id OR g.black_id = p.id)
                 JOIN players pw ON g.white_id = pw.id
                 JOIN players pb ON g.black_id = pb.id
                 {pos_join}
                 WHERE 1=1 {player_filter} {color_filter}
                 {date_from_filter} {date_to_filter} {event_filter} {eco_filter} {moves_filter} {fen_filter}
                 ORDER BY g.date DESC LIMIT {limit}"
            )
        }
    } else {
        // ── White/black mode: color-specific filters ──────────────────────────
        let mut conditions: Vec<String> = Vec::new();
        if let Some(id) = white_fide_id {
            conditions.push("pw.fide_id = ?".into());
            param_vals.push(Box::new(id));
        } else if let Some(w) = white {
            conditions.push("pw.name_normalized LIKE ?".into());
            param_vals.push(Box::new(format!("%{}%", normalize_name(w))));
        }
        if let Some(id) = black_fide_id {
            conditions.push("pb.fide_id = ?".into());
            param_vals.push(Box::new(id));
        } else if let Some(b) = black {
            conditions.push("pb.name_normalized LIKE ?".into());
            param_vals.push(Box::new(format!("%{}%", normalize_name(b))));
        }
        if let Some(f) = from        { param_vals.push(Box::new(f.to_string())); }
        if let Some(t) = to          { param_vals.push(Box::new(t.to_string())); }
        if let Some(e) = event       { param_vals.push(Box::new(format!("%{}%", e))); }
        if let Some(e) = eco         { param_vals.push(Box::new(format!("{}%", e))); }
        if let Some(fm) = first_moves { param_vals.push(Box::new(format!("{}%", parse_first_moves(fm)))); }

        let where_clause = if conditions.is_empty() {
            "1=1".to_string()
        } else {
            conditions.join(" AND ")
        };

        if count_only {
            format!(
                "SELECT COUNT(*) FROM games g
                 JOIN players pw ON g.white_id = pw.id
                 JOIN players pb ON g.black_id = pb.id
                 {pos_join}
                 WHERE {where_clause}
                 {date_from_filter} {date_to_filter} {event_filter} {eco_filter} {moves_filter} {fen_filter}"
            )
        } else {
            format!(
                "SELECT g.id, pw.name, pb.name, g.white_elo, g.black_elo,
                        g.event, g.date, g.result, g.eco, g.move_count, g.opening_line{pgn_col_sql}{move_col_sql}
                 FROM games g
                 JOIN players pw ON g.white_id = pw.id
                 JOIN players pb ON g.black_id = pb.id
                 {pos_join}
                 WHERE {where_clause}
                 {date_from_filter} {date_to_filter} {event_filter} {eco_filter} {moves_filter} {fen_filter}
                 ORDER BY g.date DESC LIMIT {limit}"
            )
        }
    };

    // FEN hash is always the last param (after all other filters)
    if let Some(hash) = fen_hash {
        param_vals.push(Box::new(hash));
    }

    let params_ref: Vec<&dyn duckdb::ToSql> = param_vals.iter().map(|p| p.as_ref()).collect();

    if count_only {
        let total: i64 = conn.query_row(&sql, params_ref.as_slice(), |r| r.get(0))?;
        println!("{}", total);
        return Ok(());
    }

    // Determine dynamic column indices
    // col 10 = opening_line (always)
    // col 11 = pgn (if pgn=true)
    // col 11 or 12 = move_number (if fen is set)
    let pgn_col_idx: Option<usize>      = if pgn          { Some(11) } else { None };
    let move_num_col_idx: Option<usize> = if fen.is_some() { Some(if pgn { 12 } else { 11 }) } else { None };

    let mut stmt = conn.prepare(&sql)?;
    let mut count = 0;

    if let Some(move_col) = move_num_col_idx {
        if let Some(pgn_col) = pgn_col_idx {
            // pgn + fen: 13 cols (0-12)
            let rows = stmt.query_map(params_ref.as_slice(), |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i16>>(3)?,
                    row.get::<_, Option<i16>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<i16>>(9)?,
                    row.get::<_, Option<String>>(10)?,  // opening_line
                    row.get::<_, Option<String>>(pgn_col)?,  // pgn
                    row.get::<_, i16>(move_col)?,  // move_number
                ))
            })?;
            for row in rows.flatten() {
                let (id, white, black, w_elo, b_elo, event, date, result, eco, moves, opening_line, pgn_text, move_num) = row;
                if pgn_text.is_some() {
                    if let Some(ref p) = pgn_text {
                        println!("{}", p);
                    }
                } else {
                    println!(
                        "[{}] {} ({}) vs {} ({})  {}  {}  {}  {}  {} moves  move {}",
                        id,
                        white,
                        w_elo.map(|e| e.to_string()).unwrap_or("-".into()),
                        black,
                        b_elo.map(|e| e.to_string()).unwrap_or("-".into()),
                        result.unwrap_or("-".into()),
                        date.unwrap_or("-".into()),
                        event.unwrap_or("-".into()),
                        eco.unwrap_or("-".into()),
                        moves.unwrap_or(0),
                        move_num,
                    );
                    if show_moves {
                        if let Some(ref line) = opening_line {
                            println!("  {}", format_opening_line(line));
                        }
                    }
                }
                count += 1;
            }
        } else {
            // no pgn + fen: 12 cols (0-11)
            let rows = stmt.query_map(params_ref.as_slice(), |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i16>>(3)?,
                    row.get::<_, Option<i16>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<i16>>(9)?,
                    row.get::<_, Option<String>>(10)?,  // opening_line
                    row.get::<_, i16>(move_col)?,  // move_number
                ))
            })?;
            for row in rows.flatten() {
                let (id, white, black, w_elo, b_elo, event, date, result, eco, moves, opening_line, move_num) = row;
                println!(
                    "[{}] {} ({}) vs {} ({})  {}  {}  {}  {}  {} moves  move {}",
                    id,
                    white,
                    w_elo.map(|e| e.to_string()).unwrap_or("-".into()),
                    black,
                    b_elo.map(|e| e.to_string()).unwrap_or("-".into()),
                    result.unwrap_or("-".into()),
                    date.unwrap_or("-".into()),
                    event.unwrap_or("-".into()),
                    eco.unwrap_or("-".into()),
                    moves.unwrap_or(0),
                    move_num,
                );
                if show_moves {
                    if let Some(ref line) = opening_line {
                        println!("  {}", format_opening_line(line));
                    }
                }
                count += 1;
            }
        }
    } else if let Some(pgn_col) = pgn_col_idx {
        // pgn + no fen: 12 cols (0-11)
        let rows = stmt.query_map(params_ref.as_slice(), |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i16>>(3)?,
                row.get::<_, Option<i16>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<i16>>(9)?,
                row.get::<_, Option<String>>(10)?,  // opening_line
                row.get::<_, Option<String>>(pgn_col)?,  // pgn
            ))
        })?;
        for row in rows.flatten() {
            let (_id, _white, _black, _w_elo, _b_elo, _event, _date, _result, _eco, _moves, _opening_line, pgn_text) = row;
            if let Some(ref p) = pgn_text {
                println!("{}", p);
            }
            count += 1;
        }
    } else {
        // no pgn + no fen: 11 cols (0-10)
        let rows = stmt.query_map(params_ref.as_slice(), |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i16>>(3)?,
                row.get::<_, Option<i16>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<i16>>(9)?,
                row.get::<_, Option<String>>(10)?,  // opening_line
            ))
        })?;
        for row in rows.flatten() {
            let (id, white, black, w_elo, b_elo, event, date, result, eco, moves, opening_line) = row;
            println!(
                "[{}] {} ({}) vs {} ({})  {}  {}  {}  {}  {} moves",
                id,
                white,
                w_elo.map(|e| e.to_string()).unwrap_or("-".into()),
                black,
                b_elo.map(|e| e.to_string()).unwrap_or("-".into()),
                result.unwrap_or("-".into()),
                date.unwrap_or("-".into()),
                event.unwrap_or("-".into()),
                eco.unwrap_or("-".into()),
                moves.unwrap_or(0),
            );
            if show_moves {
                if let Some(ref line) = opening_line {
                    println!("  {}", format_opening_line(line));
                }
            }
            count += 1;
        }
    }

    if !pgn {
        println!("\n{} game(s) found (limit {})", count, limit);
    }
    Ok(())
}

pub fn game_by_id(conn: &Connection, id: u32) -> Result<()> {
    let row = conn.query_row(
        "SELECT pw.name, pb.name, g.white_elo, g.black_elo,
                g.event, g.date, g.result, g.eco, g.move_count, g.pgn
         FROM games g
         JOIN players pw ON g.white_id = pw.id
         JOIN players pb ON g.black_id = pb.id
         WHERE g.id = ?",
        duckdb::params![id],
        |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<i16>>(2)?,
            r.get::<_, Option<i16>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, Option<i16>>(8)?,
            r.get::<_, Option<String>>(9)?,
        )),
    ).map_err(|_| anyhow::anyhow!("game {} not found", id))?;

    let (white, black, w_elo, b_elo, event, date, result, eco, moves, pgn) = row;
    println!(
        "[{}] {} ({}) vs {} ({})  {}  {}  {}  {}  {} moves",
        id,
        white,
        w_elo.map(|e| e.to_string()).unwrap_or("-".into()),
        black,
        b_elo.map(|e| e.to_string()).unwrap_or("-".into()),
        result.as_deref().unwrap_or("-"),
        date.as_deref().unwrap_or("-"),
        event.as_deref().unwrap_or("-"),
        eco.as_deref().unwrap_or("-"),
        moves.unwrap_or(0),
    );
    if let Some(pgn) = pgn {
        println!("\n{}", pgn);
    }
    Ok(())
}

/// Look up exactly one player by name (exact normalized match).
/// Returns an error if zero or more than one player matches — safe for scripting.
pub fn player_id_by_exact_name(conn: &Connection, name: &str) -> Result<u32> {
    let norm = normalize_name(name);
    let mut stmt = conn.prepare(
        "SELECT id, name FROM players WHERE name_normalized = ? ORDER BY id LIMIT 2",
    )?;
    let rows: Vec<(u32, String)> = stmt
        .query_map(duckdb::params![norm], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    match rows.len() {
        0 => anyhow::bail!("no player found with exact name {:?}", name),
        1 => Ok(rows[0].0),
        _ => anyhow::bail!(
            "ambiguous name {:?} — matches: {}",
            name,
            rows.iter().map(|(id, n)| format!("[{}] {}", id, n)).collect::<Vec<_>>().join(", ")
        ),
    }
}

/// Replay a sequence of SAN moves from the starting position and return the
/// resulting `Chess` position together with its Zobrist hash.
fn moves_to_position(first_moves: &str) -> Result<(Chess, i64)> {
    let mut pos = Chess::default();
    for token in parse_first_moves(first_moves).split_whitespace() {
        let san: San = token.parse()
            .map_err(|_| anyhow::anyhow!("invalid move: {}", token))?;
        let mv = san.to_move(&pos)
            .map_err(|_| anyhow::anyhow!("illegal move: {}", token))?;
        pos.play_unchecked(mv);
    }
    let hash: Zobrist64 = pos.zobrist_hash(EnPassantMode::Legal);
    Ok((pos, hash.0 as i64))
}

/// Show aggregated move statistics for a position.
///
/// The position is specified by exactly one of `fen` or `first_moves`; if
/// neither is given the starting position is used.  All other parameters
/// narrow the game set just as they do for `search::games`.
#[allow(clippy::too_many_arguments)]
pub fn position_moves(
    conn: &Connection,
    fen: Option<&str>,
    first_moves: Option<&str>,
    name: Option<&str>,
    fide_id: Option<u32>,
    white: Option<&str>,
    black: Option<&str>,
    white_fide_id: Option<u32>,
    black_fide_id: Option<u32>,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<()> {
    use shakmaty::Color;

    let (pos, hash_i64) = if let Some(fen_str) = fen {
        let parsed: Fen = fen_str.parse()?;
        let board: Chess = parsed.into_position(shakmaty::CastlingMode::Standard)?;
        let hash: Zobrist64 = board.zobrist_hash(EnPassantMode::Legal);
        (board, hash.0 as i64)
    } else if let Some(moves) = first_moves {
        moves_to_position(moves)?
    } else {
        let board = Chess::default();
        let hash: Zobrist64 = board.zobrist_hash(EnPassantMode::Legal);
        (board, hash.0 as i64)
    };

    let side = if pos.turn() == Color::White { "White" } else { "Black" };
    let pos_desc = if let Some(fen_str) = fen {
        format!("FEN: {}", fen_str)
    } else if let Some(moves) = first_moves {
        format!("after {}", moves)
    } else {
        "starting position".to_string()
    };

    let name_pattern = name.map(|n| format!("%{}%", normalize_name(n)));
    let white_pattern = white.map(|n| format!("%{}%", normalize_name(n)));
    let black_pattern = black.map(|n| format!("%{}%", normalize_name(n)));
    let stats = crate::db::queries::position_moves(
        conn, hash_i64,
        None,
        name_pattern.as_deref(),
        fide_id,
        "any",
        white_pattern.as_deref(),
        black_pattern.as_deref(),
        white_fide_id,
        black_fide_id,
        from,
        to,
        None, // visibility — CLI doesn't expose this filter yet
    )?;
    if stats.is_empty() {
        println!("No games found for this position.");
        return Ok(());
    }

    let total: i64 = stats.iter().map(|m| m.games).sum();
    println!("\nPosition moves ({} to move, {})  —  {} game(s)\n", side, pos_desc, total);
    println!(
        "  {:<6}  {:>6}   {:>3} {:>3} {:>3}   {:<16} {:<15} Top players",
        "Move", "Games", "W%", "D%", "L%", "Elo p25/p50/p75", "Perf (±SE)"
    );
    println!("  {}", "─".repeat(74));

    for m in &stats {
        let w_pct = format!("{:.0}", m.w_pct);
        let d_pct = format!("{:.0}", m.d_pct);
        let l_pct = format!("{:.0}", m.l_pct);

        let elo_str = match (m.elo_p25, m.elo_p50, m.elo_p75) {
            (Some(p25), Some(p50), Some(p75)) =>
                format!("{:.0}/{:.0}/{:.0}", p25, p50, p75),
            _ => "—".to_string(),
        };

        let perf_str = match (m.perf, m.perf_se) {
            (Some(perf), Some(se)) => format!("{:+.0} (±{:.0})", perf, se),
            (Some(perf), None)     => format!("{:+.0}", perf),
            _                      => "—".to_string(),
        };

        let elite_str = m.elite.as_deref().unwrap_or("—");

        println!(
            "  {:<6}  {:>6}   {:>3} {:>3} {:>3}   {:<16} {:<15} {}",
            m.mv, m.games, w_pct, d_pct, l_pct, elo_str, perf_str, elite_str
        );
    }
    println!();
    Ok(())
}

pub fn players(
    conn: &Connection,
    name: &str,
    fide_id: Option<u32>,
    exact: bool,
    id_only: bool,
) -> Result<()> {
    let mut param_vals: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
    let sql = if let Some(id) = fide_id {
        param_vals.push(Box::new(id));
        "SELECT p.id, p.name, p.fide_id,
                (SELECT COUNT(*) FROM games g WHERE g.white_id = p.id OR g.black_id = p.id)
         FROM players p WHERE p.fide_id = ? ORDER BY p.name LIMIT 50".to_string()
    } else if exact {
        param_vals.push(Box::new(normalize_name(name)));
        "SELECT p.id, p.name, p.fide_id,
                (SELECT COUNT(*) FROM games g WHERE g.white_id = p.id OR g.black_id = p.id)
         FROM players p WHERE p.name_normalized = ? ORDER BY p.name LIMIT 50".to_string()
    } else {
        param_vals.push(Box::new(format!("%{}%", normalize_name(name))));
        "SELECT p.id, p.name, p.fide_id,
                (SELECT COUNT(*) FROM games g WHERE g.white_id = p.id OR g.black_id = p.id)
         FROM players p WHERE p.name_normalized LIKE ? ORDER BY p.name LIMIT 50".to_string()
    };

    let params_ref: Vec<&dyn duckdb::ToSql> = param_vals.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<(u32, String, Option<u32>, i64)> = stmt
        .query_map(params_ref.as_slice(), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    if id_only {
        match rows.len() {
            0 => anyhow::bail!("no player found matching {:?}", name),
            1 => {
                println!("{}", rows[0].0);
                return Ok(());
            }
            _ => anyhow::bail!(
                "ambiguous: {} players match {:?} — use --exact or a more specific name",
                rows.len(), name
            ),
        }
    }

    if rows.is_empty() {
        println!("No players found.");
    }
    for (id, name, fide_id, game_count) in &rows {
        let fide_str = fide_id.map(|f| f.to_string()).unwrap_or("-".into());
        println!("[{}] {}  FIDE: {}  games: {}", id, name, fide_str, game_count);
    }
    Ok(())
}
