//! One's own online games (#90): accounts on Lichess and Chess.com linked to a
//! local player, their games synced into the private collection "My online
//! games" and matched against the repertoire like any game of one's own.
//!
//! A handle on a platform is a player of its own — a *virtual* player,
//! `players.platform` set — never resolved against the FIDE list nor merged
//! with a real name; the link to one's identity is the `accounts` row, and
//! [`identity_ids`] widens a player id to the handles linked to it, which is
//! how "my games" takes the online ones in. The games carry `games.platform`,
//! so the reference figures can leave them out.
//!
//! The sync is incremental: Lichess streams a user's games as PGN from a
//! timestamp; Chess.com publishes monthly archives, the current month's a
//! live list. Both are fetched from a day (a month) before the last sync, and
//! games already held — by their URL in `games.site` — are dropped before the
//! import, so a daily run, or a "Sync now" before a review, brings today's
//! games and nothing twice.

use std::collections::HashSet;
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use duckdb::Connection;
use serde::{Deserialize, Serialize};

use crate::reporter::Reporter;

/// The collection the synced games go into, both platforms together.
pub const COLLECTION: &str = "My online games";

const USER_AGENT: &str = "LPDO (https://github.com/specure/lpdo)";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Lichess,
    Chesscom,
}

impl Platform {
    pub fn key(self) -> &'static str {
        match self { Platform::Lichess => "lichess", Platform::Chesscom => "chesscom" }
    }
    pub fn name(self) -> &'static str {
        match self { Platform::Lichess => "Lichess", Platform::Chesscom => "Chess.com" }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "lichess" => Some(Platform::Lichess),
            "chesscom" | "chess.com" => Some(Platform::Chesscom),
            _ => None,
        }
    }
}

/// How one's games are counted (#90): all of them, over the board only, or
/// online only — any of one's linked handles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    All,
    Otb,
    Online,
}

impl Scope {
    pub fn parse(s: Option<&str>) -> Result<Self> {
        match s.map(|s| s.trim().to_lowercase()).as_deref() {
            None | Some("") | Some("all") => Ok(Scope::All),
            Some("otb") => Ok(Scope::Otb),
            Some("online") => Ok(Scope::Online),
            Some(other) => bail!("scope must be all, otb or online, not {other:?}"),
        }
    }
    /// The games' filter, with the games table as `g`.
    pub fn sql(self) -> &'static str {
        match self {
            Scope::All => "",
            Scope::Otb => " AND g.platform IS NULL",
            Scope::Online => " AND g.platform IS NOT NULL",
        }
    }
}

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS accounts (
            id           INTEGER PRIMARY KEY,
            platform     VARCHAR NOT NULL,
            username     VARCHAR NOT NULL,
            player_id    INTEGER NOT NULL,
            owner_id     INTEGER NOT NULL,
            enabled      BOOLEAN NOT NULL DEFAULT TRUE,
            last_sync    TIMESTAMP,
            last_status  VARCHAR,
            created_at   TIMESTAMP
        );",
    )?;
    Ok(())
}

/// A linked account, as the API shows it.
#[derive(Clone, Debug, Serialize)]
pub struct Account {
    pub id: i64,
    pub platform: Platform,
    pub username: String,
    /// The handle's own player row (a virtual player).
    pub player_id: i64,
    /// The local player the handle belongs to.
    pub owner_id: i64,
    pub owner_name: String,
    pub enabled: bool,
    pub last_sync: Option<String>,
    pub last_status: Option<String>,
    /// The handle's games in the database.
    pub games: i64,
}

const SELECT: &str = "SELECT a.id, a.platform, a.username, a.player_id, a.owner_id, o.name, a.enabled,
                             CAST(a.last_sync AS VARCHAR), a.last_status,
                             (SELECT COUNT(*) FROM games g WHERE (g.white_id = a.player_id OR g.black_id = a.player_id) AND g.deleted_at IS NULL)
                      FROM accounts a JOIN players o ON o.id = a.owner_id";

fn row(r: &duckdb::Row) -> duckdb::Result<Account> {
    let platform: String = r.get(1)?;
    Ok(Account {
        id: r.get(0)?,
        platform: Platform::parse(&platform).unwrap_or(Platform::Lichess),
        username: r.get(2)?,
        player_id: r.get(3)?,
        owner_id: r.get(4)?,
        owner_name: r.get(5)?,
        enabled: r.get(6)?,
        last_sync: r.get(7)?,
        last_status: r.get(8)?,
        games: r.get(9)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Account>> {
    let mut st = conn.prepare(&format!("{SELECT} ORDER BY a.id"))?;
    Ok(st.query_map([], row)?.collect::<duckdb::Result<_>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Account> {
    conn.query_row(&format!("{SELECT} WHERE a.id = ?"), duckdb::params![id], row)
        .map_err(|_| anyhow!("account {id} not found"))
}

/// The accounts to sync: the enabled ones, in order.
pub fn enabled(conn: &Connection) -> Result<Vec<Account>> {
    Ok(list(conn)?.into_iter().filter(|a| a.enabled).collect())
}

/// The player id and the handles linked to it, for "my games". A handle's own
/// id is given back as it is.
pub fn identity_ids(conn: &Connection, player: i64) -> Result<Vec<i64>> {
    let mut ids = vec![player];
    let mut st = conn.prepare("SELECT player_id FROM accounts WHERE owner_id = ? ORDER BY id")?;
    for id in st.query_map(duckdb::params![player], |r| r.get::<_, i64>(0))? {
        let id = id?;
        if !ids.contains(&id) { ids.push(id); }
    }
    Ok(ids)
}

/// A username as the platforms allow them: letters, digits, `_` and `-`.
fn valid_username(u: &str) -> bool {
    (2..=32).contains(&u.len()) && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The importer's normalised form of a name (see `get_or_create_player`).
fn normalized(name: &str) -> String {
    name.to_lowercase().replace(',', " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Link a handle to a local player: the handle's own player row, made if it
/// is not there (a virtual player, `platform` set), and the account.
pub fn add(conn: &Connection, platform: Platform, username: &str, owner_id: i64) -> Result<Account> {
    let username = username.trim();
    if !valid_username(username) { bail!("not a username: {username:?}"); }
    let owner: Option<String> = conn
        .query_row("SELECT platform FROM players WHERE id = ?", duckdb::params![owner_id], |r| r.get(0))
        .map_err(|_| anyhow!("player {owner_id} not found"))?;
    if owner.is_some() { bail!("the account must belong to a real player, not a handle"); }
    let taken: Option<i64> = conn
        .query_row("SELECT id FROM accounts WHERE platform = ? AND lower(username) = lower(?)",
            duckdb::params![platform.key(), username], |r| r.get(0))
        .ok();
    if let Some(id) = taken { bail!("{} on {} is linked already (account {id})", username, platform.name()); }

    let norm = normalized(username);
    let player_id: i64 = match conn
        .query_row("SELECT id FROM players WHERE platform = ? AND name_normalized = ?",
            duckdb::params![platform.key(), norm], |r| r.get::<_, i64>(0))
    {
        Ok(id) => id,
        Err(_) => {
            let id = crate::db::ids::next_id(conn, "players")?;
            conn.execute(
                "INSERT INTO players (id, name, name_normalized, fide_id, game_count, name_normalised, platform)
                 VALUES (?, ?, ?, NULL, 0, TRUE, ?)",
                duckdb::params![id, username, norm, platform.key()],
            )?;
            crate::db::ids::raise_high_water(conn, "players", id)?;
            id as i64
        }
    };
    let id: i64 = conn.query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM accounts", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO accounts (id, platform, username, player_id, owner_id, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, TRUE, CAST(NOW() AS TIMESTAMP))",
        duckdb::params![id, platform.key(), username, player_id, owner_id],
    )?;
    get(conn, id)
}

/// Unlink an account. Its games and the handle's player row stay.
pub fn remove(conn: &Connection, id: i64) -> Result<()> {
    let n = conn.execute("DELETE FROM accounts WHERE id = ?", duckdb::params![id])?;
    if n == 0 { bail!("account {id} not found"); }
    Ok(())
}

pub fn set_enabled(conn: &Connection, id: i64, on: bool) -> Result<()> {
    let n = conn.execute("UPDATE accounts SET enabled = ? WHERE id = ?", duckdb::params![on, id])?;
    if n == 0 { bail!("account {id} not found"); }
    Ok(())
}

fn record_sync(conn: &Connection, id: i64, status: &str, synced: bool) -> Result<()> {
    if synced {
        conn.execute("UPDATE accounts SET last_sync = CAST(NOW() AS TIMESTAMP), last_status = ? WHERE id = ?", duckdb::params![status, id])?;
    } else {
        conn.execute("UPDATE accounts SET last_status = ? WHERE id = ?", duckdb::params![status, id])?;
    }
    Ok(())
}

// ── The platforms ───────────────────────────────────────────────────────────

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(120))
        .build()?)
}

/// A user's games on Lichess as PGN, from `since` (ms since the epoch):
/// one request, streamed by Lichess at about twenty games a second.
pub async fn fetch_lichess(username: &str, since_ms: Option<i64>) -> Result<String> {
    let mut url = format!("https://lichess.org/api/games/user/{username}?moves=true&tags=true&clocks=false&evals=false&opening=false");
    if let Some(ms) = since_ms { url.push_str(&format!("&since={ms}")); }
    let resp = client()?.get(&url).header("Accept", "application/x-chess-pgn").send().await?;
    match resp.status().as_u16() {
        200 => Ok(resp.text().await?),
        404 => bail!("no such user on Lichess: {username}"),
        429 => bail!("Lichess asks to wait (rate limit); try again in a minute"),
        s => bail!("Lichess answered {s}"),
    }
}

/// A user's games on Chess.com as PGN: the monthly archives from `from`
/// (year, month) on — the current month's grows as games are played — one
/// request each, in turn.
pub async fn fetch_chesscom(username: &str, from: Option<(i32, u32)>) -> Result<String> {
    let client = client()?;
    let user = username.to_lowercase();
    let list = client.get(format!("https://api.chess.com/pub/player/{user}/games/archives")).send().await?;
    match list.status().as_u16() {
        200 => {}
        404 => bail!("no such user on Chess.com: {username}"),
        429 => bail!("Chess.com asks to wait (rate limit); try again in a minute"),
        s => bail!("Chess.com answered {s}"),
    }
    #[derive(Deserialize)]
    struct Archives { archives: Vec<String> }
    let archives: Archives = list.json().await.context("Chess.com's archive list")?;
    let mut out = String::new();
    for url in archives.archives {
        // ".../games/2026/10"
        let mut parts = url.rsplit('/');
        let month: u32 = parts.next().and_then(|m| m.parse().ok()).unwrap_or(0);
        let year: i32 = parts.next().and_then(|y| y.parse().ok()).unwrap_or(0);
        if let Some((fy, fm)) = from {
            if (year, month) < (fy, fm) { continue; }
        }
        let resp = client.get(format!("{url}/pgn")).send().await?;
        match resp.status().as_u16() {
            200 => { out.push_str(&resp.text().await?); out.push_str("\n\n"); }
            429 => bail!("Chess.com asks to wait (rate limit); try again in a minute"),
            s => bail!("Chess.com answered {s} for {url}"),
        }
    }
    Ok(out)
}

// ── The games ───────────────────────────────────────────────────────────────

/// A PGN text as its games, each from its "[Event" line.
pub fn split_games(pgn: &str) -> Vec<String> {
    let mut games: Vec<String> = Vec::new();
    for line in pgn.lines() {
        if line.starts_with("[Event ") || games.is_empty() {
            if line.trim().is_empty() && games.is_empty() { continue; }
            games.push(String::new());
        }
        let g = games.last_mut().expect("one game at least");
        g.push_str(line);
        g.push('\n');
    }
    games.into_iter().filter(|g| g.contains("[White ") && g.contains("[Black ")).collect()
}

fn tag<'a>(game: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("[{name} \"");
    game.lines().find_map(|l| l.strip_prefix(key.as_str())).and_then(|rest| rest.strip_suffix("\"]"))
}

/// The game's address on its platform — what tells it from every other game
/// held: Lichess puts it in Site; Chess.com in Link (Site says "Chess.com").
pub fn site_of(game: &str) -> Option<String> {
    let site = tag(game, "Site").unwrap_or("");
    if site.starts_with("http") { return Some(site.to_string()); }
    tag(game, "Link").filter(|l| l.starts_with("http")).map(str::to_string)
}

/// The game as it is imported: the Site tag carrying the game's address, so
/// `games.site` holds it (Chess.com's "Chess.com" is replaced by the Link).
pub fn normalise_game(game: &str) -> String {
    let Some(site) = site_of(game) else { return game.to_string() };
    let mut out = String::with_capacity(game.len() + 40);
    let mut had_site = false;
    for line in game.lines() {
        if line.starts_with("[Site \"") {
            out.push_str(&format!("[Site \"{site}\"]\n"));
            had_site = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !had_site { out = format!("[Site \"{site}\"]\n{out}"); }
    out
}

/// Of these addresses, the ones a game in the database has already.
fn known_sites(conn: &Connection, sites: &[String]) -> Result<HashSet<String>> {
    let mut known = HashSet::new();
    for chunk in sites.chunks(500) {
        let list = chunk.iter().map(|s| format!("'{}'", s.replace('\'', "''"))).collect::<Vec<_>>().join(",");
        let mut st = conn.prepare(&format!("SELECT site FROM games WHERE site IN ({list})"))?;
        for s in st.query_map([], |r| r.get::<_, String>(0))? { known.insert(s?); }
    }
    Ok(known)
}

/// What a sync did.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SyncOutcome {
    /// Games the platform gave.
    pub fetched: usize,
    /// Of them, new to the database (imported).
    pub new: usize,
}

/// "2026-10-13 09:36:55.2" → ms since the epoch.
fn timestamp_ms(s: &str) -> Option<i64> {
    let s = s.split('.').next()?;
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok().map(|t| t.and_utc().timestamp_millis())
}

/// Sync one account: fetch from a day (a month) before the last sync, drop
/// the games held, import the rest into the collection, private, as the
/// platform's games; the outcome kept on the account.
pub fn sync_account(conn: &Connection, rt: &tokio::runtime::Handle, account: &Account, dir: &Path, reporter: &Reporter) -> Result<SyncOutcome> {
    let label = format!("{} on {}", account.username, account.platform.name());
    reporter.log(format!("{label}: fetching…"));
    let last = account.last_sync.as_deref().and_then(timestamp_ms);
    let fetched = match account.platform {
        Platform::Lichess => rt.block_on(fetch_lichess(&account.username, last.map(|ms| ms - 86_400_000))),
        Platform::Chesscom => {
            let from = last.and_then(|ms| chrono::DateTime::from_timestamp_millis(ms - 86_400_000)).map(|t| {
                use chrono::Datelike;
                (t.year(), t.month())
            });
            rt.block_on(fetch_chesscom(&account.username, from))
        }
    };
    let text = match fetched {
        Ok(t) => t,
        Err(e) => {
            record_sync(conn, account.id, &format!("failed: {e:#}"), false)?;
            return Err(e);
        }
    };
    let games = split_games(&text);
    let sites: Vec<String> = games.iter().filter_map(|g| site_of(g)).collect();
    let known = known_sites(conn, &sites)?;
    let fresh: Vec<String> = games.iter()
        .filter(|g| site_of(g).map(|s| !known.contains(&s)).unwrap_or(true))
        .map(|g| normalise_game(g))
        .collect();
    let outcome = SyncOutcome { fetched: games.len(), new: fresh.len() };
    if fresh.is_empty() {
        record_sync(conn, account.id, &format!("ok: {} games, nothing new", games.len()), true)?;
        reporter.log(format!("{label}: {} games, nothing new", games.len()));
        return Ok(outcome);
    }
    // Through the importer, from a file of its own: it indexes the positions
    // (the repertoire's matching reads them) and dedups against what is held.
    std::fs::create_dir_all(dir)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let path = dir.join(format!("account-{}-{stamp}.pgn", account.id));
    std::fs::write(&path, fresh.join("\n"))?;
    let spec = crate::importer::ImportSpec {
        collection: COLLECTION.to_string(),
        visibility: "private".to_string(),
        on_duplicate: "skip".to_string(),
        platform: Some(account.platform.key().to_string()),
    };
    let res = crate::importer::import_pgn(conn, &path, Some(40), 1000, false, false, &spec, &reporter.sub_step());
    let _ = std::fs::remove_file(&path);
    match res {
        Ok(()) => {
            record_sync(conn, account.id, &format!("ok: {} new of {}", fresh.len(), games.len()), true)?;
            reporter.log(format!("{label}: {} new game(s) of {}", fresh.len(), games.len()));
            Ok(outcome)
        }
        Err(e) => {
            record_sync(conn, account.id, &format!("failed: {e:#}"), false)?;
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LICHESS: &str = "[Event \"Rated Blitz game\"]\n[Site \"https://lichess.org/abc12345\"]\n[Date \"2026.10.12\"]\n[White \"jozef77\"]\n[Black \"someone\"]\n[Result \"1-0\"]\n[UTCDate \"2026.10.12\"]\n[WhiteElo \"2100\"]\n[BlackElo \"2050\"]\n[TimeControl \"180+2\"]\n\n1. d4 Nf6 2. Nc3 d5 3. Bg5 1-0\n";
    const CHESSCOM: &str = "[Event \"Live Chess\"]\n[Site \"Chess.com\"]\n[Date \"2026.10.12\"]\n[White \"someone\"]\n[Black \"jozef77\"]\n[Result \"0-1\"]\n[TimeControl \"60\"]\n[Link \"https://www.chess.com/game/live/1234\"]\n\n1. e4 c5 0-1\n";

    #[test]
    fn games_are_split_and_addressed() {
        let games = split_games(&format!("{LICHESS}\n\n{CHESSCOM}"));
        assert_eq!(games.len(), 2);
        assert_eq!(site_of(&games[0]).as_deref(), Some("https://lichess.org/abc12345"));
        assert_eq!(site_of(&games[1]).as_deref(), Some("https://www.chess.com/game/live/1234"), "Chess.com's address is in Link");
        let n = normalise_game(&games[1]);
        assert!(n.contains("[Site \"https://www.chess.com/game/live/1234\"]"), "{n}");
        assert!(!n.contains("[Site \"Chess.com\"]"));
        assert_eq!(normalise_game(&games[0]), games[0], "Lichess's is left as it is");
    }

    #[test]
    fn scopes_parse() {
        assert_eq!(Scope::parse(None).unwrap(), Scope::All);
        assert_eq!(Scope::parse(Some("otb")).unwrap(), Scope::Otb);
        assert_eq!(Scope::parse(Some("Online")).unwrap(), Scope::Online);
        assert!(Scope::parse(Some("mine")).is_err());
    }

    #[test]
    fn an_account_links_a_handle_to_a_player() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        conn.execute_batch("INSERT INTO players (id, name, name_normalized) VALUES (1, 'Svrcek, Jozef', 'svrcek jozef');").unwrap();
        let a = add(&conn, Platform::Lichess, "jozef77", 1).unwrap();
        assert_eq!((a.platform, a.username.as_str(), a.owner_id, a.enabled), (Platform::Lichess, "jozef77", 1, true));
        let handle: (String, Option<String>) = conn.query_row("SELECT name, platform FROM players WHERE id = ?", duckdb::params![a.player_id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(handle, ("jozef77".into(), Some("lichess".into())), "a virtual player of its own");
        assert_eq!(identity_ids(&conn, 1).unwrap(), vec![1, a.player_id]);
        assert!(add(&conn, Platform::Lichess, "Jozef77", 1).is_err(), "linked already");
        assert!(add(&conn, Platform::Chesscom, "jozef77", a.player_id).is_err(), "a handle owns nothing");
        let b = add(&conn, Platform::Chesscom, "jozef77", 1).unwrap();
        assert_ne!(b.player_id, a.player_id, "the same handle on another platform is another player");
        assert_eq!(list(&conn).unwrap().len(), 2);
        remove(&conn, a.id).unwrap();
        assert_eq!(identity_ids(&conn, 1).unwrap(), vec![1, b.player_id]);
        assert!(add(&conn, Platform::Lichess, "no spaces here", 1).is_err());
    }

    /// The real platforms: run by hand — `cargo test accounts -- --ignored`.
    #[test]
    #[ignore]
    fn the_platforms_answer() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let li = rt.block_on(fetch_lichess("DrNykterstein", Some(1_700_000_000_000))).unwrap();
        assert!(li.contains("[Event "), "{}", &li[..li.len().min(200)]);
        let cc = rt.block_on(fetch_chesscom("hikaru", Some((2026, 1)))).unwrap();
        assert!(cc.contains("[Link "), "{}", &cc[..cc.len().min(200)]);
    }
}
