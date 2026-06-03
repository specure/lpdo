#[cfg(not(target_env = "msvc"))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

mod db;
mod dedup;
mod importer;
mod normalise;
mod players;
mod progress;
mod reporter;
mod search;
mod serve;
mod twic;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};

/// Default storage directory for TWIC zip archives. Used by `download` and
/// `import` when `--dir` is omitted. Matches the path the wizard and
/// MaintenancePanel write to so a CLI-only download is recognised by the GUI
/// (and vice versa).
fn default_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".chess-db")
        .join("twic")
}

fn default_db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".chess-db")
        .join("chess.db")
}

/// Default destination for `backup`. Matches the path shown in the GUI's
/// Maintenance panel so a manual CLI backup lands in the same place.
fn default_backup_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("lpdo")
        .join("backup")
}

#[derive(Parser)]
#[command(name = "chess-db", about = "Chess reference database from TWIC archives")]
struct Cli {
    /// Path to DuckDB database file
    #[arg(long, global = true, default_value_os_t = default_db_path())]
    db: PathBuf,

    /// Output progress as newline-delimited JSON (for machine consumption)
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Download TWIC PGN zip archives
    Download {
        /// Start from issue number (default: 1)
        #[arg(long, default_value_t = 1)]
        from: u32,
        /// Stop at issue number (default: latest)
        #[arg(long)]
        to: Option<u32>,
        /// Local storage directory
        #[arg(long, default_value_os_t = default_dir())]
        dir: PathBuf,
    },
    /// Import downloaded PGN files into DuckDB
    Import {
        /// Index positions by Zobrist hash up to this many half-moves (plies).
        /// Pass 0 to disable position indexing entirely.
        /// Ignored in bulk mode (>= reindex-threshold files): run index-positions separately.
        /// Default: 40 half-moves (= 20 full moves each side).
        #[arg(long, default_value_t = 40)]
        max_position_depth: u16,
        /// Source directory
        #[arg(long, default_value_os_t = default_dir())]
        dir: PathBuf,
        /// Drop all indexes before the bulk load and rebuild them at the end
        /// when the number of pending files meets or exceeds this value.
        /// Pass 0 to always use bulk mode. Default: 10.
        #[arg(long, default_value_t = 10)]
        reindex_threshold: usize,
        /// Use faster appender-based inserts instead of transactional inserts.
        /// WARNING: interrupting the import in fast mode may corrupt the database.
        #[arg(long)]
        fast: bool,
        /// Skip duplicate detection (fingerprint and ChessBase ID checks).
        /// Reduces peak memory significantly. Run 'games dedup' afterwards to remove any duplicates.
        #[arg(long)]
        skip_dedup: bool,
    },
    /// Import a PGN file or directory (skips already-imported files)
    ImportPgn {
        /// Path to a .pgn file OR a directory containing .pgn files
        path: PathBuf,
        /// Collection to add imported games to. Created on first use.
        #[arg(long, default_value = "Manual")]
        collection: String,
        /// Mark new games as private (default: public). Visibility is also
        /// ratcheted up when a public import dedup-matches an existing private game.
        #[arg(long)]
        private: bool,
        /// Behaviour when a game with the same fingerprint already exists.
        #[arg(long, value_parser = ["skip", "replace", "always"], default_value = "skip")]
        on_duplicate: String,
        /// Index positions by Zobrist hash up to this many half-moves (plies).
        /// Pass 0 to disable position indexing entirely.
        /// Ignored in bulk mode (>= reindex-threshold files): run index-positions separately.
        /// Default: 40 half-moves (= 20 full moves each side).
        #[arg(long, default_value_t = 40)]
        max_position_depth: u16,
        /// Drop all indexes before the bulk load and rebuild them at the end
        /// when the number of pending files meets or exceeds this value.
        /// Pass 0 to always use bulk mode. Default: 10.
        #[arg(long, default_value_t = 10)]
        reindex_threshold: usize,
        /// Use faster appender-based inserts instead of transactional inserts.
        /// WARNING: interrupting the import in fast mode may corrupt the database.
        #[arg(long)]
        fast: bool,
        /// Skip duplicate detection (fingerprint and ChessBase ID checks).
        /// Reduces peak memory significantly. Run 'games dedup' afterwards to remove any duplicates.
        #[arg(long)]
        skip_dedup: bool,
    },
    /// Build or rebuild the positions index from already-imported games.
    /// By default only indexes games not yet in the positions table (incremental).
    /// Use --rebuild to wipe and reprocess everything (e.g. when changing depth).
    IndexPositions {
        /// How many half-moves (plies) to index per game.
        /// Pass 0 to clear the positions table without rebuilding.
        /// Default: 40 half-moves (= 20 full moves each side).
        #[arg(long, default_value_t = 40)]
        max_position_depth: u16,
        /// Drop all existing positions and reindex from scratch.
        /// Use this when changing --max-position-depth on an existing index.
        #[arg(long)]
        rebuild: bool,
        /// Use faster appender-based inserts instead of transactional inserts.
        /// WARNING: interrupting in fast mode may corrupt the database.
        #[arg(long)]
        fast: bool,
    },
    /// Search for games or players
    Search {
        #[command(subcommand)]
        subcommand: SearchCommands,
    },
    /// Show or delete games by ID
    Games {
        #[command(subcommand)]
        subcommand: GameCommands,
    },
    /// Manage player records
    Players {
        #[command(subcommand)]
        subcommand: PlayersCommands,
    },
    /// Back up a collection's games to a timestamped PGN file
    Backup {
        /// Collection to export (default: the private "My games" collection)
        #[arg(long, default_value = "My games")]
        collection: String,
        /// Destination directory; created if it does not exist
        #[arg(long, default_value_os_t = default_backup_dir())]
        dir: PathBuf,
    },
    /// Show database statistics
    Status,
    /// Start the REST API server
    Serve {
        /// Port to listen on
        #[arg(long, default_value_t = 7777)]
        port: u16,
    },
}

#[derive(Subcommand)]
enum SearchCommands {
    /// Search games (unified: by player, by white/black, or by metadata)
    Games {
        /// Player name to search (either color); mutually exclusive with --white/--black
        #[arg(long)]
        name: Option<String>,
        /// Search by player FIDE ID (either color); mutually exclusive with --white/--black
        #[arg(long)]
        fide_id: Option<u32>,
        /// White player name; mutually exclusive with --name/--fide-id
        #[arg(long)]
        white: Option<String>,
        /// Black player name; mutually exclusive with --name/--fide-id
        #[arg(long)]
        black: Option<String>,
        /// White player FIDE ID
        #[arg(long)]
        white_fide_id: Option<u32>,
        /// Black player FIDE ID
        #[arg(long)]
        black_fide_id: Option<u32>,
        /// Filter by event name
        #[arg(long)]
        event: Option<String>,
        /// Filter by ECO code
        #[arg(long)]
        eco: Option<String>,
        /// Filter by opening moves, e.g. "1.e4 e6 2.d4 d5"
        #[arg(long)]
        first_moves: Option<String>,
        /// Filter games from this date (YYYY-MM-DD)
        #[arg(long)]
        from: Option<String>,
        /// Filter games to this date (YYYY-MM-DD)
        #[arg(long)]
        to: Option<String>,
        /// Filter games that reach a specific position (FEN string); requires position index
        #[arg(long)]
        fen: Option<String>,
        /// Show aggregated move statistics for the position (requires --fen)
        #[arg(long)]
        moves_stats: bool,
        /// Show the opening moves of each game in the results list
        #[arg(long)]
        show_moves: bool,
        /// Maximum number of games to show
        #[arg(long, default_value_t = 100)]
        limit: u32,
        /// Output raw PGN for each matching game
        #[arg(long)]
        pgn: bool,
        /// Print total match count only, without listing games
        #[arg(long)]
        count: bool,
    },
    /// Search for player records by name or FIDE ID
    Players {
        /// Player name to search for
        #[arg(default_value = "")]
        name: String,
        /// Search by FIDE ID instead of name
        #[arg(long)]
        fide_id: Option<u32>,
        /// Exact name match instead of substring search
        #[arg(long)]
        exact: bool,
        /// Print only the player ID (errors if not exactly one match)
        #[arg(long)]
        id_only: bool,
    },
}

#[derive(Subcommand)]
enum GameCommands {
    /// Show full PGN for one or more games
    Show {
        /// One or more game IDs
        #[arg(num_args = 1..)]
        ids: Vec<u32>,
    },
    /// Delete one or more games
    Delete {
        /// One or more game IDs
        #[arg(num_args = 1..)]
        ids: Vec<u32>,
        /// Skip confirmation prompt
        #[arg(long)]
        yes_all: bool,
    },
    /// Find and remove duplicate games (same players, date, and opening moves)
    Dedup {
        /// Show what would be deleted without making any changes
        #[arg(long)]
        dry_run: bool,
    },
    /// Remove non-standard games (Chess960 and game fragments) from the database
    Cleanup {
        /// Remove all non-standard games (Chess960 and game fragments)
        #[arg(long)]
        non_standard: bool,
        /// Show what would be deleted without making any changes
        #[arg(long)]
        dry_run: bool,
    },
    /// Replace a game's main-line moves. `--moves` is a single string of
    /// space-separated SAN tokens (e.g. "e4 e5 Nf3 Nc6"). Headers and
    /// player linkage are kept; movetext, move_count, opening_line and the
    /// game's `positions` rows are all rebuilt. Empty `--moves` clears all
    /// moves, leaving just the result token in the PGN body.
    ///
    /// NOTE: variations, NAGs and comments on the existing pgn blob are
    /// dropped — the new body is plain main-line SAN. UI should warn before
    /// invoking this on annotated games.
    SetMoves {
        /// Game ID
        id: u32,
        /// Space-separated SAN moves; pass an empty string to clear all moves
        #[arg(long)]
        moves: String,
    },
    /// Replace a game's PGN header tags. `--tags` takes a JSON array of
    /// {name, value} pairs (the full new tag set, not a diff). Updates the
    /// structured columns (event/site/date/round/result/eco/white_elo/black_elo)
    /// and the embedded `pgn` blob in lockstep. Does NOT touch player records
    /// or game→player linkage; use `players set-fide-id` / `players merge`
    /// for those.
    SetHeaders {
        /// Game ID
        id: u32,
        /// JSON: `[{"name":"Event","value":"..."}, ...]`
        #[arg(long)]
        tags: String,
    },
    /// Set a game's visibility to "public" or "private". This flips the
    /// games.visibility column directly — public games show up in default
    /// search/stats; private ones are filtered out unless explicitly requested.
    SetVisibility {
        /// Game ID
        id: u32,
        /// "public" or "private"
        visibility: String,
    },
    /// Add a game to a collection. Creates the collection on first use.
    /// Idempotent: re-adding an existing membership is a no-op.
    AddCollection {
        /// Game ID
        id: u32,
        /// Collection name
        name: String,
    },
    /// Remove a game from a collection. Idempotent: missing collection or
    /// membership is reported but not an error.
    RemoveCollection {
        /// Game ID
        id: u32,
        /// Collection name
        name: String,
    },
    /// Soft-delete a game: sets games.deleted_at and updates player counts.
    /// Reversible via `games restore`.
    SoftDelete {
        /// Game ID
        id: u32,
    },
    /// Restore a soft-deleted game (clears games.deleted_at, updates player counts).
    Restore {
        /// Game ID
        id: u32,
    },
    /// Permanently delete every soft-deleted game (and its positions and collection
    /// memberships). NOT recoverable. Use --dry-run to see how many rows would go.
    Purge {
        /// Show the count without deleting.
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Subcommand)]
enum PlayersCommands {
    /// Recalculate and store game counts for all players
    UpdateGameCounts,
    /// Merge duplicate player records that share the same FIDE ID
    Dedup,
    /// Merge two player records: reassign all games from drop-id to keep-id, then delete drop-id
    Merge {
        /// Player ID to keep
        keep_id: u32,
        /// Player ID to remove (all their games are reassigned to keep-id)
        drop_id: u32,
        /// Skip confirmation prompt
        #[arg(long)]
        yes: bool,
    },
    /// Merge two players by name (looks up IDs automatically)
    MergeByName {
        /// Name of the player to keep
        keep_name: String,
        /// Name of the player to remove (their games are reassigned to keep)
        drop_name: String,
        /// Skip confirmation prompt
        #[arg(long)]
        yes: bool,
    },
    /// Apply a CSV file of name-based merge corrections (keep,drop columns)
    ApplyCorrections {
        /// Path to corrections CSV file
        path: PathBuf,
        /// Skip confirmation prompts
        #[arg(long)]
        yes: bool,
    },
    /// Export normalised player names (fide_id + canonical name) to a CSV file
    Export {
        /// Output CSV file path
        path: PathBuf,
    },
    /// Import normalised player names from a CSV file produced by players export
    Import {
        /// Input CSV file path
        path: PathBuf,
    },
    /// Set or back-fill a player's FIDE ID. Used by the edit-header dialog
    /// when the user supplies a FIDE ID for a player whose row was created
    /// from an earlier import that lacked it.
    SetFideId {
        /// Player ID
        player_id: u32,
        /// FIDE ID to assign
        fide_id: u32,
    },
    /// Update player names to FIDE canonical form (looks up ratings.fide.com)
    Normalise {
        /// Print what would be changed without writing to the database
        #[arg(long)]
        dry_run: bool,
        /// Milliseconds to wait between individual FIDE requests per worker
        #[arg(long, default_value_t = 1500)]
        delay: u64,
        /// Number of players per batch (pause after each batch)
        #[arg(long, default_value_t = 100)]
        batch_size: usize,
        /// Milliseconds to pause between batches
        #[arg(long, default_value_t = 30000)]
        batch_pause: u64,
        /// Number of parallel worker threads making FIDE requests
        #[arg(long, default_value_t = 3)]
        workers: usize,
        /// Consecutive network errors that trigger a long pause (0 = disabled)
        #[arg(long, default_value_t = 10)]
        error_threshold: usize,
        /// Milliseconds to pause after hitting --error-threshold errors in a row (default: 2 hours)
        #[arg(long, default_value_t = 7_200_000)]
        error_pause: u64,
        /// Stop the run immediately on --error-threshold consecutive errors
        /// instead of pausing for --error-pause. Used by the setup wizard.
        #[arg(long)]
        stop_on_errors: bool,
        /// Cap the number of players processed in this run. Omit to normalise all
        /// pending players. The setup wizard passes 500 to keep the step bounded.
        #[arg(long)]
        limit: Option<usize>,
        /// Override the batch normalisation cache service URL (default: compiled-in).
        #[arg(long)]
        service_url: Option<String>,
        /// API key for the cache service. Defaults to env CHESSVAULT_NORMALISE_API_KEY
        /// or the compile-time baked key; without a key the service is skipped.
        #[arg(long)]
        service_key: Option<String>,
        /// Skip the batch cache service entirely (FIDE lookups only).
        #[arg(long)]
        no_service: bool,
    },
}

/// Default position-index depth (half-moves), matching the importer's
/// `--max-position-depth 40` default. When the user re-imports later with a
/// different depth, `index-positions --rebuild` will reconcile.
const SET_MOVES_POSITION_DEPTH: i16 = 40;

/// Replace a game's main-line moves. Rewrites the pgn blob's body, recomputes
/// move_count + opening_line, and rebuilds the game's positions rows. Headers
/// and player linkage are preserved. Annotations on the existing blob (NAGs,
/// comments, variations) are lost — caller should warn beforehand.
fn do_set_moves(
    conn: &duckdb::Connection,
    id: u32,
    moves_str: &str,
    reporter: &reporter::Reporter,
) -> Result<()> {
    use shakmaty::san::San;
    use shakmaty::zobrist::{Zobrist64, ZobristHash};
    use shakmaty::{Chess, EnPassantMode};

    let old_pgn: String = conn.query_row(
        "SELECT pgn FROM games WHERE id = ?",
        duckdb::params![id],
        |r| r.get(0),
    ).with_context(|| format!("game {} not found", id))?;

    // Split headers (everything up to and including the blank line) from the
    // existing body. We discard the body — the new one is built from SAN.
    let headers = split_headers(&old_pgn);

    // Parse SAN tokens, walk the board, validate every move.
    let depth = SET_MOVES_POSITION_DEPTH;
    let mut board = Chess::default();
    let mut sans: Vec<String> = Vec::new();
    let mut positions: Vec<(i16, i64, Option<String>)> = Vec::new();
    // Initial position (half-move 0) — next_move filled in once we see the first move.
    {
        let h: Zobrist64 = board.zobrist_hash(EnPassantMode::Legal);
        positions.push((0, h.0 as i64, None));
    }

    for (idx, tok) in moves_str.split_whitespace().enumerate() {
        let san: San = tok.parse()
            .with_context(|| format!("move {} (\"{}\") is not valid SAN", idx + 1, tok))?;
        let mv = san.to_move(&board)
            .with_context(|| format!("move {} (\"{}\") is illegal in this position", idx + 1, tok))?;
        // Render canonical SAN (with check/mate suffixes) before playing.
        let rendered = shakmaty::san::SanPlus::from_move_and_play_unchecked(&mut board, mv).to_string();
        sans.push(rendered.clone());

        let half_move = (idx as i16) + 1;
        if half_move <= depth + 1 {
            // Backfill next_move on the previous position record.
            if let Some(last) = positions.last_mut() {
                last.2 = Some(rendered.clone());
            }
        }
        if half_move <= depth {
            let h: Zobrist64 = board.zobrist_hash(EnPassantMode::Legal);
            positions.push((half_move, h.0 as i64, None));
        }
    }

    // Existing result token (column is canonical), defaulting to `*`.
    let result: Option<String> = conn.query_row(
        "SELECT result FROM games WHERE id = ?",
        duckdb::params![id],
        |r| r.get(0),
    ).unwrap_or(None);
    let result_token = result.as_deref().unwrap_or("*");

    let body = if sans.is_empty() {
        result_token.to_string()
    } else {
        format!("{} {}", sans.join(" "), result_token)
    };
    // PGN spec: a blank line separates the tag pairs from the movetext.
    // `headers` already ends with one `\n` (from split_headers), so adding
    // another gives the required blank line.
    let new_pgn = format!("{}\n{}\n", headers, body);

    let move_count = sans.len() as i16;
    let opening_line = sans.iter().take(10).cloned().collect::<Vec<_>>().join(" ");

    conn.execute_batch("BEGIN")?;
    conn.execute(
        "UPDATE games SET pgn = ?, move_count = ?, opening_line = ? WHERE id = ?",
        duckdb::params![new_pgn, move_count, opening_line, id],
    )?;
    conn.execute("DELETE FROM positions WHERE game_id = ?", duckdb::params![id])?;
    {
        let mut stmt = conn.prepare(
            "INSERT INTO positions (game_id, move_number, zobrist_hash, next_move) VALUES (?, ?, ?, ?)",
        )?;
        for (mv_no, hash, next_move) in &positions {
            stmt.execute(duckdb::params![id, mv_no, hash, next_move])?;
        }
    }
    conn.execute_batch("COMMIT")?;

    reporter.done(format!("Game {} updated: {} half-move(s).", id, move_count));
    Ok(())
}

/// Return the tag-section of `pgn` — every leading line that starts with `[`
/// — joined back with newlines (no trailing blank line). Robust against
/// PGNs that lack the spec-required blank line between headers and movetext
/// (e.g. blobs written by an earlier buggy version of this code).
fn split_headers(pgn: &str) -> String {
    let mut out = String::new();
    for line in pgn.lines() {
        if line.starts_with('[') {
            out.push_str(line);
            out.push('\n');
        } else {
            break;
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct TagJson {
    name: String,
    value: String,
}

/// Replace a game's PGN header tags. The `tags_json` is the full new tag
/// set; structured columns and the embedded `pgn` are updated in lockstep.
fn do_set_headers(
    conn: &duckdb::Connection,
    id: u32,
    tags_json: &str,
    reporter: &reporter::Reporter,
) -> Result<()> {
    let tags: Vec<TagJson> = serde_json::from_str(tags_json)
        .context("--tags must be a JSON array of {name, value} objects")?;

    let old_pgn: String = conn.query_row(
        "SELECT pgn FROM games WHERE id = ?",
        duckdb::params![id],
        |r| r.get(0),
    ).with_context(|| format!("game {} not found", id))?;

    let get = |n: &str| tags.iter().find(|t| t.name == n).map(|t| t.value.as_str());
    let nonempty = |s: &str| -> Option<String> {
        let t = s.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    };
    let parse_elo = |s: Option<&str>| -> Option<i16> {
        s.and_then(|v| v.trim().parse::<i16>().ok())
    };

    let event  = get("Event").and_then(nonempty);
    let site   = get("Site").and_then(nonempty);
    // Normalise dates to ISO 8601 (dashes) — same convention as the importer's
    // visitor. PGN-spec dot dates would lex-sort incorrectly against ISO ones.
    let date   = get("Date").and_then(nonempty).map(|s| s.replace('.', "-"));
    let round  = get("Round").and_then(nonempty);
    let result = get("Result").and_then(nonempty);
    let eco    = get("ECO").and_then(nonempty);
    let white_elo = parse_elo(get("WhiteElo"));
    let black_elo = parse_elo(get("BlackElo"));

    let new_pgn = rebuild_pgn(&old_pgn, &tags);

    conn.execute(
        "UPDATE games SET event = ?, site = ?, date = ?, round = ?, result = ?, eco = ?,
            white_elo = ?, black_elo = ?, pgn = ? WHERE id = ?",
        duckdb::params![event, site, date, round, result, eco, white_elo, black_elo, new_pgn, id],
    )?;

    reporter.done(format!("Game {} headers updated.", id));
    Ok(())
}

/// Rebuild a PGN block: replace the tag section of `old_pgn` with the new
/// tag list, keep the body (movetext + result token) intact.
fn rebuild_pgn(old_pgn: &str, tags: &[TagJson]) -> String {
    // Body starts after the first blank line. If there is no blank line
    // (header-only block, e.g. from-scratch with `*` body) the whole input
    // is treated as headers; we'll regenerate a fresh `*` body.
    let body = match old_pgn.find("\n\n") {
        Some(i) => old_pgn[i + 2..].trim_end_matches(['\r', '\n']).to_string(),
        None => match old_pgn.find("\r\n\r\n") {
            Some(i) => old_pgn[i + 4..].trim_end_matches(['\r', '\n']).to_string(),
            None => "*".to_string(),
        },
    };

    let mut out = String::new();
    for t in tags {
        let escaped = t.value.replace('\\', r"\\").replace('"', "\\\"");
        out.push_str(&format!("[{} \"{}\"]\n", t.name, escaped));
    }
    out.push('\n');
    out.push_str(&body);
    out.push('\n');
    out
}

fn do_set_fide_id(conn: &duckdb::Connection, player_id: u32, fide_id: u32) -> Result<()> {
    if fide_id == 0 {
        anyhow::bail!("fide_id must be a positive integer");
    }
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM players WHERE id = ?",
        duckdb::params![player_id],
        |r| r.get(0),
    )?;
    if exists == 0 {
        anyhow::bail!("player {} not found", player_id);
    }
    let conflict: Option<u32> = conn.query_row(
        "SELECT id FROM players WHERE fide_id = ? AND id <> ? LIMIT 1",
        duckdb::params![fide_id, player_id],
        |r| r.get(0),
    ).ok();
    if let Some(other) = conflict {
        anyhow::bail!("FIDE ID {} is already assigned to player {}; merge them instead", fide_id, other);
    }
    conn.execute(
        "UPDATE players SET fide_id = ?, name_normalised = FALSE WHERE id = ?",
        duckdb::params![fide_id, player_id],
    )?;
    println!("Player {} updated with FIDE ID {}.", player_id, fide_id);
    Ok(())
}

fn do_merge_players(conn: &duckdb::Connection, keep_id: u32, drop_id: u32, yes: bool) -> Result<()> {
    let keep: (String, Option<u32>, i64) = conn.query_row(
        "SELECT p.name, p.fide_id,
                (SELECT COUNT(*) FROM games g WHERE g.white_id = p.id OR g.black_id = p.id)
         FROM players p WHERE p.id = ?",
        duckdb::params![keep_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).with_context(|| format!("player {} not found", keep_id))?;
    let drop: (String, Option<u32>, i64) = conn.query_row(
        "SELECT p.name, p.fide_id,
                (SELECT COUNT(*) FROM games g WHERE g.white_id = p.id OR g.black_id = p.id)
         FROM players p WHERE p.id = ?",
        duckdb::params![drop_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).with_context(|| format!("player {} not found", drop_id))?;

    let fide_str = |f: Option<u32>| f.map(|v| v.to_string()).unwrap_or("-".into());
    println!("Keep: [{}] {}  FIDE: {}  games: {}", keep_id, keep.0, fide_str(keep.1), keep.2);
    println!("Drop: [{}] {}  FIDE: {}  games: {}", drop_id, drop.0, fide_str(drop.1), drop.2);
    println!("{} game(s) will be reassigned; player [{}] will be deleted.", drop.2, drop_id);

    if !yes {
        print!("Proceed? [y/N] ");
        use std::io::Write;
        std::io::stdout().flush()?;
        let mut input = String::new();
        std::io::stdin().read_line(&mut input)?;
        if input.trim().to_lowercase() != "y" {
            println!("Aborted.");
            return Ok(());
        }
    }

    conn.execute("UPDATE games SET white_id = ? WHERE white_id = ?", duckdb::params![keep_id, drop_id])?;
    conn.execute("UPDATE games SET black_id = ? WHERE black_id = ?", duckdb::params![keep_id, drop_id])?;
    conn.execute("DELETE FROM players WHERE id = ?", duckdb::params![drop_id])?;
    println!("Done. Player [{}] merged into [{}].", drop_id, keep_id);
    Ok(())
}

/// Expand a leading `~` / `~/…` to the user's home directory. Paths from the
/// GUI arrive as raw argv (no shell), so tilde expansion is our responsibility.
fn expand_home(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    }
    if let Some(rest) = s.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

/// Make a collection name safe to embed in a filename: spaces and any
/// non-alphanumeric character (besides `-`/`_`) collapse to `_`.
/// e.g. "My games" → "My_games".
fn sanitize_for_filename(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let trimmed = mapped.trim_matches('_');
    if trimmed.is_empty() { "collection".to_string() } else { trimmed.to_string() }
}

/// Export every non-deleted game in `collection` to a timestamped PGN file in
/// `dir` (created if missing). Filename: `YYYYMMDD-HHMMSS-<collection>.pgn`,
/// e.g. `20260603-084231-My_games.pgn`. Read-only over the database.
fn do_backup(
    conn: &duckdb::Connection,
    collection: &str,
    dir: &Path,
    reporter: &reporter::Reporter,
) -> Result<()> {
    let collection_id: i32 = conn
        .query_row(
            "SELECT id FROM collections WHERE name = ?",
            duckdb::params![collection],
            |r| r.get(0),
        )
        .ok()
        .with_context(|| format!("collection {:?} not found", collection))?;

    // Undated games first, then oldest to newest. `date` is an ISO-8601
    // (dashed) VARCHAR, so a lexical sort is chronological; NULLS FIRST puts
    // games with no date at the top. `g.id` breaks ties for a deterministic
    // order. Skip soft-deleted games and any row missing its PGN blob.
    let mut stmt = conn.prepare(
        "SELECT g.pgn FROM games g
         JOIN game_collections gc ON gc.game_id = g.id
         WHERE gc.collection_id = ? AND g.deleted_at IS NULL AND g.pgn IS NOT NULL
         ORDER BY g.date ASC NULLS FIRST, g.id",
    )?;
    let pgns: Vec<String> = stmt
        .query_map(duckdb::params![collection_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<_, _>>()?;

    if pgns.is_empty() {
        anyhow::bail!("collection {:?} has no games to back up", collection);
    }

    let dir = expand_home(dir);
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("cannot create backup directory {}", dir.display()))?;

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let filename = format!("{}-{}.pgn", stamp, sanitize_for_filename(collection));
    let path = dir.join(&filename);

    // Concatenate games separated by a blank line (standard PGN). Emit periodic
    // progress (≈100 ticks) with no message so the bar advances without
    // flooding the GUI log.
    let total = pgns.len() as u64;
    let step = (total / 100).max(1);
    let mut out = String::new();
    for (i, pgn) in pgns.iter().enumerate() {
        out.push_str(pgn.trim_end());
        out.push_str("\n\n");
        let done = i as u64 + 1;
        if done % step == 0 || done == total {
            reporter.progress(done, total, "");
        }
    }

    std::fs::write(&path, out).with_context(|| format!("cannot write {}", path.display()))?;

    reporter.done_with_path(
        format!("Backed up {} game(s) from {:?} to {}", total, collection, path.display()),
        path.display(),
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let reporter = reporter::Reporter::new(cli.json);

    // Ensure DB directory exists
    if let Some(parent) = cli.db.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let spinner = reporter.spinner();
    spinner.set_message("Opening database...");
    if !cli.json { spinner.tick(); }

    let conn = db::open(&cli.db)?;
    db::schema::init(&conn)?;

    spinner.finish_and_clear();

    match cli.command {
        Commands::Download { from, to, dir } => {
            // Expand a leading `~` — the GUI passes "~/.chess-db/twic" and the
            // process has no shell to expand it, so a literal "~" directory
            // would otherwise be created (and already-downloaded issues, which
            // live under the real home dir, would never be recognised).
            let dir = expand_home(&dir);
            std::fs::create_dir_all(&dir)?;
            twic::download(&conn, from, to, &dir, &reporter).await?;
        }
        Commands::Import { max_position_depth, dir, reindex_threshold, fast, skip_dedup } => {
            let dir = expand_home(&dir);
            let depth = if max_position_depth == 0 { None } else { Some(max_position_depth as i16) };
            importer::import(&conn, &dir, depth, reindex_threshold, fast, skip_dedup, &reporter)?;
        }
        Commands::ImportPgn {
            path, collection, private, on_duplicate,
            max_position_depth, reindex_threshold, fast, skip_dedup,
        } => {
            let path = expand_home(&path);
            let depth = if max_position_depth == 0 { None } else { Some(max_position_depth as i16) };
            let visibility = if private { "private".to_string() } else { "public".to_string() };
            let spec = importer::ImportSpec { collection, visibility, on_duplicate };
            importer::import_pgn(&conn, &path, depth, reindex_threshold, fast, skip_dedup, &spec, &reporter)?;
        }
        Commands::IndexPositions { max_position_depth, rebuild, fast } => {
            let depth = if max_position_depth == 0 {
                None
            } else {
                Some(max_position_depth as i16)
            };
            importer::index_positions(&conn, depth, rebuild, fast, &reporter)?;
        }
        Commands::Games { subcommand } => match subcommand {
            GameCommands::Dedup { dry_run } => {
                dedup::dedup_games(&conn, dry_run, &reporter)?;
            }
            GameCommands::Cleanup { non_standard, dry_run } => {
                dedup::cleanup_nonstandard(&conn, non_standard, dry_run, &reporter)?;
            }
            GameCommands::Show { ids } => {
                for id in ids {
                    search::game_by_id(&conn, id)?;
                    println!();
                }
            }
            GameCommands::Delete { ids, yes_all } => {
                // Look up all games first; bail if any ID is not found
                let mut games: Vec<(u32, String, String, Option<String>, Option<String>)> = Vec::new();
                for id in &ids {
                    let row = conn.query_row(
                        "SELECT g.id, pw.name, pb.name, g.date, g.event
                         FROM games g
                         JOIN players pw ON g.white_id = pw.id
                         JOIN players pb ON g.black_id = pb.id
                         WHERE g.id = ?",
                        duckdb::params![id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                    ).with_context(|| format!("game {} not found", id))?;
                    games.push(row);
                }

                for (id, white, black, date, event) in &games {
                    println!(
                        "[{}] {} vs {}  {}  {}",
                        id, white, black,
                        date.as_deref().unwrap_or("?"),
                        event.as_deref().unwrap_or("?"),
                    );
                }

                if !yes_all {
                    print!("\nDelete {} game(s)? [y/N] ", games.len());
                    use std::io::Write;
                    std::io::stdout().flush()?;
                    let mut input = String::new();
                    std::io::stdin().read_line(&mut input)?;
                    if input.trim().to_lowercase() != "y" {
                        println!("Aborted.");
                        return Ok(());
                    }
                }

                for (id, ..) in &games {
                    dedup::hard_delete_game(&conn, *id)?;
                }
                println!("{} game(s) deleted.", games.len());
            }
            GameCommands::SetMoves { id, moves } => {
                do_set_moves(&conn, id, &moves, &reporter)?;
            }
            GameCommands::SetHeaders { id, tags } => {
                do_set_headers(&conn, id, &tags, &reporter)?;
            }
            GameCommands::AddCollection { id, name } => {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    anyhow::bail!("collection name must not be empty");
                }
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM games WHERE id = ?)",
                    duckdb::params![id], |r| r.get(0),
                ).unwrap_or(false);
                if !exists {
                    anyhow::bail!("game {} not found", id);
                }
                let collection_id = importer::upsert_collection(&conn, trimmed)?;
                let inserted = conn.execute(
                    "INSERT INTO game_collections (game_id, collection_id) VALUES (?, ?)
                     ON CONFLICT (game_id, collection_id) DO NOTHING",
                    duckdb::params![id, collection_id],
                )?;
                if inserted == 0 {
                    reporter.done(format!("Game {} is already in collection {:?}.", id, trimmed));
                } else {
                    reporter.done(format!("Game {} added to collection {:?}.", id, trimmed));
                }
            }
            GameCommands::RemoveCollection { id, name } => {
                let trimmed = name.trim();
                let collection_id: Option<i32> = conn.query_row(
                    "SELECT id FROM collections WHERE name = ?",
                    duckdb::params![trimmed], |r| r.get(0),
                ).ok();
                match collection_id {
                    None => {
                        reporter.done(format!("Collection {:?} does not exist.", trimmed));
                    }
                    Some(cid) => {
                        let removed = conn.execute(
                            "DELETE FROM game_collections WHERE game_id = ? AND collection_id = ?",
                            duckdb::params![id, cid],
                        )?;
                        if removed == 0 {
                            reporter.done(format!("Game {} was not in collection {:?}.", id, trimmed));
                        } else {
                            // If the collection has no remaining members, drop it entirely.
                            // The filter list refetches on every mutation, so an empty
                            // collection would otherwise stick around forever — this saves
                            // us from needing a separate "manage collections" UI.
                            let remaining: i64 = conn.query_row(
                                "SELECT COUNT(*) FROM game_collections WHERE collection_id = ?",
                                duckdb::params![cid], |r| r.get(0),
                            ).unwrap_or(0);
                            if remaining == 0 {
                                conn.execute(
                                    "DELETE FROM collections WHERE id = ?",
                                    duckdb::params![cid],
                                )?;
                                reporter.done(format!(
                                    "Game {} removed from collection {:?} — collection now empty, deleted.",
                                    id, trimmed
                                ));
                            } else {
                                reporter.done(format!("Game {} removed from collection {:?}.", id, trimmed));
                            }
                        }
                    }
                }
            }
            GameCommands::SetVisibility { id, visibility } => {
                let v = visibility.trim().to_lowercase();
                if v != "public" && v != "private" {
                    anyhow::bail!("visibility must be 'public' or 'private', got {:?}", visibility);
                }
                let current: Option<Option<String>> = conn.query_row(
                    "SELECT visibility FROM games WHERE id = ?",
                    duckdb::params![id],
                    |r| Ok(r.get(0)?),
                ).ok();
                let current = current.with_context(|| format!("game {} not found", id))?;
                if current.as_deref() == Some(v.as_str()) {
                    reporter.done(format!("Game {} is already {}.", id, v));
                } else {
                    conn.execute(
                        "UPDATE games SET visibility = ? WHERE id = ?",
                        duckdb::params![v, id],
                    )?;
                    reporter.done(format!("Game {} set to {}.", id, v));
                }
            }
            GameCommands::SoftDelete { id } => {
                let players: Option<(u32, u32, Option<String>)> = conn.query_row(
                    "SELECT white_id, black_id, CAST(deleted_at AS VARCHAR) FROM games WHERE id = ?",
                    duckdb::params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                ).ok();
                let (white_id, black_id, already_deleted) = players
                    .with_context(|| format!("game {} not found", id))?;
                if already_deleted.is_some() {
                    reporter.done(format!("Game {} already soft-deleted.", id));
                } else {
                    conn.execute(
                        "UPDATE games SET deleted_at = CAST(NOW() AS TIMESTAMP) WHERE id = ?",
                        duckdb::params![id],
                    )?;
                    db::queries::recalculate_game_count_for(&conn, white_id)?;
                    if black_id != white_id {
                        db::queries::recalculate_game_count_for(&conn, black_id)?;
                    }
                    reporter.done(format!("Game {} soft-deleted.", id));
                }
            }
            GameCommands::Purge { dry_run } => {
                let count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM games WHERE deleted_at IS NOT NULL",
                    [], |r| r.get(0),
                ).unwrap_or(0);
                if count == 0 {
                    reporter.done("No soft-deleted games to purge.");
                } else if dry_run {
                    reporter.done(format!("Would purge {} soft-deleted game(s) (dry run).", count));
                } else {
                    let spinner = reporter.spinner();
                    spinner.set_message(format!("Purging {} soft-deleted game(s)…", count));
                    if !cli.json { spinner.tick(); }
                    conn.execute_batch(
                        "DELETE FROM positions
                            WHERE game_id IN (SELECT id FROM games WHERE deleted_at IS NOT NULL);
                         DELETE FROM game_collections
                            WHERE game_id IN (SELECT id FROM games WHERE deleted_at IS NOT NULL);
                         DELETE FROM games WHERE deleted_at IS NOT NULL;"
                    )?;
                    spinner.finish_and_clear();
                    reporter.done(format!("Purged {} soft-deleted game(s).", count));
                }
            }
            GameCommands::Restore { id } => {
                let players: Option<(u32, u32, Option<String>)> = conn.query_row(
                    "SELECT white_id, black_id, CAST(deleted_at AS VARCHAR) FROM games WHERE id = ?",
                    duckdb::params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                ).ok();
                let (white_id, black_id, was_deleted) = players
                    .with_context(|| format!("game {} not found", id))?;
                if was_deleted.is_none() {
                    reporter.done(format!("Game {} is not deleted.", id));
                } else {
                    conn.execute(
                        "UPDATE games SET deleted_at = NULL WHERE id = ?",
                        duckdb::params![id],
                    )?;
                    db::queries::recalculate_game_count_for(&conn, white_id)?;
                    if black_id != white_id {
                        db::queries::recalculate_game_count_for(&conn, black_id)?;
                    }
                    reporter.done(format!("Game {} restored.", id));
                }
            }
        },
        Commands::Players { subcommand } => match subcommand {
            PlayersCommands::UpdateGameCounts => {
                println!("Recalculating game counts for all players…");
                db::queries::recalculate_game_counts(&conn)?;
                println!("Done.");
            }
            PlayersCommands::Dedup => {
                dedup::dedup_players(&conn)?;
            }
            PlayersCommands::Merge { keep_id, drop_id, yes } => {
                do_merge_players(&conn, keep_id, drop_id, yes)?;
            }
            PlayersCommands::MergeByName { keep_name, drop_name, yes } => {
                let keep_id = search::player_id_by_exact_name(&conn, &keep_name)?;
                let drop_id = search::player_id_by_exact_name(&conn, &drop_name)?;
                do_merge_players(&conn, keep_id, drop_id, yes)?;
            }
            PlayersCommands::ApplyCorrections { path, yes } => {
                let mut rdr = csv::Reader::from_path(&path)
                    .with_context(|| format!("cannot read {}", path.display()))?;
                let mut ok = 0usize;
                let mut skipped = 0usize;
                for result in rdr.records() {
                    let record = result?;
                    let keep_name = record.get(0).unwrap_or("").trim();
                    let drop_name = record.get(1).unwrap_or("").trim();
                    if keep_name.is_empty() || drop_name.is_empty() { continue; }
                    let keep_id = match search::player_id_by_exact_name(&conn, keep_name) {
                        Ok(id) => id,
                        Err(e) => { eprintln!("  skip: {}", e); skipped += 1; continue; }
                    };
                    let drop_id = match search::player_id_by_exact_name(&conn, drop_name) {
                        Ok(id) => id,
                        Err(e) => { eprintln!("  skip: {}", e); skipped += 1; continue; }
                    };
                    match do_merge_players(&conn, keep_id, drop_id, yes) {
                        Ok(()) => ok += 1,
                        Err(e) => { eprintln!("  error merging {} → {}: {}", drop_name, keep_name, e); skipped += 1; }
                    }
                }
                println!("Corrections applied: {} merged, {} skipped.", ok, skipped);
            }
            PlayersCommands::Export { path } => {
                players::export(&conn, &path)?;
            }
            PlayersCommands::Import { path } => {
                players::import(&conn, &path, &reporter)?;
            }
            PlayersCommands::SetFideId { player_id, fide_id } => {
                do_set_fide_id(&conn, player_id, fide_id)?;
            }
            PlayersCommands::Normalise { dry_run, delay, batch_size, batch_pause, workers, error_threshold, error_pause, stop_on_errors, limit, service_url, service_key, no_service } => {
                normalise::normalise_players(&conn, dry_run, delay, batch_size, batch_pause, workers, error_threshold, error_pause, stop_on_errors, limit, service_url, service_key, no_service, &reporter)?;
            }
        },
        Commands::Search { subcommand } => match subcommand {
            SearchCommands::Games {
                name,
                fide_id,
                white,
                black,
                white_fide_id,
                black_fide_id,
                event,
                eco,
                first_moves,
                from,
                to,
                fen,
                moves_stats,
                show_moves,
                limit,
                pgn,
                count,
            } => {
                if fen.is_some() && first_moves.is_some() {
                    eprintln!("error: --fen and --first-moves are mutually exclusive");
                    std::process::exit(1);
                }
                if moves_stats {
                    search::position_moves(
                        &conn,
                        fen.as_deref(),
                        first_moves.as_deref(),
                        name.as_deref(),
                        fide_id,
                        white.as_deref(),
                        black.as_deref(),
                        white_fide_id,
                        black_fide_id,
                        from.as_deref(),
                        to.as_deref(),
                    )?;
                } else {
                    search::games(
                        &conn,
                        name.as_deref(),
                        fide_id,
                        white.as_deref(),
                        black.as_deref(),
                        white_fide_id,
                        black_fide_id,
                        event.as_deref(),
                        eco.as_deref(),
                        first_moves.as_deref(),
                        from.as_deref(),
                        to.as_deref(),
                        fen.as_deref(),
                        show_moves,
                        limit,
                        pgn,
                        count,
                    )?;
                }
            }
            SearchCommands::Players { name, fide_id, exact, id_only } => {
                search::players(&conn, &name, fide_id, exact, id_only)?;
            }
        },
        Commands::Backup { collection, dir } => {
            do_backup(&conn, &collection, &dir, &reporter)?;
        }
        Commands::Status => {
            db::queries::status(&conn, &cli.db)?;
        }
        Commands::Serve { port } => {
            // Schema was already initialised with the read-write connection above.
            // Reopen read-only so that Tauri-spawned chess-db subprocesses can
            // acquire a read-write lock for import/download operations.
            drop(conn);
            let conn_ro = db::open_readonly(&cli.db)?;
            serve::run(conn_ro, port).await?;
        }
    }

    Ok(())
}
