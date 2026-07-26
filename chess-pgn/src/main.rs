//! Thin CLI over [`chess_pgn`] for standalone use and manual testing (#104):
//!
//!   chess-pgn <file.pgn>                 # game count
//!   chess-pgn <file.pgn> <name>          # first 20 games with <name> as a player
//!   chess-pgn <file.pgn> --game <id>     # print one game's PGN by index

use std::path::Path;
use std::process::ExitCode;

use chess_pgn::{PgnIndex, Query};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: chess-pgn <file.pgn> [<name> | --game <id>]");
        return ExitCode::FAILURE;
    };

    let index = match PgnIndex::open(Path::new(&path)) {
        Ok(idx) => idx,
        Err(e) => {
            eprintln!("{path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    // CLI indexes the whole file up front (no background/growing here).
    if let Err(e) = index.index_blocking() {
        eprintln!("{path}: {e}");
        return ExitCode::FAILURE;
    }
    println!("{} games", index.len());

    match args.next().as_deref() {
        Some("--game") => {
            let id: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            match index.game_pgn(id) {
                Ok(pgn) => println!("{pgn}"),
                Err(e) => {
                    eprintln!("game {id}: {e}");
                    return ExitCode::FAILURE;
                }
            }
        }
        Some(name) => {
            let result = index.query(&Query { player1: Some(name.to_string()), limit: 20, ..Default::default() });
            println!("{} matched (showing up to 20):", result.matched);
            for row in result.rows {
                println!(
                    "  [{}] {} – {} | {} | {}",
                    row.id,
                    row.white,
                    row.black,
                    row.event.unwrap_or_default(),
                    row.date.unwrap_or_default(),
                );
            }
        }
        None => {}
    }

    ExitCode::SUCCESS
}
