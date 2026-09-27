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
    pub description: Option<String>,
    pub url: Option<String>,
    pub ord: i64,
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
    pub description: Option<Option<String>>,
    pub url: Option<Option<String>>,
    pub ord: Option<i64>,
}

#[derive(Default)]
pub struct ChapterPatch {
    pub name: Option<String>,
    pub ord: Option<i64>,
    pub active: Option<bool>,
    pub book_id: Option<i64>,
}

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
        self.rows.push(PositionRow { zobrist, ply: f.ply, next_move: canonical, mover, active: !f.off });
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
        let inner = t.trim_start_matches('[').trim_end_matches(']');
        let (n, v) = inner.split_once(' ')?;
        if n == name {
            let v = v.trim().trim_matches('"').replace("\\\"", "\"").replace("\\\\", "\\");
            return Some(v);
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
/// players where they are names, else the event, else "Chapter N".
pub fn chapter_name_from(pgn: &str, n: usize) -> String {
    if let Some(c) = tag(pgn, "ChapterName").filter(|s| !s.trim().is_empty()) { return c; }
    let event = tag(pgn, "Event").unwrap_or_default();
    if let Some((_, chapter)) = event.split_once(": ") {
        if !chapter.trim().is_empty() { return chapter.trim().to_string(); }
    }
    let real = |s: Option<String>| s.filter(|v| !v.trim().is_empty() && v.trim() != "?");
    match (real(tag(pgn, "White")), real(tag(pgn, "Black"))) {
        (Some(w), Some(b)) => return format!("{w} – {b}"),
        (Some(w), None) => return w,
        _ => {}
    }
    if !event.trim().is_empty() && event.trim() != "?" { return event.trim().to_string(); }
    format!("Chapter {n}")
}

/// A chapter's PGN: its headers — what the Analysis page shows in place of
/// the players — and the movetext.
fn compose_pgn(book: &str, ord: i64, chapter: &str, color: &str, movetext: &str) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let mut body = movetext.trim().to_string();
    if !["1-0", "0-1", "1/2-1/2", "*"].iter().any(|r| body.ends_with(r)) {
        if !body.is_empty() { body.push(' '); }
        body.push('*');
    }
    format!(
        "[Event \"{}\"]\n[Site \"LPDO repertoire\"]\n[Round \"{}\"]\n[White \"{}\"]\n[Black \"?\"]\n[Result \"*\"]\n[Orientation \"{}\"]\n\n{}\n",
        esc(book), ord, esc(chapter), color, body
    )
}

// ── Database ─────────────────────────────────────────────────────────────────

fn book_row(r: &duckdb::Row<'_>) -> duckdb::Result<Book> {
    Ok(Book { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, description: r.get(3)?, url: r.get(4)?, ord: r.get(5)? })
}

const BOOK_COLS: &str = "id, name, color, description, url, ord";

fn chapter_row(r: &duckdb::Row<'_>) -> duckdb::Result<ChapterSummary> {
    Ok(ChapterSummary {
        id: r.get(0)?, book_id: r.get(1)?, ord: r.get(2)?, name: r.get(3)?, active: r.get(4)?,
        lines: r.get(5)?, lines_off: r.get(6)?, updated_at: r.get(7)?,
    })
}

const CHAPTER_COLS: &str = "id, book_id, ord, name, active, lines, lines_off, CAST(updated_at AS VARCHAR)";

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

pub fn create_book(conn: &Connection, name: &str, color: &str, description: Option<&str>, url: Option<&str>) -> Result<Book> {
    let name = name.trim();
    if name.is_empty() { bail!("the book needs a name"); }
    valid_color(color)?;
    let id = crate::db::ids::next_id(conn, "repertoire_books")? as i64;
    let ord: i64 = conn.query_row("SELECT COALESCE(MAX(ord), 0) + 1 FROM repertoire_books", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO repertoire_books (id, name, color, description, url, ord, created_at) VALUES (?, ?, ?, ?, ?, ?, CAST(NOW() AS TIMESTAMP))",
        duckdb::params![id, name, color, description, url, ord],
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
    for (i, bid) in ids.iter().enumerate() {
        conn.execute("UPDATE repertoire_books SET ord = ? WHERE id = ?", duckdb::params![i as i64 + 1, bid])?;
    }
    Ok(())
}

pub fn update_book(conn: &Connection, id: i64, patch: BookPatch) -> Result<Book> {
    let before = get_book(conn, id)?;
    if let Some(n) = &patch.name { if n.trim().is_empty() { bail!("the book needs a name"); } }
    if let Some(c) = &patch.color { valid_color(c)?; }
    let name = patch.name.as_deref().map(str::trim).unwrap_or(&before.name).to_string();
    let color = patch.color.clone().unwrap_or(before.color.clone());
    let description = patch.description.clone().unwrap_or(before.description.clone());
    let url = patch.url.clone().unwrap_or(before.url.clone());
    conn.execute(
        "UPDATE repertoire_books SET name = ?, color = ?, description = ?, url = ? WHERE id = ?",
        duckdb::params![name, color, description, url, id],
    )?;
    if let Some(to) = patch.ord { place_book(conn, Some((id, to)))?; }
    // The chapters' headers carry the book's name and colour.
    if name != before.name || color != before.color {
        let mut st = conn.prepare("SELECT id, ord, name, pgn FROM repertoire_chapters WHERE book_id = ?")?;
        let rows: Vec<(i64, i64, String, String)> = st.query_map(duckdb::params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<duckdb::Result<_>>()?;
        for (cid, ord, cname, pgn) in rows {
            let pgn = compose_pgn(&name, ord, &cname, &color, &movetext_of(&pgn));
            conn.execute("UPDATE repertoire_chapters SET pgn = ? WHERE id = ?", duckdb::params![pgn, cid])?;
        }
    }
    get_book(conn, id)
}

pub fn delete_book(conn: &Connection, id: i64) -> Result<()> {
    get_book(conn, id)?;
    conn.execute("DELETE FROM repertoire_positions WHERE chapter_id IN (SELECT id FROM repertoire_chapters WHERE book_id = ?)", duckdb::params![id])?;
    conn.execute("DELETE FROM repertoire_chapters WHERE book_id = ?", duckdb::params![id])?;
    conn.execute("DELETE FROM repertoire_books WHERE id = ?", duckdb::params![id])?;
    place_book(conn, None)
}

fn reindex(conn: &Connection, chapter_id: i64, active: bool, walk: &Walk) -> Result<()> {
    conn.execute("DELETE FROM repertoire_positions WHERE chapter_id = ?", duckdb::params![chapter_id])?;
    let mut st = conn.prepare(
        "INSERT INTO repertoire_positions (chapter_id, zobrist_hash, ply, next_move, mover, active) VALUES (?, ?, ?, ?, ?, ?)",
    )?;
    for r in &walk.rows {
        st.execute(duckdb::params![chapter_id, r.zobrist, r.ply, r.next_move, r.mover, active && r.active])?;
    }
    Ok(())
}

/// Add chapters to a book: one empty chapter named `name`, or one chapter
/// per game of `pgn` (a file's worth), named from their headers — or `name`
/// when there is one game and a name.
pub fn add_chapters(conn: &Connection, book_id: i64, name: Option<&str>, pgn: Option<&str>) -> Result<Vec<ChapterSummary>> {
    let book = get_book(conn, book_id)?;
    let games: Vec<String> = match pgn.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            let g = split_games(p);
            if g.is_empty() { bail!("no games in the PGN"); }
            g
        }
        None => vec![String::new()],
    };
    let single = games.len() == 1;
    let mut out = Vec::new();
    for (i, game) in games.iter().enumerate() {
        let movetext = movetext_of(game);
        let walk = walk(&movetext).with_context(|| format!("game {} of the PGN", i + 1))?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM repertoire_chapters WHERE book_id = ?", duckdb::params![book_id], |r| r.get(0))?;
        let cname = match name.map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) if single => n.to_string(),
            _ if game.trim().is_empty() => format!("Chapter {}", count + 1),
            _ => chapter_name_from(game, count as usize + 1),
        };
        let ord: i64 = conn.query_row("SELECT COALESCE(MAX(ord), 0) + 1 FROM repertoire_chapters WHERE book_id = ?", duckdb::params![book_id], |r| r.get(0))?;
        let id = crate::db::ids::next_id(conn, "repertoire_chapters")? as i64;
        let full = compose_pgn(&book.name, ord, &cname, &book.color, &movetext);
        conn.execute(
            "INSERT INTO repertoire_chapters (id, book_id, ord, name, active, pgn, lines, lines_off, updated_at) VALUES (?, ?, ?, ?, TRUE, ?, ?, ?, CAST(NOW() AS TIMESTAMP))",
            duckdb::params![id, book_id, ord, cname, full, walk.lines, walk.lines_off],
        )?;
        crate::db::ids::raise_high_water(conn, "repertoire_chapters", id as u32)?;
        reindex(conn, id, true, &walk)?;
        out.push(get_chapter_summary(conn, id)?);
    }
    Ok(out)
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
    for (i, cid) in ids.iter().enumerate() {
        conn.execute("UPDATE repertoire_chapters SET ord = ? WHERE id = ?", duckdb::params![i as i64 + 1, cid])?;
    }
    Ok(())
}

pub fn update_chapter(conn: &Connection, id: i64, patch: ChapterPatch) -> Result<ChapterSummary> {
    let before = get_chapter_summary(conn, id)?;
    if let Some(n) = &patch.name { if n.trim().is_empty() { bail!("the chapter needs a name"); } }
    let name = patch.name.as_deref().map(str::trim).unwrap_or(&before.name).to_string();
    let active = patch.active.unwrap_or(before.active);
    let book_id = patch.book_id.unwrap_or(before.book_id);
    let book = get_book(conn, book_id)?;
    conn.execute(
        "UPDATE repertoire_chapters SET name = ?, active = ?, book_id = ? WHERE id = ?",
        duckdb::params![name, active, book_id, id],
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
    // The headers carry the chapter's name and order and the book's.
    let pgn: String = conn.query_row("SELECT pgn FROM repertoire_chapters WHERE id = ?", duckdb::params![id], |r| r.get(0))?;
    let movetext = movetext_of(&pgn);
    let full = compose_pgn(&book.name, after.ord, &after.name, &book.color, &movetext);
    conn.execute("UPDATE repertoire_chapters SET pgn = ? WHERE id = ?", duckdb::params![full, id])?;
    if active != before.active {
        let w = walk(&movetext)?;
        reindex(conn, id, active, &w)?;
    }
    get_chapter_summary(conn, id)
}

/// Save a chapter's moves (the editor's target) and index its positions.
pub fn set_moves(conn: &Connection, id: i64, movetext: &str) -> Result<ChapterSummary> {
    let before = get_chapter_summary(conn, id)?;
    let book = get_book(conn, before.book_id)?;
    let w = walk(movetext)?;
    let full = compose_pgn(&book.name, before.ord, &before.name, &book.color, movetext);
    conn.execute(
        "UPDATE repertoire_chapters SET pgn = ?, lines = ?, lines_off = ?, updated_at = CAST(NOW() AS TIMESTAMP) WHERE id = ?",
        duckdb::params![full, w.lines, w.lines_off, id],
    )?;
    reindex(conn, id, before.active, &w)?;
    get_chapter_summary(conn, id)
}

pub fn delete_chapter(conn: &Connection, id: i64) -> Result<()> {
    let c = get_chapter_summary(conn, id)?;
    conn.execute("DELETE FROM repertoire_positions WHERE chapter_id = ?", duckdb::params![id])?;
    conn.execute("DELETE FROM repertoire_chapters WHERE id = ?", duckdb::params![id])?;
    place_chapter(conn, c.book_id, None)
}

/// A chapter's PGN, or a whole book's — its chapters in order.
pub fn chapter_pgn(conn: &Connection, id: i64) -> Result<String> {
    Ok(get_chapter(conn, id)?.pgn)
}

pub fn book_pgn(conn: &Connection, id: i64) -> Result<String> {
    get_book(conn, id)?;
    let mut st = conn.prepare("SELECT pgn FROM repertoire_chapters WHERE book_id = ? ORDER BY ord, id")?;
    let pgns: Vec<String> = st.query_map(duckdb::params![id], |r| r.get(0))?.collect::<duckdb::Result<_>>()?;
    Ok(pgns.iter().map(|p| p.trim().to_string()).collect::<Vec<_>>().join("\n\n") + "\n")
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
    fn an_illegal_move_is_refused() {
        assert!(walk("1. e4 e5 2. Ke2 Ke7 3. Kf3 Qh4").is_err() || walk("1. e4 e4").is_err());
    }

    #[test]
    fn splits_a_file_and_names_the_chapters() {
        let text = "[Event \"Najdorf: 6.Bg5\"]\n[White \"?\"]\n\n1. e4 c5 *\n\n[Event \"Test\"]\n[White \"Doe, John\"]\n[Black \"Roe, Jane\"]\n\n1. d4 *\n";
        let games = split_games(text);
        assert_eq!(games.len(), 2);
        assert_eq!(chapter_name_from(&games[0], 1), "6.Bg5");
        assert_eq!(chapter_name_from(&games[1], 2), "Doe, John – Roe, Jane");
        assert_eq!(movetext_of(&games[1]), "1. d4 *");
        assert_eq!(tag(&games[1], "Black").as_deref(), Some("Roe, Jane"));
    }

    #[test]
    fn composes_headers_and_a_result() {
        let p = compose_pgn("Book \"A\"", 2, "Ch", "black", "1. e4");
        assert!(p.starts_with("[Event \"Book \\\"A\\\"\"]\n"));
        assert!(p.contains("[Orientation \"black\"]"));
        assert!(p.ends_with("\n\n1. e4 *\n"));
    }
}
