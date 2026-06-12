use anyhow::{Context, Result};
use duckdb::Connection;
use crate::reporter::Reporter;
use std::path::Path;

/// Export all normalised players (fide_id IS NOT NULL AND name_normalised = TRUE)
/// to a CSV file: fide_id,name
pub fn export(conn: &Connection, path: &Path) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT fide_id, name FROM players
         WHERE fide_id IS NOT NULL AND name_normalised = TRUE
         ORDER BY fide_id",
    )?;

    let rows: Vec<(u32, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        println!("No normalised players to export.");
        return Ok(());
    }

    let mut wtr = csv::Writer::from_path(path)
        .with_context(|| format!("cannot write {}", path.display()))?;

    wtr.write_record(["fide_id", "name"])?;
    for (fide_id, name) in &rows {
        wtr.write_record([fide_id.to_string().as_str(), name.as_str()])?;
    }
    wtr.flush()?;

    println!("Exported {} normalised player(s) to {}.", rows.len(), path.display());
    Ok(())
}

/// Import normalised player names from a CSV file produced by `export`.
/// For each row:
///   - If a player with that fide_id already exists, update their name and
///     set name_normalised = TRUE.
///   - If no player exists with that fide_id, insert a new row.
pub fn import(conn: &Connection, path: &Path, reporter: &Reporter) -> Result<()> {
    // Count data rows for the progress bar (subtract 1 for header).
    let total = {
        let mut rdr = csv::Reader::from_path(path)
            .with_context(|| format!("cannot read {}", path.display()))?;
        rdr.records().count() as u64
    };

    reporter.log(format!("Importing {} players...", total));
    let pb = reporter.bar(total);
    pb.set_message("Importing players");
    if !reporter.is_json() { pb.tick(); }

    let mut rdr = csv::Reader::from_path(path)
        .with_context(|| format!("cannot read {}", path.display()))?;

    let mut updated = 0usize;
    let mut inserted = 0usize;
    let mut errors = 0usize;

    let mut processed = 0u64;
    for result in rdr.records() {
        pb.inc(1);
        processed += 1;
        let record = match result {
            Ok(r) => r,
            Err(e) => {
                reporter.error(format!("  CSV parse error: {}", e));
                errors += 1;
                continue;
            }
        };

        let fide_id: u32 = match record.get(0).and_then(|v| v.parse().ok()) {
            Some(id) => id,
            None => {
                reporter.error(format!("  Skipping row with invalid fide_id: {:?}", record.get(0)));
                errors += 1;
                continue;
            }
        };

        let name = match record.get(1) {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => {
                reporter.error(format!("  Skipping fide_id={} with empty name", fide_id));
                errors += 1;
                continue;
            }
        };

        if processed.is_multiple_of(5000) {
            reporter.progress(processed, total, format!("Imported {} / {} players", processed, total));
        }

        let name_normalized = name
            .to_lowercase()
            .replace(',', " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        // Check if a player with this fide_id already exists
        let existing_id: Option<u32> = conn
            .query_row(
                "SELECT id FROM players WHERE fide_id = ? LIMIT 1",
                duckdb::params![fide_id],
                |r| r.get(0),
            )
            .ok();

        if let Some(id) = existing_id {
            conn.execute(
                "UPDATE players SET name = ?, name_normalized = ?, name_normalised = TRUE WHERE id = ?",
                duckdb::params![name, name_normalized, id],
            )?;
            updated += 1;
        } else {
            // New player — allocate an ID above the current max
            let next_id: u32 = {
                let max: Option<i64> = conn
                    .query_row("SELECT MAX(id) FROM players", [], |r| r.get(0))
                    .unwrap_or(None);
                max.unwrap_or(0) as u32 + 1
            };
            conn.execute(
                "INSERT INTO players (id, name, name_normalized, fide_id, name_normalised)
                 VALUES (?, ?, ?, ?, TRUE)",
                duckdb::params![next_id, name, name_normalized, fide_id],
            )?;
            inserted += 1;
        }
    }

    let summary = format!("Done: {} updated, {} inserted, {} errors.", updated, inserted, errors);
    pb.finish_with_message(summary.clone());
    reporter.done(summary);
    Ok(())
}
