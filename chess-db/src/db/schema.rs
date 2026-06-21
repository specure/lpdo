use anyhow::Result;
use duckdb::Connection;

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS issues (
            id          INTEGER PRIMARY KEY,
            filename    VARCHAR,
            downloaded  BOOLEAN DEFAULT FALSE,
            imported    BOOLEAN DEFAULT FALSE,
            game_count  INTEGER,
            fetched_at  TIMESTAMP,
            imported_at TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS players (
            id               INTEGER PRIMARY KEY,
            name             VARCHAR NOT NULL,
            name_normalized  VARCHAR NOT NULL,
            fide_id          INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_players_name    ON players(name_normalized);
        CREATE INDEX IF NOT EXISTS idx_players_fide_id ON players(fide_id);

        CREATE TABLE IF NOT EXISTS games (
            id            UINTEGER PRIMARY KEY,
            issue_id      INTEGER,
            white_id      INTEGER,
            black_id      INTEGER,
            white_elo     SMALLINT,
            black_elo     SMALLINT,
            event         VARCHAR,
            site          VARCHAR,
            date          VARCHAR,
            round         VARCHAR,
            result        VARCHAR,
            eco           VARCHAR,
            move_count    SMALLINT,
            pgn           TEXT,
            opening_line  VARCHAR,
            chessbase_id  BIGINT
        );

        CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_id);
        CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_id);
        CREATE INDEX IF NOT EXISTS idx_games_date  ON games(date);
        CREATE INDEX IF NOT EXISTS idx_games_eco   ON games(eco);

        CREATE TABLE IF NOT EXISTS positions (
            game_id      UINTEGER,
            move_number  SMALLINT,
            zobrist_hash BIGINT,
            next_move    VARCHAR
        );
        ",
    )?;

    conn.execute_batch(
        "ALTER TABLE games ADD COLUMN IF NOT EXISTS chessbase_id BIGINT;
         CREATE INDEX IF NOT EXISTS idx_games_chessbase_id ON games(chessbase_id);",
    )?;

    // Add opening_line column to existing databases (no-op for new ones).
    conn.execute_batch(
        "ALTER TABLE games ADD COLUMN IF NOT EXISTS opening_line VARCHAR;",
    )?;

    // Add next_move column to positions table for existing databases.
    conn.execute_batch(
        "ALTER TABLE positions ADD COLUMN IF NOT EXISTS next_move VARCHAR;",
    )?;

    // Add imported_at column to existing databases (no-op for new ones).
    conn.execute_batch(
        "ALTER TABLE issues ADD COLUMN IF NOT EXISTS imported_at TIMESTAMP;",
    )?;

    // TWIC publication date (from the index table on theweekinchess.com), as
    // distinct from imported_at (when we ingested it). Backfilled on `download`.
    conn.execute_batch(
        "ALTER TABLE issues ADD COLUMN IF NOT EXISTS published_at DATE;",
    )?;

    // Add game_count column to existing databases (no-op for new ones).
    conn.execute_batch(
        "ALTER TABLE players ADD COLUMN IF NOT EXISTS game_count INTEGER DEFAULT 0;",
    )?;
    let needs_game_count: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM players WHERE game_count IS NULL LIMIT 1)",
        [],
        |r| r.get(0),
    )?;
    if needs_game_count {
        println!("Backfilling player game counts (one-time migration)…");
        crate::db::queries::recalculate_game_counts(conn)?;
        println!("Done.");
    }

    // One-time migration: normalise dotted PGN-format dates to ISO 8601
    // dashes so VARCHAR string-sort orders chronologically. The importer's
    // visitor already does this on the way in; this fixes pre-existing rows
    // and any inserted by older code paths. Idempotent: re-runs are no-ops.
    let dotted_dates: i64 = conn.query_row(
        "SELECT COUNT(*) FROM games WHERE date LIKE '%.%'",
        [],
        |r| r.get(0),
    ).unwrap_or(0);
    if dotted_dates > 0 {
        println!("Normalising {} dotted date(s) → ISO 8601…", dotted_dates);
        conn.execute_batch(
            "UPDATE games SET date = REPLACE(date, '.', '-') WHERE date LIKE '%.%';",
        )?;
    }

    // Add name_normalised column to existing databases (no-op for new ones).
    conn.execute_batch(
        "ALTER TABLE players ADD COLUMN IF NOT EXISTS name_normalised BOOLEAN;",
    )?;
    let needs_name_normalised: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM players WHERE name_normalised IS NULL LIMIT 1)",
        [],
        |r| r.get(0),
    )?;
    if needs_name_normalised {
        conn.execute_batch(
            "UPDATE players SET name_normalised = FALSE WHERE name_normalised IS NULL;",
        )?;
    }

    // One-time migration: backfill opening_line from stored pgn.
    // The pgn field is stored as headers followed by chr(10)||chr(10) then space-separated SAN moves.
    // We split on the blank line, take the moves part, then keep the first 10 half-moves.
    let needs_opening_line: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM games WHERE opening_line IS NULL LIMIT 1)",
        [],
        |r| r.get(0),
    )?;
    if needs_opening_line {
        conn.execute_batch(
            "UPDATE games
             SET opening_line = array_to_string(
                 string_split(
                     string_split(pgn, chr(10) || chr(10))[2],
                     ' '
                 )[1:10],
                 ' '
             )
             WHERE opening_line IS NULL
               AND pgn IS NOT NULL
               AND pgn != ''
               AND pgn LIKE '%' || chr(10) || chr(10) || '%';",
        )?;
    }

    init_collections(conn)?;
    init_schedule(conn)?;

    // Soft-delete column. NULL = alive. DuckDB ALTER ADD COLUMN is fast on
    // column-store: no row rewrite, just a new NULL column.
    conn.execute_batch(
        "ALTER TABLE games ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;",
    )?;

    // Visibility column on games — replaces source-derived visibility.
    // 'public' | 'private'. One-way ratchet at import (private → public when
    // a public import touches an existing game). Editable later in the UI.
    conn.execute_batch(
        "ALTER TABLE games ADD COLUMN IF NOT EXISTS visibility VARCHAR;",
    )?;
    let needs_visibility_backfill: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM games WHERE visibility IS NULL LIMIT 1)",
        [], |r| r.get(0),
    )?;
    if needs_visibility_backfill {
        println!("Backfilling games.visibility (one-time migration)…");
        // Inherit from old source's visibility where the link still exists.
        conn.execute_batch(
            "UPDATE games SET visibility = (SELECT s.visibility FROM sources s WHERE s.id = games.source_id)
             WHERE visibility IS NULL AND source_id IS NOT NULL;
             -- Stragglers (no source row, or source vanished) default to 'public'.
             UPDATE games SET visibility = 'public' WHERE visibility IS NULL;"
        )?;
        println!("Done.");
    }

    // Phase 2 cleanup: the sources table and games.source_id column are no
    // longer referenced by any code path. Drop them. Idempotent via IF EXISTS.
    //
    // DuckDB quirk: ALTER TABLE DROP COLUMN requires the table to have NO
    // indexes at all (not just none on the target column). So we drop every
    // games index, drop the column, drop the source-related stuff, and
    // recreate the indexes.
    let needs_phase2: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns
                       WHERE table_name='games' AND column_name='source_id')",
        [], |r| r.get(0),
    )?;
    if needs_phase2 {
        println!("Phase 2: dropping legacy sources table + games.source_id…");
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_games_source;
             DROP INDEX IF EXISTS idx_games_white;
             DROP INDEX IF EXISTS idx_games_black;
             DROP INDEX IF EXISTS idx_games_date;
             DROP INDEX IF EXISTS idx_games_eco;
             DROP INDEX IF EXISTS idx_games_chessbase_id;
             ALTER TABLE games DROP COLUMN IF EXISTS source_id;
             DROP TABLE IF EXISTS sources;
             CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_id);
             CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_id);
             CREATE INDEX IF NOT EXISTS idx_games_date  ON games(date);
             CREATE INDEX IF NOT EXISTS idx_games_eco   ON games(eco);
             CREATE INDEX IF NOT EXISTS idx_games_chessbase_id ON games(chessbase_id);"
        )?;
        println!("Done.");
    }

    Ok(())
}

/// Collection = user-facing grouping ("TWIC", "My games", "Najdorf repertoire").
/// Each game can belong to many collections via the game_collections join.
fn init_collections(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS collections (
            id          INTEGER PRIMARY KEY,
            name        VARCHAR NOT NULL UNIQUE,
            created_at  TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS game_collections (
            game_id        UINTEGER NOT NULL,
            collection_id  INTEGER NOT NULL,
            PRIMARY KEY (game_id, collection_id)
        );
        CREATE INDEX IF NOT EXISTS idx_game_collections_collection
            ON game_collections(collection_id);
        ",
    )?;

    // Seed the default TWIC collection (idempotent). The TWIC importer adds
    // every issue's games here.
    conn.execute_batch(
        "
        INSERT INTO collections (id, name, created_at)
        SELECT COALESCE((SELECT MAX(id) FROM collections), 0) + 1,
               'TWIC', CAST(NOW() AS TIMESTAMP)
        WHERE NOT EXISTS (SELECT 1 FROM collections WHERE name = 'TWIC');
        ",
    )?;

    Ok(())
}

/// Single-row config for the server's in-process update scheduler. The server
/// reads it each tick to decide whether an automatic `update` job is due, and
/// records the outcome here. Auto-update is on by default.
fn init_schedule(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS schedule (
            id             INTEGER PRIMARY KEY,
            enabled        BOOLEAN NOT NULL DEFAULT TRUE,
            interval_hours INTEGER NOT NULL DEFAULT 24,
            last_run       TIMESTAMP,
            last_status    VARCHAR,
            last_job_id    VARCHAR
        );

        INSERT INTO schedule (id, enabled, interval_hours)
        SELECT 1, TRUE, 24
        WHERE NOT EXISTS (SELECT 1 FROM schedule WHERE id = 1);
        ",
    )?;
    Ok(())
}
