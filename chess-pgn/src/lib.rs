//! Lightweight, DuckDB-free PGN indexing + browsing engine (#104).
//!
//! [`PgnIndex::open`] takes a PGN file and [`PgnIndex::index`] streams it once,
//! recording per game its **byte offset** plus the tag-roster headers (White,
//! Black, Result, Date, Event, Elos). [`PgnIndex::query`] filters/paginates that
//! index and [`PgnIndex::game_pgn`] reads a single game's raw text back by offset
//! — so a multi-GB, millions-of-games file is browsable with bounded memory and
//! no whole-file-in-RAM parse.
//!
//! The index is built **incrementally under an `RwLock`**: a background thread
//! calls [`PgnIndex::index`] to append games in batches while readers call
//! [`PgnIndex::query`]/[`PgnIndex::game_pgn`] concurrently (#104 "growing index").
//! So the client can open a huge file instantly and watch the game list and
//! search results fill in live; [`QueryResult::complete`] reports when indexing
//! has finished. Synchronous callers (CLI/tests) use [`PgnIndex::index_blocking`].
//!
//! Parsing rides on the same [`pgn_reader`] crate the chess-db importer uses, so
//! game boundaries and tag decoding match an import (a `[Event …]` inside a
//! comment does *not* start a new game — unlike a naive regex splitter).
//!
//! Scope is deliberately narrow: **header-based browse/search only**. Position
//! search, dedup and player normalisation stay in the database (import for that).

use std::cell::Cell;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use pgn_reader::{RawTag, Reader, Visitor};
use serde::{Deserialize, Serialize};

/// Games appended to the index per lock acquisition while building. Big enough
/// that the write lock is taken only a few hundred times over millions of games
/// (low contention with readers), small enough that the first games appear ~fast.
pub const DEFAULT_BATCH: usize = 16_384;

/// Which side a name filter applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Color {
    /// Match the name against either side.
    #[default]
    Any,
    White,
    Black,
}

/// A browse query over an index. Mirrors the local viewer's filters (player 1/2
/// with an optional side, event substring, year range). All fields default to
/// "no constraint"; `limit == 0` means "no page limit" (return every match).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Query {
    pub player1: Option<String>,
    pub player1_color: Color,
    pub player2: Option<String>,
    pub player2_color: Color,
    pub event: Option<String>,
    /// Inclusive lower bound on the game's year (e.g. "2015"), compared lexically.
    pub date_from: Option<String>,
    /// Inclusive upper bound on the game's year.
    pub date_to: Option<String>,
    /// How many matches to skip before the returned page.
    pub offset: usize,
    /// Page size; `0` = unlimited.
    pub limit: usize,
}

/// One row in a query result — the shape the game-list UI needs. `id` is the
/// game's index in file order and is what [`PgnIndex::game_pgn`] takes.
#[derive(Debug, Clone, Serialize)]
pub struct GameRow {
    pub id: u32,
    pub white: String,
    pub black: String,
    pub white_elo: Option<u16>,
    pub black_elo: Option<u16>,
    pub event: Option<String>,
    pub date: Option<String>,
    pub result: Option<String>,
}

/// The outcome of a [`Query`]: the page of rows, counts for the header
/// ("`matched` / `total` games"), and whether indexing has finished (`complete`)
/// — while it's `false`, `total`/`rows` grow as the background pass proceeds.
#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    /// Games indexed so far (before filtering). Grows until `complete`.
    pub total: usize,
    /// Games matching the filters among those indexed so far.
    pub matched: usize,
    /// The requested page of matching rows.
    pub rows: Vec<GameRow>,
    /// True once the whole file has been indexed.
    pub complete: bool,
}

/// Deduplicating string pool: header values (player names, events, dates) repeat
/// heavily across games, so we store a `u32` id per field instead of an owned
/// `String`. A lowercased copy is kept alongside for allocation-free
/// case-insensitive filtering. Id `0` is the empty string ("absent").
struct Interner {
    map: HashMap<String, u32>,
    values: Vec<String>,
    lowered: Vec<String>,
}

impl Interner {
    fn new() -> Self {
        let mut it = Interner { map: HashMap::new(), values: Vec::new(), lowered: Vec::new() };
        it.intern(""); // id 0 == absent
        it
    }

    fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.map.get(s) {
            return id;
        }
        let id = self.values.len() as u32;
        self.values.push(s.to_string());
        self.lowered.push(s.to_lowercase());
        self.map.insert(s.to_string(), id);
        id
    }

    fn value(&self, id: u32) -> &str {
        &self.values[id as usize]
    }

    fn lowered(&self, id: u32) -> &str {
        &self.lowered[id as usize]
    }
}

/// One game's index entry — 36 bytes, no heap. Everything display-relevant is an
/// interner id (`0` = absent); Elos are `u16` (`0` = absent); `offset` is the
/// byte position of the game's first tag in the file.
struct Entry {
    offset: u64,
    white: u32,
    black: u32,
    event: u32,
    date: u32,
    result: u32,
    white_elo: u16,
    black_elo: u16,
}

/// The growing index data (guarded by a lock inside [`PgnIndex`]). Holds the
/// query logic; knows nothing about the file (offsets are resolved against
/// `file_len` by the owner).
struct IndexData {
    interner: Interner,
    games: Vec<Entry>,
}

impl IndexData {
    fn new() -> Self {
        IndexData { interner: Interner::new(), games: Vec::new() }
    }

    /// Append one parsed game.
    fn push(&mut self, offset: u64, h: Headers) {
        let white = self.interner.intern(clean(h.white).as_deref().unwrap_or("?"));
        let black = self.interner.intern(clean(h.black).as_deref().unwrap_or("?"));
        let event = self.intern_opt(clean(h.event));
        let date = self.intern_opt(clean(h.date));
        let result = self.intern_opt(clean(h.result));
        self.games.push(Entry {
            offset,
            white,
            black,
            event,
            date,
            result,
            white_elo: h.white_elo.unwrap_or(0),
            black_elo: h.black_elo.unwrap_or(0),
        });
    }

    fn intern_opt(&mut self, v: Option<String>) -> u32 {
        match v {
            Some(s) => self.interner.intern(&s),
            None => 0,
        }
    }

    /// Filter + paginate the games indexed so far.
    fn query(&self, q: &Query) -> QueryResult {
        let p1 = q.player1.as_deref().filter(|s| !s.is_empty()).map(str::to_lowercase);
        let p2 = q.player2.as_deref().filter(|s| !s.is_empty()).map(str::to_lowercase);
        let ev = q.event.as_deref().filter(|s| !s.is_empty()).map(str::to_lowercase);
        let from = q.date_from.as_deref().filter(|s| !s.is_empty());
        let to = q.date_to.as_deref().filter(|s| !s.is_empty());

        let mut matched = 0usize;
        let mut rows = Vec::new();
        for (i, e) in self.games.iter().enumerate() {
            if let Some(ref n) = p1 {
                if !self.name_matches(e, n, q.player1_color) {
                    continue;
                }
            }
            if let Some(ref n) = p2 {
                if !self.name_matches(e, n, q.player2_color) {
                    continue;
                }
            }
            if let Some(ref n) = ev {
                if !self.interner.lowered(e.event).contains(n.as_str()) {
                    continue;
                }
            }
            if (from.is_some() || to.is_some()) && !date_in_range(self.interner.value(e.date), from, to) {
                continue;
            }

            if matched >= q.offset && (q.limit == 0 || rows.len() < q.limit) {
                rows.push(self.row(i as u32, e));
            }
            matched += 1;
        }

        QueryResult { total: self.games.len(), matched, rows, complete: false }
    }

    fn name_matches(&self, e: &Entry, needle_lower: &str, color: Color) -> bool {
        let w = || self.interner.lowered(e.white).contains(needle_lower);
        let b = || self.interner.lowered(e.black).contains(needle_lower);
        match color {
            Color::White => w(),
            Color::Black => b(),
            Color::Any => w() || b(),
        }
    }

    fn row(&self, id: u32, e: &Entry) -> GameRow {
        GameRow {
            id,
            white: self.interner.value(e.white).to_string(),
            black: self.interner.value(e.black).to_string(),
            white_elo: (e.white_elo != 0).then_some(e.white_elo),
            black_elo: (e.black_elo != 0).then_some(e.black_elo),
            event: non_empty(self.interner.value(e.event)),
            date: non_empty(self.interner.value(e.date)),
            result: non_empty(self.interner.value(e.result)),
        }
    }
}

/// A PGN file opened for browsing. The header index grows incrementally under an
/// `RwLock`, so queries can run while a background thread is still indexing.
pub struct PgnIndex {
    path: PathBuf,
    file_len: u64,
    data: RwLock<IndexData>,
    cancel: AtomicBool,
    complete: AtomicBool,
}

impl PgnIndex {
    /// Open a file for indexing (reads only its length). The returned handle is
    /// empty until [`index`](Self::index) / [`index_blocking`](Self::index_blocking)
    /// populate it. Shared via `Arc` so a background thread can index while
    /// readers query.
    pub fn open(path: &Path) -> io::Result<Arc<Self>> {
        let file_len = std::fs::metadata(path)?.len();
        Ok(Arc::new(PgnIndex {
            path: path.to_path_buf(),
            file_len,
            data: RwLock::new(IndexData::new()),
            cancel: AtomicBool::new(false),
            complete: AtomicBool::new(false),
        }))
    }

    /// Stream the file, appending games to the index `batch` at a time under the
    /// write lock (parsing happens unlocked; only the short append is locked).
    /// Stops early if [`cancel`](Self::cancel) was called; sets the complete flag
    /// on reaching EOF. Run this on a background thread while others query.
    pub fn index(&self, batch: usize) -> io::Result<()> {
        let file = File::open(&self.path)?;
        let count = Rc::new(Cell::new(0u64));
        let mut reader = Reader::new(CountingReader { inner: file, count: count.clone() });
        let mut visitor = HeaderVisitor;
        let mut pending: Vec<(u64, Headers)> = Vec::with_capacity(batch);

        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(()); // closed mid-index — abandon without marking complete
            }
            match next_game(&mut reader, &count, &mut visitor)? {
                Some(item) => {
                    pending.push(item);
                    if pending.len() >= batch {
                        self.flush(&mut pending);
                    }
                }
                None => break,
            }
        }
        self.flush(&mut pending);
        self.complete.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Index the whole file to completion in one go (CLI / tests).
    pub fn index_blocking(&self) -> io::Result<()> {
        self.index(DEFAULT_BATCH)
    }

    fn flush(&self, pending: &mut Vec<(u64, Headers)>) {
        if pending.is_empty() {
            return;
        }
        let mut data = self.data.write().unwrap();
        for (offset, h) in pending.drain(..) {
            data.push(offset, h);
        }
    }

    /// Games indexed so far.
    pub fn len(&self) -> usize {
        self.data.read().unwrap().games.len()
    }

    /// Whether the file held no games *and* indexing has finished.
    pub fn is_empty(&self) -> bool {
        self.is_complete() && self.len() == 0
    }

    /// Whether the whole file has been indexed.
    pub fn is_complete(&self) -> bool {
        self.complete.load(Ordering::Relaxed)
    }

    /// Ask a running [`index`](Self::index) to stop at the next game boundary.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Filter + paginate. Stamps the current `complete` flag onto the result so
    /// the caller knows whether more games are still arriving.
    pub fn query(&self, q: &Query) -> QueryResult {
        let mut result = self.data.read().unwrap().query(q);
        result.complete = self.is_complete();
        result
    }

    /// Read one game's raw PGN text back from the file by its `id` (index in file
    /// order). The slice runs to the next game's offset (or EOF), so it includes
    /// the game's tags and movetext; trailing separator whitespace is trimmed.
    pub fn game_pgn(&self, id: u32) -> io::Result<String> {
        let (start, end) = {
            let data = self.data.read().unwrap();
            let i = id as usize;
            let start = data
                .games
                .get(i)
                .map(|e| e.offset)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "game id out of range"))?;
            let end = data.games.get(i + 1).map(|n| n.offset).unwrap_or(self.file_len);
            (start, end)
        };
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(start))?;
        let mut buf = vec![0u8; end.saturating_sub(start) as usize];
        file.read_exact(&mut buf)?;
        Ok(String::from_utf8_lossy(&buf).trim().to_string())
    }
}

/// Pull the next game from the reader: its byte offset (via the counting reader:
/// bytes read − still-buffered) plus its parsed headers. Returns `None` at EOF.
fn next_game<R: Read>(
    reader: &mut Reader<R>,
    count: &Cell<u64>,
    visitor: &mut HeaderVisitor,
) -> io::Result<Option<(u64, Headers)>> {
    // has_more() flushes the previous game's (skipped) movetext + inter-game
    // whitespace, leaving the position at the next game's first byte.
    if !reader.has_more()? {
        return Ok(None);
    }
    let offset = count.get() - reader.buffer().len() as u64;
    Ok(reader.read_game(visitor)?.map(|h| (offset, h)))
}

/// A `Read` wrapper that counts every byte handed upstream, into a shared cell we
/// can read while pgn-reader owns the reader (used for offset tracking).
struct CountingReader<R> {
    inner: R,
    count: Rc<Cell<u64>>,
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count.set(self.count.get() + n as u64);
        Ok(n)
    }
}

/// The parsed tag roster for one game. Owned by the visitor; movetext is skipped.
#[derive(Default)]
struct Headers {
    white: Option<String>,
    black: Option<String>,
    event: Option<String>,
    date: Option<String>,
    result: Option<String>,
    white_elo: Option<u16>,
    black_elo: Option<u16>,
}

/// Tag-only visitor: captures the roster, then breaks at `begin_movetext` so
/// pgn-reader fast-skips the moves instead of parsing them.
struct HeaderVisitor;

impl Visitor for HeaderVisitor {
    type Tags = Headers;
    type Movetext = ();
    type Output = Headers;

    fn begin_tags(&mut self) -> ControlFlow<Self::Output, Self::Tags> {
        ControlFlow::Continue(Headers::default())
    }

    fn tag(&mut self, tags: &mut Self::Tags, name: &[u8], value: RawTag<'_>) -> ControlFlow<Self::Output> {
        // decode_utf8 unescapes PGN string tokens (\\ and \") exactly as the
        // importer does, so values match an import.
        let v = match value.decode_utf8() {
            Ok(s) => s.trim().to_string(),
            Err(_) => return ControlFlow::Continue(()),
        };
        match name {
            b"White" => tags.white = Some(v),
            b"Black" => tags.black = Some(v),
            b"Event" => tags.event = Some(v),
            b"Date" => tags.date = Some(v),
            b"Result" => tags.result = Some(v),
            b"WhiteElo" => tags.white_elo = v.parse().ok().filter(|&e| e > 0),
            b"BlackElo" => tags.black_elo = v.parse().ok().filter(|&e| e > 0),
            _ => {}
        }
        ControlFlow::Continue(())
    }

    fn begin_movetext(&mut self, tags: Self::Tags) -> ControlFlow<Self::Output, Self::Movetext> {
        // The roster IS the output; skip the moves.
        ControlFlow::Break(tags)
    }

    fn end_game(&mut self, _movetext: Self::Movetext) -> Self::Output {
        // Unreachable — begin_movetext always breaks — but the trait requires it.
        Headers::default()
    }
}

/// Empty / "?" tag values mean "absent" (matching the local viewer's `getTag`).
fn clean(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.is_empty() && s != "?")
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

/// Year-range test mirroring the local viewer: a dateless game fails whenever a
/// bound is set; otherwise compare the leading year lexically.
fn date_in_range(date: &str, from: Option<&str>, to: Option<&str>) -> bool {
    if date.is_empty() {
        return from.is_none() && to.is_none();
    }
    let year = &date[..date.len().min(4)];
    if let Some(f) = from {
        if year < f {
            return false;
        }
    }
    if let Some(t) = to {
        if year > t {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Write `content` to a uniquely-named temp file and return its path.
    fn temp_pgn(tag: &str, content: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("chess-pgn-test-{tag}.pgn"));
        let mut f = File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    /// Open + index a file to completion (the synchronous path used in tests).
    fn build(path: &Path) -> Arc<PgnIndex> {
        let idx = PgnIndex::open(path).unwrap();
        idx.index_blocking().unwrap();
        idx
    }

    const SAMPLE: &str = r#"[Event "Wch London"]
[Site "London"]
[Date "2018.11.09"]
[Round "1"]
[White "Carlsen, Magnus"]
[Black "Caruana, Fabiano"]
[Result "1/2-1/2"]
[WhiteElo "2835"]
[BlackElo "2832"]

1. e4 c5 2. Nf3 1/2-1/2

[Event "Tata Steel"]
[Site "Wijk aan Zee"]
[Date "2013.01.12"]
[Round "1"]
[White "Aronian, Levon"]
[Black "Carlsen, Magnus"]
[Result "0-1"]
[WhiteElo "2802"]
[BlackElo "2861"]

1. d4 Nf6 2. c4 e6 0-1

[Event "Casual"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 { this comment mentions [Event "Fake"] which must NOT split the game } e5 *
"#;

    #[test]
    fn indexes_all_games_and_ignores_event_in_comments() {
        let path = temp_pgn("count", SAMPLE);
        let idx = build(&path);
        // Three real games — the bracketed text inside the comment is NOT a 4th.
        assert_eq!(idx.len(), 3);
        assert!(idx.is_complete());
    }

    #[test]
    fn reads_headers() {
        let path = temp_pgn("headers", SAMPLE);
        let idx = build(&path);
        let all = idx.query(&Query::default());
        assert_eq!(all.matched, 3);
        assert!(all.complete);
        let g0 = &all.rows[0];
        assert_eq!(g0.white, "Carlsen, Magnus");
        assert_eq!(g0.black, "Caruana, Fabiano");
        assert_eq!(g0.result.as_deref(), Some("1/2-1/2"));
        assert_eq!(g0.white_elo, Some(2835));
        assert_eq!(g0.date.as_deref(), Some("2018.11.09"));
        // "?" names read back as absent (→ "?"); "*" is a real (unknown) result,
        // kept like the local viewer does; a missing Elo is None.
        let g2 = &all.rows[2];
        assert_eq!(g2.white, "?");
        assert_eq!(g2.result.as_deref(), Some("*"));
        assert_eq!(g2.white_elo, None);
    }

    #[test]
    fn filters_by_player_and_color() {
        let path = temp_pgn("player", SAMPLE);
        let idx = build(&path);

        // Carlsen appears in both real games (as White, then as Black).
        let any = idx.query(&Query { player1: Some("carlsen".into()), ..Default::default() });
        assert_eq!(any.matched, 2);

        // ...but only as Black in one of them.
        let as_black = idx.query(&Query {
            player1: Some("carlsen".into()),
            player1_color: Color::Black,
            ..Default::default()
        });
        assert_eq!(as_black.matched, 1);
        assert_eq!(as_black.rows[0].white, "Aronian, Levon");
    }

    #[test]
    fn filters_by_two_players_event_and_year() {
        let path = temp_pgn("combo", SAMPLE);
        let idx = build(&path);

        let both = idx.query(&Query {
            player1: Some("carlsen".into()),
            player2: Some("caruana".into()),
            ..Default::default()
        });
        assert_eq!(both.matched, 1);

        let event = idx.query(&Query { event: Some("tata".into()), ..Default::default() });
        assert_eq!(event.matched, 1);

        let year = idx.query(&Query {
            date_from: Some("2015".into()),
            date_to: Some("2020".into()),
            ..Default::default()
        });
        // Only the 2018 game falls in [2015, 2020]; the 2013 and dateless ones don't.
        assert_eq!(year.matched, 1);
        assert_eq!(year.rows[0].date.as_deref(), Some("2018.11.09"));
    }

    #[test]
    fn paginates() {
        let path = temp_pgn("page", SAMPLE);
        let idx = build(&path);
        let page = idx.query(&Query { offset: 1, limit: 1, ..Default::default() });
        assert_eq!(page.total, 3);
        assert_eq!(page.matched, 3);
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0].white, "Aronian, Levon");
    }

    #[test]
    fn fetches_exact_game_text_by_offset() {
        let path = temp_pgn("fetch", SAMPLE);
        let idx = build(&path);

        let g1 = idx.game_pgn(1).unwrap();
        // The right game, whole and self-contained (Aronian vs Carlsen)...
        assert!(g1.contains("[White \"Aronian, Levon\"]"));
        assert!(g1.contains("[Black \"Carlsen, Magnus\"]"));
        assert!(g1.contains("1. d4 Nf6 2. c4 e6 0-1"));
        // ...and none of its neighbours (game 0's Caruana, game 2's Casual).
        assert!(!g1.contains("Caruana"));
        assert!(!g1.contains("Casual"));

        // The last game slices cleanly to EOF, comment intact.
        let g2 = idx.game_pgn(2).unwrap();
        assert!(g2.contains("[Event \"Casual\"]"));
        assert!(g2.contains("[Event \"Fake\"]")); // the comment text survives in the raw game
    }

    #[test]
    fn open_starts_empty_and_incomplete() {
        let path = temp_pgn("empty-open", SAMPLE);
        let idx = PgnIndex::open(&path).unwrap();
        assert_eq!(idx.len(), 0);
        assert!(!idx.is_complete());
        assert!(!idx.query(&Query::default()).complete);
        idx.index_blocking().unwrap();
        assert!(idx.is_complete());
        assert_eq!(idx.len(), 3);
    }

    #[test]
    fn queries_run_concurrently_while_indexing() {
        // A file big enough that indexing isn't instantaneous, so the reader and
        // the background writer genuinely overlap under the RwLock.
        let mut content = String::with_capacity(4_000_000);
        for i in 0..40_000 {
            content.push_str(&format!(
                "[White \"P{}\"]\n[Black \"Q\"]\n[Result \"1-0\"]\n\n1. e4 e5 1-0\n\n",
                i % 50
            ));
        }
        let path = temp_pgn("concurrent", &content);
        let idx = PgnIndex::open(&path).unwrap();

        let writer = idx.clone();
        let handle = std::thread::spawn(move || writer.index(256).unwrap());

        // Poll while indexing: the running total must never go backwards. A small
        // gap between polls mirrors the client's real cadence (~500 ms) and leaves
        // the writer room — a *tight* reader loop would starve it, since glibc's
        // RwLock favours readers (why the app polls rather than busy-loops).
        let mut last = 0usize;
        let mut saw_partial = false;
        loop {
            let r = idx.query(&Query { limit: 1, ..Default::default() });
            assert!(r.total >= last, "total went backwards: {} < {last}", r.total);
            if r.total > 0 && !r.complete {
                saw_partial = true;
            }
            last = r.total;
            if r.complete {
                break;
            }
            std::thread::sleep(std::time::Duration::from_micros(200));
        }
        handle.join().unwrap();
        assert!(saw_partial, "expected to observe the index mid-growth");

        let done = idx.query(&Query { player1: Some("P7".into()), player1_color: Color::White, limit: 0, ..Default::default() });
        assert_eq!(done.total, 40_000);
        assert!(done.complete);
        // P7 is White in every 50th game → 800 of 40k.
        assert_eq!(done.matched, 800);
    }

    #[test]
    fn cancel_stops_indexing_without_marking_complete() {
        let path = temp_pgn("cancel", SAMPLE);
        let idx = PgnIndex::open(&path).unwrap();
        idx.cancel();
        idx.index_blocking().unwrap();
        // Cancelled before any batch flushed: nothing indexed, not complete.
        assert!(!idx.is_complete());
        assert_eq!(idx.len(), 0);
    }
}
