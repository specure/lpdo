use anyhow::Result;
use duckdb::Connection;

pub fn init(conn: &Connection) -> Result<()> {
    // Multi-source migration (#40): the TWIC-era `issues` ledger becomes the
    // source-agnostic `source_items`. No foreign key references it (games.issue_id
    // is a plain column), so a rename is safe; rows are tagged by the historical
    // id convention below (TWIC used natural issue numbers <1e6; local PGN imports
    // were allocated ids >=1e6).
    let has_issues = table_exists(conn, "issues")?;
    let has_source_items = table_exists(conn, "source_items")?;
    if has_issues && !has_source_items {
        println!("Migrating the import ledger (issues → source_items) for multi-source support…");
        conn.execute_batch("ALTER TABLE issues RENAME TO source_items;")?;
    }

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS source_items (
            id           INTEGER PRIMARY KEY,
            source_key   VARCHAR,
            external_id  VARCHAR,
            filename     VARCHAR,
            downloaded   BOOLEAN DEFAULT FALSE,
            imported     BOOLEAN DEFAULT FALSE,
            game_count   INTEGER,
            fetched_at   TIMESTAMP,
            imported_at  TIMESTAMP,
            published_at DATE
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

    // One-time migration: a "rebuild from scratch" used to recreate the
    // positions table WITH a `REFERENCES games(id)` foreign key (the initial
    // schema has none). DuckDB implements UPDATE as delete+insert, so that
    // incoming FK makes `UPDATE games` fail at scale — breaking player merge and
    // soft-delete with a "game_id … still referenced" error — and DuckDB can't
    // drop a constraint via ALTER. positions is derived data, so the FK isn't
    // needed: recreate the table without it (rows preserved). Runs before any
    // migration that does `UPDATE games` below.
    let positions_has_fk: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM duckdb_constraints()
         WHERE table_name = 'positions' AND constraint_type = 'FOREIGN KEY'",
        [],
        |r| r.get(0),
    ).unwrap_or(false);
    if positions_has_fk {
        println!("Removing a foreign key on the positions table (one-time migration; may take a moment on a large index)…");
        conn.execute_batch(
            "CREATE TABLE positions_new (
                 game_id      UINTEGER,
                 move_number  SMALLINT,
                 zobrist_hash BIGINT,
                 next_move    VARCHAR
             );
             INSERT INTO positions_new
                 SELECT game_id, move_number, zobrist_hash, next_move FROM positions;
             DROP TABLE positions;
             ALTER TABLE positions_new RENAME TO positions;",
        )?;
        println!("Done.");
    }

    // Ledger column adds for databases that predate them (no-op for new ones).
    // These target source_items (renamed from issues above).
    conn.execute_batch(
        "ALTER TABLE source_items ADD COLUMN IF NOT EXISTS imported_at TIMESTAMP;
         -- TWIC publication date (from theweekinchess.com), distinct from
         -- imported_at (when we ingested it). Backfilled on download.
         ALTER TABLE source_items ADD COLUMN IF NOT EXISTS published_at DATE;
         -- Multi-source columns (#40).
         ALTER TABLE source_items ADD COLUMN IF NOT EXISTS source_key VARCHAR;
         ALTER TABLE source_items ADD COLUMN IF NOT EXISTS external_id VARCHAR;",
    )?;
    // Backfill provenance on migrated/legacy rows: TWIC used natural issue
    // numbers (<1e6); local PGN imports were allocated ids >=1e6 → 'manual'.
    conn.execute_batch(
        "UPDATE source_items
            SET source_key = CASE WHEN id < 1000000 THEN 'twic' ELSE 'manual' END
          WHERE source_key IS NULL;
         UPDATE source_items
            SET external_id = CAST(id AS VARCHAR)
          WHERE external_id IS NULL;",
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

    // Must run AFTER the Phase 2 block above: that drops the legacy `sources`
    // table (the old games.source_id FK target), and the multi-source state
    // table (#40) reuses the name. Creating it last avoids the drop clobbering it.
    init_sources(conn)?;

    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT COUNT(*) > 0 FROM information_schema.tables WHERE table_name = ?",
        duckdb::params![name],
        |r| r.get(0),
    )?)
}

/// Per-database state for each import source (#40). The catalog of *available*
/// sources lives in code (`crate::sources`); this table records which ones this
/// database has enabled, whether their attribution was acknowledged, the
/// per-source date window (B1), and the outcome of the last sync. Seeded with
/// TWIC enabled (the historical default).
///
/// `from_date`/`to_date` are inclusive game-date bounds (NULL = unbounded);
/// `exclude_undated` drops games with no usable date. All default to
/// unbounded/false, so an existing TWIC source keeps importing everything.
fn init_sources(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sources (
            key             VARCHAR PRIMARY KEY,
            enabled         BOOLEAN NOT NULL DEFAULT FALSE,
            credit_acked    BOOLEAN NOT NULL DEFAULT FALSE,
            from_date       DATE,
            to_date         DATE,
            exclude_undated BOOLEAN NOT NULL DEFAULT FALSE,
            last_run        TIMESTAMP,
            last_status     VARCHAR
        );

        -- Add the date-window columns to databases whose `sources` table predates
        -- them (Phase A created the table without them).
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS from_date DATE;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS to_date DATE;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS exclude_undated BOOLEAN DEFAULT FALSE;
        UPDATE sources SET exclude_undated = FALSE WHERE exclude_undated IS NULL;
        ",
    )?;

    // Was TWIC already tracked before this init? Distinguishes a legacy upgrade
    // (sources table created now) from a normal restart, so the preserve-TWIC
    // step below never overrides a user's later choice to disable it.
    let twic_existed: bool = conn
        .query_row("SELECT COUNT(*) FROM sources WHERE key = 'twic'", [], |r| r.get::<_, i64>(0))
        .map(|n| n > 0)
        .unwrap_or(false);

    // Seed a state row for every catalog source with its default enabled flag and
    // date window. ON CONFLICT DO NOTHING leaves existing rows (and the user's
    // choices) untouched — defaults only apply to sources new to this database.
    for s in crate::sources::CATALOG {
        conn.execute(
            "INSERT INTO sources (key, enabled, from_date, to_date, exclude_undated)
             VALUES (?, ?, CAST(? AS DATE), CAST(? AS DATE), ?)
             ON CONFLICT (key) DO NOTHING",
            duckdb::params![
                s.key,
                s.default_enabled,
                s.default_from,
                s.default_to,
                s.default_exclude_undated
            ],
        )?;
    }

    // TWIC now seeds disabled so a fresh install imports nothing until the wizard
    // enables it (#40 C4). But a database upgrading from the TWIC-only era was
    // actively using TWIC — if TWIC is new to this DB yet imported TWIC items
    // already exist, keep it enabled so those users' updates continue. Guarded on
    // "TWIC wasn't already tracked" so a normal restart never re-enables a source
    // the user has since disabled.
    if !twic_existed {
        conn.execute(
            "UPDATE sources SET enabled = TRUE
             WHERE key = 'twic'
               AND EXISTS (SELECT 1 FROM source_items WHERE source_key = 'twic' AND imported = TRUE)",
            [],
        )?;
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
            id              INTEGER PRIMARY KEY,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            interval_hours  INTEGER NOT NULL DEFAULT 24,
            last_run        TIMESTAMP,
            last_status     VARCHAR,
            last_job_id     VARCHAR,
            -- Gate for background auto-sync (#40 C4): the daemon does not
            -- auto-import enabled-but-unsynced sources until first-run setup has
            -- completed (set by the wizard's /setup/start), so a source enabled
            -- mid-wizard isn't synced before the user finishes. A populated DB
            -- (games > 0) also opens the gate, so upgrades aren't blocked.
            setup_completed BOOLEAN NOT NULL DEFAULT FALSE
        );

        -- Add to databases whose `schedule` table predates the column.
        ALTER TABLE schedule ADD COLUMN IF NOT EXISTS setup_completed BOOLEAN DEFAULT FALSE;
        UPDATE schedule SET setup_completed = FALSE WHERE setup_completed IS NULL;

        INSERT INTO schedule (id, enabled, interval_hours)
        SELECT 1, TRUE, 24
        WHERE NOT EXISTS (SELECT 1 FROM schedule WHERE id = 1);
        ",
    )?;

    // The scheduler now runs once a day at a chosen local clock time rather than
    // every `interval_hours`. `daily_minute` is minutes past local midnight
    // (default 240 = 04:00). interval_hours is kept for backwards compatibility
    // but no longer drives scheduling.
    conn.execute_batch(
        "ALTER TABLE schedule ADD COLUMN IF NOT EXISTS daily_minute INTEGER DEFAULT 240;
         UPDATE schedule SET daily_minute = 240 WHERE daily_minute IS NULL;",
    )?;
    Ok(())
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn fresh_db_creates_source_items_and_seeds_twic() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        assert!(table_exists(&conn, "source_items").unwrap());
        assert!(!table_exists(&conn, "issues").unwrap());
        let enabled: bool = conn
            .query_row("SELECT enabled FROM sources WHERE key = 'twic'", [], |r| r.get(0))
            .unwrap();
        assert!(!enabled, "twic should be seeded disabled on a fresh install (#40 C4)");

        // Date window (B1) defaults to unbounded so existing TWIC keeps importing
        // every date.
        let (from, to, excl): (Option<String>, Option<String>, bool) = conn
            .query_row(
                "SELECT CAST(from_date AS VARCHAR), CAST(to_date AS VARCHAR), exclude_undated
                 FROM sources WHERE key = 'twic'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((from, to, excl), (None, None, false), "window defaults unbounded");

        // Lichess Broadcasts is seeded from the catalog: disabled, live-tail
        // window (from 2026-01-01).
        let (lenabled, lfrom): (bool, Option<String>) = conn
            .query_row(
                "SELECT enabled, CAST(from_date AS VARCHAR) FROM sources WHERE key = 'lichess-broadcasts'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(!lenabled, "lichess should be seeded disabled");
        assert_eq!(lfrom.as_deref(), Some("2026-01-01"));

        // Ajedrez OTB seeded from the catalog: disabled, unbounded (B3).
        let aenabled: bool = conn
            .query_row("SELECT enabled FROM sources WHERE key = 'ajedrez-otb'", [], |r| r.get(0))
            .unwrap();
        assert!(!aenabled, "ajedrez-otb should be seeded disabled");
    }

    #[test]
    fn migrates_legacy_issues_ledger_tagging_by_id_convention() {
        let conn = Connection::open_in_memory().unwrap();
        // A legacy DB: the old TWIC-era `issues` table with a TWIC row (id<1e6)
        // and a local-import row (id>=1e6).
        conn.execute_batch(
            "CREATE TABLE issues (
                 id INTEGER PRIMARY KEY, filename VARCHAR, downloaded BOOLEAN,
                 imported BOOLEAN, game_count INTEGER, fetched_at TIMESTAMP, imported_at TIMESTAMP
             );
             INSERT INTO issues (id, filename, downloaded, imported) VALUES (1649, 'twic1649g.zip', TRUE, TRUE);
             INSERT INTO issues (id, filename, downloaded, imported) VALUES (1000001, 'megabase.pgn', TRUE, TRUE);",
        ).unwrap();

        init(&conn).unwrap();

        assert!(!table_exists(&conn, "issues").unwrap(), "issues should be renamed away");
        assert!(table_exists(&conn, "source_items").unwrap());

        let twic_key: String = conn
            .query_row("SELECT source_key FROM source_items WHERE id = 1649", [], |r| r.get(0))
            .unwrap();
        assert_eq!(twic_key, "twic");
        let twic_ext: String = conn
            .query_row("SELECT external_id FROM source_items WHERE id = 1649", [], |r| r.get(0))
            .unwrap();
        assert_eq!(twic_ext, "1649");

        let manual_key: String = conn
            .query_row("SELECT source_key FROM source_items WHERE id = 1000001", [], |r| r.get(0))
            .unwrap();
        assert_eq!(manual_key, "manual");

        // Legacy upgrade: TWIC seeds disabled by default (#40 C4), but this DB has
        // imported TWIC items (issue 1649), so it's preserved enabled — existing
        // users' TWIC updates keep working after the upgrade.
        let enabled: bool = conn
            .query_row("SELECT enabled FROM sources WHERE key = 'twic'", [], |r| r.get(0))
            .unwrap();
        assert!(enabled, "TWIC should stay enabled for a legacy DB with imported items");
    }
}
