use anyhow::Result;
use duckdb::Connection;
use std::collections::HashSet;
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

pub fn dedup_games(conn: &Connection, dry_run: bool, full: bool, reporter: &Reporter) -> Result<()> {
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
    // Ensure every game has a move fingerprint. New games are hashed at import;
    // this backfills any that predate the columns — a one-time cost after upgrade,
    // a no-op afterwards and for fresh installs. Required before the hash join
    // below; it writes only the derived hash columns, so it runs even on a dry run.
    backfill_move_hashes(conn, reporter)?;

    let spinner = reporter.spinner();
    spinner.set_message("Scanning for duplicate games...");
    if reporter.is_json() { reporter.log("Scanning for duplicate games..."); }

    // Incremental (background) runs only consider pairs with an unvetted side; a
    // `full` run (manual `games dedup` / the Maintenance button) drops that filter
    // to re-examine every pair.
    let incremental_filter = if full {
        ""
    } else {
        "AND (g1.deduped IS NOT TRUE OR g2.deduped IS NOT TRUE)"
    };
    // Candidates come straight from the move fingerprints: same players, date and
    // result, and either identical move sequences (move_hash = move_hash) or a
    // one-trailing-half-move difference (move_hash = move_hash_short, either way).
    // No per-pair PGN parsing drives this — the hash match IS the filter — so the
    // set is the true duplicates, not every game sharing an opening.
    let candidates: Vec<(u32, u32, String, String)> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT g1.id, g2.id, g1.pgn, g2.pgn
             FROM games g1
             JOIN games g2
               ON g1.white_id = g2.white_id
              AND g1.black_id = g2.black_id
              AND g1.date IS NOT NULL
              AND g1.date = g2.date
              AND g1.result IS NOT DISTINCT FROM g2.result
              AND g1.id < g2.id
              AND (g1.move_hash = g2.move_hash
                   OR g1.move_hash = g2.move_hash_short
                   OR g1.move_hash_short = g2.move_hash)
              {incremental_filter}"
        ))?;
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect()
    };

    spinner.finish_and_clear();

    if candidates.is_empty() {
        // Nothing to remove, but the games examined this pass (any still-unvetted
        // rows) are now vetted — mark them so future runs skip them.
        mark_vetted(conn, dry_run, reporter)?;
        reporter.done("No duplicate games found.");
        return Ok(());
    }

    let total = candidates.len() as u64;
    reporter.log(format!(
        "{total} duplicate pair(s) found.{}",
        if dry_run { " (dry run)" } else { "" }
    ));

    let pb = reporter.bar(total);

    let mut deleted = 0usize;
    let mut collisions = 0usize;
    let mut checked = 0u64;
    // Games slated for deletion this pass. dedup removes only the `games` row
    // inline (a PK lookup) and defers the positions/game_collections cleanup to a
    // single sweep at the end — those tables have no game_id index, so per-game
    // deletes would each scan the whole table. Tracking dropped ids also keeps
    // triplets (3+ copies) consistent: a pair whose game already went is skipped,
    // the same effect the old immediate delete had by making later pairs no-ops.
    let mut dropped: HashSet<u32> = HashSet::new();

    for (id1, id2, pgn1, pgn2) in &candidates {
        // Cooperative cancellation (#157): stop between pairs. Each `games` delete
        // is its own committed unit; the deferred references are swept here before
        // returning, so a cancelled run still leaves a consistent database.
        if reporter.is_cancelled() {
            pb.finish_and_clear();
            if !dry_run && !dropped.is_empty() {
                sweep_deleted_game_refs(conn)?;
            }
            reporter.cancelled(format!(
                "Cancelled — {deleted} duplicate(s) deleted before stopping ({checked}/{total} pairs checked)."
            ));
            return Ok(());
        }
        pb.inc(1);
        checked += 1;

        // A prior pair already removed one of these two games — nothing to do.
        if dropped.contains(id1) || dropped.contains(id2) {
            reporter.progress(checked, total, format!("Checked {checked}/{total} · {deleted} removed"));
            continue;
        }

        // The hash join already established these are duplicates (identical, or a
        // single trailing half-move apart). Re-derive the move sequences and
        // confirm to rule out the ~never 64-bit collision — a false positive here
        // would delete a real game, so verify before deleting.
        let m1 = canonical_moves(pgn1);
        let m2 = canonical_moves(pgn2);
        let confirmed = m1 == m2
            || (m1.len() + 1 == m2.len() && m2[..m1.len()] == m1[..])
            || (m2.len() + 1 == m1.len() && m1[..m2.len()] == m2[..]);
        if !confirmed {
            collisions += 1;
            reporter.progress(checked, total, format!("Checked {checked}/{total} · {deleted} removed"));
            continue;
        }

        // Survivor = the game with the LONGEST raw movetext (annotations and
        // variations included): a more complete game wins, and at equal moves an
        // annotated game beats a bare one — even if that means keeping the game
        // with fewer moves played. Ties break to the lower id (id1 < id2 here).
        let (keep_id, drop_id, drop_pgn) = if raw_movetext_len(pgn1) >= raw_movetext_len(pgn2) {
            (id1, id2, pgn2)
        } else {
            (id2, id1, pgn1)
        };

        // Identify the game being removed so the user can see exactly what was
        // deleted — players, event and date, plus the game it duplicates.
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
            // Move the dropped game's collection memberships onto the survivor
            // first, then remove only the games row — a PK lookup. Its
            // positions/game_collections rows are cleaned by the end sweep.
            merge_collections(conn, *keep_id, *drop_id)?;
            conn.execute("DELETE FROM games WHERE id = ?", duckdb::params![*drop_id])?;
            dropped.insert(*drop_id);
        }
        // Per-deletion detail goes to the terminal bar only. The daemon/GUI gets a
        // running summary via progress() below, not a line per game.
        pb.println(&msg);
        deleted += 1;

        // Drive the bar with a rolling summary (pairs checked + removed so far)
        // rather than a per-pair line, so the Activity panel stays legible.
        reporter.progress(checked, total, format!("Checked {checked}/{total} · {deleted} removed"));
    }

    pb.finish_and_clear();

    // Clean the deferred references of every game removed this pass — one anti-
    // join each, no matter how many games went. Guarded on an actual deletion so
    // a no-op incremental pass never pays for a full positions scan.
    if !dry_run && !dropped.is_empty() {
        sweep_deleted_game_refs(conn)?;
    }

    // A complete pass vetted every remaining unvetted game (survivors of a pair
    // and games that had no candidate). Mark them so the next daily run only
    // re-examines newly imported games. Reached only when the loop ran to the
    // end — the cancel path above returns early without marking, so the next run
    // re-checks the games it didn't reach.
    mark_vetted(conn, dry_run, reporter)?;

    // `collisions` counts hash matches that verification rejected — expected to
    // be zero; surfaced only when non-zero so it never adds noise.
    let tail = if collisions > 0 { format!(" ({collisions} hash collision(s) skipped)") } else { String::new() };
    let summary = if dry_run {
        format!("Dry run: {deleted} duplicate(s) would be deleted.{tail}")
    } else {
        format!("Done: {deleted} duplicate game(s) deleted.{tail}")
    };
    reporter.done(&summary);
    Ok(())
}

/// Delete `positions` and `game_collections` rows that reference a game no longer
/// in `games`. `dedup_games` removes duplicate `games` rows inline but defers
/// these two — both lack a `game_id` index, so a per-game delete scans the whole
/// (large) table; one anti-join sweeps every orphan in a single pass instead.
/// Positions are always removed before/with their game, so a hard kill can only
/// leave games-without-positions (which `index_positions` refills), never the
/// reverse — and the next run's sweep clears anything a kill left behind.
fn sweep_deleted_game_refs(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM positions
           WHERE NOT EXISTS (SELECT 1 FROM games g WHERE g.id = positions.game_id);
         DELETE FROM game_collections
           WHERE NOT EXISTS (SELECT 1 FROM games g WHERE g.id = game_collections.game_id);",
    )?;
    Ok(())
}

/// Populate `move_hash`/`move_hash_short` for games that lack them — those that
/// predate the columns. New games are hashed at import, so this is a one-time
/// pass after upgrade and a no-op on every run thereafter (and for fresh
/// installs). Processed in id-range chunks so peak memory is bounded (each chunk
/// holds only its PGNs), and stopped cleanly on cancel — the next run resumes,
/// since it only touches still-NULL rows. Not gated by dry_run: it writes only
/// the derived hash columns, which the candidate query needs to work at all.
fn backfill_move_hashes(conn: &Connection, reporter: &Reporter) -> Result<()> {
    let pending: i64 =
        conn.query_row("SELECT COUNT(*) FROM games WHERE move_hash IS NULL", [], |r| r.get(0))?;
    if pending == 0 {
        return Ok(());
    }
    reporter.log(format!("Computing move fingerprints for {pending} game(s) (one-time)…"));
    let max_id: i64 = conn.query_row("SELECT COALESCE(MAX(id), 0) FROM games", [], |r| r.get(0))?;
    conn.execute_batch(
        "DROP TABLE IF EXISTS hash_backfill;
         CREATE TEMP TABLE hash_backfill (id UINTEGER, h BIGINT, hs BIGINT);",
    )?;

    const CHUNK: i64 = 200_000; // games per id-range pass; bounds memory to its PGNs
    let mut lo = 0i64;
    let mut done = 0i64;
    while lo <= max_id {
        if reporter.is_cancelled() {
            conn.execute_batch("DROP TABLE IF EXISTS hash_backfill;")?;
            return Ok(()); // resumes next run — only NULL rows are processed
        }
        let hi = lo + CHUNK;
        let batch: Vec<(u32, String)> = {
            let mut stmt = conn
                .prepare("SELECT id, pgn FROM games WHERE move_hash IS NULL AND id >= ? AND id < ?")?;
            stmt.query_map(duckdb::params![lo, hi], |r| Ok((r.get(0)?, r.get(1)?)))?
                .filter_map(|r| r.ok())
                .collect()
        };
        if !batch.is_empty() {
            conn.execute_batch("DELETE FROM hash_backfill;")?;
            {
                let mut app = conn.appender("hash_backfill")?;
                for (id, pgn) in &batch {
                    let (h, hs) = move_fingerprints(pgn);
                    app.append_row(duckdb::params![id, h, hs])?;
                }
                app.flush()?;
            }
            conn.execute_batch(
                "UPDATE games SET move_hash = m.h, move_hash_short = m.hs
                 FROM hash_backfill m WHERE games.id = m.id;",
            )?;
            done += batch.len() as i64;
            reporter.progress(done as u64, pending as u64, format!("Fingerprinting games… {done}/{pending}"));
        }
        lo = hi;
    }
    conn.execute_batch("DROP TABLE IF EXISTS hash_backfill;")?;
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

/// Reduce a PGN to its bare sequence of SAN moves so the same game matches
/// across sources that annotate differently. Move numbers, comments (`{…}`,
/// including Lichess's `[%eval]`/`[%clk]`), NAGs (`$n`), variations (`(…)`), and
/// the result token are all dropped; castling `0-0`/`0-0-0` is normalised to
/// `O-O`/`O-O-O` and trailing `!`/`?` move-quality marks are stripped.
fn canonical_moves(pgn: &str) -> Vec<String> {
    // Movetext = from the first non-header line onward. Can't scan for a trailing
    // `]` (the old approach): Lichess comments embed it, e.g. `{[%eval 0.1]}`.
    let movetext = pgn
        .lines()
        .skip_while(|l| {
            let t = l.trim_start();
            t.is_empty() || t.starts_with('[')
        })
        .collect::<Vec<_>>()
        .join(" ");

    // Strip `{comments}` and `(variations)` in one depth-tracked pass. A comment
    // suppresses parens inside it (they're free text), so brace wins.
    let mut bare = String::with_capacity(movetext.len());
    let mut brace = 0usize;
    let mut paren = 0usize;
    for c in movetext.chars() {
        match c {
            '{' => brace += 1,
            '}' => brace = brace.saturating_sub(1),
            '(' if brace == 0 => paren += 1,
            ')' if brace == 0 => paren = paren.saturating_sub(1),
            _ if brace == 0 && paren == 0 => bare.push(c),
            _ => {}
        }
    }

    bare.split_whitespace().filter_map(normalise_san_token).collect()
}

/// FNV-1a 64-bit over the space-joined SAN tokens. Deliberately *not*
/// `DefaultHasher` — that isn't guaranteed stable across std versions, and these
/// hashes are persisted in `games.move_hash`. Returned as `i64` (same bits) to
/// fit DuckDB's BIGINT.
fn hash_moves(moves: &[String]) -> i64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for (i, m) in moves.iter().enumerate() {
        if i > 0 {
            h = (h ^ u64::from(b' ')).wrapping_mul(0x0000_0100_0000_01b3);
        }
        for &b in m.as_bytes() {
            h = (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h as i64
}

/// The two move fingerprints stored per game (#—): a hash of the full canonical
/// SAN sequence, and — for games of ≥2 moves — a hash of that sequence with the
/// last half-move dropped. The pair lets dedup match exact duplicates AND ones
/// that differ by a single trailing half-move (e.g. a resignation where the last
/// move went unrecorded in one source) with a pure-SQL hash join, no per-pair
/// move parsing. Computed from the stored PGN via the same `canonical_moves`
/// dedup verifies with, so the two always agree.
pub fn move_fingerprints(pgn: &str) -> (i64, Option<i64>) {
    let m = canonical_moves(pgn);
    let full = hash_moves(&m);
    let short = (m.len() >= 2).then(|| hash_moves(&m[..m.len() - 1]));
    (full, short)
}

/// Byte length of a PGN's raw move section (headers dropped) — the survivor
/// tiebreaker for dedup: the game with the *longest* raw movetext wins, so a more
/// complete game beats a shorter one and, at equal moves, an annotated game
/// (inline `[%eval]`/`[%clk]`, variations) beats a bare one.
fn raw_movetext_len(pgn: &str) -> usize {
    pgn.lines()
        .skip_while(|l| {
            let t = l.trim_start();
            t.is_empty() || t.starts_with('[')
        })
        .map(|l| l.len() + 1)
        .sum()
}

/// Normalise one movetext token to a SAN move, or `None` if it isn't a move (a
/// move number like `12.`/`12...`, a NAG `$n`, a result, or empty afterwards).
fn normalise_san_token(tok: &str) -> Option<String> {
    if matches!(tok, "1-0" | "0-1" | "1/2-1/2" | "*") || tok.starts_with('$') {
        return None;
    }
    // Drop a leading move number: `12.` / `12...`, possibly glued (`12.e4`).
    let bytes = tok.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let mv = if i > 0 && bytes.get(i) == Some(&b'.') {
        let mut j = i;
        while j < bytes.len() && bytes[j] == b'.' {
            j += 1;
        }
        &tok[j..]
    } else {
        tok
    };
    // Trailing move-quality marks (`!`, `?`, `!?`, `?!`) — keep `+`/`#`.
    let mv = mv.trim_end_matches(['!', '?']);
    if mv.is_empty() {
        return None;
    }
    Some(match mv {
        "0-0" => "O-O".to_string(),
        "0-0-0" => "O-O-O".to_string(),
        _ => mv.to_string(),
    })
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

        dedup_games(&conn, false, false, &Reporter::silent()).unwrap();

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
        dedup_games(&conn, false, false, &Reporter::silent()).unwrap();
        assert_eq!(count_games(&conn), 2, "diverging games are both kept");

        // A newly imported duplicate of game 1 (unvetted). The old games are now
        // vetted; the pair (old vetted, new unvetted) must still be a candidate —
        // proving the OR filter catches new dups of already-vetted games.
        insert_game(&conn, 3, "e4 e5 Nf3 Nc6 Bb5", false); // extends game 1
        dedup_games(&conn, false, false, &Reporter::silent()).unwrap();

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

        dedup_games(&conn, true, false, &Reporter::silent()).unwrap();

        assert_eq!(count_games(&conn), 2, "dry run deletes nothing");
        let unvetted: i64 = conn
            .query_row("SELECT COUNT(*) FROM games WHERE deduped IS NOT TRUE", [], |r| r.get(0))
            .unwrap();
        assert_eq!(unvetted, 2, "dry run leaves games unvetted");
    }

    /// Removing a duplicate defers its positions/game_collections to the end
    /// sweep — verify those rows are gone while the survivor's are kept.
    #[test]
    fn end_sweep_clears_removed_games_positions_and_collections() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO collections (id, name) VALUES (10, 'Dedup Test Coll');
             INSERT INTO games (id, white_id, black_id, date, result, opening_line, move_count, pgn, deduped) VALUES
               (1, 1, 2, '2024-06-18', '1-0', 'e4 e5 Nf3', 4, '[W \"a\"]\n\n1. e4 e5 2. Nf3 Nc6 1-0', FALSE),
               (2, 1, 2, '2024-06-18', '1-0', 'e4 e5 Nf3', 3, '[W \"a\"]\n\n1. e4 e5 2. Nf3 1-0', FALSE);
             INSERT INTO positions (game_id, move_number, zobrist_hash, next_move) VALUES
               (1, 1, 111, 'e4'), (2, 1, 222, 'e4');
             INSERT INTO game_collections (game_id, collection_id) VALUES (1, 10), (2, 10);",
        ).unwrap();

        dedup_games(&conn, false, true, &Reporter::silent()).unwrap();

        // Game 2 (the shorter prefix) is removed; its deferred rows are swept.
        assert_eq!(count_games(&conn), 1);
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM positions WHERE game_id = 2"), 0, "removed game's positions swept");
        assert_eq!(count("SELECT COUNT(*) FROM positions WHERE game_id = 1"), 1, "survivor's positions kept");
        assert_eq!(count("SELECT COUNT(*) FROM game_collections WHERE game_id = 2"), 0, "removed game's memberships swept");
        assert_eq!(count("SELECT COUNT(*) FROM game_collections WHERE game_id = 1"), 1, "survivor still in its collection");
    }

    /// The same game from TWIC (clean SAN) and a Lichess broadcast (eval/clock
    /// comments, NAGs, black-move numbers, a `]`-bearing GameURL header) must
    /// dedup — the annotations previously defeated the raw-string compare.
    #[test]
    fn matches_across_clean_and_annotated_sources() {
        let conn = setup();
        let opening = "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 c4 c6";
        let insert = |id: u32, pgn: &str| {
            conn.execute(
                "INSERT INTO games (id, white_id, black_id, date, result, opening_line, move_count, pgn, deduped)
                 VALUES (?, 1, 2, '2024-06-18', '1-0', ?, 12, ?, FALSE)",
                duckdb::params![id, opening, pgn],
            ).unwrap();
        };
        // TWIC: bare SAN.
        insert(1,
            "[White \"Svrcek,Jozef\"]\n[Black \"Mazak,Ryan\"]\n[Date \"2024-06-18\"]\n[Result \"1-0\"]\n\n\
             1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4 5. c4 c6 6. d3 Nf6 1-0");
        // Lichess broadcast: same moves, drowned in annotations + a header value
        // that itself contains ']' (must not fool the movetext split).
        insert(2,
            "[White \"Svrcek, Jozef\"]\n[Black \"Mazak, Ryan\"]\n[Date \"2024-06-18\"]\n[Result \"1-0\"]\n\
             [GameURL \"https://lichess.org/broadcast/a/b/jF5[x]DQ\"]\n\n\
             1. e4 {[%eval 0.15] [%clk 1:00:53]} 1... e5 {[%eval 0.15]} 2. Nf3 {[%clk 1:01:14]} \
             2... Nf6 {[%eval 0.27]} 3. Nxe5 {[%eval 0.19]} 3... d6 {[%eval 0.32]} \
             4. Nf3 {[%eval 0.31]} 4... Nxe4 {[%eval 0.26]} 5. c4 $6 {Inaccuracy. d4 was best.} \
             5... c6 {[%eval 0.28]} 6. d3 {[%eval 0.13]} 6... Nf6 {[%eval 0.12]} 1-0");

        dedup_games(&conn, false, false, &Reporter::silent()).unwrap();

        assert_eq!(count_games(&conn), 1, "the annotated duplicate is removed");
    }

    #[test]
    fn canonical_moves_strips_annotations_and_matches() {
        // Clean vs annotated reduce to the same SAN sequence.
        let clean = canonical_moves("[W \"a\"]\n\n1. e4 e5 2. Nf3 Nc6 1-0");
        let annotated = canonical_moves(
            "[W \"a\"]\n[URL \"x]y\"]\n\n1. e4 {[%eval 0.1]} 1... e5 $1 (1... c5 2. Nf3) 2. Nf3 {c} 2... Nc6 1-0",
        );
        assert_eq!(clean, vec!["e4", "e5", "Nf3", "Nc6"]);
        assert_eq!(clean, annotated, "annotations, NAGs and a variation are stripped");
    }

    #[test]
    fn fingerprints_encode_exact_and_off_by_one() {
        let four = move_fingerprints("[W \"a\"]\n\n1. e4 e5 2. Nf3 Nc6 1-0");
        let three = move_fingerprints("[W \"a\"]\n\n1. e4 e5 2. Nf3 1-0");
        // Identical move lists → identical full hash.
        let four_again = move_fingerprints("[W \"a\"]\n\n1. e4 {[%eval 0.1]} 1... e5 2. Nf3 Nc6 1-0");
        assert_eq!(four.0, four_again.0, "annotations don't change the full hash");
        // The 4-move game's short hash == the 3-move game's full hash (off-by-one).
        assert_eq!(four.1, Some(three.0), "short hash drops exactly the last half-move");
    }

    /// The survivor is the longest RAW movetext, so an annotated game wins even
    /// with one fewer move played (the resignation case).
    #[test]
    fn annotated_shorter_game_wins() {
        let conn = setup();
        // Bare, 5 moves.
        conn.execute(
            "INSERT INTO games (id, white_id, black_id, date, result, opening_line, move_count, pgn, deduped)
             VALUES (1, 1, 2, '2024-06-18', '1-0', 'e4 e5 Nf3 Nc6 Bb5', 5, ?, FALSE)",
            duckdb::params!["[White \"A\"]\n[Black \"B\"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 1-0"],
        ).unwrap();
        // Annotated, 4 moves (one fewer — last move unrecorded) but far longer raw text.
        conn.execute(
            "INSERT INTO games (id, white_id, black_id, date, result, opening_line, move_count, pgn, deduped)
             VALUES (2, 1, 2, '2024-06-18', '1-0', 'e4 e5 Nf3 Nc6', 4, ?, FALSE)",
            duckdb::params!["[White \"A\"]\n[Black \"B\"]\n[GameURL \"x\"]\n\n\
                1. e4 {[%eval 0.15] [%clk 1:00:53]} 1... e5 {[%eval 0.15] [%clk 1:00:52]} \
                2. Nf3 {[%eval 0.11] [%clk 1:01:14]} 2... Nc6 {[%eval 0.27] [%clk 1:01:09]} 1-0"],
        ).unwrap();

        dedup_games(&conn, false, true, &Reporter::silent()).unwrap();

        let survivors: Vec<u32> = {
            let mut s = conn.prepare("SELECT id FROM games").unwrap();
            s.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        };
        assert_eq!(survivors, vec![2], "the annotated 4-move game wins over the bare 5-move one");
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
