// Local FIDE player list (#162): load the official monthly FIDE download into the
// `fide_players` table, which powers forward normalise (fide_id → name) and
// reverse resolve-fide (name → fide_id) as local joins — replacing the normalise
// service and per-player ratings.fide.com scraping.
//
// Source format: the FIDE fixed-width "players list" (e.g. players_list_foa.txt),
// one player per line after a header. Columns (1-indexed):
//   ID Number: 1..15   Name: 16..76   Fed: 77..   (we only need id + name).

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use duckdb::Connection;

use crate::reporter::Reporter;

/// Official FIDE combined player list (a zip of the fixed-width `players_list_foa.txt`).
pub const FIDE_LIST_URL: &str = "https://ratings.fide.com/download/players_list.zip";

/// Parse one line of the fixed-width FIDE list into (fide_id, name). Returns None
/// for the header, blanks, or unparseable ids.
fn parse_line(line: &str) -> Option<(u32, String)> {
    if line.len() < 16 {
        return None;
    }
    // ID is the first whitespace-delimited token in cols 1..15 (always ASCII).
    let fide_id: u32 = line.get(..15)?.trim().parse().ok()?;
    // Name occupies cols 16..76; byte-slice is safe at 15 (ASCII id region) and we
    // clamp the end, decoding lossily in case of stray non-UTF-8 bytes.
    let bytes = line.as_bytes();
    let end = bytes.len().min(76);
    let name = String::from_utf8_lossy(&bytes[15..end]).trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some((fide_id, name))
}

/// Replace `fide_players` with the fixed-width FIDE list read from `reader`.
/// Returns the number of players loaded (Appender bulk load).
pub fn load_from_reader<R: BufRead>(conn: &Connection, reader: R, source: &str, reporter: &Reporter) -> Result<usize> {
    conn.execute_batch("DELETE FROM fide_players")?;

    let mut count = 0usize;
    {
        let mut app = conn.appender("fide_players")?;
        for (i, line) in reader.lines().enumerate() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue, // skip a stray undecodable line
            };
            if i == 0 {
                continue; // header
            }
            if let Some((fide_id, name)) = parse_line(&line) {
                app.append_row(duckdb::params![fide_id, name])?;
                count += 1;
                if count % 200_000 == 0 {
                    reporter.progress(count as u64, 0, format!("Loaded {count} FIDE players…"));
                }
            }
        }
        app.flush()?;
    }

    reporter.done(format!("Loaded {count} FIDE players from {source}"));
    Ok(count)
}

/// Load `fide_players` from a local FIDE list file (already unzipped .txt).
pub fn load_from_file(conn: &Connection, path: &Path, reporter: &Reporter) -> Result<usize> {
    let file = File::open(path).with_context(|| format!("opening FIDE list {}", path.display()))?;
    load_from_reader(conn, BufReader::new(file), &path.display().to_string(), reporter)
}

/// Download the FIDE list zip from `url`, extract its `.txt`, and load it. The
/// daemon can't read the user's home dir (ProtectHome), so it fetches the list
/// itself — this is also the scheduled monthly-refresh path (#162).
pub fn download_and_load(conn: &Connection, url: &str, reporter: &Reporter) -> Result<usize> {
    reporter.log(format!("Downloading FIDE list from {url} …"));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(900))
        .build()
        .context("building HTTP client")?;
    let mut resp = client
        .get(url)
        .send()
        .with_context(|| format!("requesting {url}"))?
        .error_for_status()
        .context("FIDE download failed")?;

    // Spool the zip to a temp file (bounded memory), then stream the .txt entry
    // straight into the loader without materialising the ~300 MB uncompressed.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("fide-list-{stamp}.zip"));
    {
        let mut f = File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        resp.copy_to(&mut f).context("saving FIDE download")?;
    }
    reporter.log("Download complete; extracting and loading…");

    let result = (|| -> Result<usize> {
        let zf = File::open(&tmp)?;
        let mut archive = zip::ZipArchive::new(zf).context("opening FIDE zip")?;
        let mut idx = None;
        for i in 0..archive.len() {
            if archive.by_index(i)?.name().to_ascii_lowercase().ends_with(".txt") {
                idx = Some(i);
                break;
            }
        }
        let idx = idx.ok_or_else(|| anyhow::anyhow!("no .txt entry inside the FIDE zip"))?;
        let entry = archive.by_index(idx)?;
        load_from_reader(conn, BufReader::new(entry), url, reporter)
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_id_and_name_from_fixed_width() {
        // cols:      1.............15|16..............
        let line = "40132986       -Moonen, Bas                                                 NED M";
        let (id, name) = parse_line(line).unwrap();
        assert_eq!(id, 40132986);
        assert_eq!(name, "-Moonen, Bas");

        let line2 = "1503014        Carlsen, Magnus                                              NOR M  GM";
        let (id2, name2) = parse_line(line2).unwrap();
        assert_eq!(id2, 1503014);
        assert_eq!(name2, "Carlsen, Magnus");
    }

    #[test]
    fn rejects_header_and_junk() {
        assert!(parse_line("ID Number      Name").is_none());
        assert!(parse_line("").is_none());
        assert!(parse_line("short").is_none());
    }
}

#[cfg(test)]
mod fold_tests {
    use duckdb::Connection;

    /// The reverse-resolve fold key, computed in DuckDB (accents stripped,
    /// punctuation → space, collapsed, lowercased). Must match on both sides.
    fn fold(conn: &Connection, s: &str) -> String {
        conn.query_row(
            "SELECT trim(regexp_replace(strip_accents(lower(?)), '[^a-z0-9]+', ' ', 'g'))",
            duckdb::params![s],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn duckdb_fold_matches_accents_and_punctuation() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(fold(&conn, "Svrček, Jozef"), "svrcek jozef");
        assert_eq!(fold(&conn, "Svrcek, Jozef"), "svrcek jozef");
        assert_eq!(fold(&conn, "Carlsen, Magnus."), "carlsen magnus");
        assert_eq!(fold(&conn, "Vachier-Lagrave, Maxime"), "vachier lagrave maxime");
        assert_ne!(fold(&conn, "Svrcek, J"), fold(&conn, "Svrcek, Jozef"));
    }
}
