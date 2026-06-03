use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ShortlistEntry {
    Individual {
        id: String,
        name: String,
        url: String,
        my_snr: u32,
        my_name: String,
        my_fide_id: Option<u64>,
    },
    Team {
        id: String,
        name: String,
        url: String,
        my_team_name: String,
        /// If true: home team plays Black on board 1, White on board 2, alternating.
        /// If false: home team plays White on board 1, Black on board 2, alternating.
        home_black_board1: bool,
    },
}

impl ShortlistEntry {
    pub fn id(&self) -> &str {
        match self {
            Self::Individual { id, .. } | Self::Team { id, .. } => id,
        }
    }
}

pub fn shortlist_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .expect("app config dir not available")
        .join("shortlist.json")
}

pub fn load(app: &tauri::AppHandle) -> Vec<ShortlistEntry> {
    let path = shortlist_path(app);
    if !path.exists() {
        return Vec::new();
    }
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, entries: &[ShortlistEntry]) -> Result<(), String> {
    let path = shortlist_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}
