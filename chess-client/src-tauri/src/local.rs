use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    is_dir: bool,
    size: u64,
}

#[derive(Serialize)]
pub struct DirectoryListing {
    path: String,
    parent: Option<String>,
    entries: Vec<DirEntry>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<DirectoryListing, String> {
    let dir = if path.is_empty() || path == "~" {
        home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?
    } else if let Some(rest) = path.strip_prefix("~/") {
        let home = home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
        home.join(rest)
    } else {
        PathBuf::from(&path)
    };

    let dir = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;

    let parent = dir.parent().map(|p| p.to_string_lossy().into_owned());

    let rd = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Skip hidden files/dirs
        if name.starts_with('.') {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            dirs.push(DirEntry {
                name,
                is_dir: true,
                size: 0,
            });
        } else if name.to_lowercase().ends_with(".pgn") {
            files.push(DirEntry {
                name,
                is_dir: false,
                size: meta.len(),
            });
        }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let mut entries = dirs;
    entries.append(&mut files);

    Ok(DirectoryListing {
        path: dir.to_string_lossy().into_owned(),
        parent,
        entries,
    })
}

const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024; // 100 MB

#[tauri::command]
pub async fn read_pgn_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({:.0} MB, max 100 MB)",
            meta.len() as f64 / 1_048_576.0
        ));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("{path}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn write_pgn_file(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    let p = PathBuf::from(&path);

    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }

    // Write to a sibling temp file then atomically rename over the target so
    // a crash mid-write can't leave the original truncated.
    let mut tmp = p.clone();
    let file_name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "pgn".to_string());
    tmp.set_file_name(format!(".{file_name}.tmp"));

    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("{}: {e}", tmp.display()))?;
    }

    std::fs::rename(&tmp, &p).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(())
}

/// Writes pasted PGN content to a temp file in the OS temp directory and
/// returns the path. Used by the import dialog's paste-from-clipboard flow so
/// the existing `import-pgn` sidecar (which only takes file paths) can ingest
/// it without a new code path on the Rust side.
#[tauri::command]
pub async fn write_temp_pgn_file(content: String) -> Result<String, String> {
    use std::io::Write;
    if content.trim().is_empty() {
        return Err("PGN content is empty".to_string());
    }
    let mut p = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    p.push(format!("lpdo-paste-{stamp}.pgn"));

    let mut f = std::fs::File::create(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    f.write_all(content.as_bytes()).map_err(|e| format!("{}: {e}", p.display()))?;
    f.sync_all().map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn append_pgn_file(path: String, pgn: String) -> Result<(), String> {
    use std::io::Write;
    let p = PathBuf::from(&path);
    let trimmed = pgn.trim_end_matches(['\r', '\n']);
    if trimmed.trim().is_empty() {
        return Err("PGN content is empty".to_string());
    }

    // Ensure parent dir exists.
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }

    // Decide what separator we need based on existing tail.
    let needs_blank_line = match std::fs::metadata(&p) {
        Ok(meta) if meta.len() == 0 => false,
        Ok(meta) => {
            // Read the last few bytes to see whether the file already ends with a blank line.
            let mut file = std::fs::File::open(&p).map_err(|e| format!("{path}: {e}"))?;
            use std::io::{Read, Seek, SeekFrom};
            let len = meta.len();
            let read_from = len.saturating_sub(4);
            file.seek(SeekFrom::Start(read_from))
                .map_err(|e| format!("{path}: {e}"))?;
            let mut tail = Vec::new();
            file.read_to_end(&mut tail).map_err(|e| format!("{path}: {e}"))?;
            let s = String::from_utf8_lossy(&tail);
            !(s.ends_with("\n\n") || s.ends_with("\r\n\r\n"))
        }
        Err(_) => false, // file does not exist; will be created
    };

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| format!("{path}: {e}"))?;

    if needs_blank_line {
        file.write_all(b"\n\n").map_err(|e| format!("{path}: {e}"))?;
    }
    file.write_all(trimmed.as_bytes())
        .map_err(|e| format!("{path}: {e}"))?;
    file.write_all(b"\n").map_err(|e| format!("{path}: {e}"))?;
    Ok(())
}
