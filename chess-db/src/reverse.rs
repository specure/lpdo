// Reverse player normalisation: assign FIDE IDs to players FROM their names
// (#152, #162). The forward path (normalise.rs) is fide_id → canonical name; this
// is the opposite — name → fide_id — for FIDE-less sources like Ajedrez.
//
// Since #162 this is a purely LOCAL operation: it matches FIDE-less players
// against the union of the local `fide_players` table (the monthly FIDE download)
// and this DB's own FIDE-tagged players (which cover registrations arriving via
// TWIC etc. between refreshes). No network, no cache service.
//
// Policy: assign a FIDE ID only on a SINGLE EXACT match after folding accents +
// punctuation. A folded name shared by several distinct FIDE IDs is treated as
// not-found — never guess, because a wrong FIDE ID corrupts stats worse than a
// missing one.

use std::path::Path;

use anyhow::{Context, Result};
use duckdb::Connection;

use crate::reporter::Reporter;

/// The fold key for FIDE name matching, as a DuckDB expression over `col`:
/// lowercase → strip accents (é→e, č→c) → punctuation/whitespace collapsed to
/// single spaces → trimmed. Applied identically to both sides of every match so
/// spelling/accent variants line up (e.g. `Svrček, Jozef` == `Svrcek, Jozef`),
/// while genuinely different names (incl. abbreviated initials) stay distinct.
fn fold_expr(col: &str) -> String {
    format!("trim(regexp_replace(strip_accents(lower({col})), '[^a-z0-9]+', ' ', 'g'))")
}

/// How many players still lack a fide_id (the reverse-resolution backlog).
pub fn pending_count(conn: &Connection) -> Result<usize> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM players WHERE fide_id IS NULL AND name_normalized <> ''",
        [],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

/// Assign FIDE IDs to FIDE-less players by matching their (folded) name against
/// the union of the local FIDE list and this DB's own FIDE-tagged players, taking
/// only single-exact matches. Local-only since #162 (the `service_*`/`no_service`
/// arguments are vestigial and ignored — the normalise service is being retired).
pub fn resolve_fide(
    conn: &Connection,
    dry_run: bool,
    _service_url: Option<String>,
    _service_key: Option<String>,
    _no_service: bool,
    reporter: &Reporter,
) -> Result<usize> {
    let before = pending_count(conn)?;
    reporter.log(format!("{before} player(s) without a FIDE ID."));

    let fide_count: i64 = conn.query_row("SELECT COUNT(*) FROM fide_players", [], |r| r.get(0))?;
    if fide_count == 0 {
        reporter.done(
            "No FIDE list loaded — run `chess-db fide refresh --file <FIDE players list>` first.",
        );
        return Ok(0);
    }
    reporter.log(format!(
        "Matching FIDE-less names against {fide_count} FIDE players + this DB's tagged players…"
    ));

    // Materialise the single-exact name→fide_id map from the union of the FIDE
    // list and the DB's own FIDE-tagged players. A folded name that maps to more
    // than one distinct fide_id across the union is dropped (never guessed).
    let fold_u = fold_expr("u.name");
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS resolve_cand;
         CREATE TEMP TABLE resolve_cand AS
         WITH folded AS (
           SELECT fide_id, {fold_u} AS nf
           FROM (SELECT fide_id, name FROM fide_players
                 UNION ALL
                 SELECT fide_id, name FROM players WHERE fide_id IS NOT NULL) u
           WHERE u.name <> ''
         )
         SELECT nf, MIN(fide_id) AS fide_id
         FROM folded WHERE nf <> ''
         GROUP BY nf HAVING COUNT(DISTINCT fide_id) = 1;"
    ))?;

    // Proposed assignments at the player level, then the birth-year sanity gate.
    // We can't prove two same-named people are the same person from a source
    // without FIDE IDs, so we accept some false positives — but a game played
    // BEFORE a candidate's FIDE birth year proves a different person, so those we
    // reject outright. Rating is deliberately not used (it drifts over the years).
    let fold_p = fold_expr("p.name");
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS resolve_assign;
         CREATE TEMP TABLE resolve_assign AS
         SELECT p.id AS player_id, c.fide_id
         FROM players p JOIN resolve_cand c ON {fold_p} = c.nf
         WHERE p.fide_id IS NULL;

         -- Earliest game year per candidate player (either colour).
         DROP TABLE IF EXISTS resolve_firstyear;
         CREATE TEMP TABLE resolve_firstyear AS
         SELECT pid AS player_id, MIN(gy) AS first_year
         FROM (
           SELECT white_id AS pid, TRY_CAST(substr(date, 1, 4) AS INTEGER) AS gy FROM games
           UNION ALL
           SELECT black_id AS pid, TRY_CAST(substr(date, 1, 4) AS INTEGER) AS gy FROM games
         ) t
         WHERE pid IN (SELECT player_id FROM resolve_assign)
           AND gy IS NOT NULL AND gy BETWEEN 1400 AND 2100
         GROUP BY pid;

         -- Reject a match whose earliest game predates the candidate's birth year.
         DROP TABLE IF EXISTS resolve_reject;
         CREATE TEMP TABLE resolve_reject AS
         SELECT a.player_id
         FROM resolve_assign a
         JOIN resolve_firstyear fy ON fy.player_id = a.player_id
         JOIN fide_players f ON f.fide_id = a.fide_id
         WHERE f.birth_year IS NOT NULL AND fy.first_year < f.birth_year;"
    ))?;

    let total: i64 = conn.query_row("SELECT COUNT(*) FROM resolve_assign", [], |r| r.get(0))?;
    let rejected: i64 = conn.query_row("SELECT COUNT(*) FROM resolve_reject", [], |r| r.get(0))?;

    let assigned_players = if dry_run {
        (total - rejected).max(0) as usize
    } else {
        // name_normalised=FALSE so a subsequent forward `normalise` canonicalises
        // the newly-fide'd name from fide_players.
        conn.execute(
            "UPDATE players SET fide_id = a.fide_id, name_normalised = FALSE
             FROM resolve_assign a
             WHERE players.id = a.player_id AND players.fide_id IS NULL
               AND a.player_id NOT IN (SELECT player_id FROM resolve_reject)",
            [],
        )?
    };
    conn.execute_batch(
        "DROP TABLE IF EXISTS resolve_cand;
         DROP TABLE IF EXISTS resolve_assign;
         DROP TABLE IF EXISTS resolve_firstyear;
         DROP TABLE IF EXISTS resolve_reject;",
    )?;

    let gate = if rejected > 0 {
        format!(" Birth-year gate rejected {rejected} impossible match(es) (game predates FIDE birth year).")
    } else {
        String::new()
    };
    if dry_run {
        reporter.done(format!(
            "Dry run — would assign a FIDE ID to {assigned_players} of {before} FIDE-less player(s).{gate}"
        ));
    } else {
        let after = pending_count(conn)?;
        reporter.done(format!(
            "Resolved FIDE IDs: {assigned_players} player row(s) assigned ({before} → {after} still without one).{gate}"
        ));
    }
    Ok(assigned_players)
}

/// Export the resolution ledger (name → outcome), including negatives, to CSV.
/// (Legacy sharing path from #152; superseded by the shared FIDE list under #162
/// but kept until the service is fully retired.)
pub fn export_resolutions(conn: &Connection, path: &Path) -> Result<usize> {
    let rows: Vec<(String, Option<u32>, Option<String>, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT name_normalized, fide_id, source, CAST(checked_at AS VARCHAR)
             FROM name_resolution ORDER BY name_normalized",
        )?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .filter_map(|r| r.ok())
            .collect()
    };
    let mut wtr = csv::Writer::from_path(path)
        .with_context(|| format!("cannot write {}", path.display()))?;
    wtr.write_record(["name_normalized", "fide_id", "source", "checked_at"])?;
    for (name, fide_id, source, checked) in &rows {
        wtr.write_record([
            name.as_str(),
            &fide_id.map(|v| v.to_string()).unwrap_or_default(),
            source.as_deref().unwrap_or(""),
            checked.as_deref().unwrap_or(""),
        ])?;
    }
    wtr.flush()?;
    Ok(rows.len())
}

/// Import a resolution ledger produced by `export_resolutions`: positives win
/// (upsert + assign), negatives never clobber an existing answer.
pub fn import_resolutions(conn: &Connection, path: &Path, reporter: &Reporter) -> Result<()> {
    let mut rdr = csv::Reader::from_path(path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    let mut positives = 0usize;
    let mut negatives = 0usize;
    for rec in rdr.records() {
        let rec = rec.context("CSV parse error")?;
        let name = rec.get(0).unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let fide_id: Option<u32> = rec
            .get(1)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .and_then(|v| v.parse().ok());
        let source = rec.get(2).map(|s| s.trim()).filter(|s| !s.is_empty());
        let checked = rec.get(3).map(|s| s.trim()).filter(|s| !s.is_empty());
        let src = source.unwrap_or("import");
        if let Some(id) = fide_id {
            conn.execute(
                "INSERT INTO name_resolution (name_normalized, fide_id, source, checked_at)
                 VALUES (?, ?, ?, COALESCE(TRY_CAST(? AS DATE), CURRENT_DATE))
                 ON CONFLICT (name_normalized) DO UPDATE SET
                   fide_id = excluded.fide_id, source = excluded.source, checked_at = excluded.checked_at",
                duckdb::params![name, id, src, checked],
            )?;
            positives += 1;
        } else {
            conn.execute(
                "INSERT INTO name_resolution (name_normalized, fide_id, source, checked_at)
                 VALUES (?, NULL, ?, COALESCE(TRY_CAST(? AS DATE), CURRENT_DATE))
                 ON CONFLICT (name_normalized) DO NOTHING",
                duckdb::params![name, src, checked],
            )?;
            negatives += 1;
        }
    }
    let assigned = conn.execute(
        "UPDATE players SET fide_id = nr.fide_id, name_normalised = FALSE
         FROM name_resolution nr
         WHERE players.name_normalized = nr.name_normalized
           AND players.fide_id IS NULL AND nr.fide_id IS NOT NULL",
        [],
    )?;
    reporter.done(format!(
        "Imported resolution ledger: {} positive, {} negative → {} player row(s) assigned a FIDE ID.",
        positives, negatives, assigned,
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        conn
    }

    #[test]
    fn resolve_single_exact_from_fide_list_folding_accents() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO fide_players (fide_id, name) VALUES
               (100, 'Svrcek, Jozef'),
               (200, 'Smith, John'),
               (201, 'Smith, John');           -- same name, two ids → ambiguous
             INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'Svrček, Jozef','svrcek jozef',NULL,FALSE),  -- accented, FIDE-less
               (2,'Smith, John','smith john',NULL,FALSE),       -- ambiguous
               (3,'Nobody, X','nobody x',NULL,FALSE);           -- not in FIDE",
        )
        .unwrap();

        let assigned = resolve_fide(&conn, false, None, None, false, &Reporter::silent()).unwrap();
        assert_eq!(assigned, 1);

        let f = |id: u32| -> Option<u32> {
            conn.query_row("SELECT fide_id FROM players WHERE id=?", duckdb::params![id], |r| r.get(0)).unwrap()
        };
        assert_eq!(f(1), Some(100), "accented FIDE-less name folds to the ASCII FIDE entry");
        assert_eq!(f(2), None, "name shared by two FIDE IDs is never guessed");
        assert_eq!(f(3), None, "name not in FIDE stays unresolved");
    }

    #[test]
    fn birth_year_gate_rejects_games_before_the_candidate_was_born() {
        let conn = setup();
        // fide namesakes: 100 is a junior (born 2010), 200 born 1975. Both local
        // players have a 2005 game — impossible for the 2010 junior, fine for 1975.
        conn.execute_batch(
            "INSERT INTO fide_players (fide_id, name, birth_year) VALUES
               (100, 'Young, Junior', 2010),
               (200, 'Old, Master', 1975);
             INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'Young, Junior','young junior',NULL,FALSE),
               (2,'Old, Master','old master',NULL,FALSE);
             INSERT INTO games (id, white_id, black_id, date) VALUES
               (1, 1, 999, '2005-06-01'),
               (2, 2, 998, '2005-06-01');",
        )
        .unwrap();

        resolve_fide(&conn, false, None, None, false, &Reporter::silent()).unwrap();
        let f = |id: u32| -> Option<u32> {
            conn.query_row("SELECT fide_id FROM players WHERE id=?", duckdb::params![id], |r| r.get(0)).unwrap()
        };
        assert_eq!(f(1), None, "game predates the candidate's birth → rejected, not guessed");
        assert_eq!(f(2), Some(200), "game after birth → assigned normally");
    }

    #[test]
    fn resolve_uses_db_tagged_players_as_fresh_delta() {
        let conn = setup();
        // fide_id 999 is NOT in the FIDE list yet, but a source tagged a DB player
        // with it (fresh TWIC registration) — under a slightly different spelling.
        conn.execute_batch(
            "INSERT INTO fide_players (fide_id, name) VALUES (100, 'Carlsen, Magnus');
             INSERT INTO players (id,name,name_normalized,fide_id,name_normalised) VALUES
               (1,'Svrcek, Jozef','svrcek jozef',999,FALSE),   -- DB-tagged (ASCII)
               (2,'Svrček, Jozef','svrcek jozef',NULL,FALSE);  -- FIDE-less namesake (accented)",
        )
        .unwrap();

        resolve_fide(&conn, false, None, None, false, &Reporter::silent()).unwrap();
        let f2: Option<u32> =
            conn.query_row("SELECT fide_id FROM players WHERE id=2", [], |r| r.get(0)).unwrap();
        assert_eq!(f2, Some(999), "resolves via the DB-tagged side even though not in the FIDE list");
    }
}
