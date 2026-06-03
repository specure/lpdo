use anyhow::Result;
use duckdb::Connection;
use crate::reporter::Reporter;

/// Hard-delete a game and clean every row that references it: positions,
/// game_collections, finally games. Use this any time a game row is removed
/// for good (dedup, manual delete, purge) so we never leak orphan rows.
pub fn hard_delete_game(conn: &Connection, id: u32) -> Result<()> {
    conn.execute("DELETE FROM positions WHERE game_id = ?", duckdb::params![id])?;
    conn.execute("DELETE FROM game_collections WHERE game_id = ?", duckdb::params![id])?;
    conn.execute("DELETE FROM games WHERE id = ?", duckdb::params![id])?;
    Ok(())
}

/// Move every collection membership from `drop_id` to `keep_id` (idempotent).
/// Used by dedup so the surviving row inherits any collections the dropped row
/// belonged to — e.g. a TWIC row that's also tagged "My games" stays in both.
pub fn merge_collections(conn: &Connection, keep_id: u32, drop_id: u32) -> Result<()> {
    conn.execute(
        "INSERT INTO game_collections (game_id, collection_id)
         SELECT ?, gc.collection_id FROM game_collections gc WHERE gc.game_id = ?
         ON CONFLICT (game_id, collection_id) DO NOTHING",
        duckdb::params![keep_id, drop_id],
    )?;
    Ok(())
}

pub fn dedup_players(conn: &Connection) -> Result<()> {
    // Find all fide_ids that have more than one player row
    let dup_fide_ids: Vec<u32> = {
        let mut stmt = conn.prepare(
            "SELECT fide_id FROM players
             WHERE fide_id IS NOT NULL
             GROUP BY fide_id HAVING COUNT(*) > 1
             ORDER BY fide_id",
        )?;
        stmt.query_map([], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect()
    };

    if dup_fide_ids.is_empty() {
        println!("No duplicate players found.");
        return Ok(());
    }

    println!("Found {} fide_id(s) with duplicate player records.", dup_fide_ids.len());
    let mut merged = 0usize;

    for fide_id in &dup_fide_ids {
        // Fetch all rows for this fide_id plus their most recent game date
        let rows: Vec<(u32, String, bool, Option<String>)> = {
            let mut stmt = conn.prepare(
                "SELECT p.id, p.name, p.name_normalised, MAX(g.date) as last_date
                 FROM players p
                 LEFT JOIN games g ON (g.white_id = p.id OR g.black_id = p.id)
                 WHERE p.fide_id = ?
                 GROUP BY p.id, p.name, p.name_normalised
                 ORDER BY p.id",
            )?;
            stmt.query_map(duckdb::params![fide_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .filter_map(|r| r.ok())
            .collect()
        };

        if rows.len() < 2 {
            continue;
        }

        let survivor_idx = pick_survivor(&rows);
        let (survivor_id, survivor_name, ..) = &rows[survivor_idx];

        println!(
            "  fide_id {}: merging {} variants → \"{}\"",
            fide_id,
            rows.len(),
            survivor_name
        );
        for (id, name, normalised, _) in &rows {
            let marker = if id == survivor_id { " ← keep" } else { " → merge" };
            let norm = if *normalised { " [normalised]" } else { "" };
            println!("    [{}] {}{}{}", id, name, norm, marker);
        }

        // Reassign games to the survivor, then delete the duplicate rows.
        // Wrapped in a single batch transaction so DuckDB defers FK validation
        // to commit time (avoids spurious positions→games FK sweep on UPDATE).
        for (other_id, ..) in rows.iter().filter(|(id, ..)| id != survivor_id) {
            conn.execute("UPDATE games SET white_id = ? WHERE white_id = ?", duckdb::params![survivor_id, other_id])?;
            conn.execute("UPDATE games SET black_id = ? WHERE black_id = ?", duckdb::params![survivor_id, other_id])?;
            conn.execute("DELETE FROM players WHERE id = ?", duckdb::params![other_id])?;
            merged += 1;
        }
    }

    println!(
        "\nRemoved {} duplicate player record(s) across {} fide_id(s).",
        merged,
        dup_fide_ids.len()
    );
    Ok(())
}

/// Score a player row for survivor selection. Higher = better candidate to keep.
fn name_score(name: &str, name_normalised: bool, last_date: Option<&str>) -> i64 {
    // A normalised row always wins
    if name_normalised {
        return 1_000_000;
    }

    let mut score: i64 = 0;

    // Prefer "Lastname, Firstname" format
    if let Some((before_comma, after_comma)) = name.split_once(',') {
        score += 1000;
        let first = after_comma.trim();
        // Penalise abbreviations like "Kuthan,A" — first name is a single char
        if first.len() > 1 {
            score += 500;
        }
        // Penalise title prefixes like "MMag.", "Mag.", "Dr.", "Ing.", "Prof."
        let has_title = before_comma
            .split_whitespace()
            .any(|w| w.ends_with('.') && w.len() > 1);
        if has_title {
            score -= 300;
        }
    }

    // Recency tiebreaker: "YYYY-MM-DD" sorts lexicographically so parse numeric
    if let Some(date) = last_date {
        let numeric: i64 = date.replace('-', "").parse().unwrap_or(0);
        // Scale down so it doesn't swamp the name-quality scores
        score += numeric / 10_000;
    }

    score
}

/// Pull a single PGN tag value (e.g. "White") from a game's PGN blob. Scans the
/// leading tag-pair section only; returns None if the tag isn't present.
fn pgn_header<'a>(pgn: &'a str, tag: &str) -> Option<&'a str> {
    for line in pgn.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        // Tag section ends at the first non-`[` line (the movetext).
        let rest = match line.strip_prefix('[') {
            Some(r) => r,
            None => break,
        };
        let name_end = match rest.find(' ') {
            Some(i) => i,
            None => continue,
        };
        if &rest[..name_end] != tag { continue; }
        // Value is quoted: [Tag "value"]
        let after = rest[name_end + 1..].trim_start();
        let inner = after.strip_prefix('"').unwrap_or(after);
        return Some(match inner.find('"') {
            Some(end) => &inner[..end],
            None => inner,
        });
    }
    None
}

pub fn dedup_games(conn: &Connection, dry_run: bool, reporter: &Reporter) -> Result<()> {
    // Phase 1: find candidate pairs via SQL.
    // Candidates share (white_id, black_id, date) and their opening_lines
    // are equal or one is a proper prefix of the other.
    let spinner = reporter.spinner();
    spinner.set_message("Scanning for candidate duplicate pairs...");
    if reporter.is_json() { reporter.log("Scanning for candidate duplicate pairs..."); }

    let candidates: Vec<(u32, u32, i16, i16, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT g1.id, g2.id, g1.move_count, g2.move_count, g1.pgn, g2.pgn
             FROM games g1
             JOIN games g2
               ON g1.white_id = g2.white_id
              AND g1.black_id = g2.black_id
              AND g1.date IS NOT NULL
              AND g1.date = g2.date
              AND g1.result IS NOT DISTINCT FROM g2.result
              AND g1.id < g2.id
             WHERE g1.opening_line = g2.opening_line
                OR g2.opening_line LIKE g1.opening_line || ' %'
                OR g1.opening_line LIKE g2.opening_line || ' %'",
        )?;
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, i16>(2)?,
                r.get::<_, i16>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect()
    };

    spinner.finish_and_clear();

    if candidates.is_empty() {
        reporter.done("No candidate duplicate pairs found.");
        return Ok(());
    }

    let total = candidates.len() as u64;
    let header = format!(
        "{} candidate pair(s) found. Checking move text...{}",
        total,
        if dry_run { " (dry run)" } else { "" }
    );
    reporter.log(&header);

    let pb = reporter.bar(total);

    let mut deleted = 0usize;
    let mut diverged = 0usize;
    let mut checked = 0u64;

    for (id1, id2, moves1, moves2, pgn1, pgn2) in &candidates {
        pb.inc(1);
        checked += 1;

        let text1 = strip_result(extract_moves(pgn1));
        let text2 = strip_result(extract_moves(pgn2));

        let (keep_id, drop_id, shorter, longer) = if moves1 >= moves2 {
            (id1, id2, text2, text1)
        } else {
            (id2, id1, text1, text2)
        };

        if is_move_prefix(shorter, longer) {
            // Identify the game being removed so the user can see exactly what
            // was deleted — players, event and date, plus the game it duplicates.
            let drop_pgn = if drop_id == id1 { pgn1 } else { pgn2 };
            let white = pgn_header(drop_pgn, "White").unwrap_or("?");
            let black = pgn_header(drop_pgn, "Black").unwrap_or("?");
            let date  = pgn_header(drop_pgn, "Date").unwrap_or("?");
            let event = pgn_header(drop_pgn, "Event").unwrap_or("");
            let where_ = if event.is_empty() { String::new() } else { format!(", {}", event) };
            let msg = format!(
                "{} [{}] {} vs {}{} ({}) — duplicate of [{}]",
                if dry_run { "Would delete" } else { "Deleted" },
                drop_id, white, black, where_, date, keep_id,
            );
            if !dry_run {
                merge_collections(conn, *keep_id, *drop_id)?;
                hard_delete_game(conn, *drop_id)?;
            }
            pb.println(&msg);
            if reporter.is_json() { reporter.log(&msg); }
            deleted += 1;
        } else {
            // Same opening, different game — not a duplicate. Counted for the
            // summary but not logged per-pair, which would bury the deletions.
            diverged += 1;
        }

        // Advance the progress bar without emitting a per-pair log line.
        reporter.progress(checked, total, "");
    }

    pb.finish_and_clear();

    let summary = if dry_run {
        format!(
            "Dry run: {} would be deleted, {} pairs skipped (diverging moves).",
            deleted, diverged
        )
    } else {
        format!(
            "Done: {} duplicate game(s) deleted, {} pair(s) skipped (diverging moves).",
            deleted, diverged
        )
    };
    reporter.done(&summary);
    Ok(())
}

/// Delete non-standard games (Chess960 and mid-game fragments) from the database.
pub fn cleanup_nonstandard(
    conn: &Connection,
    non_standard: bool,
    dry_run: bool,
    reporter: &Reporter,
) -> Result<()> {
    if !non_standard {
        reporter.error("Nothing to do. Pass --non-standard to remove Chess960 and game fragments.");
        return Ok(());
    }

    // Chess960: identified by [Variant "chess960"] tag (case-insensitive).
    // Fragments: identified by [SetUp "1"] without a Chess960 variant tag.
    let where_clause =
        "pgn ILIKE '%[Variant \"chess960\"]%' OR pgn LIKE '%[SetUp \"1\"]%'";

    let spinner = reporter.spinner();
    spinner.set_message("Scanning for non-standard games...");
    if reporter.is_json() { reporter.log("Scanning for non-standard games..."); }

    let total: u64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM games WHERE {}", where_clause),
        [],
        |r| r.get(0),
    )?;

    spinner.finish_and_clear();

    if total == 0 {
        reporter.done("No non-standard games found.");
        return Ok(());
    }

    reporter.log(format!(
        "{} non-standard game(s) found{}.",
        total,
        if dry_run { " (dry run — nothing will be deleted)" } else { "" },
    ));

    if dry_run {
        reporter.done(format!("Would delete {} game(s).", total));
        return Ok(());
    }

    // Phase 1: delete positions
    let spinner = reporter.spinner();
    spinner.set_message(format!("Deleting positions for {} game(s)...", total));
    if reporter.is_json() { reporter.log(format!("Deleting positions for {} game(s)...", total)); }

    conn.execute_batch(&format!(
        "DELETE FROM positions WHERE game_id IN (SELECT id FROM games WHERE {})",
        where_clause,
    ))?;

    spinner.finish_and_clear();

    // Phase 2: delete games
    let spinner = reporter.spinner();
    spinner.set_message("Deleting games...");
    if reporter.is_json() { reporter.log("Deleting games..."); }

    conn.execute_batch(&format!("DELETE FROM games WHERE {}", where_clause))?;

    spinner.finish_and_clear();

    // Phase 3: recalculate player game counts (game counts are now stale)
    let spinner = reporter.spinner();
    spinner.set_message("Recalculating player game counts...");
    if reporter.is_json() { reporter.log("Recalculating player game counts..."); }

    crate::db::queries::recalculate_game_counts(conn)?;

    spinner.finish_and_clear();

    reporter.done(format!("Done: {} non-standard game(s) deleted.", total));
    Ok(())
}

/// Extract just the move section from a PGN string (everything after the last header tag).
fn extract_moves(pgn: &str) -> &str {
    if let Some(pos) = pgn.rfind(']') {
        pgn[pos + 1..].trim_start()
    } else {
        pgn
    }
}

/// Strip the PGN result token from the end of a move text string.
fn strip_result(pgn: &str) -> &str {
    let s = pgn.trim_end();
    for suffix in &["1/2-1/2", "1-0", "0-1", "*"] {
        if let Some(rest) = s.strip_suffix(suffix) {
            return rest.trim_end();
        }
    }
    s
}

/// Returns true if `shorter` is a move-boundary prefix of `longer`.
/// Requires that after `shorter` ends, `longer` has either ended or
/// continues with a space (preventing partial token matches).
fn is_move_prefix(shorter: &str, longer: &str) -> bool {
    if shorter.is_empty() {
        return true;
    }
    if !longer.starts_with(shorter) {
        return false;
    }
    matches!(longer.as_bytes().get(shorter.len()), None | Some(b' '))
}

fn pick_survivor(rows: &[(u32, String, bool, Option<String>)]) -> usize {
    rows.iter()
        .enumerate()
        .max_by_key(|(_, (_, name, normalised, last_date))| {
            name_score(name, *normalised, last_date.as_deref())
        })
        .map(|(i, _)| i)
        .unwrap_or(0)
}
