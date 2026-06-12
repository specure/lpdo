use std::ops::ControlFlow;

use pgn_reader::{Nag, RawComment, RawTag, SanPlus, Skip, Visitor};
use regex::Regex;
use shakmaty::fen::Fen;
use shakmaty::zobrist::{Zobrist64, ZobristHash};
use shakmaty::{Chess, EnPassantMode, Position};

/// Accumulated tag data between begin_tags and begin_movetext.
#[derive(Default)]
pub struct Tags {
    pub white: Option<String>,
    pub black: Option<String>,
    pub white_elo: Option<i16>,
    pub black_elo: Option<i16>,
    pub white_fide_id: Option<u32>,
    pub black_fide_id: Option<u32>,
    pub event: Option<String>,
    pub site: Option<String>,
    pub date: Option<String>,
    pub event_date: Option<String>,
    pub round: Option<String>,
    pub result: Option<String>,
    pub eco: Option<String>,
    pub chessbase_id: Option<i64>,
    pub pgn_headers: String,
    pub start_pos: Chess,
    /// True when the game starts from a non-standard position (Chess960 or
    /// mid-game fragment).  Such games are skipped by the importer.
    pub non_standard: bool,
}

/// State accumulated during move parsing.
pub struct Movetext {
    pub tags: Tags,
    pub board: Chess,
    pub moves_buf: String,
    pub move_count: i16,
    pub positions: Vec<(i16, i64, Option<String>)>, // (half-move, zobrist as signed bits, next_move SAN)
    pub max_position_depth: Option<i16>,
    pub error: bool,
    /// Nesting depth of the current variation; 0 on the main line. Moves inside
    /// variations are preserved in `moves_buf` but never counted or indexed.
    pub variation_depth: usize,
    /// Main-line SANs only — drives `opening_line` (and thus the dedup
    /// fingerprint) independently of the now-annotated `moves_buf`.
    pub main_sans: Vec<String>,
}

/// Final game data returned from end_game.
pub struct GameData {
    pub white: Option<String>,
    pub black: Option<String>,
    pub white_elo: Option<i16>,
    pub black_elo: Option<i16>,
    pub white_fide_id: Option<u32>,
    pub black_fide_id: Option<u32>,
    pub event: Option<String>,
    pub site: Option<String>,
    pub date: Option<String>,
    pub round: Option<String>,
    pub result: Option<String>,
    pub eco: Option<String>,
    pub chessbase_id: Option<i64>,
    pub pgn: String,
    pub opening_line: String,
    pub move_count: i16,
    pub positions: Vec<(i16, i64, Option<String>)>,
    pub non_standard: bool,
}

pub struct GameVisitor {
    /// None = don't collect positions; Some(n) = collect up to n half-moves.
    pub max_position_depth: Option<i16>,
}

impl GameVisitor {
    pub fn new(max_position_depth: Option<i16>) -> Self {
        Self { max_position_depth }
    }
}

impl Visitor for GameVisitor {
    type Tags = Tags;
    type Movetext = Movetext;
    type Output = Option<GameData>;

    fn begin_tags(&mut self) -> ControlFlow<Self::Output, Self::Tags> {
        ControlFlow::Continue(Tags::default())
    }

    fn tag(
        &mut self,
        tags: &mut Self::Tags,
        name: &[u8],
        value: RawTag<'_>,
    ) -> ControlFlow<Self::Output> {
        let k = std::str::from_utf8(name).unwrap_or("");
        let v = match value.decode_utf8() {
            Ok(s) => s.trim().to_string(),
            Err(_) => return ControlFlow::Continue(()),
        };

        tags.pgn_headers.push('[');
        tags.pgn_headers.push_str(k);
        tags.pgn_headers.push_str(" \"");
        // Escape backslashes and double-quotes per PGN string token spec.
        for ch in v.chars() {
            match ch {
                '\\' => tags.pgn_headers.push_str("\\\\"),
                '"'  => tags.pgn_headers.push_str("\\\""),
                _    => tags.pgn_headers.push(ch),
            }
        }
        tags.pgn_headers.push_str("\"]\n");

        match k {
            "White" => tags.white = Some(v),
            "Black" => tags.black = Some(v),
            "WhiteElo" => tags.white_elo = v.parse().ok().filter(|&e: &i16| e > 0),
            "BlackElo" => tags.black_elo = v.parse().ok().filter(|&e: &i16| e > 0),
            "WhiteFideId" => tags.white_fide_id = v.parse().ok(),
            "BlackFideId" => tags.black_fide_id = v.parse().ok(),
            "Event" => tags.event = Some(v),
            "Site" => tags.site = Some(v),
            "Date" | "UTCDate" => tags.date = Some(v.replace('.', "-")),
            "EventDate" => tags.event_date = Some(v.replace('.', "-")),
            "Round" => tags.round = Some(v),
            "Result" => tags.result = Some(v),
            "ECO" => tags.eco = Some(v),
            "GameId" => tags.chessbase_id = v.parse().ok(),
            "FEN" => {
                match v.parse::<Fen>()
                    .ok()
                    .and_then(|f| f.into_position(shakmaty::CastlingMode::Standard).ok())
                {
                    Some(pos) if pos == Chess::default() => {
                        // Explicitly set to the standard starting position — treat as normal.
                        tags.start_pos = pos;
                    }
                    Some(pos) => {
                        // Non-default starting position: mid-game fragment.
                        tags.start_pos = pos;
                        tags.non_standard = true;
                    }
                    None => {
                        // Failed to parse as standard chess — likely Chess960
                        // (file-letter castling rights such as "GEge" or "FBfb").
                        tags.non_standard = true;
                    }
                }
            }
            _ => {}
        }
        ControlFlow::Continue(())
    }

    fn begin_movetext(
        &mut self,
        tags: Self::Tags,
    ) -> ControlFlow<Self::Output, Self::Movetext> {
        let board = tags.start_pos.clone();
        let mut positions = Vec::new();

        if let Some(_depth) = self.max_position_depth {
            // Record the starting position (half-move 0)
            let hash: Zobrist64 = board.zobrist_hash(EnPassantMode::Legal);
            positions.push((0i16, hash.0 as i64, None));
        }

        ControlFlow::Continue(Movetext {
            board,
            moves_buf: String::new(),
            move_count: 0,
            positions,
            max_position_depth: self.max_position_depth,
            error: false,
            tags,
            variation_depth: 0,
            main_sans: Vec::new(),
        })
    }

    fn san(
        &mut self,
        movetext: &mut Self::Movetext,
        san_plus: SanPlus,
    ) -> ControlFlow<Self::Output> {
        if movetext.error {
            return ControlFlow::Continue(());
        }

        let san_str = san_plus.to_string();

        // The annotated movetext keeps every move, including those nested inside
        // variations.
        if !movetext.moves_buf.is_empty() {
            movetext.moves_buf.push(' ');
        }
        movetext.moves_buf.push_str(&san_str);

        // Only the main line is counted, indexed and used for the opening line /
        // dedup fingerprint. Variation moves are text-only — they never touch
        // the board or the position index.
        if movetext.variation_depth == 0 {
            movetext.move_count += 1;
            movetext.main_sans.push(san_str.clone());

            if let Some(depth) = movetext.max_position_depth {
                // Record the SAN of this move as the next_move for the last recorded position.
                // We go up to depth+1 so that the deepest recorded position also gets its next_move.
                if movetext.move_count <= depth + 1 {
                    if let Some(last) = movetext.positions.last_mut() {
                        last.2 = Some(san_str.clone());
                    }
                }
                if movetext.move_count <= depth {
                    match san_plus.san.to_move(&movetext.board) {
                        Ok(m) => {
                            movetext.board.play_unchecked(m);
                            let hash: Zobrist64 =
                                movetext.board.zobrist_hash(EnPassantMode::Legal);
                            movetext.positions.push((movetext.move_count, hash.0 as i64, None));
                        }
                        Err(_) => {
                            movetext.error = true;
                        }
                    }
                }
            }
        }

        ControlFlow::Continue(())
    }

    fn nag(&mut self, movetext: &mut Self::Movetext, nag: Nag) -> ControlFlow<Self::Output> {
        if movetext.error {
            return ControlFlow::Continue(());
        }
        if !movetext.moves_buf.is_empty() {
            movetext.moves_buf.push(' ');
        }
        movetext.moves_buf.push('$');
        movetext.moves_buf.push_str(&nag.0.to_string());
        ControlFlow::Continue(())
    }

    fn comment(
        &mut self,
        movetext: &mut Self::Movetext,
        comment: RawComment<'_>,
    ) -> ControlFlow<Self::Output> {
        if movetext.error {
            return ControlFlow::Continue(());
        }
        // Preserve the comment verbatim, minus ChessBase's whole-game eval
        // profile ([%evp ...]): a large, ChessBase-only blob nothing here
        // consumes. Everything else — free text, [%cal]/[%csl] graphics,
        // [%clk]/[%emt]/[%eval]/[%mdl], … — is kept as-is. A comment that was
        // *only* an evp tag collapses to nothing (no empty `{}`).
        let raw = String::from_utf8_lossy(comment.as_bytes());
        let cleaned = strip_evp(&raw);
        let cleaned = cleaned.trim();
        if cleaned.is_empty() {
            return ControlFlow::Continue(());
        }
        if !movetext.moves_buf.is_empty() {
            movetext.moves_buf.push(' ');
        }
        movetext.moves_buf.push('{');
        movetext.moves_buf.push_str(cleaned);
        movetext.moves_buf.push('}');
        ControlFlow::Continue(())
    }

    fn begin_variation(
        &mut self,
        movetext: &mut Self::Movetext,
    ) -> ControlFlow<Self::Output, Skip> {
        if movetext.error {
            return ControlFlow::Continue(Skip(true));
        }
        if !movetext.moves_buf.is_empty() {
            movetext.moves_buf.push(' ');
        }
        movetext.moves_buf.push('(');
        movetext.variation_depth += 1;
        ControlFlow::Continue(Skip(false)) // descend so the variation is preserved
    }

    fn end_variation(&mut self, movetext: &mut Self::Movetext) -> ControlFlow<Self::Output> {
        if movetext.error {
            return ControlFlow::Continue(());
        }
        movetext.moves_buf.push(')');
        movetext.variation_depth = movetext.variation_depth.saturating_sub(1);
        ControlFlow::Continue(())
    }

    fn end_game(&mut self, movetext: Self::Movetext) -> Self::Output {
        let t = movetext.tags;
        if t.white.is_none() || t.black.is_none() {
            return None;
        }
        let pgn = format!("{}\n{}", t.pgn_headers, movetext.moves_buf);
        let opening_line = movetext.main_sans
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");

        let current_year = {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            1970 + (secs / 31_557_600) as u32 // approximate, good enough
        };
        let year_valid = |d: &str| -> bool {
            d.get(..4)
                .and_then(|y| y.parse::<u32>().ok())
                .map(|y| y >= 1000 && y <= current_year + 1)
                .unwrap_or(false)
        };
        let resolved_date = match &t.date {
            Some(d) if year_valid(d) => t.date.clone(),
            _ => t.event_date.filter(|d| year_valid(d)),
        };

        Some(GameData {
            white: t.white,
            black: t.black,
            white_elo: t.white_elo,
            black_elo: t.black_elo,
            white_fide_id: t.white_fide_id,
            black_fide_id: t.black_fide_id,
            event: t.event,
            site: t.site,
            date: resolved_date,
            round: t.round,
            result: t.result,
            eco: t.eco,
            chessbase_id: t.chessbase_id,
            pgn,
            opening_line,
            move_count: movetext.move_count,
            positions: movetext.positions,
            non_standard: t.non_standard,
        })
    }
}

/// Remove ChessBase `[%evp ...]` evaluation-profile tags from a comment body.
/// Case-insensitive; leaves all other `[%...]` directives untouched.
fn strip_evp(comment: &str) -> std::borrow::Cow<'_, str> {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)\[%evp\b[^\]]*\]").unwrap());
    re.replace_all(comment, "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pgn_reader::Reader;
    use std::io::Cursor;

    fn parse_one(pgn: &str) -> GameData {
        let mut visitor = GameVisitor::new(Some(40));
        let mut reader = Reader::new(Cursor::new(pgn.as_bytes()));
        reader
            .read_game(&mut visitor)
            .expect("read")
            .flatten()
            .expect("a game with White & Black tags")
    }

    #[test]
    fn preserves_comments_nags_and_variations() {
        let pgn = "[White \"A\"]\n[Black \"B\"]\n\n\
            1. e4 {good} $1 (1. d4 {alt} d5) e5 2. Nf3 Nc6 *\n";
        let g = parse_one(pgn);
        assert!(g.pgn.contains("{good}"), "comment kept: {}", g.pgn);
        assert!(g.pgn.contains("$1"), "nag kept: {}", g.pgn);
        assert!(g.pgn.contains('(') && g.pgn.contains(')'), "variation kept: {}", g.pgn);
        assert!(g.pgn.contains("d4") && g.pgn.contains("{alt}"), "variation body kept: {}", g.pgn);
        // Main line only: e4 e5 Nf3 Nc6 — the d4/d5 variation is not counted.
        assert_eq!(g.move_count, 4, "main-line move count");
        assert_eq!(g.opening_line, "e4 e5 Nf3 Nc6");
        // Positions: start + 4 main-line moves, none from the variation.
        assert_eq!(g.positions.len(), 5);
    }

    #[test]
    fn opening_line_stable_for_fingerprint() {
        // The same game with and without annotations must share an opening_line
        // so dedup still collapses them to one row.
        let annotated =
            parse_one("[White \"A\"]\n[Black \"B\"]\n\n1. e4 {x} e5 (1... c5) 2. Nf3 *\n");
        let plain = parse_one("[White \"A\"]\n[Black \"B\"]\n\n1. e4 e5 2. Nf3 *\n");
        assert_eq!(annotated.opening_line, plain.opening_line);
        assert_eq!(annotated.opening_line, "e4 e5 Nf3");
    }

    #[test]
    fn drops_evp_keeps_other_directives() {
        let pgn = "[White \"A\"]\n[Black \"B\"]\n\n\
            { [%evp 0,38,28,30] } 1. e4 { [%cal Ge2e4] keep me } e5 *\n";
        let g = parse_one(pgn);
        assert!(!g.pgn.contains("%evp"), "evp dropped: {}", g.pgn);
        assert!(!g.pgn.contains("0,38"), "evp payload dropped: {}", g.pgn);
        // A pure-evp start comment leaves no empty comment block.
        assert!(!g.pgn.contains("{}"), "no empty comment: {}", g.pgn);
        // Other directives and free text survive verbatim.
        assert!(g.pgn.contains("[%cal Ge2e4]"), "cal kept: {}", g.pgn);
        assert!(g.pgn.contains("keep me"), "text kept: {}", g.pgn);
    }
}
