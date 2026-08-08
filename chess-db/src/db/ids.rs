//! Persistent id high-water marks (#249).
//!
//! Player, game, and collection ids used to be allocated as `MAX(id) + 1`,
//! which silently REUSES ids: merging away (or deleting) the top-id row lets
//! the next import hand that id to a brand-new, unrelated entity. Anything
//! still holding the old id — the client's stored recent/selected player,
//! collection scope filters, dedup ledgers — then silently rebinds to the new
//! owner (a user saw another player's games listed under their own name).
//!
//! The fix: record the highest id ever handed out per entity in
//! `id_high_water`, and allocate above `max(MAX(id), high_water)`. Deletions
//! never lower the mark, so a freed id is never reissued. Every allocation
//! site must go through [`next_id`] / raise the mark after inserting; a site
//! that bypasses this module reintroduces the bug.

use anyhow::{bail, Result};
use duckdb::Connection;

/// Whitelist of id-carrying tables (`entity` doubles as the table name).
fn table_for(entity: &str) -> Result<&'static str> {
    match entity {
        "players" => Ok("players"),
        "games" => Ok("games"),
        "collections" => Ok("collections"),
        _ => bail!("unknown id entity: {entity}"),
    }
}

/// First id safe to hand out for `entity`: one above both the live rows and
/// the high-water mark. Does not bump the mark — call [`raise_high_water`]
/// after the rows are actually written.
pub fn next_id(conn: &Connection, entity: &str) -> Result<u32> {
    let table = table_for(entity)?;
    let live_max: i64 = conn.query_row(
        &format!("SELECT COALESCE(MAX(id), 0) FROM {table}"),
        [],
        |r| r.get(0),
    )?;
    let high: i64 = conn.query_row(
        "SELECT COALESCE(MAX(high_id), 0) FROM id_high_water WHERE entity = ?",
        duckdb::params![entity],
        |r| r.get(0),
    )?;
    Ok(live_max.max(high) as u32 + 1)
}

/// Record that ids up to and including `last_used` have been handed out for
/// `entity`. Monotonic: never lowers the stored mark.
pub fn raise_high_water(conn: &Connection, entity: &str, last_used: u32) -> Result<()> {
    table_for(entity)?;
    conn.execute(
        "INSERT INTO id_high_water (entity, high_id) VALUES (?, ?)
         ON CONFLICT (entity) DO UPDATE SET high_id = GREATEST(high_id, excluded.high_id)",
        duckdb::params![entity, last_used as i64],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        conn
    }

    /// The #249 scenario: top-id player deleted (merge), next allocation must
    /// NOT reuse the freed id.
    #[test]
    fn deleted_top_id_is_never_reissued() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO players (id, name, name_normalized) VALUES
               (1, 'Keep', 'keep'), (2, 'Drop, Top', 'drop top');",
        ).unwrap();
        raise_high_water(&conn, "players", 2).unwrap();

        conn.execute("DELETE FROM players WHERE id = 2", []).unwrap();
        assert_eq!(next_id(&conn, "players").unwrap(), 3, "id 2 must stay retired");
    }

    /// Pre-watermark databases (mark missing or stale) still allocate above
    /// the live rows.
    #[test]
    fn live_rows_win_when_mark_is_behind() {
        let conn = setup();
        conn.execute(
            "INSERT INTO players (id, name, name_normalized) VALUES (7, 'A', 'a')",
            [],
        ).unwrap();
        assert_eq!(next_id(&conn, "players").unwrap(), 8);

        raise_high_water(&conn, "players", 3).unwrap(); // stale, behind live max
        assert_eq!(next_id(&conn, "players").unwrap(), 8);
    }

    #[test]
    fn raise_is_monotonic() {
        let conn = setup();
        raise_high_water(&conn, "games", 100).unwrap();
        raise_high_water(&conn, "games", 50).unwrap(); // must not lower
        assert_eq!(next_id(&conn, "games").unwrap(), 101);
    }

    #[test]
    fn unknown_entity_is_rejected() {
        let conn = setup();
        assert!(next_id(&conn, "positions; DROP TABLE players").is_err());
    }
}
