//! Opening repertoire (#327): books of chapters, each chapter one move tree
//! (a PGN game with variations, comments and marks), studied in the Analysis
//! page and edited with the game editor. See docs/design/opening-repertoire.md.
//!
//! Kept apart from the games — tables of their own — so the games lists,
//! statistics and duplicate detection never see them. Every position of every
//! variation is indexed in `repertoire_positions`, with whether it is active:
//! the chapter switched on, and no move switched off above it (a `[%rep off]`
//! tag in a move's comment means "not in my repertoire from here").

use std::io::Cursor;
use std::ops::ControlFlow;

use anyhow::{anyhow, bail, Context, Result};
use duckdb::Connection;
use pgn_reader::{Nag, Outcome, RawComment, RawTag, Reader, SanPlus, Skip, Visitor};
use serde::Serialize;
use shakmaty::fen::Fen;
use shakmaty::san::SanPlus as ShakmatySanPlus;
use shakmaty::zobrist::Zobrist64;
use shakmaty::{Chess, Color, EnPassantMode, Position};

/// The tag in a move's comment that switches the move — and everything below
/// it — out of the active repertoire.
pub const OFF_TAG: &str = "[%rep off]";

#[derive(Clone, Debug, Serialize)]
pub struct Book {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub ord: i64,
    /// Off: the whole book is out of the active repertoire, whatever its
    /// chapters' own switches say.
    pub active: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChapterSummary {
    pub id: i64,
    pub book_id: i64,
    pub ord: i64,
    pub name: String,
    pub active: bool,
    pub lines: i64,
    pub lines_off: i64,
    pub updated_at: Option<String>,
    /// When the chapter was last analysed for practice, and whether its
    /// positions changed since — moves added or removed; not a comment.
    pub analysed_at: Option<String>,
    pub analysis_stale: Option<bool>,
    /// A model game: a complete annotated game kept with the book to show
    /// its ideas — not part of the repertoire (its positions never indexed),
    /// its own headers kept.
    pub model: bool,
    /// The game's result: `*`, `1-0`, `0-1` or `1/2-1/2` (`*` for a chapter).
    pub result: String,
    /// A model game with comments of its own — arrows, marks or text; not
    /// the clock times and evaluations a broadcast leaves. Without, it is a
    /// reference game: listed apart.
    pub annotated: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct BookWithChapters {
    #[serde(flatten)]
    pub book: Book,
    pub chapters: Vec<ChapterSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChapterDetail {
    #[serde(flatten)]
    pub summary: ChapterSummary,
    pub pgn: String,
    pub book: Book,
}

#[derive(Default)]
pub struct BookPatch {
    pub name: Option<String>,
    pub color: Option<String>,
    pub author: Option<Option<String>>,
    pub description: Option<Option<String>>,
    pub url: Option<Option<String>>,
    pub ord: Option<i64>,
    pub active: Option<bool>,
}

#[derive(Default)]
pub struct ChapterPatch {
    pub name: Option<String>,
    pub ord: Option<i64>,
    pub active: Option<bool>,
    pub book_id: Option<i64>,
    /// Make it a model game, or a chapter again.
    pub model: Option<bool>,
    /// A model game's result.
    pub result: Option<String>,
}

/// A game's possible results, as PGN writes them.
pub const RESULTS: [&str; 4] = ["*", "1-0", "0-1", "1/2-1/2"];

fn valid_color(c: &str) -> Result<&str> {
    match c {
        "white" | "black" => Ok(c),
        _ => bail!("colour is white or black"),
    }
}

// ── Walking a chapter ────────────────────────────────────────────────────────

/// One position of a chapter with the move played from it.
pub struct PositionRow {
    pub zobrist: i64,
    pub ply: i16,
    pub next_move: String,
    pub mover: &'static str,
    /// The position's key for the client ([`position_key`]), and the
    /// position after the move with its own — for the figures of a chapter's
    /// every position, the ends of its lines included.
    pub key: String,
    pub after_zobrist: i64,
    pub after_key: String,
    /// No move switched off on the way here (the chapter's own switch is
    /// applied on top).
    pub active: bool,
}

pub struct Walk {
    pub rows: Vec<PositionRow>,
    pub lines: i64,
    pub lines_off: i64,
}

/// One line being walked: the main line, or a variation.
struct Frame {
    pos: Chess,
    /// The position before the last move — where a variation of it starts.
    prev: Option<Chess>,
    ply: i16,
    off: bool,
    /// `off` as it was before the last move: what a variation of it inherits.
    prev_off: bool,
    moves: usize,
    /// The row of the last move, for a `[%rep off]` in its comment.
    last_row: Option<usize>,
}

struct Walker {
    frames: Vec<Frame>,
    rows: Vec<PositionRow>,
    lines: i64,
    lines_off: i64,
    error: Option<String>,
}

impl Walker {
    fn close_frame(&mut self) {
        if let Some(f) = self.frames.pop() {
            if f.moves > 0 {
                self.lines += 1;
                if f.off { self.lines_off += 1; }
            }
        }
    }
}

impl Visitor for Walker {
    type Tags = ();
    type Movetext = ();
    type Output = ();

    fn begin_tags(&mut self) -> ControlFlow<(), ()> { ControlFlow::Continue(()) }
    fn tag(&mut self, _t: &mut (), _name: &[u8], _value: RawTag<'_>) -> ControlFlow<()> { ControlFlow::Continue(()) }
    fn begin_movetext(&mut self, _t: ()) -> ControlFlow<(), ()> {
        self.frames.push(Frame { pos: Chess::default(), prev: None, ply: 0, off: false, prev_off: false, moves: 0, last_row: None });
        ControlFlow::Continue(())
    }

    fn san(&mut self, _m: &mut (), san_plus: SanPlus) -> ControlFlow<()> {
        let Some(f) = self.frames.last_mut() else { return ControlFlow::Continue(()) };
        let mv = match san_plus.san.to_move(&f.pos) {
            Ok(m) => m,
            Err(_) => {
                self.error = Some(format!("{} is not a legal move at move {}", san_plus, f.ply / 2 + 1));
                return ControlFlow::Break(());
            }
        };
        let before = f.pos.clone();
        let mover = if f.pos.turn() == Color::White { "white" } else { "black" };
        let canonical = ShakmatySanPlus::from_move_and_play_unchecked(&mut f.pos, mv).to_string();
        let zobrist = before.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;
        let after_zobrist = f.pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;
        self.rows.push(PositionRow {
            zobrist, ply: f.ply, next_move: canonical, mover, active: !f.off,
            key: position_key(&before), after_zobrist, after_key: position_key(&f.pos),
        });
        f.prev = Some(before);
        f.prev_off = f.off;
        f.ply += 1;
        f.moves += 1;
        f.last_row = Some(self.rows.len() - 1);
        ControlFlow::Continue(())
    }

    fn nag(&mut self, _m: &mut (), _nag: Nag) -> ControlFlow<()> { ControlFlow::Continue(()) }

    fn comment(&mut self, _m: &mut (), comment: RawComment<'_>) -> ControlFlow<()> {
        if !contains(comment.as_bytes(), OFF_TAG.as_bytes()) { return ControlFlow::Continue(()); }
        if let Some(f) = self.frames.last_mut() {
            if let Some(i) = f.last_row {
                self.rows[i].active = false;
                f.off = true;
            }
        }
        ControlFlow::Continue(())
    }

    fn begin_variation(&mut self, _m: &mut ()) -> ControlFlow<(), Skip> {
        let Some(parent) = self.frames.last() else { return ControlFlow::Continue(Skip(true)) };
        let Some(prev) = parent.prev.clone() else { return ControlFlow::Continue(Skip(true)) };
        let (ply, off) = (parent.ply - 1, parent.prev_off);
        self.frames.push(Frame { pos: prev, prev: None, ply, off, prev_off: off, moves: 0, last_row: None });
        ControlFlow::Continue(Skip(false))
    }

    fn end_variation(&mut self, _m: &mut ()) -> ControlFlow<()> {
        if self.frames.len() > 1 { self.close_frame(); }
        ControlFlow::Continue(())
    }

    fn outcome(&mut self, _m: &mut (), _o: Outcome) -> ControlFlow<()> { ControlFlow::Continue(()) }

    fn end_game(&mut self, _m: ()) {
        while !self.frames.is_empty() { self.close_frame(); }
    }
}

/// A position as the client names it: the FEN's board, side to move and
/// castling rights — no en passant square (chess.js and shakmaty set it under
/// different rules), no move counters.
pub fn position_key(pos: &Chess) -> String {
    let fen = Fen::from_position(pos, EnPassantMode::Legal).to_string();
    fen.split(' ').take(3).collect::<Vec<_>>().join(" ")
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Every position of a chapter's movetext with its move, and the line
/// counts. An illegal move is an error: a chapter is kept only when the
/// engine and the board can follow it.
pub fn walk(movetext: &str) -> Result<Walk> {
    let text = format!("[Event \"?\"]\n\n{}\n", movetext.trim());
    let mut w = Walker { frames: Vec::new(), rows: Vec::new(), lines: 0, lines_off: 0, error: None };
    let mut reader = Reader::new(Cursor::new(text.as_bytes()));
    reader.read_game(&mut w).context("reading the moves")?;
    if let Some(e) = w.error { bail!(e); }
    while !w.frames.is_empty() { w.close_frame(); }
    Ok(Walk { rows: w.rows, lines: w.lines, lines_off: w.lines_off })
}

// ── PGN text ─────────────────────────────────────────────────────────────────

/// The games of a PGN file, each as its own text: a game starts at a tag
/// line that follows movetext.
pub fn split_games(text: &str) -> Vec<String> {
    let mut games: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_moves = false;
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with('[') && t.ends_with(']') {
            if in_moves && !cur.trim().is_empty() {
                games.push(std::mem::take(&mut cur));
                in_moves = false;
            }
        } else if !t.is_empty() {
            in_moves = true;
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() { games.push(cur); }
    games
}

/// A header's value.
pub fn tag(pgn: &str, name: &str) -> Option<String> {
    for line in pgn.lines() {
        let t = line.trim();
        if !t.starts_with('[') { if !t.is_empty() { break; } else { continue; } }
        let inner = t.strip_prefix('[').and_then(|t| t.strip_suffix(']')).unwrap_or(t);
        let (n, v) = inner.split_once(' ')?;
        if n == name {
            // One quote off each end (not every quote — a value can end in an
            // escaped one), then \" \\ and \n (a line break, in LPDO's own
            // notes) unescaped in a single pass.
            let v = v.trim();
            let v = v.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(v);
            let mut out = String::with_capacity(v.len());
            let mut chars = v.chars();
            while let Some(c) = chars.next() {
                if c == '\\' { if let Some(n) = chars.next() { out.push(if n == 'n' { '\n' } else { n }); continue; } }
                out.push(c);
            }
            return Some(out);
        }
    }
    None
}

/// The movetext: everything after the headers.
pub fn movetext_of(pgn: &str) -> String {
    let mut out = String::new();
    let mut past = false;
    for line in pgn.lines() {
        let t = line.trim();
        if !past {
            if t.starts_with('[') || t.is_empty() { continue; }
            past = true;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

/// A chapter's name from an imported game's headers: a Lichess study's
/// `[ChapterName]`, the chapter part of its `[Event "Study: Chapter"]`, the
/// players where they are names, else the event — or none.
fn header_name(pgn: &str) -> Option<String> {
    if let Some(c) = tag(pgn, "LpdoChapter").filter(|s| !s.trim().is_empty()) { return Some(c); }
    if let Some(c) = tag(pgn, "ChapterName").filter(|s| !s.trim().is_empty()) { return Some(c); }
    let event = tag(pgn, "Event").unwrap_or_default();
    if let Some((_, chapter)) = event.split_once(": ") {
        if !chapter.trim().is_empty() { return Some(chapter.trim().to_string()); }
    }
    let real = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty() && v != "?");
    match (real(tag(pgn, "White")), real(tag(pgn, "Black"))) {
        (Some(w), Some(b)) => return Some(format!("{w} – {b}")),
        (Some(w), None) => return Some(w),
        _ => {}
    }
    (!event.trim().is_empty() && event.trim() != "?").then(|| event.trim().to_string())
}

/// A chapter's PGN: its headers — what the Analysis page shows in place of
/// the players — and the movetext.
fn compose_pgn(book: &str, author: Option<&str>, ord: i64, chapter: &str, color: &str, movetext: &str) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let mut body = movetext.trim().to_string();
    if !["1-0", "0-1", "1/2-1/2", "*"].iter().any(|r| body.ends_with(r)) {
        if !body.is_empty() { body.push(' '); }
        body.push('*');
    }
    let annotator = author.map(str::trim).filter(|a| !a.is_empty())
        .map(|a| format!("[Annotator \"{}\"]\n", esc(a))).unwrap_or_default();
    format!(
        "[Event \"{}\"]\n[Site \"LPDO repertoire\"]\n[Round \"{}\"]\n[White \"{}\"]\n[Black \"?\"]\n[Result \"*\"]\n{}[Orientation \"{}\"]\n\n{}\n",
        esc(book), ord, esc(chapter), annotator, color, body
    )
}

/// The result a game's PGN gives: its `[Result]`, else the token its moves
/// end with — `*` when neither says.
fn result_of(pgn: &str) -> String {
    if let Some(r) = tag(pgn, "Result").map(|r| r.trim().to_string()).filter(|r| r != "*" && RESULTS.contains(&r.as_str())) {
        return r;
    }
    let moves = movetext_of(pgn);
    RESULTS.iter().find(|r| moves.trim_end().ends_with(*r)).map_or("*", |r| r).to_string()
}

/// Moves without the result token ending them.
fn strip_result(movetext: &str) -> &str {
    let t = movetext.trim_end();
    ["1/2-1/2", "1-0", "0-1", "*"].iter().find_map(|r| t.strip_suffix(r)).map_or(t, str::trim_end)
}

/// A model game's PGN: its own headers — LPDO's tags left out — with
/// `[Result]` as `result`, then its moves, ending in it.
fn model_pgn(pgn: &str, movetext: &str, result: &str) -> String {
    let mut head = String::new();
    let mut has_result = false;
    for line in pgn.lines() {
        let t = line.trim();
        if t.is_empty() { if head.is_empty() { continue } else { break } }
        if !t.starts_with('[') { break; }
        if t.starts_with("[Lpdo") { continue; }
        if t.starts_with("[Result ") { has_result = true; head += &format!("[Result \"{result}\"]\n"); continue; }
        head += t;
        head.push('\n');
    }
    if !has_result { head += &format!("[Result \"{result}\"]\n"); }
    let body = strip_result(movetext);
    format!("{head}\n{body}{}{result}\n", if body.is_empty() { "" } else { " " })
}

// ── Database ─────────────────────────────────────────────────────────────────

fn book_row(r: &duckdb::Row<'_>) -> duckdb::Result<Book> {
    Ok(Book {
        id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, author: r.get(3)?, description: r.get(4)?, url: r.get(5)?,
        ord: r.get(6)?, active: r.get(7)?,
    })
}

const BOOK_COLS: &str = "id, name, color, author, description, url, ord, active";

fn chapter_row(r: &duckdb::Row<'_>) -> duckdb::Result<ChapterSummary> {
    Ok(ChapterSummary {
        id: r.get(0)?, book_id: r.get(1)?, ord: r.get(2)?, name: r.get(3)?, active: r.get(4)?,
        lines: r.get(5)?, lines_off: r.get(6)?, updated_at: r.get(7)?,
        analysed_at: r.get(8)?, analysis_stale: r.get(9)?,
        model: r.get(10)?, result: r.get(11)?, annotated: r.get(12)?,
    })
}

const CHAPTER_COLS: &str = "id, book_id, ord, name, active, lines, lines_off, CAST(updated_at AS VARCHAR),
    (SELECT CAST(a.analysed_at AS VARCHAR) FROM repertoire_analysis a WHERE a.chapter_id = repertoire_chapters.id),
    (SELECT a.positions_hash IS DISTINCT FROM repertoire_chapters.positions_hash FROM repertoire_analysis a WHERE a.chapter_id = repertoire_chapters.id),
    COALESCE(model, FALSE), COALESCE(result, '*'),
    COALESCE(model, FALSE) AND regexp_matches(
        regexp_replace(pgn, '\\[%(clk|emt|eval|tqu)[^\\]]*\\]', '', 'g'), '\\{\\s*[^}\\s]')";

pub fn get_book(conn: &Connection, id: i64) -> Result<Book> {
    conn.query_row(&format!("SELECT {BOOK_COLS} FROM repertoire_books WHERE id = ?"), duckdb::params![id], book_row)
        .map_err(|_| anyhow!("book {id} not found"))
}

fn get_chapter_summary(conn: &Connection, id: i64) -> Result<ChapterSummary> {
    conn.query_row(&format!("SELECT {CHAPTER_COLS} FROM repertoire_chapters WHERE id = ?"), duckdb::params![id], chapter_row)
        .map_err(|_| anyhow!("chapter {id} not found"))
}

pub fn list(conn: &Connection) -> Result<Vec<BookWithChapters>> {
    let mut st = conn.prepare(&format!("SELECT {BOOK_COLS} FROM repertoire_books ORDER BY ord, id"))?;
    let books: Vec<Book> = st.query_map([], book_row)?.collect::<duckdb::Result<_>>()?;
    let mut st = conn.prepare(&format!("SELECT {CHAPTER_COLS} FROM repertoire_chapters ORDER BY book_id, ord, id"))?;
    let chapters: Vec<ChapterSummary> = st.query_map([], chapter_row)?.collect::<duckdb::Result<_>>()?;
    Ok(books.into_iter().map(|book| {
        let mine = chapters.iter().filter(|c| c.book_id == book.id).cloned().collect();
        BookWithChapters { book, chapters: mine }
    }).collect())
}

pub fn create_book(conn: &Connection, name: &str, color: &str, author: Option<&str>, description: Option<&str>, url: Option<&str>) -> Result<Book> {
    let name = name.trim();
    if name.is_empty() { bail!("the book needs a name"); }
    valid_color(color)?;
    let id = crate::db::ids::next_id(conn, "repertoire_books")? as i64;
    let ord: i64 = conn.query_row("SELECT COALESCE(MAX(ord), 0) + 1 FROM repertoire_books", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO repertoire_books (id, name, color, author, description, url, ord, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, CAST(NOW() AS TIMESTAMP))",
        duckdb::params![id, name, color, author, description, url, ord],
    )?;
    crate::db::ids::raise_high_water(conn, "repertoire_books", id as u32)?;
    get_book(conn, id)
}

/// Number the books 1.. in their order — with `moved` put at place `to`
/// (1-based) first, when there is one.
fn place_book(conn: &Connection, moved: Option<(i64, i64)>) -> Result<()> {
    let mut st = conn.prepare("SELECT id FROM repertoire_books ORDER BY ord, id")?;
    let mut ids: Vec<i64> = st.query_map([], |r| r.get(0))?.collect::<duckdb::Result<_>>()?;
    if let Some((id, to)) = moved {
        ids.retain(|&x| x != id);
        let at = ((to.max(1) - 1) as usize).min(ids.len());
        ids.insert(at, id);
    }
    renumber(conn, "repertoire_books", &ids)
}

/// `ids` numbered 1.. in this order (their `ord`), in one statement — one
/// UPDATE a row, each committing on its own, made deleting 49 chapters of a
/// book (each renumbering the rest) take minutes.
fn renumber(conn: &Connection, table: &str, ids: &[i64]) -> Result<()> {
    if ids.is_empty() { return Ok(()); }
    let values = ids.iter().enumerate().map(|(i, id)| format!("({id}, {})", i + 1)).collect::<Vec<_>>().join(", ");
    conn.execute(
        &format!("UPDATE {table} SET ord = v.o FROM (VALUES {values}) AS v(id, o) WHERE {table}.id = v.id AND {table}.ord IS DISTINCT FROM v.o"),
        [],
    )?;
    Ok(())
}

pub fn update_book(conn: &Connection, id: i64, patch: BookPatch) -> Result<Book> {
    let before = get_book(conn, id)?;
    if let Some(n) = &patch.name { if n.trim().is_empty() { bail!("the book needs a name"); } }
    if let Some(c) = &patch.color { valid_color(c)?; }
    let name = patch.name.as_deref().map(str::trim).unwrap_or(&before.name).to_string();
    let color = patch.color.clone().unwrap_or(before.color.clone());
    let author = patch.author.clone().unwrap_or(before.author.clone()).map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
    let description = patch.description.clone().unwrap_or(before.description.clone());
    let url = patch.url.clone().unwrap_or(before.url.clone());
    let active = patch.active.unwrap_or(before.active);
    conn.execute(
        "UPDATE repertoire_books SET name = ?, color = ?, author = ?, description = ?, url = ?, active = ? WHERE id = ?",
        duckdb::params![name, color, author, description, url, active, id],
    )?;
    if let Some(to) = patch.ord { place_book(conn, Some((id, to)))?; }
    // The chapters' headers carry the book's name, author and colour; their
    // positions, whether the book is on.
    let headers = name != before.name || color != before.color || author != before.author;
    if headers || active != before.active {
        let mut st = conn.prepare("SELECT id, ord, name, pgn, active, COALESCE(model, FALSE) FROM repertoire_chapters WHERE book_id = ?")?;
        let rows: Vec<(i64, i64, String, String, bool, bool)> = st
            .query_map(duckdb::params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
            .collect::<duckdb::Result<_>>()?;
        for (cid, ord, cname, pgn, chapter_active, model) in rows {
            // A model game keeps its own headers, and has no positions.
            if model { continue; }
            let movetext = movetext_of(&pgn);
            if headers {
                let pgn = compose_pgn(&name, author.as_deref(), ord, &cname, &color, &movetext);
                conn.execute("UPDATE repertoire_chapters SET pgn = ? WHERE id = ?", duckdb::params![pgn, cid])?;
            }
            if active != before.active {
                reindex(conn, cid, active && chapter_active, &walk(&movetext)?)?;
            }
        }
    }
    get_book(conn, id)
}

pub fn delete_book(conn: &Connection, id: i64) -> Result<()> {
    get_book(conn, id)?;
    conn.execute("DELETE FROM repertoire_positions WHERE chapter_id IN (SELECT id FROM repertoire_chapters WHERE book_id = ?)", duckdb::params![id])?;
    conn.execute("DELETE FROM repertoire_analysis WHERE chapter_id IN (SELECT id FROM repertoire_chapters WHERE book_id = ?)", duckdb::params![id])?;
    conn.execute("DELETE FROM repertoire_chapters WHERE book_id = ?", duckdb::params![id])?;
    conn.execute("DELETE FROM repertoire_books WHERE id = ?", duckdb::params![id])?;
    place_book(conn, None)
}

/// Index a chapter's positions; `active` is whether the chapter counts at
/// all — it and its book on.
/// A fingerprint of a set of positions (their hashes, in any order): FNV-1a
/// over them sorted.
fn fingerprint(zobrists: impl Iterator<Item = i64>) -> i64 {
    let mut zs: Vec<i64> = zobrists.collect();
    zs.sort_unstable();
    zs.dedup();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for z in zs {
        for b in z.to_le_bytes() { h ^= b as u64; h = h.wrapping_mul(0x0100_0000_01b3); }
    }
    h as i64
}

/// A chapter's set of positions — every one, before each move and after it —
/// as a fingerprint: what its analysis depends on.
fn positions_hash(walk: &Walk) -> i64 {
    fingerprint(walk.rows.iter().flat_map(|r| [r.zobrist, r.after_zobrist]))
}

/// Fill in the fingerprints databases from before them lack: a chapter's
/// from its moves, an analysis's from the positions it keeps.
pub fn fill_positions_hashes(conn: &Connection) -> Result<()> {
    let mut st = conn.prepare("SELECT id, pgn FROM repertoire_chapters WHERE positions_hash IS NULL")?;
    let rows: Vec<(i64, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<duckdb::Result<_>>()?;
    for (id, pgn) in rows {
        if let Ok(w) = walk(&movetext_of(&pgn)) {
            conn.execute("UPDATE repertoire_chapters SET positions_hash = ? WHERE id = ?", duckdb::params![positions_hash(&w), id])?;
        }
    }
    let mut st = conn.prepare("SELECT chapter_id, positions FROM repertoire_analysis WHERE positions_hash IS NULL")?;
    let rows: Vec<(i64, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<duckdb::Result<_>>()?;
    for (id, json) in rows {
        let Ok(positions) = serde_json::from_str::<Vec<PositionStat>>(&json) else { continue };
        let h = fingerprint(positions.iter().filter_map(|p| u64::from_str_radix(&p.zobrist, 16).ok().map(|z| z as i64)));
        conn.execute("UPDATE repertoire_analysis SET positions_hash = ? WHERE chapter_id = ?", duckdb::params![h, id])?;
    }
    Ok(())
}

fn reindex(conn: &Connection, chapter_id: i64, active: bool, walk: &Walk) -> Result<()> {
    conn.execute("UPDATE repertoire_chapters SET positions_hash = ? WHERE id = ?", duckdb::params![positions_hash(walk), chapter_id])?;
    conn.execute("DELETE FROM repertoire_positions WHERE chapter_id = ?", duckdb::params![chapter_id])?;
    // A model game is not part of the repertoire: none of its positions count.
    let model: bool = conn.query_row("SELECT COALESCE(model, FALSE) FROM repertoire_chapters WHERE id = ?", duckdb::params![chapter_id], |r| r.get(0))?;
    if model { return Ok(()); }
    // In bulk: one INSERT a position, each its own transaction, took a book
    // of 25 chapters (6,000 positions) a minute on a large database.
    let mut app = conn.appender("repertoire_positions")?;
    for r in &walk.rows {
        app.append_row(duckdb::params![chapter_id, r.zobrist, r.ply, r.next_move, r.mover, active && r.active])?;
    }
    app.flush()?;
    Ok(())
}

/// Add chapters to a book: one empty chapter named `name`, or one chapter
/// per game of `pgn` (a file's worth), named from their headers — or `name`
/// when there is one game and a name. `file` is the file the PGN came from:
/// its name names the chapters the headers leave unnamed.
#[cfg(test)]
pub fn add_chapters(conn: &Connection, book_id: i64, name: Option<&str>, pgn: Option<&str>, file: Option<&str>) -> Result<Vec<ChapterSummary>> {
    add_chapters_as(conn, book_id, name, pgn, file, false)
}

/// [`add_chapters`], or — `model` — model games: one per game of `pgn`, each
/// with its own headers and result.
pub fn add_chapters_as(conn: &Connection, book_id: i64, name: Option<&str>, pgn: Option<&str>, file: Option<&str>, model: bool) -> Result<Vec<ChapterSummary>> {
    let book = get_book(conn, book_id)?;
    if model && pgn.is_none_or(|p| p.trim().is_empty()) { bail!("model games come from PGN"); }
    let games: Vec<String> = match pgn.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            let g = split_games(p);
            if g.is_empty() { bail!("no games in the PGN"); }
            g
        }
        None => vec![String::new()],
    };
    let single = games.len() == 1;
    // One transaction for the whole file: on a large database each statement
    // committing on its own is what made a book slow; and a game that fails
    // leaves nothing half imported.
    crate::db::with_tx(conn, || {
        let mut out = Vec::new();
        for (i, game) in games.iter().enumerate() {
            let movetext = movetext_of(game);
            let walk = walk(&movetext).with_context(|| format!("game {} of the PGN", i + 1))?;
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM repertoire_chapters WHERE book_id = ?", duckdb::params![book_id], |r| r.get(0))?;
            let cname = match name.map(str::trim).filter(|n| !n.is_empty()) {
                Some(n) if single => n.to_string(),
                _ if game.trim().is_empty() => format!("Chapter {}", count + 1),
                _ => match (header_name(game), file.map(str::trim).filter(|f| !f.is_empty())) {
                    (Some(h), _) => h,
                    (None, Some(f)) if single => f.to_string(),
                    (None, Some(f)) => format!("{f} {}", i + 1),
                    (None, None) => format!("Chapter {}", count + 1),
                },
            };
            let id = insert_chapter(conn, &book, &cname, &movetext, &walk, true, model.then_some(game.as_str()))?;
            out.push(get_chapter_summary(conn, id)?);
        }
        Ok(out)
    })
}

/// A chapter added at the end of `book`, its positions indexed; its id.
/// `model`: the game it is — a model game, with the game's own headers and
/// result.
fn insert_chapter(conn: &Connection, book: &Book, name: &str, movetext: &str, walk: &Walk, active: bool, model: Option<&str>) -> Result<i64> {
    let ord: i64 = conn.query_row("SELECT COALESCE(MAX(ord), 0) + 1 FROM repertoire_chapters WHERE book_id = ?", duckdb::params![book.id], |r| r.get(0))?;
    let id = crate::db::ids::next_id(conn, "repertoire_chapters")? as i64;
    let (full, result) = match model {
        Some(game) => { let r = result_of(game); (model_pgn(game, movetext, &r), r) }
        None => (compose_pgn(&book.name, book.author.as_deref(), ord, name, &book.color, movetext), "*".to_string()),
    };
    conn.execute(
        "INSERT INTO repertoire_chapters (id, book_id, ord, name, active, pgn, lines, lines_off, updated_at, model, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(NOW() AS TIMESTAMP), ?, ?)",
        duckdb::params![id, book.id, ord, name, active, full, walk.lines, walk.lines_off, model.is_some(), result],
    )?;
    crate::db::ids::raise_high_water(conn, "repertoire_chapters", id as u32)?;
    reindex(conn, id, book.active && active, walk)?;
    Ok(id)
}

/// Books from a PGN exported by LPDO — a book, or a backup of them all —
/// made again one to one: each with its name, colour, author, link, notes
/// and active switch from the `LpdoBook…` tags, its chapters in order with
/// their names and active switches. A PGN without those tags makes one book,
/// named after `file`, its colour from `[Orientation]`. Never adds to an
/// existing book; all or nothing.
pub fn import_books(conn: &Connection, pgn: &str, file: Option<&str>) -> Result<Vec<Book>> {
    let games = split_games(pgn.trim());
    if games.is_empty() { bail!("no games in the PGN"); }
    // The books in the order they first come, each with its games.
    let mut groups: Vec<(Option<String>, Vec<&String>)> = Vec::new();
    for g in &games {
        let key = tag(g, "LpdoBook").filter(|n| !n.trim().is_empty());
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, gs)) => gs.push(g),
            None => groups.push((key, vec![g])),
        }
    }
    crate::db::with_tx(conn, || {
        let mut books = Vec::new();
        for (key, gs) in &groups {
            let first = gs[0];
            let name = key.clone()
                .or_else(|| file.map(str::trim).filter(|f| !f.is_empty()).map(str::to_string))
                .unwrap_or_else(|| "Imported book".to_string());
            let color = tag(first, "LpdoBookColor").or_else(|| tag(first, "Orientation"))
                .filter(|c| c == "white" || c == "black").unwrap_or_else(|| "white".to_string());
            let nonempty = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
            let author = if key.is_some() { nonempty(tag(first, "LpdoBookAuthor")) } else { nonempty(tag(first, "Annotator")) };
            let notes = nonempty(tag(first, "LpdoBookNotes"));
            let url = nonempty(tag(first, "LpdoBookUrl"));
            let mut book = create_book(conn, &name, &color, author.as_deref(), notes.as_deref(), url.as_deref())?;
            if tag(first, "LpdoBookActive").as_deref() == Some("false") {
                conn.execute("UPDATE repertoire_books SET active = FALSE WHERE id = ?", duckdb::params![book.id])?;
                book.active = false;
            }
            for (i, g) in gs.iter().enumerate() {
                let movetext = movetext_of(g);
                let walk = walk(&movetext).with_context(|| format!("“{name}”, chapter {}", i + 1))?;
                let cname = header_name(g).unwrap_or_else(|| format!("Chapter {}", i + 1));
                let active = tag(g, "LpdoChapterActive").as_deref() != Some("false");
                let model = tag(g, "LpdoModelGame").as_deref() == Some("1");
                insert_chapter(conn, &book, &cname, &movetext, &walk, active, model.then_some(g.as_str()))?;
            }
            books.push(book);
        }
        Ok(books)
    })
}

pub fn get_chapter(conn: &Connection, id: i64) -> Result<ChapterDetail> {
    let summary = get_chapter_summary(conn, id)?;
    let pgn: String = conn.query_row("SELECT pgn FROM repertoire_chapters WHERE id = ?", duckdb::params![id], |r| r.get(0))?;
    let book = get_book(conn, summary.book_id)?;
    Ok(ChapterDetail { summary, pgn, book })
}

/// Number a book's chapters 1.. in their order — with `moved` put at place
/// `to` (1-based) first, when there is one.
fn place_chapter(conn: &Connection, book_id: i64, moved: Option<(i64, i64)>) -> Result<()> {
    let mut st = conn.prepare("SELECT id FROM repertoire_chapters WHERE book_id = ? ORDER BY ord, id")?;
    let mut ids: Vec<i64> = st.query_map(duckdb::params![book_id], |r| r.get(0))?.collect::<duckdb::Result<_>>()?;
    if let Some((id, to)) = moved {
        ids.retain(|&x| x != id);
        let at = ((to.max(1) - 1) as usize).min(ids.len());
        ids.insert(at, id);
    }
    renumber(conn, "repertoire_chapters", &ids)
}

/// Put `ids` — chapters of one book — in this order, in the places they
/// hold now, the book's other chapters staying where they are: the model
/// games reversed, say.
pub fn order_chapters(conn: &Connection, ids: &[i64]) -> Result<()> {
    let Some(first) = ids.first() else { return Ok(()) };
    let book_id = get_chapter_summary(conn, *first)?.book_id;
    let mut st = conn.prepare("SELECT id FROM repertoire_chapters WHERE book_id = ? ORDER BY ord, id")?;
    let all: Vec<i64> = st.query_map(duckdb::params![book_id], |r| r.get(0))?.collect::<duckdb::Result<_>>()?;
    for (i, id) in ids.iter().enumerate() {
        if !all.contains(id) { bail!("chapter {id} is not in the same book"); }
        if ids[..i].contains(id) { bail!("chapter {id} is given twice"); }
    }
    let mut next = ids.iter();
    let order: Vec<i64> = all.iter().map(|id| if ids.contains(id) { *next.next().unwrap_or(id) } else { *id }).collect();
    crate::db::with_tx(conn, || renumber(conn, "repertoire_chapters", &order))
}

pub fn update_chapter(conn: &Connection, id: i64, patch: ChapterPatch) -> Result<ChapterSummary> {
    let before = get_chapter_summary(conn, id)?;
    if let Some(n) = &patch.name { if n.trim().is_empty() { bail!("the chapter needs a name"); } }
    let name = patch.name.as_deref().map(str::trim).unwrap_or(&before.name).to_string();
    let active = patch.active.unwrap_or(before.active);
    let book_id = patch.book_id.unwrap_or(before.book_id);
    let model = patch.model.unwrap_or(before.model);
    let result = match patch.result {
        Some(r) if RESULTS.contains(&r.as_str()) => r,
        Some(r) => bail!("“{r}” is not a result: *, 1-0, 0-1 or 1/2-1/2"),
        None if model => before.result.clone(),
        None => "*".to_string(),
    };
    let book = get_book(conn, book_id)?;
    let counted_before = before.active && get_book(conn, before.book_id)?.active;
    conn.execute(
        "UPDATE repertoire_chapters SET name = ?, active = ?, book_id = ?, model = ?, result = ? WHERE id = ?",
        duckdb::params![name, active, book_id, model, result, id],
    )?;
    if book_id != before.book_id {
        // To the end of the new book; the old one closes its gap.
        let last: i64 = conn.query_row("SELECT COALESCE(MAX(ord), 0) + 1 FROM repertoire_chapters WHERE book_id = ? AND id <> ?", duckdb::params![book_id, id], |r| r.get(0))?;
        place_chapter(conn, book_id, Some((id, patch.ord.unwrap_or(last))))?;
        place_chapter(conn, before.book_id, None)?;
    } else if let Some(to) = patch.ord {
        place_chapter(conn, book_id, Some((id, to)))?;
    }
    let after = get_chapter_summary(conn, id)?;
    // The headers carry the chapter's name and order and the book's — a
    // model game's are its own, with its result.
    let pgn: String = conn.query_row("SELECT pgn FROM repertoire_chapters WHERE id = ?", duckdb::params![id], |r| r.get(0))?;
    let movetext = movetext_of(&pgn);
    let full = if model { model_pgn(&pgn, &movetext, &result) }
        else { compose_pgn(&book.name, book.author.as_deref(), after.ord, &after.name, &book.color, &movetext) };
    conn.execute("UPDATE repertoire_chapters SET pgn = ? WHERE id = ?", duckdb::params![full, id])?;
    if (active && book.active) != counted_before || model != before.model {
        let w = walk(&movetext)?;
        reindex(conn, id, active && book.active, &w)?;
    }
    get_chapter_summary(conn, id)
}

/// Save a chapter's moves (the editor's target) and index its positions.
pub fn set_moves(conn: &Connection, id: i64, movetext: &str) -> Result<ChapterSummary> {
    let before = get_chapter_summary(conn, id)?;
    let book = get_book(conn, before.book_id)?;
    let w = walk(movetext)?;
    let full = if before.model {
        let pgn: String = conn.query_row("SELECT pgn FROM repertoire_chapters WHERE id = ?", duckdb::params![id], |r| r.get(0))?;
        model_pgn(&pgn, movetext, &before.result)
    } else {
        compose_pgn(&book.name, book.author.as_deref(), before.ord, &before.name, &book.color, movetext)
    };
    conn.execute(
        "UPDATE repertoire_chapters SET pgn = ?, lines = ?, lines_off = ?, updated_at = CAST(NOW() AS TIMESTAMP) WHERE id = ?",
        duckdb::params![full, w.lines, w.lines_off, id],
    )?;
    reindex(conn, id, before.active && book.active, &w)?;
    get_chapter_summary(conn, id)
}

pub fn delete_chapter(conn: &Connection, id: i64) -> Result<()> {
    delete_chapters(conn, &[id])
}

/// Delete chapters — the ones merged into another, say — all in one
/// transaction, their books renumbered once.
pub fn delete_chapters(conn: &Connection, ids: &[i64]) -> Result<()> {
    if ids.is_empty() { return Ok(()); }
    let mut books: Vec<i64> = Vec::new();
    for id in ids {
        let b = get_chapter_summary(conn, *id)?.book_id;
        if !books.contains(&b) { books.push(b); }
    }
    let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    crate::db::with_tx(conn, || {
        conn.execute(&format!("DELETE FROM repertoire_positions WHERE chapter_id IN ({list})"), [])?;
        conn.execute(&format!("DELETE FROM repertoire_analysis WHERE chapter_id IN ({list})"), [])?;
        conn.execute(&format!("DELETE FROM repertoire_chapters WHERE id IN ({list})"), [])?;
        for b in &books { place_chapter(conn, *b, None)?; }
        Ok(())
    })
}

/// A chapter's PGN, or a whole book's — its chapters in order.
/// A chapter as exported: its headers made now (the book as it is now —
/// renamed, say) with the book's own in `LpdoBook…` tags and the chapter's in
/// `LpdoChapter…`, so that importing it makes the book again one to one
/// ([`import_books`]); then its moves.
/// A model game keeps its own headers, marked `[LpdoModelGame "1"]`.
fn export_chapter(book: &Book, ord: i64, name: &str, active: bool, model: bool, pgn: &str) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "");
    let base = if model { model_pgn(pgn, &movetext_of(pgn), &result_of(pgn)) }
        else { compose_pgn(&book.name, book.author.as_deref(), ord, name, &book.color, &movetext_of(pgn)) };
    let mut tags = format!("[LpdoBook \"{}\"]\n[LpdoBookColor \"{}\"]\n", esc(&book.name), book.color);
    for (t, v) in [("LpdoBookAuthor", &book.author), ("LpdoBookUrl", &book.url), ("LpdoBookNotes", &book.description)] {
        if let Some(v) = v.as_deref().filter(|v| !v.trim().is_empty()) { tags += &format!("[{t} \"{}\"]\n", esc(v)); }
    }
    if !book.active { tags += "[LpdoBookActive \"false\"]\n"; }
    tags += &format!("[LpdoChapter \"{}\"]\n", esc(name));
    if !active { tags += "[LpdoChapterActive \"false\"]\n"; }
    if model { tags += "[LpdoModelGame \"1\"]\n"; }
    match base.split_once("\n\n") {
        Some((head, body)) => format!("{head}\n{tags}\n{body}"),
        None => base,
    }
}

/// A book's chapters as exported, in order.
fn export_book(conn: &Connection, book: &Book) -> Result<Vec<String>> {
    let mut st = conn.prepare("SELECT ord, name, active, COALESCE(model, FALSE), pgn FROM repertoire_chapters WHERE book_id = ? ORDER BY ord, id")?;
    let rows: Vec<(i64, String, bool, bool, String)> = st.query_map(duckdb::params![book.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<duckdb::Result<_>>()?;
    Ok(rows.iter().map(|(ord, name, active, model, pgn)| export_chapter(book, *ord, name, *active, *model, pgn).trim().to_string()).collect())
}

pub fn chapter_pgn(conn: &Connection, id: i64) -> Result<String> {
    let c = get_chapter(conn, id)?;
    Ok(export_chapter(&c.book, c.summary.ord, &c.summary.name, c.summary.active, c.summary.model, &c.pgn))
}

pub fn book_pgn(conn: &Connection, id: i64) -> Result<String> {
    let book = get_book(conn, id)?;
    Ok(export_book(conn, &book)?.join("\n\n") + "\n")
}

/// Every book, in order — the repertoire's backup; [`import_books`] makes it
/// all again.
pub fn all_books_pgn(conn: &Connection) -> Result<String> {
    let mut out = Vec::new();
    for b in list(conn)? { out.extend(export_book(conn, &b.book)?); }
    Ok(out.join("\n\n") + "\n")
}

// ── The database's figures for a chapter (practice, #327) ───────────────────

/// A move from a position, as the database's games played it.
#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq)]
pub struct MoveStat {
    /// SAN without check marks — the source PGNs are not consistent about them.
    pub san: String,
    pub games: i64,
    /// The average result for the side playing the move (1 win, ½ draw).
    pub score: f64,
}

/// A stored engine evaluation, from White's side.
#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Eval {
    Cp { cp: i32 },
    Mate { mate: i32 },
}

/// One position of a chapter with what the database knows of it.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct PositionStat {
    /// [`position_key`]: how the client finds the position.
    pub key: String,
    /// The position's hash as 16 hex digits: part of a card's key.
    pub zobrist: String,
    /// Games that reached the position and went on (the positions index
    /// covers each game's first ~40 plies).
    pub games: i64,
    /// The most played moves, and every move the chapter has here, most
    /// played first.
    pub moves: Vec<MoveStat>,
    pub eval: Option<Eval>,
}

/// A chapter's stored analysis (see [`analyse_chapter`]), or the figures
/// worked out on the spot (`analysed_at` none).
#[derive(Clone, Debug, Serialize)]
pub struct Analysis {
    pub analysed_at: Option<String>,
    /// The chapter's `updated_at` the analysis was made from.
    pub chapter_updated: Option<String>,
    pub positions: Vec<PositionStat>,
}

/// How many of the database's moves a position keeps besides the chapter's.
const TOP_MOVES: usize = 8;

/// The database's figures for every position of a chapter — the moves
/// played from it (engine games left out, as the Reference tab does by
/// default) and a stored evaluation. One query for the whole chapter.
/// One's own games are not here: they change every week, and are looked up
/// live ([`chapter_mine`]).
pub fn chapter_stats(conn: &Connection, id: i64) -> Result<Vec<PositionStat>> {
    let pgn = get_chapter(conn, id)?.pgn;
    let w = walk(&movetext_of(&pgn))?;

    // Every position, before each move and after it; the chapter's own moves
    // from each.
    let mut order: Vec<i64> = Vec::new();
    let mut keys: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    let mut chapter_moves: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
    let mut black_to_move: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for r in &w.rows {
        for (z, k, black) in [(r.zobrist, &r.key, r.mover == "black"), (r.after_zobrist, &r.after_key, r.mover == "white")] {
            if keys.insert(z, k.clone()).is_none() { order.push(z); }
            if black { black_to_move.insert(z); }
        }
        chapter_moves.entry(r.zobrist).or_default().push(strip_marks(&r.next_move).to_string());
    }
    if order.is_empty() { return Ok(Vec::new()); }
    let list = order.iter().map(|z| z.to_string()).collect::<Vec<_>>().join(",");

    let ceiling = crate::db::queries::HUMAN_ELO_CEILING;
    let sql = format!("
        SELECT p.zobrist_hash,
               regexp_replace(p.next_move, '[+#!?]+$', '') AS san,
               COUNT(*) AS games,
               AVG(CASE WHEN p.move_number % 2 = 0 THEN
                        CASE g.result WHEN '1-0' THEN 1.0 WHEN '1/2-1/2' THEN 0.5 ELSE 0.0 END
                    ELSE
                        CASE g.result WHEN '0-1' THEN 1.0 WHEN '1/2-1/2' THEN 0.5 ELSE 0.0 END
                    END) AS score
        FROM positions p
        JOIN games g ON p.game_id = g.id
        WHERE p.zobrist_hash IN ({list})
          AND p.next_move IS NOT NULL
          AND g.result IN ('1-0', '0-1', '1/2-1/2')
          AND g.deleted_at IS NULL
          AND COALESCE(g.white_elo, 0) <= {ceiling}
          AND COALESCE(g.black_elo, 0) <= {ceiling}
          AND g.id NOT IN (SELECT game_id FROM engine_games)
        GROUP BY 1, 2");
    let mut by_pos: std::collections::HashMap<i64, Vec<MoveStat>> = std::collections::HashMap::new();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, MoveStat { san: r.get(1)?, games: r.get(2)?, score: r.get(3)? })))?;
    for row in rows {
        let (z, m) = row?;
        by_pos.entry(z).or_default().push(m);
    }

    let evals = stored_evals(conn, &list, &black_to_move)?;

    Ok(order.into_iter().map(|z| {
        let mut moves = by_pos.remove(&z).unwrap_or_default();
        moves.sort_by(|a, b| b.games.cmp(&a.games).then_with(|| a.san.cmp(&b.san)));
        let games = moves.iter().map(|m| m.games).sum();
        let ours = chapter_moves.get(&z).cloned().unwrap_or_default();
        let moves = moves.into_iter().enumerate()
            .filter(|(i, m)| *i < TOP_MOVES || ours.contains(&m.san))
            .map(|(_, m)| m)
            .collect();
        PositionStat { key: keys.remove(&z).unwrap_or_default(), zobrist: format!("{:016x}", z as u64), games, moves, eval: evals.get(&z).cloned() }
    }).collect())
}

// ── One's own games, live ───────────────────────────────────────────────────

/// One's own games through a position.
#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq)]
pub struct Mine {
    /// How many games went through it.
    pub games: i64,
    /// One's wins, draws, losses from there.
    pub w: i64,
    pub d: i64,
    pub l: i64,
    /// The performance rating, with at least three rated opponents.
    pub perf: Option<i32>,
    /// The moves played next in those games, with how often, most first.
    pub moves: Vec<(String, i64)>,
}

/// One's own games through a chapter's positions (see [`chapter_mine`]).
#[derive(Clone, Debug, Serialize)]
pub struct OwnGames {
    /// Which games count: those with the book's colour, from `since` on
    /// (none: all of them) — `months` as set.
    pub color: String,
    pub months: u32,
    pub since: Option<String>,
    /// How many of one's games count.
    pub games: i64,
    /// How long the lookup took.
    pub ms: i64,
    pub positions: Vec<PositionMine>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PositionMine {
    pub key: String,
    pub mine: Mine,
}

/// One of one's own games: the result for oneself, the opponent's rating.
struct MyGame { score: f64, opp_elo: Option<i64> }

/// The first day of the last `months` months before `today`, as games
/// store dates ("2025-10-01"); none for 0 (all of them). Worked out here,
/// not in SQL: `current_date - INTERVAL n MONTH` sometimes bound to `age()`
/// on one of the server's connections and failed.
fn since_months(months: u32, today: chrono::NaiveDate) -> Option<String> {
    if months == 0 { return None; }
    let day = today.checked_sub_months(chrono::Months::new(months)).unwrap_or(chrono::NaiveDate::MIN);
    Some(day.format("%Y-%m-%d").to_string())
}

/// One's games with `color`, from the period the settings give (games
/// without a date left out when there is one): the months, the first day
/// counted, the games by id.
fn my_games(conn: &Connection, player: i64, color: &str) -> Result<(u32, Option<String>, std::collections::HashMap<i64, MyGame>)> {
    let months = settings().own_games_months;
    let since = since_months(months, chrono::Local::now().date_naive());
    let (me, opp, win) = if color == "white" { ("white_id", "black_elo", "1-0") } else { ("black_id", "white_elo", "0-1") };
    let mut games = std::collections::HashMap::new();
    let mut st = conn.prepare(&format!(
        "SELECT id, CASE result WHEN '{win}' THEN 1.0 WHEN '1/2-1/2' THEN 0.5 ELSE 0.0 END, {opp}
         FROM games
         WHERE {me} = ?1 AND result IN ('1-0', '0-1', '1/2-1/2') AND deleted_at IS NULL
           AND (?2 IS NULL OR date >= ?2)"))?;
    let mut rows = st.query(duckdb::params![player, since])?;
    while let Some(r) = rows.next()? {
        games.insert(r.get(0)?, MyGame { score: r.get(1)?, opp_elo: r.get::<_, Option<i64>>(2)?.filter(|e| *e > 0) });
    }
    Ok((months, since, games))
}

/// A score over some of one's games: wins, draws, losses, and a performance
/// rating with three rated opponents or more.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Score {
    pub games: i64,
    pub w: i64,
    pub d: i64,
    pub l: i64,
    pub perf: Option<i32>,
}

fn score_of<'a>(games: impl Iterator<Item = &'a MyGame>) -> Score {
    let mut s = Score::default();
    let (mut sum, mut n) = (0.0, 0);
    for g in games {
        s.games += 1;
        if g.score == 1.0 { s.w += 1 } else if g.score == 0.5 { s.d += 1 } else { s.l += 1 }
        if let Some(e) = g.opp_elo { sum += e as f64 + 400.0 * (2.0 * g.score - 1.0); n += 1; }
    }
    s.perf = (n >= 3).then(|| (sum / n as f64).round() as i32);
    s
}

/// One's own games across a book's chapters (see [`book_mine`]).
#[derive(Clone, Debug, Serialize)]
pub struct BookGames {
    pub color: String,
    pub months: u32,
    pub since: Option<String>,
    /// One's games with the book's colour in the period, all of them.
    pub games: i64,
    /// Those that reached the moves every chapter shares — the book's
    /// opening — and their score.
    pub in_book: Score,
    /// Of those, the ones that reached no chapter's own position: where one
    /// left the book, by the move that left it ("3...Bb4"), most first.
    pub left: Score,
    pub left_by: Vec<(String, i64)>,
    pub chapters: Vec<ChapterGames>,
    pub ms: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChapterGames {
    pub id: i64,
    #[serde(flatten)]
    pub score: Score,
}

/// One's own games across a book: for each chapter, the games that reached
/// one of its own positions — those no other chapter of the book has, after
/// either side's move — transpositions included; and
/// the book's games that went into none ("left the book"), by the move that
/// left. With the book's colour, from the period the settings give; looked
/// up live (~0.1 s).
pub fn book_mine(conn: &Connection, book_id: i64, player: i64) -> Result<BookGames> {
    let started = std::time::Instant::now();
    let p = place(conn, book_id, player)?;
    let mut out = BookGames {
        color: p.color.clone(), months: p.months, since: p.since.clone(), games: p.games.len() as i64,
        in_book: score_of(p.in_book.iter().filter_map(|g| p.games.get(g))),
        left: score_of(p.left.iter().filter_map(|g| p.games.get(g))),
        left_by: Vec::new(),
        chapters: p.chapters.iter().zip(&p.per_chapter)
            .map(|(id, gs)| ChapterGames { id: *id, score: score_of(gs.iter().filter_map(|g| p.games.get(g))) })
            .collect(),
        ms: 0,
    };
    let mut by: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for g in &p.left {
        if let Some((ply, Some(san))) = p.deepest.get(g) {
            // The move from the deepest book position the game reached.
            *by.entry(move_label(*ply, san)).or_default() += 1;
        }
    }
    let mut by: Vec<(String, i64)> = by.into_iter().collect();
    by.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.left_by = by;
    out.ms = started.elapsed().as_millis() as i64;
    Ok(out)
}

/// "3...Bb4": the move played from the position after `ply` half-moves.
fn move_label(ply: i64, san: &str) -> String {
    format!("{}{}{}", ply / 2 + 1, if ply % 2 == 1 { "..." } else { "." }, strip_marks(san))
}

/// Where one's games went in a book (see [`book_mine`]).
struct Placement {
    color: String,
    months: u32,
    since: Option<String>,
    games: std::collections::HashMap<i64, MyGame>,
    /// The book's chapters, in order, and the games that count for each.
    chapters: Vec<i64>,
    per_chapter: Vec<Vec<i64>>,
    /// The games in the book's opening, and those of them that went into no
    /// chapter.
    in_book: Vec<i64>,
    left: Vec<i64>,
    /// Per game, the deepest book position it reached (its ply) and the
    /// move played from it.
    deepest: std::collections::HashMap<i64, (i64, Option<String>)>,
}

/// Which of one's games count for which of a book's chapters: those that
/// reached one of a chapter's own positions — no other chapter of the book
/// has them — by any move order.
fn place(conn: &Connection, book_id: i64, player: i64) -> Result<Placement> {
    let book = get_book(conn, book_id)?;
    let mut st = conn.prepare("SELECT id, pgn FROM repertoire_chapters WHERE book_id = ? AND NOT COALESCE(model, FALSE) ORDER BY ord, id")?;
    let chapters: Vec<(i64, String)> = st.query_map(duckdb::params![book_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<duckdb::Result<_>>()?;

    // Each chapter's positions (the start left out: every game has it), in
    // how many chapters each one is, and those one reaches with one's own
    // move — the book's colour having just moved.
    let start = Chess::default().zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;
    let mut mine_after: Vec<std::collections::HashSet<i64>> = Vec::new();
    let mut sets: Vec<std::collections::HashSet<i64>> = Vec::new();
    let mut count: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
    for (_, pgn) in &chapters {
        let w = walk(&movetext_of(pgn))?;
        let mut set = std::collections::HashSet::new();
        let mut after = std::collections::HashSet::new();
        for r in &w.rows {
            for z in [r.zobrist, r.after_zobrist] { if z != start { set.insert(z); } }
            if r.mover == book.color { after.insert(r.after_zobrist); }
        }
        for z in &set { *count.entry(*z).or_default() += 1; }
        sets.push(set);
        mine_after.push(after);
    }
    let n = chapters.len();
    // The book's opening: the positions every chapter has, reached by one's
    // own move (after 1...e6 in a French book — not after 1.e4, which a
    // Sicilian game reaches too); with none, any position one reaches by
    // one's own move in some chapter.
    let any_after: std::collections::HashSet<i64> = mine_after.iter().flatten().copied().collect();
    let shared: std::collections::HashSet<i64> = count.iter()
        .filter(|(z, c)| **c == n && any_after.contains(z))
        .map(|(z, _)| *z).collect();
    let shared = if shared.is_empty() { any_after } else { shared };
    // A chapter's own positions: those no other chapter of the book has,
    // whoever moved last. A chapter is what parts it from the others — in a
    // Black book mostly White's move (3.Nd2 for the Tarrasch) — so a game
    // that got there counts for it even when one deviated straight after
    // (an older 3...c5 under a 3...a6 chapter); positions several chapters
    // share count for none of them.
    let own: Vec<std::collections::HashSet<i64>> = sets.iter()
        .map(|set| set.iter().filter(|z| count[z] == 1).copied().collect())
        .collect();

    let (months, since, games) = my_games(conn, player, &book.color)?;
    let mut out = Placement {
        color: book.color.clone(), months, since, games,
        chapters: chapters.iter().map(|(id, _)| *id).collect(),
        per_chapter: vec![Vec::new(); n],
        in_book: Vec::new(), left: Vec::new(), deepest: std::collections::HashMap::new(),
    };
    if out.games.is_empty() || count.is_empty() { return Ok(out); }

    // Where one's games went among the book's positions: per game, the
    // positions it reached, and the deepest with the move played from it.
    let ids = out.games.keys().map(|g| g.to_string()).collect::<Vec<_>>().join(",");
    let hashes = count.keys().map(|z| z.to_string()).collect::<Vec<_>>().join(",");
    let mut st = conn.prepare(&format!(
        "SELECT game_id, zobrist_hash, move_number, next_move FROM positions
         WHERE game_id IN ({ids}) AND zobrist_hash IN ({hashes})"))?;
    let mut reached: std::collections::HashMap<i64, std::collections::HashSet<i64>> = std::collections::HashMap::new();
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let (g, z, ply, next): (i64, i64, i64, Option<String>) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
        reached.entry(g).or_default().insert(z);
        let d = out.deepest.entry(g).or_insert((-1, None));
        if ply > d.0 { *d = (ply, next); }
    }

    out.in_book = reached.iter().filter(|(_, zs)| zs.iter().any(|z| shared.contains(z))).map(|(g, _)| *g).collect();
    let mut placed: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for (i, own) in own.iter().enumerate() {
        let gs: Vec<i64> = reached.iter().filter(|(_, zs)| zs.iter().any(|z| own.contains(z))).map(|(g, _)| *g).collect();
        placed.extend(gs.iter().copied());
        out.per_chapter[i] = gs;
    }
    out.left = out.in_book.iter().copied().filter(|g| !placed.contains(g)).collect();
    Ok(out)
}

/// A game as the lists show it.
struct GameRow { id: i64, white: String, black: String, white_elo: Option<i64>, black_elo: Option<i64>, event: Option<String>, date: Option<String>, result: Option<String> }

/// These games, newest first.
fn game_rows(conn: &Connection, ids: &[i64]) -> Result<Vec<GameRow>> {
    if ids.is_empty() { return Ok(Vec::new()); }
    let list = ids.iter().map(|g| g.to_string()).collect::<Vec<_>>().join(",");
    let mut st = conn.prepare(&format!(
        "SELECT g.id, pw.name, pb.name, g.white_elo, g.black_elo, g.event, g.date, g.result
         FROM games g JOIN players pw ON g.white_id = pw.id JOIN players pb ON g.black_id = pb.id
         WHERE g.id IN ({list})
         ORDER BY g.date DESC NULLS LAST, g.id DESC"))?;
    let rows = st.query_map([], |r| Ok(GameRow {
        id: r.get(0)?, white: r.get(1)?, black: r.get(2)?, white_elo: r.get(3)?, black_elo: r.get(4)?,
        event: r.get(5)?, date: r.get(6)?, result: r.get(7)?,
    }))?;
    Ok(rows.collect::<duckdb::Result<_>>()?)
}

/// One of one's games in a book's opening (see [`book_games`]): the chapters
/// it counts for, or — none — the move that left the book.
#[derive(Clone, Debug, Serialize)]
pub struct BookGame {
    pub id: i64,
    pub white: String,
    pub black: String,
    pub white_elo: Option<i64>,
    pub black_elo: Option<i64>,
    pub event: Option<String>,
    pub date: Option<String>,
    pub result: Option<String>,
    pub chapters: Vec<i64>,
    /// How far it followed its (first) chapter — as that chapter's list says.
    pub follow: Option<Follow>,
    pub left: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BookGameList {
    pub color: String,
    pub months: u32,
    pub since: Option<String>,
    pub games: Vec<BookGame>,
    pub ms: i64,
}

/// One's games in a book's opening, newest first, each with the chapters it
/// counts for — or the move that left the book.
pub fn book_games(conn: &Connection, book_id: i64, player: i64) -> Result<BookGameList> {
    let started = std::time::Instant::now();
    let p = place(conn, book_id, player)?;
    let mut out = BookGameList { color: p.color.clone(), months: p.months, since: p.since.clone(), games: Vec::new(), ms: 0 };
    // How far each game followed its chapter — the first it counts for —
    // the same as the chapter's own list.
    let mut follow: std::collections::HashMap<i64, Follow> = std::collections::HashMap::new();
    let mut st = conn.prepare("SELECT id, pgn FROM repertoire_chapters WHERE book_id = ? AND NOT COALESCE(model, FALSE)")?;
    let pgns: std::collections::HashMap<i64, String> = st.query_map(duckdb::params![book_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<duckdb::Result<_>>()?;
    let mut first: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    for g in &p.in_book {
        if let Some(c) = p.chapters.iter().zip(&p.per_chapter).find(|(_, gs)| gs.contains(g)).map(|(c, _)| *c) {
            first.entry(c).or_default().push(*g);
        }
    }
    for (c, gs) in &first {
        if let Some(pgn) = pgns.get(c) { follow.extend(follow_chapter(conn, pgn, gs, &p.color)?); }
    }
    for row in game_rows(conn, &p.in_book)? {
        let chapters: Vec<i64> = p.chapters.iter().zip(&p.per_chapter)
            .filter(|(_, gs)| gs.contains(&row.id)).map(|(c, _)| *c).collect();
        let left = if chapters.is_empty() {
            p.deepest.get(&row.id).and_then(|(ply, san)| san.as_deref().map(|s| move_label(*ply, s)))
        } else { None };
        out.games.push(BookGame {
            id: row.id, white: row.white, black: row.black, white_elo: row.white_elo, black_elo: row.black_elo,
            event: row.event, date: row.date, result: row.result, chapters, follow: follow.remove(&row.id), left,
        });
    }
    out.ms = started.elapsed().as_millis() as i64;
    Ok(out)
}

/// One of one's games in a chapter (see [`chapter_games`]).
#[derive(Clone, Debug, Serialize)]
pub struct ChapterGame {
    pub id: i64,
    pub white: String,
    pub black: String,
    pub white_elo: Option<i64>,
    pub black_elo: Option<i64>,
    pub event: Option<String>,
    pub date: Option<String>,
    pub result: Option<String>,
    #[serde(flatten)]
    pub follow: Follow,
}

/// How far a game followed a chapter: "left" — a move the chapter does not
/// have, `left_by` (one's own or the opponent's), `move` ("8...b6"); "end" —
/// to the end of one of its lines; "index" — as far as the positions index
/// goes (each game's first ~40 plies); "ended" — the game ended in it. And
/// the deepest chapter position it reached, by its key — where to put the
/// board — with its ply.
#[derive(Clone, Debug, Serialize)]
pub struct Follow {
    pub followed: &'static str,
    pub left_by: Option<&'static str>,
    #[serde(rename = "move")]
    pub mv: Option<String>,
    pub at_key: String,
    pub at_ply: i64,
}

/// How far each of these games followed a chapter (`pgn`), one playing
/// `color`.
fn follow_chapter(conn: &Connection, pgn: &str, ids: &[i64], color: &str) -> Result<std::collections::HashMap<i64, Follow>> {
    let mut out = std::collections::HashMap::new();
    if ids.is_empty() { return Ok(out); }
    // The chapter's positions: their keys and the chapter's moves from each.
    let w = walk(&movetext_of(pgn))?;
    let mut keys: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    let mut moves: std::collections::HashMap<i64, std::collections::HashSet<String>> = std::collections::HashMap::new();
    for r in &w.rows {
        keys.insert(r.zobrist, r.key.clone());
        keys.insert(r.after_zobrist, r.after_key.clone());
        moves.entry(r.zobrist).or_default().insert(strip_marks(&r.next_move).to_string());
    }
    if keys.is_empty() { return Ok(out); }

    // Per game, the deepest chapter position it reached and the move played.
    let list = ids.iter().map(|g| g.to_string()).collect::<Vec<_>>().join(",");
    let hashes = keys.keys().map(|z| z.to_string()).collect::<Vec<_>>().join(",");
    let mut st = conn.prepare(&format!(
        "SELECT game_id, zobrist_hash, move_number, next_move FROM positions
         WHERE game_id IN ({list}) AND zobrist_hash IN ({hashes})"))?;
    let mut deepest: std::collections::HashMap<i64, (i64, i64, Option<String>)> = std::collections::HashMap::new();
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let (g, z, ply, next): (i64, i64, i64, Option<String>) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
        let d = deepest.entry(g).or_insert((-1, 0, None));
        if ply > d.0 { *d = (ply, z, next); }
    }
    for (g, (ply, z, next)) in deepest {
        let ours = moves.get(&z);
        let side_to_move = if ply % 2 == 0 { "white" } else { "black" };
        let (followed, left_by, mv) = match next.as_deref().map(strip_marks) {
            None => ("ended", None, None),
            Some(san) if ours.is_some_and(|m| m.contains(san)) => ("index", None, None),
            Some(_) if ours.is_none() => ("end", None, None),
            Some(san) => ("left", Some(if side_to_move == color { "you" } else { "opponent" }), Some(move_label(ply, san))),
        };
        out.insert(g, Follow { followed, left_by, mv, at_key: keys.get(&z).cloned().unwrap_or_default(), at_ply: ply });
    }
    Ok(out)
}

/// One's games in a chapter (as [`book_mine`] counts them), newest first,
/// each with how far it followed the chapter and who left it.
#[derive(Clone, Debug, Serialize)]
pub struct ChapterGameList {
    pub color: String,
    pub months: u32,
    pub since: Option<String>,
    pub games: Vec<ChapterGame>,
    pub ms: i64,
}

pub fn chapter_games(conn: &Connection, chapter_id: i64, player: i64) -> Result<ChapterGameList> {
    let started = std::time::Instant::now();
    let detail = get_chapter(conn, chapter_id)?;
    let p = place(conn, detail.summary.book_id, player)?;
    let ids: Vec<i64> = p.chapters.iter().position(|c| *c == chapter_id)
        .map(|i| p.per_chapter[i].clone()).unwrap_or_default();
    let mut out = ChapterGameList { color: p.color.clone(), months: p.months, since: p.since.clone(), games: Vec::new(), ms: 0 };
    if ids.is_empty() {
        out.ms = started.elapsed().as_millis() as i64;
        return Ok(out);
    }

    let follow = follow_chapter(conn, &detail.pgn, &ids, &p.color)?;
    for row in game_rows(conn, &ids)? {
        let Some(f) = follow.get(&row.id).cloned() else { continue };
        out.games.push(ChapterGame {
            id: row.id, white: row.white, black: row.black, white_elo: row.white_elo, black_elo: row.black_elo,
            event: row.event, date: row.date, result: row.result, follow: f,
        });
    }
    out.ms = started.elapsed().as_millis() as i64;
    Ok(out)
}

/// One's own games through every position of a chapter, looked up live —
/// they change every week, unlike the database's figures. Only the games
/// played with the book's colour (a Black repertoire is about one's games as
/// Black), from the last `own_games_months` of the settings. From one's games
/// (the players indexes) to their positions — never a scan of the whole
/// positions index: ~0.1 s.
pub fn chapter_mine(conn: &Connection, id: i64, player: i64) -> Result<OwnGames> {
    let started = std::time::Instant::now();
    let detail = get_chapter(conn, id)?;
    let w = walk(&movetext_of(&detail.pgn))?;
    let mut keys: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    for r in &w.rows {
        keys.insert(r.zobrist, r.key.clone());
        keys.insert(r.after_zobrist, r.after_key.clone());
    }
    let color = detail.book.color.clone();
    let (months, since, games) = my_games(conn, player, &color)?;
    let mut out = OwnGames { color, months, since, games: games.len() as i64, ms: 0, positions: Vec::new() };
    if games.is_empty() || keys.is_empty() {
        out.ms = started.elapsed().as_millis() as i64;
        return Ok(out);
    }

    let ids = games.keys().map(|g| g.to_string()).collect::<Vec<_>>().join(",");
    let hashes = keys.keys().map(|z| z.to_string()).collect::<Vec<_>>().join(",");
    let mut st = conn.prepare(&format!(
        "SELECT game_id, zobrist_hash, regexp_replace(next_move, '[+#!?]+$', '')
         FROM positions
         WHERE game_id IN ({ids}) AND zobrist_hash IN ({hashes}) AND next_move IS NOT NULL"))?;
    #[derive(Default)]
    struct Sum { games: i64, w: i64, d: i64, l: i64, perf_sum: f64, perf_n: i64, moves: std::collections::BTreeMap<String, i64> }
    let mut by_pos: std::collections::HashMap<i64, Sum> = std::collections::HashMap::new();
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let (g, z, san): (i64, i64, String) = (r.get(0)?, r.get(1)?, r.get(2)?);
        let Some(game) = games.get(&g) else { continue };
        let s = by_pos.entry(z).or_default();
        s.games += 1;
        if game.score == 1.0 { s.w += 1 } else if game.score == 0.5 { s.d += 1 } else { s.l += 1 }
        if let Some(e) = game.opp_elo { s.perf_sum += e as f64 + 400.0 * (2.0 * game.score - 1.0); s.perf_n += 1; }
        *s.moves.entry(san).or_default() += 1;
    }
    out.positions = by_pos.into_iter().filter_map(|(z, s)| {
        let mut moves: Vec<(String, i64)> = s.moves.into_iter().collect();
        moves.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Some(PositionMine {
            key: keys.get(&z)?.clone(),
            mine: Mine {
                games: s.games, w: s.w, d: s.d, l: s.l,
                perf: (s.perf_n >= 3).then(|| (s.perf_sum / s.perf_n as f64).round() as i32),
                moves,
            },
        })
    }).collect();
    out.ms = started.elapsed().as_millis() as i64;
    Ok(out)
}

// ── Settings ─────────────────────────────────────────────────────────────────

/// The repertoire's settings, on the Maintenance page; kept in
/// repertoire.json in the data directory.
#[derive(Clone, Copy, Debug, Serialize, serde::Deserialize, PartialEq)]
#[serde(default)]
pub struct RepertoireSettings {
    /// One's own games count from this many months back; 0 = all of them.
    pub own_games_months: u32,
}

impl Default for RepertoireSettings {
    fn default() -> Self { Self { own_games_months: 12 } }
}

static SETTINGS_FILE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
static SETTINGS: std::sync::RwLock<Option<RepertoireSettings>> = std::sync::RwLock::new(None);

/// Where the settings live; read them. Called once when the server starts.
pub fn init_settings(data_dir: &std::path::Path) {
    let file = data_dir.join("repertoire.json");
    let loaded = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let _ = SETTINGS_FILE.set(file);
    *SETTINGS.write().unwrap() = Some(loaded);
}

pub fn settings() -> RepertoireSettings {
    SETTINGS.read().unwrap().unwrap_or_default()
}

pub fn set_settings(mut new: RepertoireSettings) -> Result<RepertoireSettings, String> {
    new.own_games_months = new.own_games_months.min(600);
    if let Some(file) = SETTINGS_FILE.get() {
        let json = serde_json::to_string_pretty(&new).map_err(|e| e.to_string())?;
        std::fs::write(file, json).map_err(|e| format!("{}: {e}", file.display()))?;
    }
    *SETTINGS.write().unwrap() = Some(new);
    Ok(new)
}

// ── Stored analyses ──────────────────────────────────────────────────────────

/// Analyse a chapter for practice and keep the result: the figures of
/// [`chapter_stats`], from the chapter as it is now. Made again only when
/// asked — never by itself.
pub fn analyse_chapter(conn: &Connection, id: i64) -> Result<()> {
    let updated: String = conn.query_row(
        "SELECT CAST(updated_at AS VARCHAR) FROM repertoire_chapters WHERE id = ?", duckdb::params![id], |r| r.get(0))
        .map_err(|_| anyhow!("chapter {id} not found"))?;
    let positions = chapter_stats(conn, id)?;
    let hash: Option<i64> = conn.query_row("SELECT positions_hash FROM repertoire_chapters WHERE id = ?", duckdb::params![id], |r| r.get(0))?;
    conn.execute(
        "INSERT OR REPLACE INTO repertoire_analysis (chapter_id, chapter_updated, player_id, analysed_at, positions, positions_hash)
         VALUES (?, CAST(? AS TIMESTAMP), NULL, CAST(NOW() AS TIMESTAMP), ?, ?)",
        duckdb::params![id, updated, serde_json::to_string(&positions)?, hash],
    )?;
    Ok(())
}

/// A chapter's stored analysis, if it has one.
pub fn stored_analysis(conn: &Connection, id: i64) -> Result<Option<Analysis>> {
    let row = conn.query_row(
        "SELECT CAST(analysed_at AS VARCHAR), CAST(chapter_updated AS VARCHAR), positions FROM repertoire_analysis WHERE chapter_id = ?",
        duckdb::params![id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
    );
    match row {
        Ok((at, version, json)) => Ok(Some(Analysis {
            analysed_at: Some(at), chapter_updated: Some(version),
            positions: serde_json::from_str(&json).context("reading a stored analysis")?,
        })),
        Err(duckdb::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn strip_marks(san: &str) -> &str {
    san.trim_end_matches(['+', '#', '!', '?'])
}

/// The cloud evaluations kept in the database for these positions (a list of
/// hashes, as SQL): Lichess's first line where there is one, else chessdb's
/// best move — both turned to White's side.
fn stored_evals(conn: &Connection, list: &str, black_to_move: &std::collections::HashSet<i64>) -> Result<std::collections::HashMap<i64, Eval>> {
    use crate::cloud_eval::{CloudEval, LichessEval};
    let mut out = std::collections::HashMap::new();
    let mut stmt = conn.prepare(&format!(
        "SELECT service, zobrist, body FROM cloud_evals WHERE service IN ('lichess', 'chessdb') AND zobrist IN ({list}) ORDER BY service DESC"))?;
    // 'lichess' sorts after 'chessdb': DESC puts it first, and the first kept wins.
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?;
    for row in rows {
        let (service, z, body) = row?;
        if out.contains_key(&z) { continue; }
        let eval = if service == "lichess" {
            serde_json::from_str::<LichessEval>(&body).ok()
                .filter(|e| e.status == "ok")
                .and_then(|e| e.lines.into_iter().next())
                .and_then(|l| l.mate.map(|mate| Eval::Mate { mate }).or(l.eval_cp.map(|cp| Eval::Cp { cp })))
        } else {
            let sign = if black_to_move.contains(&z) { -1 } else { 1 };
            serde_json::from_str::<CloudEval>(&body).ok()
                .filter(|e| e.status == "ok")
                .and_then(|e| e.moves.into_iter().next())
                .map(|m| match m.mate { Some(mate) => Eval::Mate { mate: sign * mate }, None => Eval::Cp { cp: sign * m.score_cp } })
        };
        if let Some(e) = eval { out.insert(z, e); }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_every_variation_and_the_off_switch() {
        // Main line 1.e4 e5 2.Nf3; a variation 1...c5 switched off, with a
        // reply; a variation 2.Nc3 on.
        let w = walk("1. e4 e5 (1... c5 {[%rep off]} 2. Nf3) 2. Nf3 (2. Nc3 Nf6) *").unwrap();
        assert_eq!(w.lines, 3);
        assert_eq!(w.lines_off, 1);
        let by_move: Vec<(i16, &str, bool)> = w.rows.iter().map(|r| (r.ply, r.next_move.as_str(), r.active)).collect();
        assert!(by_move.contains(&(0, "e4", true)));
        assert!(by_move.contains(&(1, "e5", true)));
        assert!(by_move.contains(&(1, "c5", false)), "{by_move:?}");
        assert!(by_move.contains(&(2, "Nf3", false)), "the reply to the off move is off too: {by_move:?}");
        assert!(by_move.contains(&(2, "Nc3", true)));
        assert!(by_move.contains(&(3, "Nf6", true)));
        assert_eq!(w.rows[0].mover, "white");
    }

    #[test]
    fn a_chapters_figures_come_from_the_games() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let book = create_book(&conn, "B", "white", None, None, None).unwrap();
        let ch = add_chapters(&conn, book.id, Some("Ch"), Some("1. e4 e5 (1... c5) *"), None).unwrap().remove(0);

        let start = Chess::default();
        let z0 = start.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;
        let mut after_e4 = start.clone();
        let e4 = shakmaty::san::San::from_ascii(b"e4").unwrap().to_move(&after_e4).unwrap();
        after_e4.play_unchecked(e4);
        let z1 = after_e4.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;

        // Three games from the start: e4 won and drew, d4 lost; after 1.e4, c5
        // (written with a check mark by its source) and e5. Game 9 is an
        // engine game: left out.
        conn.execute_batch(&format!("
            INSERT INTO players (id, name, name_normalized) VALUES (1, 'A', 'a'), (2, 'B', 'b');
            INSERT INTO games (id, white_id, black_id, result, pgn) VALUES
              (1, 1, 2, '1-0', ''), (2, 1, 2, '1/2-1/2', ''), (3, 1, 2, '0-1', ''), (9, 1, 2, '1-0', '');
            INSERT INTO engine_games (game_id) VALUES (9);
            INSERT INTO positions (game_id, move_number, zobrist_hash, next_move) VALUES
              (1, 0, {z0}, 'e4'), (2, 0, {z0}, 'e4'), (3, 0, {z0}, 'd4'), (9, 0, {z0}, 'd4'),
              (1, 1, {z1}, 'c5+'), (2, 1, {z1}, 'e5');
            INSERT INTO cloud_evals (service, zobrist, body, fetched) VALUES
              ('lichess', {z1}, '{{\"status\":\"ok\",\"depth\":40,\"knodes\":1,\"lines\":[{{\"evalCp\":25,\"mate\":null,\"pvUci\":[]}}]}}', 0);
        ")).unwrap();

        let stats = chapter_stats(&conn, ch.id).unwrap();
        let at = |key: &str| stats.iter().find(|s| s.key == key).unwrap_or_else(|| panic!("{key} in {stats:?}"));
        let s0 = at("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq");
        assert_eq!(s0.games, 3, "the engine game is left out");
        assert_eq!(s0.moves, vec![
            MoveStat { san: "e4".into(), games: 2, score: 0.75 },
            MoveStat { san: "d4".into(), games: 1, score: 0.0 },
        ]);
        assert_eq!(s0.zobrist, format!("{:016x}", z0 as u64));
        assert_eq!(s0.eval, None);
        let s1 = at("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq");
        assert_eq!(s1.moves.iter().map(|m| m.san.as_str()).collect::<Vec<_>>(), vec!["c5", "e5"], "check marks stripped");
        assert_eq!(s1.moves[0].score, 0.0, "c5 lost: scored for Black");
        assert_eq!(s1.eval, Some(Eval::Cp { cp: 25 }));
        // The ends of the lines are there too, without games.
        assert_eq!(stats.len(), 4);
        assert!(stats.iter().any(|s| s.key.ends_with(" w KQkq") && s.key.contains("2p5") && s.games == 0));
    }

    #[test]
    fn ones_own_games_live_and_a_stored_analysis() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let book = create_book(&conn, "B", "black", None, None, None).unwrap();
        let ch = add_chapters(&conn, book.id, Some("Ch"), Some("1. e4 e6 *"), None).unwrap().remove(0);
        let start = Chess::default();
        let z0 = start.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;
        let mut after = start.clone();
        after.play_unchecked(shakmaty::san::San::from_ascii(b"e4").unwrap().to_move(&after).unwrap());
        let z1 = after.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;
        // Player 1 as Black: a win (e6) and a loss (c5) this month, a draw
        // (e6) years ago; as White, a game that does not count for a Black
        // book.
        conn.execute_batch(&format!("
            INSERT INTO players (id, name, name_normalized) VALUES (1, 'Me', 'me'), (2, 'B', 'b');
            INSERT INTO games (id, white_id, black_id, white_elo, black_elo, date, result, pgn) VALUES
              (1, 2, 1, 2000, 1900, CAST(current_date AS VARCHAR), '0-1', ''),
              (2, 2, 1, 2100, 1900, CAST(current_date AS VARCHAR), '1-0', ''),
              (3, 2, 1, 2200, 1900, '1993-05-01', '1/2-1/2', ''),
              (4, 1, 2, NULL, NULL, CAST(current_date AS VARCHAR), '1-0', '');
            INSERT INTO positions (game_id, move_number, zobrist_hash, next_move) VALUES
              (1, 0, {z0}, 'e4'), (1, 1, {z1}, 'e6'),
              (2, 0, {z0}, 'e4'), (2, 1, {z1}, 'c5+'),
              (3, 0, {z0}, 'e4'), (3, 1, {z1}, 'e6'),
              (4, 0, {z0}, 'e4'), (4, 1, {z1}, 'e5');
        ")).unwrap();

        // The last 12 months (the default): games 1 and 2.
        let live = chapter_mine(&conn, ch.id, 1).unwrap();
        assert_eq!((live.color.as_str(), live.months, live.games), ("black", 12, 2));
        assert!(live.since.is_some());
        let after_e4 = live.positions.iter().find(|p| p.key.ends_with(" b KQkq")).unwrap();
        assert_eq!(after_e4.mine, Mine {
            games: 2, w: 1, d: 0, l: 1,
            perf: None, // two rated opponents: too few
            moves: vec![("c5".to_string(), 1), ("e6".to_string(), 1)],
        });

        // All of them: the old draw too, never the game as White.
        set_settings(RepertoireSettings { own_games_months: 0 }).unwrap();
        let all = chapter_mine(&conn, ch.id, 1).unwrap();
        set_settings(RepertoireSettings::default()).unwrap();
        assert_eq!((all.games, all.since.clone()), (3, None));
        let m = &all.positions.iter().find(|p| p.key.ends_with(" b KQkq")).unwrap().mine;
        assert_eq!((m.games, m.w, m.d, m.l), (3, 1, 1, 1));
        assert_eq!(m.perf, Some(2100), "(2000+400) + (2100-400) + 2200, over three");
        assert!(!m.moves.iter().any(|(san, _)| san == "e5"), "the game as White does not count");

        // The stored analysis: nothing until asked; then the list shows when,
        // and from which version of the chapter.
        assert!(stored_analysis(&conn, ch.id).unwrap().is_none());
        assert_eq!(get_chapter_summary(&conn, ch.id).unwrap().analysed_at, None);
        analyse_chapter(&conn, ch.id).unwrap();
        let a = stored_analysis(&conn, ch.id).unwrap().unwrap();
        assert_eq!(a.positions.len(), 3);
        let s = get_chapter_summary(&conn, ch.id).unwrap();
        assert!(s.analysed_at.is_some());
        assert_eq!(s.analysis_stale, Some(false), "analysed as the chapter is now");
        // Only a comment changes (a FEN removed, say): still up to date.
        set_moves(&conn, ch.id, "1. e4 {A comment.} e6 *").unwrap();
        assert_eq!(get_chapter_summary(&conn, ch.id).unwrap().analysis_stale, Some(false), "a comment is not a change of positions");
        // A move changes: out of date.
        set_moves(&conn, ch.id, "1. e4 c5 *").unwrap();
        assert_eq!(get_chapter_summary(&conn, ch.id).unwrap().analysis_stale, Some(true), "changed since");
        // A database from before the fingerprints: filled in from the
        // chapter's moves and the analysis's positions — up to date again
        // once analysed as it is.
        analyse_chapter(&conn, ch.id).unwrap();
        conn.execute_batch("UPDATE repertoire_chapters SET positions_hash = NULL; UPDATE repertoire_analysis SET positions_hash = NULL;").unwrap();
        fill_positions_hashes(&conn).unwrap();
        assert_eq!(get_chapter_summary(&conn, ch.id).unwrap().analysis_stale, Some(false), "filled in alike");

        delete_chapter(&conn, ch.id).unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM repertoire_analysis", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "goes with its chapter");
    }

    #[test]
    fn ones_own_games_across_a_book() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let book = create_book(&conn, "French", "black", None, None, None).unwrap();
        let add = |name: &str, moves: &str| add_chapters(&conn, book.id, Some(name), Some(moves), None).unwrap().remove(0).id;
        let advance = add("Advance", "1. e4 e6 2. d4 d5 3. e5 c5 *");
        let steinitz = add("Steinitz", "1. e4 e6 2. d4 d5 3. Nc3 Nf6 *");
        // 3.Nc3 in two chapters: that position is neither's own.
        let _fort_knox = add("Fort Knox", "1. e4 e6 2. d4 d5 3. Nc3 dxe4 *");
        let kia = add("KIA", "1. e4 e6 2. d3 d5 *");
        let tarrasch = add("Tarrasch", "1. e4 e6 2. d4 d5 3. Nd2 a6 *");

        // Player 1's games as Black, this month: the Advance (won); the
        // Steinitz by transposition (drawn); a Winawer, 3...Bb4 — after a
        // 3.Nc3 two chapters share: out of the book (lost); the KIA (lost); a
        // Sicilian — not the French at all; an older 3...c5 against the
        // Tarrasch — the chapter's own position after 3.Nd2 (won).
        let games: [(&str, &str); 6] = [
            ("e4 e6 d4 d5 e5 c5", "0-1"),
            ("e4 e6 Nc3 d5 d4 Nf6", "1/2-1/2"),
            ("e4 e6 d4 d5 Nc3 Bb4", "1-0"),
            ("e4 e6 d3 d5", "1-0"),
            ("e4 c5 Nf3 d6", "0-1"),
            ("e4 e6 d4 d5 Nd2 c5 exd5", "0-1"),
        ];
        let mut sql = String::from("INSERT INTO players (id, name, name_normalized) VALUES (1, 'Me', 'me'), (2, 'O', 'o');");
        for (i, (moves, result)) in games.iter().enumerate() {
            let id = i + 1;
            sql += &format!("INSERT INTO games (id, white_id, black_id, date, result, pgn) VALUES ({id}, 2, 1, CAST(current_date AS VARCHAR), '{result}', '');");
            let mut pos = Chess::default();
            for (ply, san) in moves.split(' ').enumerate() {
                let z = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;
                sql += &format!("INSERT INTO positions (game_id, move_number, zobrist_hash, next_move) VALUES ({id}, {ply}, {z}, '{san}');");
                let m = shakmaty::san::San::from_ascii(san.as_bytes()).unwrap().to_move(&pos).unwrap();
                pos.play_unchecked(m);
            }
            // The index keeps the final position too, without a next move.
            let (ply, z) = (moves.split(' ').count(), pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64);
            sql += &format!("INSERT INTO positions (game_id, move_number, zobrist_hash, next_move) VALUES ({id}, {ply}, {z}, NULL);");
        }
        conn.execute_batch(&sql).unwrap();

        let b = book_mine(&conn, book.id, 1).unwrap();
        assert_eq!(b.games, 6);
        assert_eq!((b.in_book.games, b.in_book.w, b.in_book.d, b.in_book.l), (5, 2, 1, 2), "the Sicilian is not in the book");
        let at = |id: i64| b.chapters.iter().find(|c| c.id == id).unwrap().score.clone();
        assert_eq!((at(advance).games, at(advance).w), (1, 1));
        assert_eq!((at(steinitz).games, at(steinitz).d), (1, 1), "by transposition");
        assert_eq!((at(kia).games, at(kia).l), (1, 1));
        assert_eq!((at(tarrasch).games, at(tarrasch).w), (1, 1), "3.Nd2 is the Tarrasch's own: the older 3...c5 counts");
        assert_eq!((b.left.games, b.left.l), (1, 1), "the Winawer reached only positions two chapters share");
        assert_eq!(b.left_by, vec![("3...Bb4".to_string(), 1)]);

        // The games of a chapter, and how far each followed it: the Advance
        // game to the end of the line (the index has its last position).
        let adv = chapter_games(&conn, advance, 1).unwrap();
        assert_eq!(adv.games.len(), 1);
        assert_eq!((adv.games[0].id, adv.games[0].follow.followed), (1, "ended"));
        let st = chapter_games(&conn, steinitz, 1).unwrap();
        assert_eq!(st.games.iter().map(|g| g.id).collect::<Vec<_>>(), vec![2]);
        let ta = chapter_games(&conn, tarrasch, 1).unwrap();
        assert_eq!(ta.games.len(), 1);
        let f = &ta.games[0].follow;
        assert_eq!((f.followed, f.left_by, f.mv.as_deref()), ("left", Some("you"), Some("3...c5")));

        // The book's games: each with its chapter, the Winawer with the move
        // that left; the Sicilian not at all.
        let bg = book_games(&conn, book.id, 1).unwrap();
        let mut by: Vec<(i64, Vec<i64>, Option<String>)> = bg.games.into_iter().map(|g| (g.id, g.chapters, g.left)).collect();
        by.sort();
        assert_eq!(by, vec![
            (1, vec![advance], None), (2, vec![steinitz], None),
            (3, vec![], Some("3...Bb4".to_string())), (4, vec![kia], None),
            (6, vec![tarrasch], None),
        ]);
        // Each with how far it followed its chapter, as the chapter's list says.
        let bg = book_games(&conn, book.id, 1).unwrap();
        let adv_in_book = bg.games.iter().find(|g| g.id == 1).unwrap();
        assert_eq!(adv_in_book.follow.as_ref().map(|f| f.followed), Some(adv.games[0].follow.followed));
    }

    #[test]
    fn the_period_of_ones_own_games() {
        let d = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        assert_eq!(since_months(0, d("2026-10-01")), None, "0: all of them");
        assert_eq!(since_months(12, d("2026-10-01")).as_deref(), Some("2025-10-01"));
        assert_eq!(since_months(1, d("2026-03-31")).as_deref(), Some("2026-02-28"), "the month's last day when it has fewer");
    }

    /// How long a whole book takes to import: `LPDO_BOOK_PGN=<file>`.
    #[test]
    #[ignore]
    fn import_timing() {
        let Ok(path) = std::env::var("LPDO_BOOK_PGN") else { return };
        let text = std::fs::read_to_string(path).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let book = create_book(&conn, "B", "white", None, None, None).unwrap();
        let t = std::time::Instant::now();
        let cs = add_chapters(&conn, book.id, None, Some(&text), Some("book")).unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM repertoire_positions", [], |r| r.get(0)).unwrap();
        println!("{} chapters, {rows} positions indexed in {:.2?}", cs.len(), t.elapsed());
    }

    #[test]
    fn a_book_exported_imports_one_to_one() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let fr = create_book(&conn, "French \"Classic\"", "black", Some("GM J."), Some("Line one\nLine two"), Some("chessable.com/x")).unwrap();
        add_chapters(&conn, fr.id, None, Some("[Event \"A\"]\n\n1. e4 e6 2. d4 d5 3. e5 {Advance [%rep off]} c5 *\n\n[Event \"B\"]\n\n1. e4 e6 2. d4 d5 3. Nd2 *\n"), None).unwrap();
        let chs = list(&conn).unwrap()[0].chapters.clone();
        update_chapter(&conn, chs[1].id, ChapterPatch { active: Some(false), ..Default::default() }).unwrap();
        update_chapter(&conn, chs[0].id, ChapterPatch { name: Some("Advance".into()), ..Default::default() }).unwrap();
        let eng = create_book(&conn, "English", "white", None, None, None).unwrap();
        add_chapters(&conn, eng.id, Some("1.c4"), Some("1. c4 e5 *"), None).unwrap();
        update_book(&conn, eng.id, BookPatch { active: Some(false), ..Default::default() }).unwrap();

        let backup = all_books_pgn(&conn).unwrap();
        assert!(backup.contains("[LpdoBook \"English\"]"));

        // Into an empty database: the same books, chapters, switches.
        let empty = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&empty).unwrap();
        let made = import_books(&empty, &backup, Some("backup")).unwrap();
        assert_eq!(made.len(), 2);
        let again = list(&empty).unwrap();
        let (a, b) = (&again[0], &again[1]);
        assert_eq!((a.book.name.as_str(), a.book.color.as_str(), a.book.author.as_deref(), a.book.url.as_deref()),
                   ("French \"Classic\"", "black", Some("GM J."), Some("chessable.com/x")));
        assert_eq!(a.book.description.as_deref(), Some("Line one\nLine two"), "notes over several lines");
        assert_eq!(a.chapters.iter().map(|c| (c.name.as_str(), c.active)).collect::<Vec<_>>(), vec![("Advance", true), ("B", false)]);
        assert_eq!(a.chapters[0].lines_off, 1, "the off switch, in the moves");
        assert_eq!((b.book.name.as_str(), b.book.active, b.chapters.len()), ("English", false, 1));

        // A PGN without the tags: one book, after the file, its colour from
        // [Orientation].
        let plain = "[Event \"X\"]\n[Orientation \"black\"]\n\n1. e4 c5 *\n";
        let made = import_books(&empty, plain, Some("Najdorf")).unwrap();
        assert_eq!((made[0].name.as_str(), made[0].color.as_str()), ("Najdorf", "black"));
    }

    #[test]
    fn deleting_many_chapters_renumbers_the_rest_once() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let book = create_book(&conn, "B", "white", None, None, None).unwrap();
        let text: String = (1..=60).map(|i| format!("[Event \"C{i}\"]\n\n1. e4 e5 {i}. Nf3 *\n\n")).collect();
        let cs = add_chapters(&conn, book.id, None, Some(&text), None).unwrap();
        assert_eq!(cs.len(), 60);
        let gone: Vec<i64> = cs.iter().skip(1).step_by(2).take(25).map(|c| c.id).collect();
        let t = std::time::Instant::now();
        delete_chapters(&conn, &gone).unwrap();
        println!("25 chapters deleted in {:.2?}", t.elapsed());
        let left = &list(&conn).unwrap()[0].chapters;
        assert_eq!(left.len(), 35);
        assert_eq!(left.iter().map(|c| c.ord).collect::<Vec<_>>(), (1..=35).collect::<Vec<_>>(), "numbered 1.. again");
        assert_eq!(left[0].name, "C1");
        assert_eq!(left[1].name, "C3");
        let pos: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM repertoire_positions WHERE chapter_id IN ({})", gone.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")), [], |r| r.get(0)).unwrap();
        assert_eq!(pos, 0);
        // A move still lands where it is put.
        update_chapter(&conn, left[34].id, ChapterPatch { ord: Some(1), ..Default::default() }).unwrap();
        assert_eq!(list(&conn).unwrap()[0].chapters[0].id, left[34].id);
    }

    #[test]
    fn a_file_with_a_bad_game_imports_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let book = create_book(&conn, "B", "white", None, None, None).unwrap();
        let text = "[Event \"One\"]\n\n1. e4 e5 *\n\n[Event \"Two\"]\n\n1. e4 e4 *\n";
        assert!(add_chapters(&conn, book.id, None, Some(text), None).is_err());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM repertoire_chapters", [], |r| r.get(0)).unwrap();
        let p: i64 = conn.query_row("SELECT COUNT(*) FROM repertoire_positions", [], |r| r.get(0)).unwrap();
        assert_eq!((n, p), (0, 0), "the good first game is rolled back with the bad second");
        // And the connection is clean for the next import.
        assert_eq!(add_chapters(&conn, book.id, None, Some("1. d4 *"), None).unwrap().len(), 1);
    }

    #[test]
    fn an_illegal_move_is_refused() {
        assert!(walk("1. e4 e5 2. Ke2 Ke7 3. Kf3 Qh4").is_err() || walk("1. e4 e4").is_err());
    }

    #[test]
    fn splits_a_file_and_names_the_chapters() {
        let text = "[Event \"Najdorf: 6.Bg5\"]\n[White \"?\"]\n\n1. e4 c5 *\n\n[Event \"Test\"]\n[White \"Doe, John\"]\n[Black \"Roe, Jane\"]\n\n1. d4 *\n";
        let games = split_games(text);
        assert_eq!(games.len(), 2);
        assert_eq!(header_name(&games[0]).as_deref(), Some("6.Bg5"));
        assert_eq!(header_name(&games[1]).as_deref(), Some("Doe, John – Roe, Jane"));
        assert_eq!(header_name("[Event \"?\"]\n\n1. e4 *"), None, "nothing to name it by: the file's name, else Chapter N");
        assert_eq!(movetext_of(&games[1]), "1. d4 *");
        assert_eq!(tag(&games[1], "Black").as_deref(), Some("Roe, Jane"));
    }

    #[test]
    fn composes_headers_and_a_result() {
        let p = compose_pgn("Book \"A\"", Some("Doe, J."), 2, "Ch", "black", "1. e4");
        assert!(p.starts_with("[Event \"Book \\\"A\\\"\"]\n"));
        assert!(p.contains("[Annotator \"Doe, J.\"]\n[Orientation \"black\"]"));
        assert!(!compose_pgn("B", Some(" "), 1, "Ch", "white", "").contains("Annotator"));
        assert!(p.ends_with("\n\n1. e4 *\n"));
    }

    #[test]
    fn model_games_keep_their_headers_and_result_and_stay_out_of_the_repertoire() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let book = create_book(&conn, "1.c4 Simplified", "white", None, None, None).unwrap();
        add_chapters(&conn, book.id, Some("Theory"), Some("1. c4 e5 *"), None).unwrap();
        // As Chessable exports them: the title in [White], no result.
        let pgn = "[Event \"\"]\n[Site \"?\"]\n[Date \"2026-10-02\"]\n[Round \"?\"]\n[White \"Garry Kasparov – Nigel Short, Linares 1990\"]\n[Black \"?\"]\n[Result \"*\"]\n\n1.c4 Nc6 2.Nc3 e5 {[%cal Gd8d7] A plan.} 3.g3 g6\n\n[Event \"\"]\n[White \"Svidler – Carlsen, Grenke 2019\"]\n[Black \"?\"]\n[Result \"0-1\"]\n\n1.e4 c5 2.Nf3 Nc6 0-1\n";
        let ms = add_chapters_as(&conn, book.id, None, Some(pgn), None, true).unwrap();
        assert_eq!(ms.iter().map(|m| (m.name.as_str(), m.model, m.result.as_str())).collect::<Vec<_>>(),
                   vec![("Garry Kasparov – Nigel Short, Linares 1990", true, "*"), ("Svidler – Carlsen, Grenke 2019", true, "0-1")]);
        // Never indexed: not part of the repertoire.
        let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM repertoire_positions WHERE chapter_id IN ({}, {})", ms[0].id, ms[1].id), [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);

        // A result set, the moves edited, the book renamed: its own headers
        // stay, with the result in [Result] and after the moves.
        update_chapter(&conn, ms[0].id, ChapterPatch { result: Some("1-0".into()), ..Default::default() }).unwrap();
        assert!(update_chapter(&conn, ms[0].id, ChapterPatch { result: Some("2-0".into()), ..Default::default() }).is_err());
        set_moves(&conn, ms[0].id, "1. c4 Nc6 2. Nc3 e5 {A plan.} 3. g3 g6 4. Bg2").unwrap();
        update_book(&conn, book.id, BookPatch { name: Some("English".into()), ..Default::default() }).unwrap();
        let g = get_chapter(&conn, ms[0].id).unwrap();
        assert!(g.pgn.contains("[White \"Garry Kasparov – Nigel Short, Linares 1990\"]\n[Black \"?\"]\n[Result \"1-0\"]"), "{}", g.pgn);
        assert!(g.pgn.trim_end().ends_with("4. Bg2 1-0"), "{}", g.pgn);
        assert!(!g.pgn.contains("LPDO repertoire"));

        // Exported and imported: model games again, with their results.
        let backup = all_books_pgn(&conn).unwrap();
        assert_eq!(backup.matches("[LpdoModelGame \"1\"]").count(), 2);
        let empty = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&empty).unwrap();
        import_books(&empty, &backup, None).unwrap();
        let again = &list(&empty).unwrap()[0];
        assert_eq!(again.chapters.iter().map(|c| (c.name.as_str(), c.model, c.result.as_str())).collect::<Vec<_>>(),
                   vec![("Theory", false, "*"), ("Garry Kasparov – Nigel Short, Linares 1990", true, "1-0"), ("Svidler – Carlsen, Grenke 2019", true, "0-1")]);
        let g2 = get_chapter(&empty, again.chapters[1].id).unwrap();
        assert!(!g2.pgn.contains("[Lpdo"), "LPDO's tags are not kept in the game: {}", g2.pgn);
        assert_eq!(backup, all_books_pgn(&empty).unwrap(), "a second round trip changes nothing");

        // A chapter made a model game and back: indexed again as a chapter.
        let theory = again.chapters[0].id;
        update_chapter(&empty, theory, ChapterPatch { model: Some(true), ..Default::default() }).unwrap();
        let n: i64 = empty.query_row("SELECT COUNT(*) FROM repertoire_positions WHERE chapter_id = ?", [theory], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        let back = update_chapter(&empty, theory, ChapterPatch { model: Some(false), ..Default::default() }).unwrap();
        assert_eq!((back.model, back.result.as_str()), (false, "*"));
        let n: i64 = empty.query_row("SELECT COUNT(*) FROM repertoire_positions WHERE chapter_id = ?", [theory], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn chapters_are_ordered_within_their_places() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let book = create_book(&conn, "B", "white", None, None, None).unwrap();
        let cs = add_chapters(&conn, book.id, None, Some("[Event \"A\"]\n\n1. e4 *\n\n[Event \"M1\"]\n\n1. d4 *\n\n[Event \"B\"]\n\n1. c4 *\n\n[Event \"M2\"]\n\n1. Nf3 *\n\n[Event \"M3\"]\n\n1. g3 *\n"), None).unwrap();
        // The model games M1, M2, M3 reversed: A and B keep their places.
        order_chapters(&conn, &[cs[4].id, cs[3].id, cs[1].id]).unwrap();
        let names: Vec<String> = list(&conn).unwrap()[0].chapters.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, vec!["A", "M3", "B", "M2", "M1"]);
        assert!(order_chapters(&conn, &[cs[0].id, cs[0].id]).is_err());
    }

    #[test]
    fn model_games_with_comments_are_told_from_reference_games() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init(&conn).unwrap();
        let book = create_book(&conn, "B", "white", None, None, None).unwrap();
        add_chapters(&conn, book.id, Some("Theory"), Some("1. c4 {A comment} e5 *"), None).unwrap();
        let pgn = "[White \"Text\"]\n\n1. c4 {A plan.} e5 *\n\n\
                   [White \"Arrows\"]\n\n1. c4 {[%cal Gc4c5]} e5 *\n\n\
                   [White \"Plain\"]\n\n1. c4 e5 2. Nc3 1-0\n\n\
                   [White \"Clock\"]\n\n1. c4 { [%clk 1:30:00] } e5 { [%clk 1:29:58] [%eval 0.2] } *\n";
        add_chapters_as(&conn, book.id, None, Some(pgn), None, true).unwrap();
        let got: Vec<(String, bool)> = list(&conn).unwrap()[0].chapters.iter().map(|c| (c.name.clone(), c.annotated)).collect();
        assert_eq!(got, vec![("Theory".into(), false), ("Text".into(), true), ("Arrows".into(), true), ("Plain".into(), false), ("Clock".into(), false)]);
    }
}
