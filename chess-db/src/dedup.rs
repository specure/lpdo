use anyhow::{Context, Result};
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

/// One candidate row for the player merge: everything needed to cluster it and
/// to score it as a survivor.
struct PlayerRow {
    id: u32,
    name: String,
    name_normalized: String,
    fide_id: Option<u32>,
    name_normalised: bool,
    last_date: Option<String>,
}

pub fn dedup_players(conn: &Connection, dry_run: bool, reporter: &Reporter) -> Result<()> {
    // Fetch every player row that shares a fide_id OR a normalised name with
    // another, plus that player's most recent game date (for the survivor
    // tiebreaker) — all in ONE query. The per-player last-date is computed in a
    // single pass over games rather than a whole-table scan per group (the old
    // approach's first cost).
    //
    // Normalised name is the second key because it is the SAME key the importer
    // identifies people by: `get_or_create_player` looks a name up in a cache of
    // every existing `name_normalized` before it ever considers a FIDE ID, so
    // one normalised name already means one person as far as import is
    // concerned. Two rows sharing one are an artefact — most often a rename
    // (`players normalise` / `players import` rewrite a row to its FIDE-canonical
    // spelling, which can land on a name another row already holds) — and until
    // they are merged they also hide duplicate GAMES, since `dedup_games` pairs
    // on player ids. `cluster_players` refuses the one case where the rows are
    // known to be different people: distinct FIDE IDs.
    let rows: Vec<PlayerRow> = {
        let mut stmt = conn.prepare(
            "WITH dup_fide AS (
                 SELECT fide_id FROM players
                 WHERE fide_id IS NOT NULL
                 GROUP BY fide_id HAVING COUNT(*) > 1
             ),
             dup_name AS (
                 SELECT name_normalized FROM players
                 WHERE name_normalized IS NOT NULL AND name_normalized <> ''
                 GROUP BY name_normalized HAVING COUNT(*) > 1
             ),
             cand AS (
                 SELECT id, name, name_normalized, fide_id, name_normalised
                 FROM players
                 WHERE fide_id IN (SELECT fide_id FROM dup_fide)
                    OR name_normalized IN (SELECT name_normalized FROM dup_name)
             ),
             last AS (
                 SELECT pid, MAX(date) AS last_date
                 FROM (SELECT white_id AS pid, date FROM games
                       UNION ALL
                       SELECT black_id AS pid, date FROM games)
                 WHERE pid IN (SELECT id FROM cand)
                 GROUP BY pid
             )
             SELECT c.id, c.name, c.name_normalized, c.fide_id, c.name_normalised, l.last_date
             FROM cand c
             LEFT JOIN last l ON l.pid = c.id
             ORDER BY c.id",
        )?;
        stmt.query_map([], |r| {
            Ok(PlayerRow {
                id: r.get(0)?,
                name: r.get(1)?,
                name_normalized: r.get(2)?,
                fide_id: r.get(3)?,
                name_normalised: r.get(4)?,
                last_date: r.get(5)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect()
    };

    if rows.is_empty() {
        reporter.done("No duplicate players found.");
        return Ok(());
    }

    let (mapping, groups) = cluster_players(&rows);

    if mapping.is_empty() {
        reporter.done("No duplicate players found.");
        return Ok(());
    }

    if dry_run {
        report_planned_merges(&rows, &mapping, groups, reporter);
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

    // Drop the player-column indexes for the duration of the UPDATE passes and
    // rebuild them afterwards. Updating an ART-indexed column pays a per-row
    // incremental index delete+insert — measured at ~88s per 1M-id range on the
    // real table vs 0.02s with the indexes dropped (#244): single-threaded,
    // allocation-bound CPU work that made this step take ~45 min on Windows.
    // A bulk CREATE INDEX after the fact is parallel and fast. Queries running
    // during the window fall back to scans, which DuckDB handles fine briefly.
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_games_white;
         DROP INDEX IF EXISTS idx_games_black;",
    )?;
    let merge_result = run_player_merge_updates(conn, reporter);
    // Rebuild the indexes on EVERY exit (success, cancel, or error) — reads
    // depend on them. Then surface whichever failure happened first.
    //
    // Clear a stray transaction first: DuckDB refuses to build an index while
    // the connection holds uncommitted changes ("Cannot create index with
    // outstanding updates"), and older builds could leak one from a failed
    // import. Without this the rebuild fails and the indexes stay DROPPED,
    // degrading every player query until a later run repairs them (#255).
    crate::db::clear_stray_transaction(conn);
    let rebuild_result = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_id);
         CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_id);",
    );
    let finished = merge_result?;
    rebuild_result.context(
        "the games player-column indexes could not be rebuilt and are now missing — \
         queries will be slow until this step is re-run",
    )?;
    if !finished {
        // Cancelled mid-merge: reassignment is idempotent and a re-run rebuilds
        // the same map, so a partial merge is safe — the next run finishes it.
        reporter.done("Cancelled — player merge partially applied; re-run to finish.");
        return Ok(());
    }

    // Survivors now own their losers' games, so every stored count is understated.
    // The pipeline's later `dedup_games` would refresh them, but a merge run on
    // its own from the Maintenance page has to leave the numbers right too.
    crate::db::queries::recalculate_game_counts(conn)?;

    reporter.done(format!(
        "Removed {} duplicate player record(s) across {} player(s).",
        mapping.len(),
        groups,
    ));
    Ok(())
}

/// Spell out what a real run would merge, without touching anything. A merge
/// cannot be undone, so the preview has to be specific enough to spot a wrong
/// one: every planned merge is listed by name and id, with the FIDE ID that
/// links it — or "by name" when the names alone did, which is the case worth
/// checking, since two people really can share a name.
fn report_planned_merges(
    rows: &[PlayerRow],
    mapping: &[(u32, u32)],
    groups: usize,
    reporter: &Reporter,
) {
    use std::collections::HashMap;
    let by_id: HashMap<u32, &PlayerRow> = rows.iter().map(|r| (r.id, r)).collect();

    // Group the flat old→new mapping back into one line per survivor.
    let mut per_survivor: HashMap<u32, Vec<u32>> = HashMap::new();
    for (old, new) in mapping {
        per_survivor.entry(*new).or_default().push(*old);
    }
    let mut survivors: Vec<u32> = per_survivor.keys().copied().collect();
    survivors.sort_unstable();

    // Cap the listing: a first run on a large database can plan thousands of
    // merges, and flooding the log helps nobody. The counts below are complete.
    const MAX_LINES: usize = 50;
    let mut by_name_only = 0usize;
    for (shown, sid) in survivors.iter().enumerate() {
        let losers = &per_survivor[sid];
        let keep = by_id.get(sid);
        let fide = keep.and_then(|k| k.fide_id);
        // "By name" = nothing in the cluster carries a FIDE ID to justify it.
        let linked_by_fide =
            fide.is_some() || losers.iter().any(|l| by_id.get(l).and_then(|r| r.fide_id).is_some());
        if !linked_by_fide {
            by_name_only += 1;
        }
        if shown >= MAX_LINES {
            continue;
        }
        let names = losers
            .iter()
            .map(|l| match by_id.get(l) {
                Some(r) => format!("“{}” [{}]", r.name, r.id),
                None => format!("[{}]", l),
            })
            .collect::<Vec<_>>()
            .join(", ");
        reporter.log(format!(
            "  keep “{}” [{}] ({}) ← {}",
            keep.map(|k| k.name.as_str()).unwrap_or("?"),
            sid,
            match fide {
                Some(f) => format!("FIDE {f}"),
                None => "by name".to_string(),
            },
            names,
        ));
    }
    if survivors.len() > MAX_LINES {
        reporter.log(format!("  …and {} more", survivors.len() - MAX_LINES));
    }
    if by_name_only > 0 {
        reporter.log(format!(
            "{by_name_only} of these are linked by name alone (no FIDE ID on either side) — \
             check those for genuine namesakes.",
        ));
    }
    reporter.done(format!(
        "Dry run: {} duplicate player record(s) across {} player(s) would be merged.",
        mapping.len(),
        groups,
    ));
}

/// Cluster candidate rows into "same person" sets and choose one survivor each.
/// Returns `(old_id → survivor_id for every non-survivor, number of clusters)`.
///
/// Two rows join a cluster when they share a FIDE ID or share a normalised name;
/// union-find makes the relation transitive, so `A(fide 7) — B(fide 7, "smith
/// john") — C("smith john")` collapses to one survivor without the caller having
/// to chase chains through the mapping.
///
/// The one refusal: a normalised name held by rows with two or more DIFFERENT
/// FIDE IDs is left alone entirely. Those are namesakes that FIDE itself
/// distinguishes, and a merge cannot be undone. (FIDE IDs never conflict inside a
/// cluster otherwise: unioning by FIDE ID cannot mix two of them, and this guard
/// stops a name from doing so.)
fn cluster_players(rows: &[PlayerRow]) -> (Vec<(u32, u32)>, usize) {
    use std::collections::HashMap;

    // Rows with ≥2 distinct FIDE IDs under one normalised name — never merged.
    let ambiguous: std::collections::HashSet<&str> = {
        let mut seen: HashMap<&str, u32> = HashMap::new();
        let mut bad = std::collections::HashSet::new();
        for r in rows {
            let Some(fid) = r.fide_id else { continue };
            match seen.get(r.name_normalized.as_str()) {
                Some(&other) if other != fid => { bad.insert(r.name_normalized.as_str()); }
                Some(_) => {}
                None => { seen.insert(&r.name_normalized, fid); }
            }
        }
        bad
    };

    let mut parent: HashMap<u32, u32> = rows.iter().map(|r| (r.id, r.id)).collect();
    let union = |parent: &mut HashMap<u32, u32>, a: u32, b: u32| {
        let (ra, rb) = (uf_find(parent, a), uf_find(parent, b));
        if ra != rb {
            parent.insert(ra, rb);
        }
    };
    let mut by_fide: HashMap<u32, u32> = HashMap::new();
    let mut by_name: HashMap<&str, u32> = HashMap::new();
    for r in rows {
        if let Some(fid) = r.fide_id {
            match by_fide.get(&fid) {
                Some(&first) => union(&mut parent, r.id, first),
                None => { by_fide.insert(fid, r.id); }
            }
        }
        if ambiguous.contains(r.name_normalized.as_str()) {
            continue;
        }
        match by_name.get(r.name_normalized.as_str()) {
            Some(&first) => union(&mut parent, r.id, first),
            None => { by_name.insert(&r.name_normalized, r.id); }
        }
    }

    // Group by cluster root, then pick each cluster's survivor.
    let mut clusters: HashMap<u32, Vec<&PlayerRow>> = HashMap::new();
    for r in rows {
        clusters.entry(uf_find(&mut parent, r.id)).or_default().push(r);
    }
    let mut mapping = Vec::new();
    let mut groups = 0usize;
    for members in clusters.values() {
        if members.len() < 2 {
            continue; // a lone row: its partner was the ambiguous-name case
        }
        groups += 1;
        let survivor = pick_survivor(members);
        for m in members {
            if m.id != survivor {
                mapping.push((m.id, survivor));
            }
        }
    }
    // Deterministic order so a cancelled run rebuilds the same map on re-run.
    mapping.sort_unstable();
    (mapping, groups)
}

/// The UPDATE/DELETE body of the player merge, run while the games player-column
/// indexes are dropped (see dedup_players). Reads the prepared `merge_map` temp
/// table. Returns Ok(false) if cancelled between range chunks (merge_map is
/// cleaned up; old player rows are kept for the re-run), Ok(true) on completion.
fn run_player_merge_updates(conn: &Connection, reporter: &Reporter) -> Result<bool> {
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
                conn.execute_batch("DROP TABLE IF EXISTS merge_map;")?;
                return Ok(false);
            }
            conn.execute(&sql, duckdb::params![lo, hi])?;
            step += 1;
            reporter.progress(step, total_steps, "Merging duplicate players…".to_string());
        }
    }
    conn.execute("DELETE FROM players WHERE id IN (SELECT old_id FROM merge_map)", [])?;
    step += 1;
    reporter.progress(step, total_steps, "Merging duplicate players…".to_string());

    // Re-open every survivor's games for deduplication. `dedup_games` pairs on
    // white_id AND black_id, so each verdict it reached while these rows were
    // split is stale — two copies of one game that could not be matched then can
    // be matched now. The pipeline's dedup_games is INCREMENTAL and skips games
    // already flagged `deduped`, so without this the copies this merge just
    // exposed would never be looked at again (#266). Matching on new_id (the
    // reassignment above has already run) also re-opens games the survivor
    // always held, which is harmless: unvetted only means "look again".
    // Unindexed column, so no per-row ART cost — cheap next to the passes above.
    conn.execute(
        "UPDATE games SET deduped = FALSE
         WHERE white_id IN (SELECT new_id FROM merge_map)
            OR black_id IN (SELECT new_id FROM merge_map)",
        [],
    )?;
    conn.execute_batch("DROP TABLE IF EXISTS merge_map;")?;
    Ok(true)
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


pub fn dedup_games(conn: &Connection, dry_run: bool, full: bool, reporter: &Reporter) -> Result<()> {
    // Duplicates are identified entirely from the stored move fingerprints — no
    // PGN text is loaded or parsed here. `deduped` keeps daily runs incremental:
    // a pair is a candidate only when at least one side is still unvetted, and
    // survivors are flipped to TRUE once the pass completes, so a later run only
    // re-examines games that arrived since. A `full` run drops that filter.
    //
    // Ensure every game has a fingerprint first. New games are hashed at import;
    // this backfills any that predate the columns — a one-time cost after upgrade,
    // a no-op afterwards and for fresh installs. Writes only the derived hash
    // columns, so it runs even on a dry run.
    backfill_move_hashes(conn, reporter)?;

    let spinner = reporter.spinner();
    spinner.set_message("Finding duplicate games...");
    if reporter.is_json() { reporter.log("Finding duplicate games..."); }

    let incremental_filter = if full {
        ""
    } else {
        "AND (g1.deduped IS NOT TRUE OR g2.deduped IS NOT TRUE)"
    };
    // Duplicate PAIRS straight from the fingerprints: same players/date/result and
    // identical (move_hash = move_hash) or off-by-one-trailing-half-move
    // (move_hash = move_hash_short, either way) move sequences. We carry each
    // game's pgn LENGTH — the survivor metric — but never the pgn itself, so this
    // stays a tiny id+length result no matter how many duplicates there are.
    let pairs: Vec<(u32, i64, u32, i64)> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT g1.id, LENGTH(g1.pgn), g2.id, LENGTH(g2.pgn)
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
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .filter_map(|r| r.ok())
            .collect()
    };
    spinner.finish_and_clear();

    // Resolve duplicate clusters and pick each survivor: the LONGEST pgn wins — a
    // more complete game, or (at equal moves) an annotated one, beats a bare copy;
    // ties break to the lowest id. Union-find handles exact duplicates, off-by-one
    // truncations and 3+-way copies uniformly. Returns (loser_id, winner_id).
    let losers = resolve_survivors(&pairs);

    if losers.is_empty() {
        // Nothing to remove, but the games examined this pass are now vetted.
        mark_vetted(conn, dry_run, reporter)?;
        reporter.done("No duplicate games found.");
        return Ok(());
    }

    if !dry_run {
        let spinner = reporter.spinner();
        spinner.set_message(format!("Removing {} duplicate game(s)…", losers.len()));
        if reporter.is_json() { reporter.log(format!("Removing {} duplicate game(s)…", losers.len())); }
        // Reassign each loser's collections to its winner and delete the losers —
        // all set-based (one INSERT, one DELETE), then sweep their now-orphaned
        // positions/game_collections rows and refresh player game counts (#205).
        //
        // Drop the games secondary indexes around the mass DELETE: removing rows
        // pays a per-row incremental ART delete on every index over the table
        // (#244) — the same allocation-bound cost that dominated the player merge.
        // A bulk CREATE INDEX afterwards is parallel and fast. Rebuild on every
        // exit so reads always get their indexes back.
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_games_white;
             DROP INDEX IF EXISTS idx_games_black;
             DROP INDEX IF EXISTS idx_games_date;
             DROP INDEX IF EXISTS idx_games_eco;
             DROP INDEX IF EXISTS idx_games_chessbase_id;",
        )?;
        let apply_result = apply_dedup(conn, &losers).and_then(|()| sweep_deleted_game_refs(conn));
        // Same guard as the player merge: an inherited transaction would make
        // every CREATE INDEX below fail and leave five indexes missing (#255).
        crate::db::clear_stray_transaction(conn);
        let rebuild_result = conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_id);
             CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_id);
             CREATE INDEX IF NOT EXISTS idx_games_date  ON games(date);
             CREATE INDEX IF NOT EXISTS idx_games_eco   ON games(eco);
             CREATE INDEX IF NOT EXISTS idx_games_chessbase_id ON games(chessbase_id);",
        );
        apply_result?;
        rebuild_result.context(
            "the games secondary indexes could not be rebuilt and are now missing — \
             queries will be slow until deduplication is re-run",
        )?;
        crate::db::queries::recalculate_game_counts(conn)?;
        spinner.finish_and_clear();
    }

    mark_vetted(conn, dry_run, reporter)?;
    reporter.done(format!(
        "{}: {} duplicate game(s) {}.",
        if dry_run { "Dry run" } else { "Done" },
        losers.len(),
        if dry_run { "would be deleted" } else { "deleted" },
    ));
    Ok(())
}

/// Given duplicate pairs `(id_a, pgn_len_a, id_b, pgn_len_b)`, group them into
/// clusters (union-find over the pair graph) and pick one survivor per cluster —
/// the game with the LONGEST pgn (ties → lowest id). Returns `(loser, winner)`
/// for every non-survivor. All in memory over ids + lengths; no PGNs involved.
fn resolve_survivors(pairs: &[(u32, i64, u32, i64)]) -> Vec<(u32, u32)> {
    use std::collections::HashMap;
    let mut parent: HashMap<u32, u32> = HashMap::new();
    let mut len: HashMap<u32, i64> = HashMap::new();
    for &(a, la, b, lb) in pairs {
        parent.entry(a).or_insert(a);
        parent.entry(b).or_insert(b);
        len.insert(a, la);
        len.insert(b, lb);
        let ra = uf_find(&mut parent, a);
        let rb = uf_find(&mut parent, b);
        if ra != rb {
            parent.insert(ra, rb);
        }
    }
    // Best (longest pgn, else lowest id) per cluster root.
    let ids: Vec<u32> = len.keys().copied().collect();
    let mut winner: HashMap<u32, (i64, u32)> = HashMap::new();
    for &id in &ids {
        let root = uf_find(&mut parent, id);
        let l = len[&id];
        let e = winner.entry(root).or_insert((l, id));
        if l > e.0 || (l == e.0 && id < e.1) {
            *e = (l, id);
        }
    }
    let mut out = Vec::new();
    for &id in &ids {
        let root = uf_find(&mut parent, id);
        let w = winner[&root].1;
        if id != w {
            out.push((id, w));
        }
    }
    out
}

/// Union-find root with path compression.
fn uf_find(parent: &mut std::collections::HashMap<u32, u32>, x: u32) -> u32 {
    let mut root = x;
    while let Some(&p) = parent.get(&root) {
        if p == root {
            break;
        }
        root = p;
    }
    let mut cur = x;
    while let Some(&p) = parent.get(&cur) {
        if p == root {
            break;
        }
        parent.insert(cur, root);
        cur = p;
    }
    root
}

/// Apply a resolved `(loser, winner)` set: move every loser's collection
/// memberships onto its winner, then delete all losers — two set-based statements
/// via a staging temp table, so the cost is one `game_collections` scan and one
/// keyed `games` delete regardless of how many duplicates there are. Callers run
/// the orphan sweep + game-count refresh afterwards.
fn apply_dedup(conn: &Connection, losers: &[(u32, u32)]) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS dedup_map;
         CREATE TEMP TABLE dedup_map (loser UINTEGER, winner UINTEGER);",
    )?;
    {
        let mut app = conn.appender("dedup_map")?;
        for (loser, winner) in losers {
            app.append_row(duckdb::params![loser, winner])?;
        }
        app.flush()?;
    }
    // Move each loser's collection memberships onto its winner via an anti-join
    // rather than `ON CONFLICT DO NOTHING`: the upsert against the composite-PK
    // ART index could leave it inconsistent, and a later DELETE then died with
    // "Failed to delete all rows from index", invalidating the whole DB (#244).
    conn.execute_batch(
        "INSERT INTO game_collections (game_id, collection_id)
             SELECT DISTINCT m.winner, gc.collection_id
             FROM game_collections gc JOIN dedup_map m ON gc.game_id = m.loser
             WHERE NOT EXISTS (
                 SELECT 1 FROM game_collections x
                 WHERE x.game_id = m.winner AND x.collection_id = gc.collection_id
             );
         DELETE FROM games WHERE id IN (SELECT loser FROM dedup_map);
         DROP TABLE IF EXISTS dedup_map;",
    )?;
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
    // `positions` has no index at all, so deleting orphans is a plain scan-delete.
    conn.execute_batch(
        "DELETE FROM positions
           WHERE NOT EXISTS (SELECT 1 FROM games g WHERE g.id = positions.game_id);",
    )?;

    // `game_collections` is cleared by REBUILD, not DELETE: a plain delete removes
    // entries from its composite-PK ART index one row at a time — both slow (#244,
    // the incremental ART-maintenance cost) and the trigger of DuckDB's "Failed to
    // delete all rows from index" fatal on a large first-run. Recreating from a
    // SELECT DISTINCT of still-referenced rows builds a fresh index in bulk, drops
    // orphans, and collapses any duplicate rows a prior inconsistent index hid.
    conn.execute_batch(
        "CREATE TABLE game_collections_rebuild (
             game_id        UINTEGER NOT NULL,
             collection_id  INTEGER NOT NULL,
             PRIMARY KEY (game_id, collection_id)
         );
         INSERT INTO game_collections_rebuild (game_id, collection_id)
             SELECT DISTINCT gc.game_id, gc.collection_id
             FROM game_collections gc
             WHERE EXISTS (SELECT 1 FROM games g WHERE g.id = gc.game_id);
         DROP TABLE game_collections;
         ALTER TABLE game_collections_rebuild RENAME TO game_collections;
         CREATE INDEX IF NOT EXISTS idx_game_collections_collection
             ON game_collections(collection_id);",
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

/// The id of the row to keep for a cluster. A row carrying the cluster's FIDE ID
/// always wins: the merge only rewrites `games`, so a FIDE-less survivor would
/// drop the ID off the database entirely. Among equals, `name_score` decides,
/// and the lowest id breaks a tie so the choice is stable across runs.
fn pick_survivor(rows: &[&PlayerRow]) -> u32 {
    rows.iter()
        .max_by_key(|r| {
            (
                r.fide_id.is_some(),
                name_score(&r.name, r.name_normalised, r.last_date.as_deref()),
                std::cmp::Reverse(r.id),
            )
        })
        .map(|r| r.id)
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

    /// #205: removing a duplicate must refresh the players' game counts, which the
    /// deleted game left overstated.
    #[test]
    fn dedup_refreshes_player_game_counts() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO players (id, name, name_normalized, name_normalised, game_count) VALUES
               (1, 'A', 'a', FALSE, 99), (2, 'B', 'b', FALSE, 99);
             INSERT INTO games (id, white_id, black_id, date, result, opening_line, move_count, pgn, deduped) VALUES
               (1, 1, 2, '2024-06-18', '1-0', 'e4 e5 Nf3 Nc6', 4, '[W \"a\"]\n\n1. e4 e5 2. Nf3 Nc6 1-0', FALSE),
               (2, 1, 2, '2024-06-18', '1-0', 'e4 e5 Nf3 Nc6', 4, '[W \"a\"]\n\n1. e4 e5 2. Nf3 Nc6 1-0', FALSE);",
        ).unwrap();

        dedup_games(&conn, false, true, &Reporter::silent()).unwrap();

        assert_eq!(count_games(&conn), 1, "the duplicate game is removed");
        let gc = |id: u32| -> i64 {
            conn.query_row("SELECT game_count FROM players WHERE id = ?", duckdb::params![id], |r| r.get(0)).unwrap()
        };
        assert_eq!(gc(1), 1, "white player's count refreshed (was stale 99)");
        assert_eq!(gc(2), 1, "black player's count refreshed (was stale 99)");
    }

    #[test]
    fn resolve_survivors_picks_longest_per_cluster() {
        // 3-way cluster (all pairwise, e.g. exact copies); lengths 10/30/20 → win 2.
        let mut losers = resolve_survivors(&[(1, 10, 2, 30), (2, 30, 3, 20), (1, 10, 3, 20)]);
        losers.sort();
        assert_eq!(losers, vec![(1, 2), (3, 2)], "both shorter copies map to the longest");
    }

    #[test]
    fn resolve_survivors_handles_chains() {
        // Chain 1-2, 2-3 with no 1-3 pair (off-by-one truncations); win = longest.
        let mut losers = resolve_survivors(&[(1, 10, 2, 20), (2, 20, 3, 30)]);
        losers.sort();
        assert_eq!(losers, vec![(1, 3), (2, 3)], "chain collapses to the longest");
    }

    #[test]
    fn resolve_survivors_breaks_length_ties_by_lowest_id() {
        let losers = resolve_survivors(&[(5, 10, 2, 10)]);
        assert_eq!(losers, vec![(5, 2)], "equal length → lower id (2) survives");
    }

    /// Three copies of one game in the DB collapse to the single longest, and both
    /// losers' collection memberships land on the survivor.
    #[test]
    fn three_way_duplicate_collapses_to_longest_with_merged_collections() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO collections (id, name) VALUES (10, 'C1'), (20, 'C2'), (30, 'C3');
             INSERT INTO games (id, white_id, black_id, date, result, opening_line, move_count, pgn, deduped) VALUES
               (1, 1, 2, '2024-06-18', '1-0', 'e4 e5 Nf3', 3, '[W \"a\"]\n\n1. e4 e5 2. Nf3 1-0', FALSE),
               (2, 1, 2, '2024-06-18', '1-0', 'e4 e5 Nf3', 3, '[W \"a\"]\n\n1. e4 e5 2. Nf3 {longest annotated copy here} 1-0', FALSE),
               (3, 1, 2, '2024-06-18', '1-0', 'e4 e5 Nf3', 3, '[W \"a\"]\n\n1. e4 e5 2. Nf3 {mid} 1-0', FALSE);
             INSERT INTO game_collections (game_id, collection_id) VALUES (1, 10), (2, 20), (3, 30);",
        ).unwrap();

        dedup_games(&conn, false, true, &Reporter::silent()).unwrap();

        // Only game 2 (longest pgn) survives.
        let ids: Vec<u32> = {
            let mut s = conn.prepare("SELECT id FROM games ORDER BY id").unwrap();
            s.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        };
        assert_eq!(ids, vec![2]);
        // Survivor inherits all three collections; the losers' rows are swept.
        let cols: Vec<i32> = {
            let mut s = conn.prepare("SELECT collection_id FROM game_collections ORDER BY collection_id").unwrap();
            s.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        };
        assert_eq!(cols, vec![10, 20, 30], "winner inherits every loser's collection; orphans swept");
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

        dedup_players(&conn, false, &Reporter::silent()).unwrap();

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
        dedup_players(&conn, false, &Reporter::silent()).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM players", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    fn ids(conn: &Connection) -> Vec<u32> {
        let mut s = conn.prepare("SELECT id FROM players ORDER BY id").unwrap();
        s.query_map([], |r| r.get(0)).unwrap().filter_map(|r| r.ok()).collect()
    }

    /// The gap this key closes: two rows with the same normalised name and no
    /// FIDE ID on either. Nothing linked them before, and while they were split
    /// `dedup_games` could not see that their games were the same game.
    #[test]
    fn merges_same_normalised_name_without_fide_ids() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'Sedlak,Marek','sedlak marek',NULL,FALSE),
               (2,'Sedlak, Marek','sedlak marek',NULL,FALSE);
             INSERT INTO games (id, white_id, black_id, date) VALUES (1, 2, 1, '2020-01-01');",
        )
        .unwrap();

        dedup_players(&conn, false, &Reporter::silent()).unwrap();

        // Rows in a name group differ only in spacing/case — which `name_score`
        // scores identically — so the tiebreak decides: the lowest (oldest) id.
        assert_eq!(ids(&conn), vec![1]);
        let g: (u32, u32) = conn
            .query_row("SELECT white_id, black_id FROM games WHERE id=1", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(g, (1, 1), "both sides reassigned to the survivor");
    }

    /// A rename (`players normalise` / `players import`) can land a FIDE-carrying
    /// row on a name a FIDE-less row already holds. The merged row must keep the
    /// FIDE ID — the merge only rewrites `games`, so a FIDE-less survivor would
    /// drop it from the database.
    #[test]
    fn survivor_keeps_the_fide_id_when_merging_by_name() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'Sedlak, Marek','sedlak marek',NULL,FALSE),
               (2,'Sedlak, Marek','sedlak marek',555,TRUE);
             INSERT INTO games (id, white_id, black_id, date) VALUES (1, 1, 2, '2020-01-01');",
        )
        .unwrap();

        dedup_players(&conn, false, &Reporter::silent()).unwrap();

        assert_eq!(ids(&conn), vec![2]);
        let fide: Option<u32> = conn
            .query_row("SELECT fide_id FROM players WHERE id=2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fide, Some(555));
    }

    /// Namesakes FIDE itself distinguishes are left alone — a merge cannot be
    /// undone, so two distinct FIDE IDs under one name veto the whole name group.
    #[test]
    fn refuses_same_name_with_two_different_fide_ids() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'Smith, John','smith john',111,TRUE),
               (2,'Smith, John','smith john',222,TRUE),
               (3,'Smith, John','smith john',NULL,FALSE);",
        )
        .unwrap();

        dedup_players(&conn, false, &Reporter::silent()).unwrap();

        assert_eq!(ids(&conn), vec![1, 2, 3], "including the FIDE-less row: which one is it?");
    }

    /// Chained across both keys: A and B share a FIDE ID, B and C share a name.
    /// All three are one person and must collapse to a single row.
    #[test]
    fn chains_fide_id_and_name_links_into_one_cluster() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'Novak,P','novak p',77,FALSE),
               (2,'Novak, Peter','novak peter',77,TRUE),
               (3,'Novak, Peter','novak peter',NULL,FALSE);
             INSERT INTO games (id, white_id, black_id, date) VALUES
               (1, 1, 3, '2020-01-01'),
               (2, 3, 2, '2021-01-01');",
        )
        .unwrap();

        dedup_players(&conn, false, &Reporter::silent()).unwrap();

        assert_eq!(ids(&conn), vec![2], "the normalised, FIDE-carrying row survives");
        let all: Vec<(u32, u32)> = {
            let mut s = conn.prepare("SELECT white_id, black_id FROM games ORDER BY id").unwrap();
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().filter_map(|r| r.ok()).collect()
        };
        assert_eq!(all, vec![(2, 2), (2, 2)], "every reference chased to the one survivor");
    }

    /// An empty normalised name is not an identity — rows that have one must not
    /// all collapse into a single player.
    #[test]
    fn empty_normalised_name_is_not_a_merge_key() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'?','',NULL,FALSE),
               (2,'','',NULL,FALSE);",
        )
        .unwrap();

        dedup_players(&conn, false, &Reporter::silent()).unwrap();

        assert_eq!(ids(&conn), vec![1, 2]);
    }

    /// Merging players changes the very key `dedup_games` pairs on, so any
    /// "already vetted" verdict reached while the rows were split is stale. The
    /// automatic pipeline runs normalise → dedup_players → dedup_games, and its
    /// dedup_games is INCREMENTAL: without re-opening the survivor's games, a
    /// duplicate pair that was unmatchable in one pass stays vetted and is never
    /// looked at again — so the copies survive forever (#266).
    #[test]
    fn merge_reopens_the_survivors_games_for_the_next_incremental_dedup() {
        let conn = setup();
        // Two records for one person (same normalised name), each holding one
        // copy of the SAME game. Both games were vetted by an earlier pass that
        // could not pair them, because their white_ids differed.
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'Abadjian, Vahram','abadjian vahram',NULL,FALSE),
               (2,'Abadjian, Vahram','abadjian vahram',12345,TRUE),
               (3,'Krejcar, Walter','krejcar walter',NULL,FALSE);
             INSERT INTO games (id, white_id, black_id, date, result, opening_line, move_count, pgn, deduped) VALUES
               (1, 1, 3, '2026-02-14', '0-1', 'e4 e5', 4, '[W \"a\"]\n\n1. e4 e5 2. Nf3 Nc6 0-1', TRUE),
               (2, 2, 3, '2026-02-14', '0-1', 'e4 e5', 4, '[W \"a\"]\n\n1. e4 e5 2. Nf3 Nc6 0-1', TRUE);",
        )
        .unwrap();

        dedup_players(&conn, false, &Reporter::silent()).unwrap();
        // Incremental — exactly what the post-import pipeline runs.
        dedup_games(&conn, false, false, &Reporter::silent()).unwrap();

        let games: i64 = conn.query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0)).unwrap();
        assert_eq!(games, 1, "the copy the merge exposed is removed by the very next pass");
    }

    /// A preview must leave the database exactly as it found it — players, game
    /// assignments and the `deduped` flags a real merge would have cleared.
    #[test]
    fn dry_run_changes_nothing() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'Abadjian, Vahram','abadjian vahram',NULL,FALSE),
               (2,'Abadjian, Vahram','abadjian vahram',12345,TRUE),
               (3,'Krejcar, Walter','krejcar walter',NULL,FALSE);
             INSERT INTO games (id, white_id, black_id, date, deduped) VALUES
               (1, 1, 3, '2026-02-14', TRUE);",
        )
        .unwrap();

        dedup_players(&conn, true, &Reporter::silent()).unwrap();

        assert_eq!(ids(&conn), vec![1, 2, 3], "no row removed");
        let (w, vetted): (u32, bool) = conn
            .query_row("SELECT white_id, deduped FROM games WHERE id=1", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(w, 1, "no game reassigned");
        assert!(vetted, "dedup flags untouched");

        // ...and the real run that follows still does the work.
        dedup_players(&conn, false, &Reporter::silent()).unwrap();
        assert_eq!(ids(&conn), vec![2, 3]);
    }

    /// #205-style: after a merge the survivor owns its losers' games, so the
    /// stored counts must be refreshed even when no game dedup follows.
    #[test]
    fn merge_refreshes_player_game_counts() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO players (id,name,name_normalized,fide_id,name_normalised,game_count) VALUES
               (1,'Sedlak, Marek','sedlak marek',NULL,FALSE,1),
               (2,'Sedlak, Marek','sedlak marek',555,TRUE,1),
               (3,'Horak, Jan','horak jan',666,TRUE,2);
             INSERT INTO games (id, white_id, black_id, date) VALUES
               (1, 1, 3, '2020-01-01'),
               (2, 2, 3, '2021-01-01');",
        )
        .unwrap();

        dedup_players(&conn, false, &Reporter::silent()).unwrap();

        let gc = |id: u32| -> i64 {
            conn.query_row("SELECT game_count FROM players WHERE id=?", duckdb::params![id], |r| r.get(0)).unwrap()
        };
        assert_eq!(gc(2), 2, "survivor's count covers both merged rows' games");
        assert_eq!(gc(3), 2, "untouched player's count still right");
    }
}
