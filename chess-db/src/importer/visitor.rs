use std::ops::ControlFlow;

use pgn_reader::{RawTag, SanPlus, Skip, Visitor};
use shakmaty::fen::Fen;
use shakmaty::zobrist::{Zobrist64, ZobristHash};
use shakmaty::{Chess, EnPassantMode, Position};

/// Accumulated tag data between begin_tags and begin_movetext.
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

impl Default for Tags {
    fn default() -> Self {
        Self {
            white: None,
            black: None,
            white_elo: None,
            black_elo: None,
            white_fide_id: None,
            black_fide_id: None,
            event: None,
            site: None,
            date: None,
            event_date: None,
            round: None,
            result: None,
            eco: None,
            chessbase_id: None,
            pgn_headers: String::new(),
            start_pos: Chess::default(),
            non_standard: false,
        }
    }
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

        if !movetext.moves_buf.is_empty() {
            movetext.moves_buf.push(' ');
        }
        movetext.moves_buf.push_str(&san_plus.to_string());
        movetext.move_count += 1;

        if let Some(depth) = movetext.max_position_depth {
            // Record the SAN of this move as the next_move for the last recorded position.
            // We go up to depth+1 so that the deepest recorded position also gets its next_move.
            if movetext.move_count <= depth + 1 {
                if let Some(last) = movetext.positions.last_mut() {
                    last.2 = Some(san_plus.to_string());
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

        ControlFlow::Continue(())
    }

    fn begin_variation(
        &mut self,
        _movetext: &mut Self::Movetext,
    ) -> ControlFlow<Self::Output, Skip> {
        ControlFlow::Continue(Skip(true)) // skip variations
    }

    fn end_game(&mut self, movetext: Self::Movetext) -> Self::Output {
        let t = movetext.tags;
        if t.white.is_none() || t.black.is_none() {
            return None;
        }
        let pgn = format!("{}\n{}", t.pgn_headers, movetext.moves_buf);
        let opening_line = movetext.moves_buf
            .split_whitespace()
            .take(10)
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
