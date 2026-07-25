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

pub fn dedup_players(conn: &Connection, reporter: &Reporter) -> Result<()> {
    // Fetch every player row that shares a fide_id with another, plus that
    // player's most recent game date (for the survivor tiebreaker) — all in ONE
    // query. The per-player last-date is computed in a single pass over games
    // rather than a whole-table scan per fide_id (the old approach's first cost).
    let rows: Vec<(u32, u32, String, bool, Option<String>)> = {
        let mut stmt = conn.prepare(
            "WITH dups AS (
                 SELECT fide_id FROM players
                 WHERE fide_id IS NOT NULL
                 GROUP BY fide_id HAVING COUNT(*) > 1
             ),
             last AS (
                 SELECT pid, MAX(date) AS last_date
                 FROM (SELECT white_id AS pid, date FROM games
                       UNION ALL
                       SELECT black_id AS pid, date FROM games)
                 WHERE pid IN (SELECT id FROM players WHERE fide_id IN (SELECT fide_id FROM dups))
                 GROUP BY pid
             )
             SELECT p.fide_id, p.id, p.name, p.name_normalised, l.last_date
             FROM players p
             JOIN dups d ON d.fide_id = p.fide_id
             LEFT JOIN last l ON l.pid = p.id
             ORDER BY p.fide_id, p.id",
        )?;
        stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .filter_map(|r| r.ok())
        .collect()
    };

    if rows.is_empty() {
        reporter.done("No duplicate players found.");
        return Ok(());
    }

    // Group consecutive rows by fide_id (the query is ORDER BY fide_id), pick a
    // survivor per group, and build a flat old_id → survivor_id reassignment map.
    // Each player row has exactly one fide_id, so no old_id is another group's
    // survivor — the map needs no chaining.
    let mut mapping: Vec<(u32, u32)> = Vec::new();
    let mut fide_ids = 0usize;
    let mut group: Vec<(u32, String, bool, Option<String>)> = Vec::new();
    let flush = |group: &mut Vec<(u32, String, bool, Option<String>)>,
                     mapping: &mut Vec<(u32, u32)>,
                     fide_ids: &mut usize| {
        if group.len() >= 2 {
            *fide_ids += 1;
            let survivor_idx = pick_survivor(group);
            let survivor_id = group[survivor_idx].0;
            for (id, ..) in group.iter() {
                if *id != survivor_id {
                    mapping.push((*id, survivor_id));
                }
            }
        }
        group.clear();
    };

    let mut cur_fide: Option<u32> = None;
    for (fide_id, id, name, normalised, last_date) in rows {
        if cur_fide != Some(fide_id) {
            flush(&mut group, &mut mapping, &mut fide_ids);
            cur_fide = Some(fide_id);
        }
        group.push((id, name, normalised, last_date));
    }
    flush(&mut group, &mut mapping, &mut fide_ids);

    if mapping.is_empty() {
        reporter.done("No duplicate players found.");
        return Ok(());
    }

    if reporter.is_cancelled() {
        reporter.done("Cancelled before merging.");
        return Ok(());
    }

    // Apply the reassignment set-based (two passes over games + one delete), but
    // split each pass into game-id ranges so we can report REAL progress. DuckDB
    // prunes row groups by the id min/max, so a range UPDATE only touches that
    // range's row groups — each row group is still rewritten once per pass (the
    // same total work as one statement), while the bar advances per range. Keeps
    // the O(games) cost from #172, not O(duplicates × games).
    reporter.progress(0, 0, format!("Preparing to merge {} player row(s)…", mapping.len()));
    conn.execute_batch(
        "DROP TABLE IF EXISTS merge_map;
         CREATE TEMP TABLE merge_map (old_id INTEGER, new_id INTEGER);",
    )?;
    {
        let mut app = conn.appender("merge_map")?;
        for (old_id, new_id) in &mapping {
            app.append_row(duckdb::params![old_id, new_id])?;
        }
        app.flush()?;
    }

    let max_id: i64 = conn.query_row("SELECT COALESCE(MAX(id), 0) FROM games", [], |r| r.get(0))?;
    const RANGE: i64 = 1_000_000; // games per progress step
    let ranges: Vec<(i64, i64)> = {
        let mut v = Vec::new();
        let mut lo = 0i64;
        loop {
            v.push((lo, lo + RANGE));
            lo += RANGE;
            if lo > max_id {
                break;
            }
        }
        v
    };
    // Two passes (white, black) over the ranges, then the delete = total steps.
    let total_steps = ranges.len() as u64 * 2 + 1;
    let mut step = 0u64;

    for col in ["white_id", "black_id"] {
        let sql = format!(
            "UPDATE games SET {col} = m.new_id FROM merge_map m
             WHERE games.{col} = m.old_id AND games.id >= ? AND games.id < ?"
        );
        for &(lo, hi) in &ranges {
            if reporter.is_cancelled() {
                // Reassignment is idempotent and re-run rebuilds the same map, so a
                // partial merge is safe — just don't delete the (still-referenced)
                // old rows; the next run finishes it.
                conn.execute_batch("DROP TABLE IF EXISTS merge_map;")?;
                reporter.done("Cancelled — player merge partially applied; re-run to finish.");
                return Ok(());
            }
            conn.execute(&sql, duckdb::params![lo, hi])?;
            step += 1;
            reporter.progress(step, total_steps, "Merging duplicate players…".to_string());
        }
    }
    conn.execute("DELETE FROM players WHERE id IN (SELECT old_id FROM merge_map)", [])?;
    step += 1;
    reporter.progress(step, total_steps, "Merging duplicate players…".to_string());
    conn.execute_batch("DROP TABLE IF EXISTS merge_map;")?;

    reporter.done(format!(
        "Removed {} duplicate player record(s) across {} FIDE ID(s).",
        mapping.len(),
        fide_ids,
    ));
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
    //
    // Incremental: `dedup_games` runs after every daily sync, but the self-join
    // is O(N) over the whole table. `deduped` lets us skip pairs where BOTH
    // sides were already vetted on a prior pass — a pair is a candidate only
    // when at least one side is still unvetted (`IS NOT TRUE` covers FALSE and
    // any stray NULL). Survivors are flipped to TRUE once the pass completes, so
    // a subsequent daily run only re-examines games that arrived since. This is
    // robust to id reuse: a new game (always written FALSE) paired with an old
    // vetted game (TRUE) still satisfies the OR, so new duplicates of old games
    // are caught regardless of which side gets the lower id.
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
              AND (g1.deduped IS NOT TRUE OR g2.deduped IS NOT TRUE)
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
        // No pairs to check, but the games examined this pass (any still-unvetted
        // rows) are now vetted — mark them so future runs skip them. Without this
        // a table of all-unique games would be rescanned in full every sync.
        mark_vetted(conn, dry_run, reporter)?;
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
        // Cooperative cancellation (#157): stop between pairs. Each delete is its
        // own committed unit, so a partial run leaves a consistent database.
        if reporter.is_cancelled() {
            pb.finish_and_clear();
            reporter.cancelled(format!(
                "Cancelled — {deleted} duplicate(s) deleted before stopping ({checked}/{total} pairs checked)."
            ));
            return Ok(());
        }
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

    // A complete pass vetted every remaining unvetted game (survivors of a pair
    // and games that had no candidate). Mark them so the next daily run only
    // re-examines newly imported games. Reached only when the loop ran to the
    // end — the cancel path above returns early without marking, so the next run
    // re-checks the games it didn't reach.
    mark_vetted(conn, dry_run, reporter)?;

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

/// Flip every still-unvetted game to `deduped = TRUE` after a complete
/// `dedup_games` pass. No-op on a dry run (a preview must not mutate state). On
/// first run / upgrade this touches many rows (a one-time full rewrite); on
/// daily runs only the games imported since the last pass are unvetted, so it's
/// cheap.
fn mark_vetted(conn: &Connection, dry_run: bool, reporter: &Reporter) -> Result<()> {
    if dry_run {
        return Ok(());
    }
    let spinner = reporter.spinner();
    spinner.set_message("Marking games as deduplicated...");
    conn.execute("UPDATE games SET deduped = TRUE WHERE deduped IS NOT TRUE", [])?;
    spinner.finish_and_clear();
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

#[cfg(test)]
mod dedup_games_tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        conn
    }

    /// A game inserted as unvetted, dated, with the same players/opening as a
    /// twin. `pgn` is a minimal tag section + movetext so extract_moves works.
    fn insert_game(conn: &Connection, id: u32, moves: &str, deduped: bool) {
        conn.execute(
            "INSERT INTO games (id, white_id, black_id, date, result, opening_line, move_count, pgn, deduped)
             VALUES (?, 1, 2, '2020-01-01', '1-0', 'e4', ?, ?, ?)",
            duckdb::params![id, moves.split_whitespace().count() as i16,
                format!("[White \"A\"]\n[Black \"B\"]\n\n{moves} 1-0"), deduped],
        ).unwrap();
    }

    fn count_games(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn removes_prefix_duplicate_and_marks_survivors_vetted() {
        let conn = setup();
        insert_game(&conn, 1, "e4 e5 Nf3", false);
        insert_game(&conn, 2, "e4 e5 Nf3 Nc6", false); // extends game 1 → dup

        dedup_games(&conn, false, &Reporter::silent()).unwrap();

        assert_eq!(count_games(&conn), 1, "the shorter prefix game is removed");
        // Every remaining game is now vetted.
        let unvetted: i64 = conn
            .query_row("SELECT COUNT(*) FROM games WHERE deduped IS NOT TRUE", [], |r| r.get(0))
            .unwrap();
        assert_eq!(unvetted, 0, "survivor is marked deduped after a complete pass");
    }

    #[test]
    fn second_pass_only_rechecks_new_games() {
        let conn = setup();
        // First pass: two distinct games (different openings won't pair; use
        // diverging moves so nothing is deleted but both get vetted).
        insert_game(&conn, 1, "e4 e5 Nf3 Nc6", false);
        insert_game(&conn, 2, "e4 e5 Nf3 d6", false);
        dedup_games(&conn, false, &Reporter::silent()).unwrap();
        assert_eq!(count_games(&conn), 2, "diverging games are both kept");

        // A newly imported duplicate of game 1 (unvetted). The old games are now
        // vetted; the pair (old vetted, new unvetted) must still be a candidate —
        // proving the OR filter catches new dups of already-vetted games.
        insert_game(&conn, 3, "e4 e5 Nf3 Nc6 Bb5", false); // extends game 1
        dedup_games(&conn, false, &Reporter::silent()).unwrap();

        // Game 1 (shorter) is removed as a prefix of game 3.
        let ids: Vec<u32> = {
            let mut s = conn.prepare("SELECT id FROM games ORDER BY id").unwrap();
            s.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        };
        assert_eq!(ids, vec![2, 3], "new dup of an old vetted game is still caught");
    }

    #[test]
    fn dry_run_does_not_mark_or_delete() {
        let conn = setup();
        insert_game(&conn, 1, "e4 e5 Nf3", false);
        insert_game(&conn, 2, "e4 e5 Nf3 Nc6", false);

        dedup_games(&conn, true, &Reporter::silent()).unwrap();

        assert_eq!(count_games(&conn), 2, "dry run deletes nothing");
        let unvetted: i64 = conn
            .query_row("SELECT COUNT(*) FROM games WHERE deduped IS NOT TRUE", [], |r| r.get(0))
            .unwrap();
        assert_eq!(unvetted, 2, "dry run leaves games unvetted");
    }
}

#[cfg(test)]
mod dedup_players_tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        conn
    }

    #[test]
    fn merges_same_fide_id_rows_and_reassigns_games() {
        let conn = setup();
        // fide 100: id 1 is normalised (survivor), id 2 is not.
        // fide 200: id 3 "Doe, John" (survivor), id 4 "Doe, J" (abbrev).
        // fide 300: id 5 is a lone player — untouched.
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'Carlsen, Magnus','carlsen magnus',100,TRUE),
               (2,'carlsen, m','carlsen m',100,FALSE),
               (3,'Doe, John','doe john',200,FALSE),
               (4,'Doe, J','doe j',200,FALSE),
               (5,'Solo, Han','solo han',300,FALSE);
             INSERT INTO games (id, white_id, black_id, date) VALUES
               (1, 2, 3, '2020-01-01'),
               (2, 4, 1, '2021-01-01');",
        )
        .unwrap();

        dedup_players(&conn, &Reporter::silent()).unwrap();

        // Non-survivors 2 and 4 are gone; 1, 3, 5 remain.
        let remaining: Vec<u32> = {
            let mut s = conn.prepare("SELECT id FROM players ORDER BY id").unwrap();
            s.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        };
        assert_eq!(remaining, vec![1, 3, 5]);

        // Games reassigned to survivors: game 1 white 2→1; game 2 white 4→3.
        let g = |id: u32| -> (u32, u32) {
            conn.query_row("SELECT white_id, black_id FROM games WHERE id=?", duckdb::params![id],
                |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        assert_eq!(g(1), (1, 3), "white 2→1 (survivor), black 3 already survivor");
        assert_eq!(g(2), (3, 1), "white 4→3 (survivor), black 1 already survivor");
    }

    #[test]
    fn no_duplicates_is_a_noop() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'A, B','a b',100,FALSE),
               (2,'C, D','c d',200,FALSE);",
        )
        .unwrap();
        dedup_players(&conn, &Reporter::silent()).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM players", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }
}
