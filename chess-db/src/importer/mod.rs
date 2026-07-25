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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const BATCH_SIZE: usize = 10_000;
const INDEX_READ_BATCH: usize = 50_000;
// Parse/flush/report indexing in sub-chunks of this many games so the progress
// bar advances smoothly even when the whole DB fits in one read batch.
const INDEX_REPORT_CHUNK: usize = 2_000;
const LARGE_FILE_THRESHOLD: u64 = 100 * 1024 * 1024; // 100 MB
/// Fixed-point progress units each issue occupies in the overall import bar. A
/// multi-file bulk import (Ajedrez's parts) reports byte progress within its
/// issue's slice, so one continuous 0→100% bar spans all files instead of the
/// bar freezing between per-file steps.
const PROGRESS_UNITS_PER_ISSUE: u64 = 10_000;

/// Total download size above which an import switches to *bulk mode* (drop the
/// games indexes, defer position indexing to a single pass) instead of indexing
/// inline per game. Sizing on bytes (≈ games) makes the decision self-adjust
/// across sources with different per-item volume: a Lichess *monthly* package is
/// ~4× a TWIC *weekly* one, so the old item-count threshold under-triggered for
/// Lichess and left a large sync grinding on the slow inline path (#145).
const BULK_MODE_BYTES: u64 = 12 * 1024 * 1024; // ~12 MB (compressed feed or raw PGN)

/// Choose bulk mode from the combined size of the files being imported. A
/// `force_threshold` of 0 forces bulk (the scheduled `update` job passes 0); any
/// other value defers entirely to the size estimate, so per-source item cadence
/// no longer skews the decision (#145).
fn bulk_mode_for_size(total_bytes: u64, force_threshold: usize) -> bool {
    force_threshold == 0 || total_bytes >= BULK_MODE_BYTES
}

/// Whether an upload of this many bytes should be treated as a bulk load — i.e.
/// skip inline dedup (defer it to one background `dedup_games` pass) and use the
/// fast path — matching `bulk_mode_for_size`'s size estimate. The upload handler
/// uses this to pick `skip_dedup` from the spooled file size (#154).
pub fn is_bulk_size(total_bytes: u64) -> bool {
    total_bytes >= BULK_MODE_BYTES
}

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
/// a directory is read non-recursively (matches existing behaviour). Accepts
/// plain `.pgn` and the compressed forms the importer can decompress:
/// `.zip`, `.zst`/`.zstd`, `.7z`.
fn collect_pgn_files(path: &Path) -> Result<Vec<std::path::PathBuf>> {
    if path.is_file() {
        if is_supported_input(path) {
            Ok(vec![path.to_path_buf()])
        } else {
            anyhow::bail!("not a .pgn/.zip/.zst/.7z file: {}", path.display());
        }
    } else if path.is_dir() {
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(path)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| is_supported_input(p))
            .collect();
        files.sort();
        Ok(files)
    } else {
        anyhow::bail!("not a file or directory: {}", path.display());
    }
}

/// True for file types `import-pgn` can ingest: plain `.pgn` or a compressed
/// archive the importer decompresses (`.zip`, `.zst`/`.zstd`, `.7z`).
fn is_supported_input(p: &Path) -> bool {
    matches!(
        p.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("pgn") | Some("zip") | Some("zst") | Some("zstd") | Some("7z")
    )
}

/// A temporary path removed on drop — used to stage a decompressed `.pgn` for
/// archive inputs (`.zip`/`.7z`) so the streaming importer reads it in bounded
/// memory without holding the whole decompressed file in RAM.
struct TempPgn {
    path: std::path::PathBuf,
    is_dir: bool,
}

impl Drop for TempPgn {
    fn drop(&mut self) {
        if self.is_dir {
            let _ = std::fs::remove_dir_all(&self.path);
        } else {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Open `path` as a streaming PGN byte source, transparently decompressing by
/// extension. Returns the reader, an optional temp guard the caller must keep
/// alive until the import finishes (cleaned up on drop), and the number of
/// bytes a progress bar should track.
///
/// - `.pgn` — streamed directly.
/// - `.zst`/`.zstd` — streamed through a zstd decoder (bounded memory).
/// - `.zip`/`.7z` — the first `.pgn` entry is streamed out to a sibling temp
///   file first (archives don't offer a cheap owned streaming reader), then
///   that temp file is streamed; the guard removes it afterwards.
///
/// Wraps a reader and tallies the bytes pulled through it into a shared counter,
/// so the importer can report byte-based progress (a real % + ETA) without the
/// parser knowing about the job reporter. `open_import_reader` places it at the
/// level whose size it returns as `prog_size` — the compressed file for `.zst`,
/// the decompressed stream for `.pgn`/`.zip`/`.7z` — so `count / prog_size` is a
/// valid 0..1 fraction in every case.
struct CountingReader<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

/// What `open_import_reader` yields: the decompressing reader, an optional
/// temp-file drop guard, the byte total the progress bar measures against, and
/// the shared byte counter the caller passes to `process_pgn_stream`.
type ImportReader = (Box<dyn Read>, Option<TempPgn>, u64, Arc<AtomicU64>);

/// Returns the decompressing reader, an optional temp-file drop guard, the byte
/// total the progress bar measures against, and the shared byte counter the
/// caller passes to `process_pgn_stream` for a real progress bar.
fn open_import_reader(path: &Path) -> Result<ImportReader> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let count = Arc::new(AtomicU64::new(0));
    match ext.as_str() {
        "pgn" | "" => {
            let f = std::fs::File::open(path)?;
            let sz = f.metadata().map(|m| m.len()).unwrap_or(0);
            let r = CountingReader { inner: std::io::BufReader::new(f), count: count.clone() };
            Ok((Box::new(r), None, sz, count))
        }
        "zst" | "zstd" => {
            let f = std::fs::File::open(path)?;
            // Progress tracks compressed bytes consumed (uncompressed size is
            // not cheaply known): count the file *before* the decoder so the
            // tally matches the compressed size reported here.
            let sz = f.metadata().map(|m| m.len()).unwrap_or(0);
            let counted = CountingReader { inner: std::io::BufReader::new(f), count: count.clone() };
            let dec = zstd::stream::read::Decoder::new(counted)
                .map_err(|e| anyhow::anyhow!("zstd open {}: {}", path.display(), e))?;
            Ok((Box::new(dec), None, sz, count))
        }
        "zip" => {
            let tmp = path.with_extension("import-tmp.pgn");
            let _ = std::fs::remove_file(&tmp);
            {
                let f = std::fs::File::open(path)?;
                let mut archive = zip::ZipArchive::new(f)?;
                let mut idx = None;
                for i in 0..archive.len() {
                    if archive.by_index(i)?.name().to_ascii_lowercase().ends_with(".pgn") {
                        idx = Some(i);
                        break;
                    }
                }
                let idx = idx
                    .ok_or_else(|| anyhow::anyhow!("no .pgn entry inside {}", path.display()))?;
                let mut entry = archive.by_index(idx)?;
                let mut out = std::fs::File::create(&tmp)?;
                std::io::copy(&mut entry, &mut out)?; // streaming, bounded memory
            }
            let f = std::fs::File::open(&tmp)?;
            let sz = f.metadata().map(|m| m.len()).unwrap_or(0);
            let r = CountingReader { inner: std::io::BufReader::new(f), count: count.clone() };
            Ok((
                Box::new(r),
                Some(TempPgn { path: tmp, is_dir: false }),
                sz,
                count,
            ))
        }
        "7z" => {
            let dir = path.with_extension("7z-import-tmp");
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir)?;
            sevenz_rust2::decompress_file(path, &dir)
                .map_err(|e| anyhow::anyhow!("7z extract {}: {}", path.display(), e))?;
            let pgn = first_pgn_in_dir(&dir)
                .ok_or_else(|| anyhow::anyhow!("no .pgn file inside {}", path.display()))?;
            let f = std::fs::File::open(&pgn)?;
            let sz = f.metadata().map(|m| m.len()).unwrap_or(0);
            let r = CountingReader { inner: std::io::BufReader::new(f), count: count.clone() };
            Ok((
                Box::new(r),
                Some(TempPgn { path: dir, is_dir: true }),
                sz,
                count,
            ))
        }
        other => anyhow::bail!("unsupported file type '.{}': {}", other, path.display()),
    }
}

/// Wraps any `Read` impl and counts newlines as they stream past, so a parse
/// error can be reported with an approximate line number WITHOUT holding the
/// whole file in memory (the parser reads game-by-game; see #95). The count
/// tracks bytes actually pulled from the underlying reader, so it may run a
/// little ahead of the exact error position when the parser buffers — good
/// enough for a diagnostic.
struct LineCountingReader<R> {
    inner: R,
    lines: usize,
}

impl<R: Read> LineCountingReader<R> {
    fn new(inner: R) -> Self {
        Self { inner, lines: 1 }
    }
    fn line(&self) -> usize {
        self.lines
    }
}

impl<R: Read> Read for LineCountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.lines += buf[..n].iter().filter(|&&b| b == b'\n').count();
        Ok(n)
    }
}

/// Drop all indexes that would be maintained live during a bulk import.
/// Safe to call even if the indexes do not exist yet.
///
/// The players indexes are included deliberately (#82): they are ART indexes, and
/// maintaining them live while the Appender bulk-inserts players can leave the
/// index inconsistent with the table — a later `DELETE FROM players` (dedup /
/// merge) then hits "Failed to delete all rows from index", a *fatal* error that
/// invalidates the whole writer connection. Dropping them during the bulk window
/// and rebuilding cleanly afterwards avoids that state entirely.
fn drop_bulk_indexes(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_games_white;
         DROP INDEX IF EXISTS idx_games_black;
         DROP INDEX IF EXISTS idx_games_date;
         DROP INDEX IF EXISTS idx_games_eco;
         DROP INDEX IF EXISTS idx_players_name;
         DROP INDEX IF EXISTS idx_players_fide_id;",
    )?;
    Ok(())
}

/// Recreate the games + players indexes after a bulk import (mirrors
/// `drop_bulk_indexes`). Position index is intentionally excluded — use
/// `chess-db index-positions` after the import completes, which runs in a clean
/// memory state. Must match the index definitions in `db::schema`.
fn recreate_bulk_indexes(conn: &Connection) -> Result<()> {
    // Use single-threaded builds to avoid memory pressure on large tables
    conn.execute_batch("SET threads=1;")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_id);
         CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_id);
         CREATE INDEX IF NOT EXISTS idx_games_date  ON games(date);
         CREATE INDEX IF NOT EXISTS idx_games_eco   ON games(eco);
         CREATE INDEX IF NOT EXISTS idx_players_name    ON players(name_normalized);
         CREATE INDEX IF NOT EXISTS idx_players_fide_id ON players(fide_id);",
    )?;
    conn.execute_batch("SET threads=4;")?;
    Ok(())
}

/// How many games an `index_positions(rebuild)` pass would process: every game
/// for a rebuild, else only those not yet in `positions`. Callers use this to
/// decide whether a fast index is large enough to warrant a safety snapshot (#139).
pub fn pending_position_count(conn: &Connection, rebuild: bool) -> Result<i64> {
    let n = if rebuild {
        conn.query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0))?
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM games g
             WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.game_id = g.id)",
            [],
            |r| r.get(0),
        )?
    };
    Ok(n)
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
        // Unmeasured DELETE over a possibly-huge table — indeterminate bar.
        reporter.progress(0, 0, "Clearing positions table…");
        conn.execute_batch("DELETE FROM positions;")?;
        reporter.done("Positions table cleared.");
        return Ok(());
    }

    if rebuild {
        // Dropping the positions table is unmeasured; reset to an indeterminate
        // bar until the measured indexing loop below starts reporting.
        reporter.progress(0, 0, "Rebuilding positions table from scratch…");
        // No `REFERENCES games(id)`: DuckDB implements UPDATE as delete+insert,
        // so an incoming FK breaks `UPDATE games` at scale (player merge,
        // soft-delete). positions is derived data — referential integrity is
        // kept by the import/delete code. Matches the initial schema (schema.rs).
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_positions_hash;
             DROP TABLE IF EXISTS positions;
             CREATE TABLE positions (
                 game_id      UINTEGER,
                 move_number  SMALLINT,
                 zobrist_hash BIGINT,
                 next_move    VARCHAR
             );",
        )?;
    }

    // Count how many games need processing
    let pending: i64 = pending_position_count(conn, rebuild)?;

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

    pb.finish_and_clear();
    if insert_result.is_ok() && reporter.is_cancelled() {
        reporter.cancelled("Position indexing cancelled — resumes on the next run.");
    } else if insert_result.is_ok() {
        reporter.done(format!("Indexing complete. {} games indexed.", pending));
    }
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

        // Cooperative cancellation (#140): stop between read batches. Positions
        // already flushed stay committed and are simply resumed on the next run
        // (the WHERE-NOT-EXISTS filter skips indexed games).
        if reporter.is_cancelled() {
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
/// `reindex_threshold` — bulk-mode override: `0` forces bulk (drop the games
/// indexes + defer position indexing); any other value lets bulk mode be chosen
/// automatically from the total download size (`BULK_MODE_BYTES`), so the
/// decision self-adjusts to a source's per-item volume instead of a raw item
/// count (#145).
/// Whether a pending source import will run in bulk mode (large enough that
/// `import` drops indexes + uses the Appender). Mirrors the size logic below so
/// the daemon can snapshot-guard a bulk import (#82) before calling `import`.
/// `false` when nothing is pending.
pub fn source_import_is_bulk(
    conn: &Connection,
    dir: &Path,
    source_key: &str,
    reindex_threshold: usize,
) -> Result<bool> {
    let mut stmt = conn.prepare(
        "SELECT filename FROM source_items
         WHERE source_key = ? AND downloaded = TRUE AND imported = FALSE",
    )?;
    let total_bytes: u64 = stmt
        .query_map(duckdb::params![source_key], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .map(|f| std::fs::metadata(dir.join(&f)).map(|m| m.len()).unwrap_or(0))
        .sum();
    Ok(bulk_mode_for_size(total_bytes, reindex_threshold))
}

pub fn import(
    conn: &Connection,
    dir: &Path,
    source_key: &str,
    collection: &str,
    max_position_depth: Option<i16>,
    reindex_threshold: usize,
    fast: bool,
    skip_dedup: bool,
    reporter: &Reporter,
) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, filename FROM source_items
         WHERE source_key = ? AND downloaded = TRUE AND imported = FALSE ORDER BY id",
    )?;

    let issues: Vec<(i32, String)> = stmt
        .query_map(duckdb::params![source_key], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    if issues.is_empty() {
        reporter.done("No new issues to import.");
        return Ok(());
    }

    // Decide bulk vs inline by total download size (≈ games), not item count, so a
    // few large Lichess monthly packages defer like many small TWIC weekly ones (#145).
    let total_bytes: u64 = issues
        .iter()
        .map(|(_, f)| std::fs::metadata(dir.join(f)).map(|m| m.len()).unwrap_or(0))
        .sum();
    let bulk_mode = bulk_mode_for_size(total_bytes, reindex_threshold);
    // A size-triggered bulk import always uses the fast Appender path: for large
    // databases (10M+ games) the transactional prepared-INSERT path is far too
    // slow. Couple it to bulk_mode so every large import gets it regardless of
    // the `fast` flag the caller passed (#154).
    let fast = fast || bulk_mode;

    reporter.log(format!("Importing {} issue(s)...", issues.len()));
    if bulk_mode {
        reporter.log("Bulk mode: indexes dropped for faster import. Positions skipped.");
        drop_bulk_indexes(conn)?;
    } else if let Some(depth) = max_position_depth {
        reporter.log(format!("Position indexing enabled (depth: {} half-moves).", depth));
    }

    let total = issues.len() as u64;
    // Overall progress in fixed-point units so within-issue byte progress and the
    // per-issue count share one monotonic bar (see PROGRESS_UNITS_PER_ISSUE).
    let total_units = total * PROGRESS_UNITS_PER_ISSUE;
    let pb = reporter.bar(total);
    let mut completed = 0u64;
    // Grand totals across all issues, for a meaningful final `done` message
    // (e.g. "12,748 games imported into Ajedrez OTB") instead of "Import complete".
    let (mut tot_imported, mut tot_dups, mut tot_ns, mut tot_window) = (0usize, 0usize, 0usize, 0usize);

    let mut ctx = ImportContext::new(conn, skip_dedup)?;
    let collection_id = upsert_collection(conn, collection)?;
    let window = crate::sources::window(conn, source_key)?;
    if let Some(desc) = window.describe() {
        reporter.log(format!("Importing {desc}."));
    }

    // Per-issue failures (e.g. a corrupt/truncated archive) are collected and
    // warned about, not treated as terminal — the run continues and reports what
    // to retry (#133).
    let mut failed: Vec<i32> = Vec::new();
    let import_result = (|| -> Result<()> {
        for (issue_id, filename) in &issues {
            // Cooperative cancellation (#157): stop between issues. Each issue is
            // committed on its own, so a partial run leaves a consistent database
            // (imported issues stay marked; the rest re-import on the next sync).
            if reporter.is_cancelled() {
                reporter.log("Import cancelled.");
                break;
            }
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
            let progress_base = completed * PROGRESS_UNITS_PER_ISSUE;
            match import_issue(conn, *issue_id, collection_id, "public", &zip_path, effective_depth, &mut ctx, fast, &window, progress_base, total_units, reporter) {
                // A single huge issue (one Ajedrez .7z is the whole database) can be
                // cancelled mid-stream — `import_issue` then returns partial counts.
                // Do NOT mark it imported: leave imported=FALSE so a re-sync
                // re-imports it, and its opening `DELETE FROM games WHERE issue_id`
                // clears the partial rows. Marking it here would record a truncated
                // import as complete (#157).
                Ok(_) if reporter.is_cancelled() => {
                    let msg = format!("  Issue {}: cancelled mid-import — left unimported, will re-import on next sync.", issue_id);
                    pb.println(&msg);
                    reporter.log(&msg);
                    break;
                }
                Ok((imported, skipped_dups, skipped_ns, skipped_window)) => {
                    conn.execute(
                        "UPDATE source_items SET imported = TRUE, imported_at = NOW(), game_count = ? WHERE id = ?",
                        duckdb::params![imported as i32, issue_id],
                    )?;
                    add_issue_to_collection(conn, *issue_id, collection_id)?;
                    tot_imported += imported; tot_dups += skipped_dups; tot_ns += skipped_ns; tot_window += skipped_window;
                    let msg = format!("  Issue {}: {}", issue_id, import_summary(imported, skipped_dups, skipped_ns, skipped_window));
                    pb.println(&msg);
                    reporter.log(&msg);
                }
                Err(e) => {
                    // A single bad issue (corrupt/truncated archive, parse error)
                    // must not abort the run or emit a terminal `error` event: an
                    // `error` event flips the job status to failed, so streaming
                    // clients (the CLI, the activity dashboard) bail even though
                    // the rest imports fine. Warn and continue; the issue stays
                    // imported=FALSE so a re-sync (with a fresh download) retries
                    // it. (#133 — mirrors the download loop's warn-don't-error.)
                    failed.push(*issue_id);
                    let msg = format!("  Issue {}: skipped — {}", issue_id, e);
                    pb.println(&msg);
                    reporter.log(&msg);
                }
            }

            pb.inc(1);
            completed += 1;
            // Report on the same units frame as the within-issue byte progress so
            // the bar stays monotonic across the issue boundary.
            reporter.progress(completed * PROGRESS_UNITS_PER_ISSUE, total_units, format!("Imported {} / {} issues", completed, total));
        }
        Ok(())
    })();

    if !failed.is_empty() {
        let ids = failed.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", ");
        let msg = format!(
            "{} issue(s) skipped due to errors, left unimported — re-run to retry: {}",
            failed.len(),
            ids
        );
        pb.println(&msg);
        reporter.log(&msg);
    }

    if bulk_mode {
        // These post-import steps are unmeasured and can run for a while on a
        // large DB. Emit an indeterminate-progress event (total=0) so the activity
        // panel shows "Rebuilding…"/"Updating…" with a working pulse instead of a
        // frozen "100%" until the job finally emits `done` (#147-style).
        reporter.progress(0, 0, "Rebuilding database indexes…".to_string());
        pb.set_message("Rebuilding indexes…");
        recreate_bulk_indexes(conn)?;
        let msg = "  Run:  chess-db index-positions  to build the positions index.";
        pb.println(msg);
        reporter.log(msg);
    }

    reporter.progress(0, 0, "Updating player game counts…".to_string());
    pb.set_message("Updating player game counts…");
    crate::db::queries::recalculate_game_counts(conn)?;

    pb.finish_and_clear();
    let done_msg = format!(
        "{} into {}.",
        import_summary(tot_imported, tot_dups, tot_ns, tot_window),
        collection,
    );
    reporter.done(&done_msg);
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
            "SELECT filename FROM source_items WHERE imported = TRUE AND filename IS NOT NULL",
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

    // Size-based bulk decision (#145): a single multi-GB PGN (1 file, so never
    // over an item-count threshold) now correctly defers instead of indexing inline.
    let total_bytes: u64 = pending
        .iter()
        .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .sum();
    let bulk_mode = bulk_mode_for_size(total_bytes, reindex_threshold);
    // Large imports always use the fast Appender path (see `import` above): the
    // transactional INSERT path can't keep up with a multi-million-game file.
    let fast = fast || bulk_mode;

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
    // Grand totals across all files, for the final `done` message.
    let (mut tot_imported, mut tot_dups, mut tot_ns, mut tot_window) = (0usize, 0usize, 0usize, 0usize);

    // Allocate issue IDs above the TWIC range (TWIC issues are ~1–1500)
    let mut next_issue_id: i32 = {
        let max_id: Option<i64> = conn
            .query_row("SELECT MAX(id) FROM source_items", [], |r| r.get(0))
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
                        "SELECT id FROM source_items WHERE filename = ? AND imported = FALSE LIMIT 1",
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
                        "INSERT INTO source_items (id, source_key, external_id, filename, downloaded, imported, game_count)
                         VALUES (?, 'manual', ?, ?, TRUE, FALSE, NULL)",
                        duckdb::params![id, filename, filename],
                    )?;
                    id
                }
            };

            // Remove any games from a previous interrupted run of this file.
            conn.execute("DELETE FROM games WHERE issue_id = ?", duckdb::params![issue_id])?;

            // Open the input as a streaming PGN source, transparently
            // decompressing .zip / .zst / .7z. `_tmp` (a staged temp .pgn for
            // archive inputs) is held for the rest of this iteration and removed
            // on drop, after the import below completes.
            let (reader, _tmp, prog_size, bytes_read) = match open_import_reader(path) {
                Ok(t) => t,
                Err(e) => {
                    let msg = format!("  {}: read error: {}", filename, e);
                    pb.println(&msg);
                    reporter.error(&msg);
                    pb.inc(1);
                    completed += 1;
                    continue;
                }
            };

            let file_pb = if !reporter.is_json() && prog_size >= LARGE_FILE_THRESHOLD {
                if let Some(ref mp) = mp {
                    let fpb = mp.insert_before(&pb, ProgressBar::new(prog_size));
                    fpb.set_style(progress::byte_bar_style());
                    Some(fpb)
                } else {
                    None
                }
            } else {
                None
            };

            // Stream rather than read into memory, so a multi-GB PGN imports in
            // bounded memory (#95). Wrap the reader in the byte-progress bar (if
            // any) so it advances as the parser consumes bytes.
            let src: Box<dyn Read> = match file_pb.as_ref() {
                Some(fpb) => Box::new(fpb.wrap_read(reader)),
                None => reader,
            };

            let effective_depth = if bulk_mode { None } else { max_position_depth };
            // Manual PGN imports are not date-filtered (unbounded window).
            let manual_window = crate::sources::DateWindow::default();
            match process_pgn_stream(conn, issue_id, collection_id, visibility, src, effective_depth, &mut ctx, fast, &manual_window, prog_size, &bytes_read, 0, PROGRESS_UNITS_PER_ISSUE, reporter) {
                Ok((imported, skipped_dups, skipped_ns, skipped_window)) => {
                    conn.execute(
                        "UPDATE source_items SET imported = TRUE, imported_at = NOW(), game_count = ? WHERE id = ?",
                        duckdb::params![imported as i32, issue_id],
                    )?;
                    add_issue_to_collection(conn, issue_id, collection_id)?;
                    tot_imported += imported; tot_dups += skipped_dups; tot_ns += skipped_ns; tot_window += skipped_window;
                    let msg = format!("  {}: {}", filename, import_summary(imported, skipped_dups, skipped_ns, skipped_window));
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
        // These post-import steps are unmeasured and can run for a while on a
        // large DB. Emit an indeterminate-progress event (total=0) so the activity
        // panel shows "Rebuilding…"/"Updating…" with a working pulse instead of a
        // frozen "100%" until the job finally emits `done` (#147-style).
        reporter.progress(0, 0, "Rebuilding database indexes…".to_string());
        pb.set_message("Rebuilding indexes…");
        recreate_bulk_indexes(conn)?;
        let msg = "  Run:  chess-db index-positions  to build the positions index.";
        pb.println(msg);
        reporter.log(msg);
    }

    reporter.progress(0, 0, "Updating player game counts…".to_string());
    pb.set_message("Updating player game counts…");
    crate::db::queries::recalculate_game_counts(conn)?;

    pb.finish_and_clear();
    let done_msg = format!(
        "{} into {}.",
        import_summary(tot_imported, tot_dups, tot_ns, tot_window),
        spec.collection,
    );
    reporter.done(&done_msg);
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
    /// When set, insert every game without any dedup — no fingerprinting, no
    /// growing in-memory fingerprint map — because a single background
    /// `dedup_games` pass cleans up afterwards. Bulk loads use this to keep dedup
    /// off the import's critical path (#131/#154).
    skip_dedup: bool,
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
                         SELECT id FROM source_items WHERE downloaded = TRUE AND imported = FALSE
                     )
                     AND issue_id IN (
                         SELECT id FROM source_items
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
                         SELECT id FROM source_items
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
            skip_dedup,
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

#[allow(clippy::too_many_arguments)]
fn import_issue(
    conn: &Connection,
    issue_id: i32,
    collection_id: i32,
    visibility: &'static str,
    zip_path: &Path,
    max_position_depth: Option<i16>,
    ctx: &mut ImportContext,
    fast: bool,
    window: &crate::sources::DateWindow,
    // This issue's slice of the overall progress bar (see PROGRESS_UNITS_PER_ISSUE).
    progress_base: u64,
    progress_total: u64,
    reporter: &Reporter,
) -> Result<(usize, usize, usize, usize)> {
    // Delete any games written during a previous interrupted run of this issue.
    conn.execute("DELETE FROM games WHERE issue_id = ?", duckdb::params![issue_id])?;
    // Decompress the issue to memory, then stream it back through a CountingReader
    // so the importer reports real byte progress within this issue's slice of the
    // bar — a big Ajedrez .7z part then advances smoothly instead of the bar
    // freezing between per-file steps.
    let pgn_bytes = extract_pgn(zip_path)?;
    let byte_total = pgn_bytes.len() as u64;
    let counter = Arc::new(AtomicU64::new(0));
    let counted = CountingReader { inner: std::io::Cursor::new(pgn_bytes), count: counter.clone() };
    process_pgn_stream(
        conn,
        issue_id,
        collection_id,
        visibility,
        Box::new(counted),
        max_position_depth,
        ctx,
        fast,
        window,
        byte_total,
        &counter,
        progress_base,
        progress_total,
        // `sub_step` shares the parent's sink (so progress flows to the activity
        // bar) and its cancel flag (so the per-batch cancel check can still stop a
        // huge single-file import mid-stream, #157), while muting terminal `done`.
        &reporter.sub_step(),
    )
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
#[allow(clippy::too_many_arguments)]
fn process_pgn_stream(
    conn: &Connection,
    issue_id: i32,
    collection_id: i32,
    visibility: &'static str,
    src: Box<dyn Read>,
    max_position_depth: Option<i16>,
    ctx: &mut ImportContext,
    fast: bool,
    window: &crate::sources::DateWindow,
    // Byte-based progress: `byte_total` is the size the caller's CountingReader
    // measures against (0 = unknown → fall back to a live game count), and
    // `bytes_read` is that reader's shared counter. Lets the activity bar show a
    // real % (and ETA) instead of a fixed indeterminate placeholder (#158).
    byte_total: u64,
    bytes_read: &AtomicU64,
    // Overall-progress frame: this issue occupies the units
    // [progress_base, progress_base + PROGRESS_UNITS_PER_ISSUE) of a bar whose
    // full span is `progress_total`. So a multi-file bulk import (Ajedrez's parts)
    // advances one smooth bar across every file instead of a per-file reset. The
    // single-file path passes (0, PROGRESS_UNITS_PER_ISSUE) — just this file's
    // byte fraction, unchanged from before the frame existed.
    progress_base: u64,
    progress_total: u64,
    reporter: &Reporter,
) -> Result<(usize, usize, usize, usize)> {
    // Comments, NAGs and variations are preserved by the visitor (see
    // GameVisitor) and stored in the game's movetext, so the PGN is parsed
    // as-is — no pre-stripping. `src` is read game-by-game, so a multi-GB file
    // never lands in memory (#95); the byte-progress CountingReader is applied by
    // the caller (open_import_reader) before the reader is handed in.
    let mut visitor = GameVisitor::new(max_position_depth);
    let mut reader = Reader::new(LineCountingReader::new(src));

    let mut game_batch: Vec<GameRow> = Vec::with_capacity(BATCH_SIZE);
    let mut position_batch: Vec<PositionRow> = Vec::with_capacity(BATCH_SIZE * 40);
    let mut total_games = 0usize;
    let mut skipped_games = 0usize;
    let mut skipped_nonstandard = 0usize;
    let mut skipped_window = 0usize;
    let window_unbounded = window.is_unbounded();
    let mut new_players: Vec<(u32, String, String, Option<u32>)> = Vec::new();
    let mut player_fide_backfill: Vec<(u32, u32)> = Vec::new();

    loop {
        let result = match reader.read_game(&mut visitor) {
            Ok(None) => break,
            Ok(Some(r)) => r,
            Err(e) => {
                let line = reader.into_inner().line();
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

        // Skip games outside this source's configured date window (B1). Cheap
        // no-op when the window is unbounded (the default).
        if !window_unbounded && !window.admits(game.date.as_deref()) {
            skipped_window += 1;
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
        let game_id = if ctx.skip_dedup {
            // Bulk load: insert everything with no dedup — no fingerprint compute
            // and no growing fingerprint map. A single background dedup_games pass
            // removes duplicates afterwards (#131/#154).
            let id = ctx.next_game_id;
            ctx.next_game_id += 1;
            id
        } else {
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
            let id = ctx.next_game_id;
            ctx.next_game_id += 1;
            ctx.seen_this_run.insert(fp, id);
            if let Some(cbid) = game.chessbase_id {
                ctx.seen_chessbase_ids.insert(cbid, id);
            }
            id
        };

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
            // Byte-based progress when the caller knows the file size: a real %
            // (and ETA) that tracks how far through the file we are. The message
            // still carries the live game count. When the size is unknown
            // (byte_total=0, e.g. the in-memory source path) fall back to the
            // count with total=0 so the bar stays indeterminate rather than wrong.
            if byte_total > 0 {
                // Map this file's byte fraction into its slice of the overall bar
                // so a multi-file bulk import advances one continuous 0→100%.
                let frac = bytes_read.load(Ordering::Relaxed).min(byte_total) as u128
                    * PROGRESS_UNITS_PER_ISSUE as u128
                    / byte_total as u128;
                reporter.progress(
                    progress_base + frac as u64,
                    progress_total,
                    format!("Imported {total_games} games…"),
                );
            } else {
                reporter.progress(
                    total_games as u64,
                    0,
                    format!("Imported {total_games} games…"),
                );
            }
            // Cooperative cancellation (#157): break on a batch boundary. The
            // batch above was just flushed/committed, so stopping here can't
            // corrupt the appender mid-write; games imported so far are kept.
            if reporter.is_cancelled() {
                break;
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

    Ok((total_games, skipped_games, skipped_nonstandard, skipped_window))
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
fn import_summary(imported: usize, skipped_dups: usize, skipped_ns: usize, skipped_window: usize) -> String {
    let mut parts = Vec::new();
    if skipped_dups > 0 {
        parts.push(format!("{} duplicates", skipped_dups));
    }
    if skipped_ns > 0 {
        parts.push(format!("{} non-standard (Chess960/fragments)", skipped_ns));
    }
    if skipped_window > 0 {
        parts.push(format!("{} outside date window", skipped_window));
    }
    if parts.is_empty() {
        format!("{} games imported", imported)
    } else {
        format!(
            "{} games imported, {} skipped ({})",
            imported,
            skipped_dups + skipped_ns + skipped_window,
            parts.join(", ")
        )
    }
}

/// Apply queued FIDE-ID back-fills: each (player_id, fide_id) pair updates
/// `players.fide_id` for a player who previously had none. Runs in a single
/// transaction. Sets `name_normalised = FALSE` so a future `players normalise`
/// pass will canonicalise the name spelling from the local FIDE list.
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

/// Read a downloaded source file into raw PGN bytes, decompressing by extension:
/// `.zip` (TWIC), `.zst` (Lichess broadcasts, #40 B2), or a plain `.pgn`.
fn extract_pgn(path: &Path) -> Result<Vec<u8>> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "zip" => extract_pgn_from_zip(path),
        "zst" | "zstd" => {
            let f = std::fs::File::open(path)?;
            zstd::stream::decode_all(std::io::BufReader::new(f))
                .map_err(|e| anyhow::anyhow!("zstd decode {}: {}", path.display(), e))
        }
        "7z" => extract_pgn_from_7z(path),
        "pgn" | "" => Ok(std::fs::read(path)?),
        other => anyhow::bail!("unsupported file type '.{}': {}", other, path.display()),
    }
}

/// Extract the PGN from a `.7z` archive (Ajedrez Data historical files, #40 B3).
/// The archive streams to a temp dir beside it (the PGN can be multi-GB, so we
/// avoid holding the compressed and decompressed copies in memory at once), then
/// the `.pgn` is read and the temp dir removed.
fn extract_pgn_from_7z(path: &Path) -> Result<Vec<u8>> {
    let dir = path.with_extension("7z-extract");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let result = (|| -> Result<Vec<u8>> {
        sevenz_rust2::decompress_file(path, &dir)
            .map_err(|e| anyhow::anyhow!("7z extract {}: {}", path.display(), e))?;
        let pgn = first_pgn_in_dir(&dir)
            .ok_or_else(|| anyhow::anyhow!("no .pgn file inside {}", path.display()))?;
        Ok(std::fs::read(pgn)?)
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// First `.pgn` file anywhere under `dir` (the Ajedrez archives hold one at the
/// root, but tolerate nesting).
fn first_pgn_in_dir(dir: &Path) -> Option<std::path::PathBuf> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).ok()?.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|e| e.to_str()) == Some("pgn") {
                return Some(p);
            }
        }
    }
    None
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

#[cfg(test)]
mod sevenz_tests {
    use super::*;

    /// Our `.7z` extraction path works on an archive sevenz-rust2 itself made.
    #[test]
    fn extract_pgn_reads_a_7z() {
        let dir = std::env::temp_dir().join(format!("lpdo-7z-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pgn = "[Event \"Test\"]\n[White \"A\"]\n[Black \"B\"]\n\n1. e4 e5 *\n";
        let src = dir.join("games.pgn");
        std::fs::write(&src, pgn).unwrap();
        let archive = dir.join("games.7z");
        sevenz_rust2::compress_to_path(&src, &archive).unwrap();

        let out = extract_pgn(&archive).unwrap();
        assert_eq!(out, pgn.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Decode a *real* Ajedrez `.7z` to prove sevenz-rust2 handles their LZMA
    /// settings. Manual: `LPDO_7Z_FIXTURE=/path/AJ-OTB-PGN-001.7z cargo test
    /// extract_real_ajedrez_7z -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn extract_real_ajedrez_7z() {
        let path = std::env::var("LPDO_7Z_FIXTURE").expect("set LPDO_7Z_FIXTURE");
        let out = extract_pgn(std::path::Path::new(&path)).unwrap();
        assert!(out.len() > 1_000_000, "expected a large PGN, got {} bytes", out.len());
        assert!(
            String::from_utf8_lossy(&out[..200]).contains("[Event"),
            "decompressed output is not PGN"
        );
        eprintln!("decoded {} bytes of PGN", out.len());
    }
}

#[cfg(test)]
mod bulk_index_tests {
    use super::*;
    use duckdb::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        conn
    }

    /// Appender-insert `n` players, bulk-style. fide_id alternates NULL/value to
    /// exercise both players indexes (idx_players_name, idx_players_fide_id).
    fn bulk_insert_players(conn: &Connection, n: i32) {
        let mut app = conn.appender("players").unwrap();
        for i in 1..=n {
            let fide: Option<i32> = if i % 2 == 0 { Some(1_000_000 + i) } else { None };
            // Column order matches flush_players: id, name, name_normalized,
            // fide_id, game_count, name_normalised.
            app.append_row(duckdb::params![
                i, format!("Player {i}"), format!("player {i}"), fide, 0_i32, false
            ])
            .unwrap();
        }
        app.flush().unwrap();
    }

    /// The #82 fix: dropping the players indexes for the bulk window and rebuilding
    /// them afterwards leaves a consistent state, so a later DELETE (dedup / merge)
    /// succeeds cleanly instead of hitting the fatal index error.
    #[test]
    fn bulk_drop_recreate_leaves_players_deletable() {
        let conn = setup();
        drop_bulk_indexes(&conn).unwrap();
        bulk_insert_players(&conn, 5000);
        recreate_bulk_indexes(&conn).unwrap();

        // Delete a player (the operation that failed in #82) — must succeed.
        let deleted = conn
            .execute("DELETE FROM players WHERE id = ?", duckdb::params![100])
            .expect("delete after clean index rebuild must not hit a fatal index error");
        assert_eq!(deleted, 1);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM players", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 4999);

        // The indexes exist again and back a lookup.
        let by_name: i64 = conn
            .query_row(
                "SELECT id FROM players WHERE name_normalized = 'player 200'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(by_name, 200);
    }
}

#[cfg(test)]
mod compressed_input_tests {
    use super::*;
    use std::io::Write;

    fn read_all(mut r: Box<dyn Read>) -> Vec<u8> {
        let mut v = Vec::new();
        r.read_to_end(&mut v).unwrap();
        v
    }

    /// `open_import_reader` transparently decompresses .zst / .zip / .7z back to
    /// the original PGN bytes, and the temp guard removes any staged file/dir
    /// once dropped.
    #[test]
    fn open_import_reader_handles_pgn_zst_zip_7z() {
        let dir = std::env::temp_dir().join(format!("lpdo-cin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pgn: &[u8] = b"[Event \"T\"]\n[White \"A\"]\n[Black \"B\"]\n\n1. e4 e5 *\n";

        // plain .pgn — streamed directly, no temp guard.
        let p_pgn = dir.join("g.pgn");
        std::fs::write(&p_pgn, pgn).unwrap();
        let (r, guard, _, _) = open_import_reader(&p_pgn).unwrap();
        assert_eq!(read_all(r), pgn);
        assert!(guard.is_none());

        // .zst — streamed through the decoder, no temp guard.
        let p_zst = dir.join("g.pgn.zst");
        std::fs::write(&p_zst, zstd::encode_all(pgn, 3).unwrap()).unwrap();
        let (r, guard, _, _) = open_import_reader(&p_zst).unwrap();
        assert_eq!(read_all(r), pgn);
        assert!(guard.is_none());

        // .zip — first .pgn entry staged to a sibling temp, removed on drop.
        let p_zip = dir.join("g.zip");
        {
            let f = std::fs::File::create(&p_zip).unwrap();
            let mut w = zip::ZipWriter::new(f);
            w.start_file("inner.pgn", zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(pgn).unwrap();
            w.finish().unwrap();
        }
        let staged;
        {
            let (r, guard, _, _) = open_import_reader(&p_zip).unwrap();
            assert_eq!(read_all(r), pgn);
            let guard = guard.expect("zip stages a temp .pgn");
            staged = guard.path.clone();
            assert!(staged.exists(), "temp present while guard held");
        }
        assert!(!staged.exists(), "temp removed after guard dropped");

        // .7z — extracted to a temp dir, removed on drop.
        let p_7z = dir.join("g.7z");
        sevenz_rust2::compress_to_path(&p_pgn, &p_7z).unwrap();
        let staged_dir;
        {
            let (r, guard, _, _) = open_import_reader(&p_7z).unwrap();
            assert_eq!(read_all(r), pgn);
            let guard = guard.expect("7z stages a temp dir");
            staged_dir = guard.path.clone();
            assert!(staged_dir.exists());
        }
        assert!(!staged_dir.exists(), "temp dir removed after guard dropped");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
