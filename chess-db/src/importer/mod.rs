pub mod visitor;

use crate::importer::visitor::GameVisitor;
use anyhow::Result;
use rayon::prelude::*;
use duckdb::Connection;
use indicatif::{MultiProgress, ProgressBar};
use crate::progress;
use crate::reporter::Reporter;
use pgn_reader::Reader;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::Path;

const BATCH_SIZE: usize = 10_000;
const INDEX_READ_BATCH: usize = 50_000;
// Parse/flush/report indexing in sub-chunks of this many games so the progress
// bar advances smoothly even when the whole DB fits in one read batch.
const INDEX_REPORT_CHUNK: usize = 2_000;
const LARGE_FILE_THRESHOLD: u64 = 100 * 1024 * 1024; // 100 MB

/// User-facing knobs for `import-pgn`: grouping + visibility + duplicate policy.
pub struct ImportSpec {
    pub collection: String,
    /// "public" | "private". Sets visibility on newly inserted games and acts
    /// as a one-way ratchet on dedup-skipped existing games (public always
    /// wins; private never auto-downgrades).
    pub visibility: String,
    pub on_duplicate: String,      // "skip" | "replace" | "always"
}

pub fn upsert_collection(conn: &Connection, name: &str) -> Result<i32> {
    if let Ok(id) = conn.query_row(
        "SELECT id FROM collections WHERE name = ?",
        duckdb::params![name],
        |r| r.get::<_, i32>(0),
    ) {
        return Ok(id);
    }
    let next_id: i32 = conn
        .query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM collections", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO collections (id, name, created_at) VALUES (?, ?, CAST(NOW() AS TIMESTAMP))",
        duckdb::params![next_id, name],
    )?;
    Ok(next_id)
}

/// On a dedup-skip event: tag the existing game with the current import's
/// collection (idempotent), and apply the visibility ratchet — public always
/// wins. Private imports never modify visibility (no auto-downgrade).
fn tag_existing_match(conn: &Connection, existing_id: u32, collection_id: i32, visibility: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO game_collections (game_id, collection_id) VALUES (?, ?)
         ON CONFLICT (game_id, collection_id) DO NOTHING",
        duckdb::params![existing_id, collection_id],
    )?;
    if visibility == "public" {
        conn.execute(
            "UPDATE games SET visibility = 'public' WHERE id = ? AND visibility != 'public'",
            duckdb::params![existing_id],
        )?;
    }
    Ok(())
}

/// Add every game belonging to `issue_id` to `collection_id` (idempotent).
fn add_issue_to_collection(conn: &Connection, issue_id: i32, collection_id: i32) -> Result<()> {
    conn.execute(
        "INSERT INTO game_collections (game_id, collection_id)
         SELECT g.id, ?
         FROM games g
         LEFT JOIN game_collections gc
                ON gc.game_id = g.id AND gc.collection_id = ?
         WHERE g.issue_id = ? AND gc.game_id IS NULL",
        duckdb::params![collection_id, collection_id, issue_id],
    )?;
    Ok(())
}

/// Expand a path into a list of .pgn files. A file path returns just that file;
/// a directory is read non-recursively (matches existing behaviour).
fn collect_pgn_files(path: &Path) -> Result<Vec<std::path::PathBuf>> {
    if path.is_file() {
        if path.extension().and_then(|s| s.to_str()) == Some("pgn") {
            Ok(vec![path.to_path_buf()])
        } else {
            anyhow::bail!("not a .pgn file: {}", path.display());
        }
    } else if path.is_dir() {
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(path)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("pgn"))
            .collect();
        files.sort();
        Ok(files)
    } else {
        anyhow::bail!("not a file or directory: {}", path.display());
    }
}

/// Wraps any `Read` impl and counts bytes consumed, so we can convert a parse
/// error's position back into a human-readable line number.
struct LineCountingReader<R> {
    inner: R,
    bytes_read: usize,
}

impl<R: Read> LineCountingReader<R> {
    fn new(inner: R) -> Self {
        Self { inner, bytes_read: 0 }
    }
    fn bytes_read(&self) -> usize {
        self.bytes_read
    }
}

impl<R: Read> Read for LineCountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.bytes_read += n;
        Ok(n)
    }
}

fn byte_offset_to_line(bytes: &[u8], offset: usize) -> usize {
    bytes[..offset.min(bytes.len())]
        .iter()
        .filter(|&&b| b == b'\n')
        .count()
        + 1
}

/// Drop all indexes that would be maintained live during a bulk import.
/// Safe to call even if the indexes do not exist yet.
fn drop_bulk_indexes(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_games_white;
         DROP INDEX IF EXISTS idx_games_black;
         DROP INDEX IF EXISTS idx_games_date;
         DROP INDEX IF EXISTS idx_games_eco;",
    )?;
    Ok(())
}

/// Recreate games indexes after a bulk import.
/// Position index is intentionally excluded — use `chess-db index-positions`
/// after the import completes, which runs in a clean memory state.
fn recreate_bulk_indexes(conn: &Connection) -> Result<()> {
    // Use single-threaded builds to avoid memory pressure on large tables
    conn.execute_batch("SET threads=1;")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_id);
         CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_id);
         CREATE INDEX IF NOT EXISTS idx_games_date  ON games(date);
         CREATE INDEX IF NOT EXISTS idx_games_eco   ON games(eco);",
    )?;
    conn.execute_batch("SET threads=4;")?;
    Ok(())
}

/// Build or extend the positions table from PGN already stored in `games`.
///
/// - `rebuild = false` (default): only processes games with no existing positions rows.
/// - `rebuild = true`: clears the table first, then reprocesses every game.
pub fn index_positions(
    conn: &Connection,
    max_position_depth: Option<i16>,
    rebuild: bool,
    fast: bool,
    reporter: &Reporter,
) -> Result<()> {
    if max_position_depth.is_none() {
        reporter.log("Clearing positions table.");
        conn.execute_batch("DELETE FROM positions;")?;
        reporter.done("Positions table cleared.");
        return Ok(());
    }

    if rebuild {
        reporter.log("Rebuilding positions table from scratch...");
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_positions_hash;
             DROP TABLE IF EXISTS positions;
             CREATE TABLE positions (
                 game_id      UINTEGER REFERENCES games(id),
                 move_number  SMALLINT,
                 zobrist_hash BIGINT,
                 next_move    VARCHAR
             );",
        )?;
    }

    // Count how many games need processing
    let pending: i64 = if rebuild {
        conn.query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0))?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM games g
             WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.game_id = g.id)",
            [],
            |r| r.get(0),
        )?
    };

    if pending == 0 {
        reporter.done("All games are already indexed. Use --rebuild to reprocess with a different depth.");
        return Ok(());
    }

    let depth = max_position_depth.unwrap();
    reporter.log(format!(
        "Indexing positions for {} game(s) (depth: {} half-moves)...",
        pending, depth
    ));

    // No hash index — DuckDB's CREATE INDEX on this column triggers a heap
    // corruption bug in the bundled version regardless of memory or thread
    // settings. DuckDB's vectorized columnar scan handles position lookups
    // fast enough without an index (~0.3s for 30M rows on modern hardware).
    conn.execute_batch("DROP INDEX IF EXISTS idx_positions_hash;")?;

    let pb = reporter.bar_with_eta(pending as u64);

    let insert_result = fill_positions(conn, &pb, reporter, pending as u64, rebuild, max_position_depth, fast);

    pb.finish_with_message("Indexing complete");
    reporter.done(format!("Indexing complete. {} games indexed.", pending));
    insert_result
}

fn fill_positions(
    conn: &Connection,
    pb: &indicatif::ProgressBar,
    reporter: &Reporter,
    total: u64,
    rebuild: bool,
    max_position_depth: Option<i16>,
    fast: bool,
) -> Result<()> {
    let select_sql = if rebuild {
        "SELECT id, pgn FROM games WHERE id > ? ORDER BY id LIMIT ?"
    } else {
        "SELECT g.id, g.pgn FROM games g
         WHERE g.id > ?
           AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.game_id = g.id)
         ORDER BY g.id LIMIT ?"
    };

    let mut last_id: u32 = 0;

    loop {
        let mut stmt = conn.prepare(select_sql)?;
        let rows: Vec<(u32, String)> = stmt
            .query_map(duckdb::params![last_id, INDEX_READ_BATCH as i64], |r| {
                Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        if rows.is_empty() {
            break;
        }

        last_id = rows.last().map(|(id, _)| *id).unwrap_or(last_id);

        // Parse/flush/report in sub-chunks so the progress bar advances smoothly.
        // Reporting only once per (large) read batch left the GUI bar at 0% until
        // the whole batch — often the entire database — had finished.
        for chunk in rows.chunks(INDEX_REPORT_CHUNK) {
            // Parse this sub-chunk in parallel — each task gets its own
            // GameVisitor (cheap: just holds max_position_depth).
            let position_batch: Vec<PositionRow> = chunk
                .par_iter()
                .flat_map(|(game_id, pgn)| {
                    let repaired = repair_pgn_header_quotes(pgn);
                    let mut visitor = GameVisitor::new(max_position_depth);
                    let mut reader = Reader::new(std::io::Cursor::new(repaired.as_bytes()));
                    match reader.read_game(&mut visitor) {
                        Ok(Some(Some(game))) => game.positions.into_iter().map(|(move_num, hash, next_move)| {
                            PositionRow {
                                game_id: *game_id,
                                move_number: move_num,
                                zobrist_hash: hash,
                                next_move,
                            }
                        }).collect(),
                        _ => vec![],
                    }
                })
                .collect();

            flush_positions(conn, &position_batch, fast)?;
            pb.inc(chunk.len() as u64);
            reporter.progress(pb.position(), total, format!("Indexed {} / {} games", pb.position(), total));
        }
    }

    Ok(())
}

/// `max_position_depth` — None = skip position indexing,
/// Some(n) = index positions up to half-move n.
/// `reindex_threshold` — drop all indexes before the bulk load and rebuild
/// them at the end when the number of pending issues meets or exceeds this
/// value. 0 = always reindex. Use a large value to disable.
pub fn import(
    conn: &Connection,
    dir: &Path,
    max_position_depth: Option<i16>,
    reindex_threshold: usize,
    fast: bool,
    skip_dedup: bool,
    reporter: &Reporter,
) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, filename FROM issues WHERE downloaded = TRUE AND imported = FALSE ORDER BY id",
    )?;

    let issues: Vec<(i32, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    if issues.is_empty() {
        reporter.done("No new issues to import.");
        return Ok(());
    }

    let bulk_mode = issues.len() >= reindex_threshold;

    reporter.log(format!("Importing {} issue(s)...", issues.len()));
    if bulk_mode {
        reporter.log("Bulk mode: indexes dropped for faster import. Positions skipped.");
        drop_bulk_indexes(conn)?;
    } else if let Some(depth) = max_position_depth {
        reporter.log(format!("Position indexing enabled (depth: {} half-moves).", depth));
    }

    let total = issues.len() as u64;
    let pb = reporter.bar(total);
    let mut completed = 0u64;

    let mut ctx = ImportContext::new(conn, skip_dedup)?;
    let twic_collection_id = upsert_collection(conn, "TWIC")?;

    let import_result = (|| -> Result<()> {
        for (issue_id, filename) in &issues {
            pb.set_message(format!("issue {}", issue_id));

            let zip_path = dir.join(filename);
            if !zip_path.exists() {
                let msg = format!("  Zip not found: {}", zip_path.display());
                pb.println(&msg);
                reporter.log(&msg);
                pb.inc(1);
                completed += 1;
                continue;
            }

            let effective_depth = if bulk_mode { None } else { max_position_depth };
            match import_issue(conn, *issue_id, twic_collection_id, "public", &zip_path, effective_depth, &mut ctx, fast) {
                Ok((imported, skipped_dups, skipped_ns)) => {
                    conn.execute(
                        "UPDATE issues SET imported = TRUE, imported_at = NOW(), game_count = ? WHERE id = ?",
                        duckdb::params![imported as i32, issue_id],
                    )?;
                    add_issue_to_collection(conn, *issue_id, twic_collection_id)?;
                    let msg = format!("  Issue {}: {}", issue_id, import_summary(imported, skipped_dups, skipped_ns));
                    pb.println(&msg);
                    reporter.log(&msg);
                }
                Err(e) => {
                    let msg = format!("  Issue {}: error: {}", issue_id, e);
                    pb.println(&msg);
                    reporter.error(&msg);
                }
            }

            pb.inc(1);
            completed += 1;
            reporter.progress(completed, total, format!("Imported {} / {} issues", completed, total));
        }
        Ok(())
    })();

    if bulk_mode {
        pb.set_message("Rebuilding indexes…");
        recreate_bulk_indexes(conn)?;
        let msg = "  Run:  chess-db index-positions  to build the positions index.";
        pb.println(msg);
        reporter.log(msg);
    }

    pb.set_message("Updating player game counts…");
    crate::db::queries::recalculate_game_counts(conn)?;

    pb.finish_with_message("Import complete");
    reporter.done("Import complete");
    import_result
}

/// Import arbitrary PGN files from a single file or a directory of `.pgn` files,
/// skipping files already recorded in the issues table.
///
/// Games are added to `spec.collection` (created if missing) and inserted with
/// `spec.visibility`. Dedup-skipped existing games are also tagged into the
/// collection; if `spec.visibility == 'public'` they are also ratcheted up.
/// `spec.on_duplicate` controls duplicate handling: "skip" (default;
/// fingerprint check), "always" (insert all), "replace" (not yet implemented).
pub fn import_pgn(
    conn: &Connection,
    path: &Path,
    max_position_depth: Option<i16>,
    reindex_threshold: usize,
    fast: bool,
    skip_dedup: bool,
    spec: &ImportSpec,
    reporter: &Reporter,
) -> Result<()> {
    let effective_skip_dedup = match spec.on_duplicate.as_str() {
        "skip" => skip_dedup,
        "always" => true,
        "replace" => anyhow::bail!("--on-duplicate=replace is not implemented yet"),
        other => anyhow::bail!("invalid --on-duplicate value: {}", other),
    };
    let visibility: &'static str = match spec.visibility.as_str() {
        "public" => "public",
        "private" => "private",
        other => anyhow::bail!("invalid visibility: {}", other),
    };

    let collection_id = upsert_collection(conn, &spec.collection)?;

    let pgn_files = collect_pgn_files(path)?;

    if pgn_files.is_empty() {
        reporter.done(format!("No PGN files found in {}.", path.display()));
        return Ok(());
    }

    // Load already-imported filenames
    let imported_filenames: std::collections::HashSet<String> = {
        let mut stmt = conn.prepare(
            "SELECT filename FROM issues WHERE imported = TRUE AND filename IS NOT NULL",
        )?;
        stmt.query_map([], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect()
    };

    let pending: Vec<_> = pgn_files
        .into_iter()
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !imported_filenames.contains(n))
                .unwrap_or(false)
        })
        .collect();

    if pending.is_empty() {
        reporter.done(format!("All PGN files at {} are already imported.", path.display()));
        return Ok(());
    }

    let bulk_mode = pending.len() >= reindex_threshold;

    reporter.log(format!("Importing {} PGN file(s)...", pending.len()));
    if bulk_mode {
        reporter.log("Bulk mode: indexes dropped for faster import. Positions skipped.");
        drop_bulk_indexes(conn)?;
    } else if let Some(depth) = max_position_depth {
        reporter.log(format!("Position indexing enabled (depth: {} half-moves).", depth));
    }

    let total = pending.len() as u64;
    let mp = if reporter.is_json() { None } else { Some(MultiProgress::new()) };
    let pb = if let Some(ref mp) = mp {
        mp.add(reporter.bar(total))
    } else {
        reporter.bar(total)
    };
    let mut completed = 0u64;

    // Allocate issue IDs above the TWIC range (TWIC issues are ~1–1500)
    let mut next_issue_id: i32 = {
        let max_id: Option<i64> = conn
            .query_row("SELECT MAX(id) FROM issues", [], |r| r.get(0))
            .unwrap_or(None);
        (max_id.unwrap_or(0) as i32).max(1_000_000) + 1
    };

    let mut ctx = ImportContext::new(conn, effective_skip_dedup)?;

    let import_result = (|| -> Result<()> {
        for path in &pending {
            let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            pb.set_message(filename.to_string());

            // Reuse an existing interrupted issue for this filename if one exists,
            // so we always clean up the right games and never accumulate orphaned rows.
            let issue_id: i32 = {
                let existing: Option<i32> = conn
                    .query_row(
                        "SELECT id FROM issues WHERE filename = ? AND imported = FALSE LIMIT 1",
                        duckdb::params![filename],
                        |r| r.get(0),
                    )
                    .ok();
                if let Some(id) = existing {
                    id
                } else {
                    let id = next_issue_id;
                    next_issue_id += 1;
                    conn.execute(
                        "INSERT INTO issues (id, filename, downloaded, imported, game_count)
                         VALUES (?, ?, TRUE, FALSE, NULL)",
                        duckdb::params![id, filename],
                    )?;
                    id
                }
            };

            // Remove any games from a previous interrupted run of this file.
            conn.execute("DELETE FROM games WHERE issue_id = ?", duckdb::params![issue_id])?;

            let pgn_bytes = match std::fs::read(path) {
                Ok(b) => b,
                Err(e) => {
                    let msg = format!("  {}: read error: {}", filename, e);
                    pb.println(&msg);
                    reporter.error(&msg);
                    pb.inc(1);
                    completed += 1;
                    continue;
                }
            };

            let file_pb = if !reporter.is_json() && pgn_bytes.len() as u64 >= LARGE_FILE_THRESHOLD {
                if let Some(ref mp) = mp {
                    let fpb = mp.insert_before(&pb, ProgressBar::new(pgn_bytes.len() as u64));
                    fpb.set_style(progress::byte_bar_style());
                    Some(fpb)
                } else {
                    None
                }
            } else {
                None
            };

            let effective_depth = if bulk_mode { None } else { max_position_depth };
            match process_pgn_bytes(conn, issue_id, collection_id, visibility, &pgn_bytes, effective_depth, &mut ctx, file_pb.as_ref(), fast) {
                Ok((imported, skipped_dups, skipped_ns)) => {
                    conn.execute(
                        "UPDATE issues SET imported = TRUE, imported_at = NOW(), game_count = ? WHERE id = ?",
                        duckdb::params![imported as i32, issue_id],
                    )?;
                    add_issue_to_collection(conn, issue_id, collection_id)?;
                    let msg = format!("  {}: {}", filename, import_summary(imported, skipped_dups, skipped_ns));
                    pb.println(&msg);
                    reporter.log(&msg);
                }
                Err(e) => {
                    let msg = format!("  {}: error: {}", filename, e);
                    pb.println(&msg);
                    reporter.error(&msg);
                }
            }

            if let Some(fpb) = file_pb {
                fpb.finish_and_clear();
            }

            pb.inc(1);
            completed += 1;
            reporter.progress(completed, total, format!("Imported {} / {} files", completed, total));
        }
        Ok(())
    })();

    if bulk_mode {
        pb.set_message("Rebuilding indexes…");
        recreate_bulk_indexes(conn)?;
        let msg = "  Run:  chess-db index-positions  to build the positions index.";
        pb.println(msg);
        reporter.log(msg);
    }

    pb.set_message("Updating player game counts…");
    crate::db::queries::recalculate_game_counts(conn)?;

    pb.finish_with_message("Import complete");
    reporter.done("Import complete");
    import_result
}

/// Shared mutable state across all files in a single import run.
struct ImportContext {
    player_cache: HashMap<String, u32>,
    fide_id_cache: HashMap<u32, u32>,
    /// player_id → known FIDE ID. Used to detect when an existing player row
    /// is missing a FIDE ID that a subsequent game's tags now provide, so we
    /// can back-fill it instead of silently dropping the new ID.
    player_fide_id: HashMap<u32, u32>,
    next_player_id: u32,
    next_game_id: u32,
    /// Fingerprint → game_id of games already in the DB or inserted during this run.
    /// Used both to skip duplicate inserts AND to look up the matching id so the
    /// existing game can be added to the current import's collection.
    seen_this_run: HashMap<u64, u32>,
    /// ChessBase GameId → game_id (same dual purpose as seen_this_run).
    seen_chessbase_ids: HashMap<i64, u32>,
}

impl ImportContext {
    fn new(conn: &Connection, skip_dedup: bool) -> Result<Self> {
        let spinner = ProgressBar::new_spinner();
        spinner.set_style(progress::spinner_style());
        spinner.set_message("Initialising...");
        spinner.tick();
        spinner.enable_steady_tick(std::time::Duration::from_millis(80));

        let mut player_cache: HashMap<String, u32> = HashMap::new();
        let next_player_id: u32 = {
            let max_id: Option<i64> = conn
                .query_row("SELECT MAX(id) FROM players", [], |r| r.get(0))
                .unwrap_or(None);
            max_id.unwrap_or(0) as u32 + 1
        };
        let next_game_id: u32 = {
            let max_id: Option<i64> = conn
                .query_row("SELECT MAX(id) FROM games", [], |r| r.get(0))
                .unwrap_or(None);
            max_id.unwrap_or(0) as u32 + 1
        };

        {
            let mut pstmt = conn.prepare("SELECT id, name_normalized FROM players")?;
            let rows = pstmt.query_map([], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows.flatten() {
                player_cache.insert(row.1, row.0);
            }
        }

        let mut fide_id_cache: HashMap<u32, u32> = HashMap::new();
        let mut player_fide_id: HashMap<u32, u32> = HashMap::new();
        {
            let mut pstmt = conn.prepare(
                "SELECT id, fide_id FROM players WHERE fide_id IS NOT NULL",
            )?;
            let rows = pstmt.query_map([], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1)?)))?;
            for row in rows.flatten() {
                fide_id_cache.insert(row.1, row.0);
                player_fide_id.insert(row.0, row.1);
            }
        }

        let mut seen_this_run: HashMap<u64, u32> = HashMap::new();
        let mut seen_chessbase_ids: HashMap<i64, u32> = HashMap::new();

        if !skip_dedup {
            {
                let mut pstmt = conn.prepare(
                    "SELECT id, white_id, black_id, date, result, opening_line, move_count FROM games
                     WHERE issue_id NOT IN (
                         SELECT id FROM issues WHERE downloaded = TRUE AND imported = FALSE
                     )
                     AND issue_id IN (
                         SELECT id FROM issues
                         WHERE imported = TRUE
                         AND imported_at > CAST(NOW() AS TIMESTAMP) - INTERVAL '1 year'
                     )
                     AND deleted_at IS NULL",
                )?;
                let rows = pstmt.query_map([], |r| {
                    Ok((
                        r.get::<_, u32>(0)?,
                        r.get::<_, u32>(1)?,
                        r.get::<_, u32>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i16>(6)?,
                    ))
                })?;
                for row in rows.flatten() {
                    let (id, white_id, black_id, date, result, opening_line, move_count) = row;
                    let fp = game_fingerprint(
                        white_id,
                        black_id,
                        date.as_deref(),
                        result.as_deref(),
                        &opening_line,
                        move_count,
                    );
                    seen_this_run.insert(fp, id);
                }
            }

            {
                let mut pstmt = conn.prepare(
                    "SELECT id, chessbase_id FROM games
                     WHERE chessbase_id IS NOT NULL
                     AND issue_id IN (
                         SELECT id FROM issues
                         WHERE imported = TRUE
                         AND imported_at > CAST(NOW() AS TIMESTAMP) - INTERVAL '1 year'
                     )
                     AND deleted_at IS NULL",
                )?;
                let rows = pstmt.query_map([], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?)))?;
                for row in rows.flatten() {
                    let (id, cbid) = row;
                    seen_chessbase_ids.insert(cbid, id);
                }
            }
        }

        spinner.finish_with_message(if skip_dedup {
            format!("Initialised: {} players. Duplicate detection disabled.", player_cache.len())
        } else {
            format!(
                "Initialised: {} players, {} game fingerprints loaded.",
                player_cache.len(),
                seen_this_run.len()
            )
        });

        Ok(Self {
            player_cache,
            fide_id_cache,
            player_fide_id,
            next_player_id,
            next_game_id,
            seen_this_run,
            seen_chessbase_ids,
        })
    }
}

fn game_fingerprint(
    white_id: u32,
    black_id: u32,
    date: Option<&str>,
    result: Option<&str>,
    opening_line: &str,
    move_count: i16,
) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    white_id.hash(&mut h);
    black_id.hash(&mut h);
    date.hash(&mut h);
    result.hash(&mut h);
    opening_line.hash(&mut h);
    move_count.hash(&mut h);
    h.finish()
}

fn import_issue(
    conn: &Connection,
    issue_id: i32,
    collection_id: i32,
    visibility: &'static str,
    zip_path: &Path,
    max_position_depth: Option<i16>,
    ctx: &mut ImportContext,
    fast: bool,
) -> Result<(usize, usize, usize)> {
    // Delete any games written during a previous interrupted run of this issue.
    conn.execute("DELETE FROM games WHERE issue_id = ?", duckdb::params![issue_id])?;
    let pgn_bytes = extract_pgn_from_zip(zip_path)?;
    process_pgn_bytes(conn, issue_id, collection_id, visibility, &pgn_bytes, max_position_depth, ctx, None, fast)
}

/// Repair PGN header lines that contain unescaped double-quotes in tag values.
///
/// The original visitor bug stored values verbatim without escaping `"` or `\`.
/// This function is idempotent: already-escaped `\"` sequences are preserved.
fn repair_pgn_header_quotes(pgn: &str) -> std::borrow::Cow<'_, str> {
    let split = pgn.find("\n\n").unwrap_or(pgn.len());
    let headers = &pgn[..split];

    // Fast path: no unescaped interior quotes.
    // An interior unescaped quote shows up as `"` followed by anything other than `]`
    // within a tag line, or as `""` anywhere.
    let needs_repair = headers.lines().any(|line| {
        if let (Some(fq), true) = (line.find('"'), line.ends_with(']')) {
            // everything between first " and last "]"
            let inner = &line[fq + 1..line.len() - 2]; // skip opening " and closing "]
            inner.contains('"')
        } else {
            false
        }
    });

    if !needs_repair {
        return std::borrow::Cow::Borrowed(pgn);
    }

    let mut result = String::with_capacity(pgn.len() + 64);
    for line in headers.lines() {
        result.push_str(&repair_header_line(line));
        result.push('\n');
    }
    result.push_str(&pgn[split..]);
    std::borrow::Cow::Owned(result)
}

/// Re-escape the value portion of a single PGN header line.
/// Input:  `[Event "Mannheim "Zaragoza" 3Meistertunier"]`
/// Output: `[Event "Mannheim \"Zaragoza\" 3Meistertunier"]`
fn repair_header_line(line: &str) -> String {
    // Must look like [TagName "..."]
    if !line.starts_with('[') || !line.ends_with(']') {
        return line.to_string();
    }
    let inner = &line[1..line.len() - 1]; // strip outer [ ]
    if let Some(first_q) = inner.find('"') {
        if inner.ends_with('"') {
            let tag_part = &inner[..first_q]; // "TagName "
            let raw_value = &inner[first_q + 1..inner.len() - 1];
            if raw_value.contains('"') {
                // Escape unescaped quotes (already-escaped ones are preserved).
                let escaped = escape_tag_value(raw_value);
                return format!("[{}\"{}\"]\n", tag_part, escaped)
                    .trim_end_matches('\n')
                    .to_string();
            }
        }
    }
    line.to_string()
}

/// Escape `"` and `\` in a PGN string token value, idempotent for already-escaped content.
fn escape_tag_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                out.push('\\');
                // Preserve existing escape sequence (e.g. \" or \\)
                if let Some(&next) = chars.peek() {
                    out.push(next);
                    chars.next();
                }
            }
            '"' => out.push_str("\\\""),
            other => out.push(other),
        }
    }
    out
}

/// Imports a single PGN payload.
///
/// `collection_id`: the collection this import targets. Existing games matched
/// by fingerprint or chessbase_id are added to this collection so the same game
/// can live in multiple collections (e.g. a TWIC game also ending up in
/// "My games" when re-imported from a personal PGN).
///
/// `visibility`: 'public' or 'private'. New rows get this; on dedup-skip into
/// a public import, the existing row's visibility is ratcheted up (private →
/// public). No auto-downgrade.
fn process_pgn_bytes(
    conn: &Connection,
    issue_id: i32,
    collection_id: i32,
    visibility: &'static str,
    pgn_bytes: &[u8],
    max_position_depth: Option<i16>,
    ctx: &mut ImportContext,
    file_pb: Option<&ProgressBar>,
    fast: bool,
) -> Result<(usize, usize, usize)> {
    // Comments, NAGs and variations are preserved by the visitor (see
    // GameVisitor) and stored in the game's movetext, so the PGN is parsed
    // as-is — no pre-stripping.
    let mut visitor = GameVisitor::new(max_position_depth);
    let inner: Box<dyn Read> = match file_pb {
        Some(pb) => Box::new(pb.wrap_read(std::io::Cursor::new(pgn_bytes))),
        None => Box::new(std::io::Cursor::new(pgn_bytes)),
    };
    let mut reader = Reader::new(LineCountingReader::new(inner));

    let mut game_batch: Vec<GameRow> = Vec::with_capacity(BATCH_SIZE);
    let mut position_batch: Vec<PositionRow> = Vec::with_capacity(BATCH_SIZE * 40);
    let mut total_games = 0usize;
    let mut skipped_games = 0usize;
    let mut skipped_nonstandard = 0usize;
    let mut new_players: Vec<(u32, String, String, Option<u32>)> = Vec::new();
    let mut player_fide_backfill: Vec<(u32, u32)> = Vec::new();

    loop {
        let result = match reader.read_game(&mut visitor) {
            Ok(None) => break,
            Ok(Some(r)) => r,
            Err(e) => {
                let offset = reader.into_inner().bytes_read();
                let line = byte_offset_to_line(pgn_bytes, offset);
                return Err(anyhow::anyhow!("{} (line {})", e, line));
            }
        };
        let game = match result {
            Some(g) => g,
            None => continue,
        };

        // Skip Chess960 and mid-game fragment games.
        if game.non_standard {
            skipped_nonstandard += 1;
            continue;
        }

        let white_name = match &game.white {
            Some(n) if !n.is_empty() => n.clone(),
            _ => continue,
        };
        let black_name = match &game.black {
            Some(n) if !n.is_empty() => n.clone(),
            _ => continue,
        };

        let white_id = get_or_create_player(
            &mut ctx.player_cache,
            &mut ctx.fide_id_cache,
            &mut ctx.player_fide_id,
            &mut ctx.next_player_id,
            &mut new_players,
            &mut player_fide_backfill,
            &white_name,
            game.white_fide_id,
        );
        let black_id = get_or_create_player(
            &mut ctx.player_cache,
            &mut ctx.fide_id_cache,
            &mut ctx.player_fide_id,
            &mut ctx.next_player_id,
            &mut new_players,
            &mut player_fide_backfill,
            &black_name,
            game.black_fide_id,
        );

        // Deduplication: ChessBase GameId is checked first — same GameId is a
        // definitive duplicate. Then fingerprint is always checked to catch the
        // same game exported from two different ChessBase databases with different
        // GameIds, as well as all non-ChessBase games.
        //
        // When a duplicate is detected we skip the insert but still tag the
        // existing row into the current import's collection — so a game can
        // belong to multiple collections without being duplicated.
        if let Some(cbid) = game.chessbase_id {
            if let Some(&existing_id) = ctx.seen_chessbase_ids.get(&cbid) {
                tag_existing_match(conn, existing_id, collection_id, visibility)?;
                skipped_games += 1;
                continue;
            }
        }
        let fp = game_fingerprint(
            white_id,
            black_id,
            game.date.as_deref(),
            game.result.as_deref(),
            &game.opening_line,
            game.move_count,
        );
        if let Some(&existing_id) = ctx.seen_this_run.get(&fp) {
            tag_existing_match(conn, existing_id, collection_id, visibility)?;
            skipped_games += 1;
            continue;
        }

        let game_id = ctx.next_game_id;
        ctx.next_game_id += 1;
        ctx.seen_this_run.insert(fp, game_id);
        if let Some(cbid) = game.chessbase_id {
            ctx.seen_chessbase_ids.insert(cbid, game_id);
        }

        game_batch.push(GameRow {
            id: game_id,
            issue_id,
            visibility,
            white_id,
            black_id,
            white_elo: game.white_elo,
            black_elo: game.black_elo,
            event: game.event,
            site: game.site,
            date: game.date,
            round: game.round,
            result: game.result,
            eco: game.eco,
            move_count: game.move_count,
            pgn: game.pgn,
            opening_line: game.opening_line,
            chessbase_id: game.chessbase_id,
        });

        if max_position_depth.is_some() {
            for (move_num, hash, next_move) in &game.positions {
                position_batch.push(PositionRow {
                    game_id,
                    move_number: *move_num,
                    zobrist_hash: *hash,
                    next_move: next_move.clone(),
                });
            }
        }

        total_games += 1;

        if game_batch.len() >= BATCH_SIZE {
            flush_players(conn, &new_players, fast)?;
            new_players.clear();
            flush_player_fide_backfill(conn, &player_fide_backfill)?;
            player_fide_backfill.clear();
            flush_games(conn, &game_batch, fast)?;
            game_batch.clear();
            if max_position_depth.is_some() {
                flush_positions(conn, &position_batch, fast)?;
                position_batch.clear();
            }
        }
    }

    if !new_players.is_empty() {
        flush_players(conn, &new_players, fast)?;
    }
    if !player_fide_backfill.is_empty() {
        flush_player_fide_backfill(conn, &player_fide_backfill)?;
    }
    if !game_batch.is_empty() {
        flush_games(conn, &game_batch, fast)?;
    }
    if max_position_depth.is_some() && !position_batch.is_empty() {
        flush_positions(conn, &position_batch, fast)?;
    }

    Ok((total_games, skipped_games, skipped_nonstandard))
}

fn get_or_create_player(
    name_cache: &mut HashMap<String, u32>,
    fide_id_cache: &mut HashMap<u32, u32>,
    player_fide_id: &mut HashMap<u32, u32>,
    next_id: &mut u32,
    new_players: &mut Vec<(u32, String, String, Option<u32>)>,
    backfill: &mut Vec<(u32, u32)>,
    name: &str,
    fide_id: Option<u32>,
) -> u32 {
    let normalized = name
        .to_lowercase()
        .replace(',', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    // 1. Fast path: name already known
    if let Some(&id) = name_cache.get(&normalized) {
        // Back-fill: if this game brings a FIDE ID and the existing player
        // doesn't have one yet, queue an UPDATE so the player row gets it.
        if let Some(fid) = fide_id {
            if let std::collections::hash_map::Entry::Vacant(e) = player_fide_id.entry(id) {
                e.insert(fid);
                fide_id_cache.insert(fid, id);
                backfill.push((id, fid));
            }
        }
        return id;
    }
    // 2. Same fide_id already imported under a different name variant
    if let Some(fid) = fide_id {
        if let Some(&id) = fide_id_cache.get(&fid) {
            // Register this name variant so future lookups by name also hit the cache
            name_cache.insert(normalized, id);
            return id;
        }
    }
    // 3. Genuinely new player
    let id = *next_id;
    *next_id += 1;
    name_cache.insert(normalized.clone(), id);
    if let Some(fid) = fide_id {
        fide_id_cache.insert(fid, id);
        player_fide_id.insert(id, fid);
    }
    new_players.push((id, name.to_string(), normalized, fide_id));
    id
}

/// Format a human-readable import result line.
fn import_summary(imported: usize, skipped_dups: usize, skipped_ns: usize) -> String {
    let mut parts = Vec::new();
    if skipped_dups > 0 {
        parts.push(format!("{} duplicates", skipped_dups));
    }
    if skipped_ns > 0 {
        parts.push(format!("{} non-standard (Chess960/fragments)", skipped_ns));
    }
    if parts.is_empty() {
        format!("{} games imported", imported)
    } else {
        format!("{} games imported, {} skipped ({})", imported, skipped_dups + skipped_ns, parts.join(", "))
    }
}

/// Apply queued FIDE-ID back-fills: each (player_id, fide_id) pair updates
/// `players.fide_id` for a player who previously had none. Runs in a single
/// transaction. Sets `name_normalised = FALSE` so a future `players normalise`
/// pass will reconcile the name spelling against ratings.fide.com.
fn flush_player_fide_backfill(
    conn: &Connection,
    backfill: &[(u32, u32)],
) -> Result<()> {
    if backfill.is_empty() {
        return Ok(());
    }
    conn.execute_batch("BEGIN")?;
    let mut stmt = conn.prepare(
        "UPDATE players SET fide_id = ?, name_normalised = FALSE WHERE id = ?",
    )?;
    for (id, fide_id) in backfill {
        stmt.execute(duckdb::params![*fide_id, *id])?;
    }
    conn.execute_batch("COMMIT")?;
    Ok(())
}

fn flush_players(
    conn: &Connection,
    players: &[(u32, String, String, Option<u32>)],
    fast: bool,
) -> Result<()> {
    if players.is_empty() {
        return Ok(());
    }
    if fast {
        // Column order: id, name, name_normalized, fide_id, game_count, name_normalised.
        let mut app = conn.appender("players")?;
        for (id, name, norm, fide_id) in players {
            app.append_row(duckdb::params![*id, name, norm, *fide_id, 0_i32, false])?;
        }
        app.flush()?;
    } else {
        conn.execute_batch("BEGIN")?;
        let mut stmt = conn.prepare(
            "INSERT INTO players (id, name, name_normalized, fide_id, name_normalised)
             VALUES (?, ?, ?, ?, FALSE)",
        )?;
        for (id, name, norm, fide_id) in players {
            stmt.execute(duckdb::params![*id, name, norm, *fide_id])?;
        }
        conn.execute_batch("COMMIT")?;
    }
    Ok(())
}

struct GameRow {
    id: u32,
    issue_id: i32,
    visibility: &'static str,
    white_id: u32,
    black_id: u32,
    white_elo: Option<i16>,
    black_elo: Option<i16>,
    event: Option<String>,
    site: Option<String>,
    date: Option<String>,
    round: Option<String>,
    result: Option<String>,
    eco: Option<String>,
    move_count: i16,
    pgn: String,
    opening_line: String,
    chessbase_id: Option<i64>,
}

struct PositionRow {
    game_id: u32,
    move_number: i16,
    zobrist_hash: i64,
    next_move: Option<String>,
}

fn flush_games(conn: &Connection, games: &[GameRow], fast: bool) -> Result<()> {
    if games.is_empty() {
        return Ok(());
    }
    if fast {
        // Appender column order matches the live table layout. After Phase 2
        // dropped source_id, the trailing columns are: chessbase_id,
        // deleted_at (NULL on insert), visibility.
        let mut app = conn.appender("games")?;
        for g in games {
            app.append_row(duckdb::params![
                g.id, g.issue_id, g.white_id, g.black_id, g.white_elo, g.black_elo,
                g.event, g.site, g.date, g.round, g.result, g.eco, g.move_count,
                g.pgn, g.opening_line, g.chessbase_id,
                duckdb::types::Value::Null,          // deleted_at (TIMESTAMP)
                g.visibility,
            ])?;
        }
        app.flush()?;
    } else {
        conn.execute_batch("BEGIN")?;
        let mut stmt = conn.prepare(
            "INSERT INTO games (id, issue_id, white_id, black_id, white_elo, black_elo,
                               event, site, date, round, result, eco, move_count, pgn,
                               opening_line, chessbase_id, visibility)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )?;
        for g in games {
            stmt.execute(duckdb::params![
                g.id, g.issue_id, g.white_id, g.black_id, g.white_elo, g.black_elo,
                g.event, g.site, g.date, g.round, g.result, g.eco, g.move_count,
                g.pgn, g.opening_line, g.chessbase_id, g.visibility
            ])?;
        }
        conn.execute_batch("COMMIT")?;
    }
    Ok(())
}

fn flush_positions(conn: &Connection, positions: &[PositionRow], fast: bool) -> Result<()> {
    if positions.is_empty() {
        return Ok(());
    }
    if fast {
        let mut app = conn.appender("positions")?;
        for p in positions {
            app.append_row(duckdb::params![p.game_id, p.move_number, p.zobrist_hash, p.next_move])?;
        }
        app.flush()?;
    } else {
        conn.execute_batch("BEGIN")?;
        let mut stmt = conn.prepare(
            "INSERT INTO positions (game_id, move_number, zobrist_hash, next_move) VALUES (?, ?, ?, ?)",
        )?;
        for p in positions {
            stmt.execute(duckdb::params![p.game_id, p.move_number, p.zobrist_hash, p.next_move])?;
        }
        conn.execute_batch("COMMIT")?;
    }
    Ok(())
}

fn extract_pgn_from_zip(zip_path: &Path) -> Result<Vec<u8>> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_lowercase();
        if name.ends_with(".pgn") {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            return Ok(buf);
        }
    }

    anyhow::bail!("No PGN file found in zip: {}", zip_path.display())
}
