//! Merging two annotated copies of one game: the same main line, each copy's
//! comments, NAGs and variations kept. Re-importing your annotated game over a
//! broadcast copy keeps the broadcast's clock times and adds your notes; over a
//! bare copy it just adds them.

/// One piece of stored movetext.
#[derive(Debug, PartialEq)]
enum Token {
    Move(String),
    Comment(String),
    Nag(String),
    Variation(String),
    Result(String),
}

/// What hangs off one point of the main line: the start of the game (before
/// the first move) or a move.
#[derive(Debug, Default)]
struct Slot {
    mv: Option<String>,
    nags: Vec<String>,
    comments: Vec<String>,
    variations: Vec<String>,
}

fn tokenize(text: &str) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '{' {
            let start = i;
            while i < chars.len() && chars[i] != '}' {
                i += 1;
            }
            i = (i + 1).min(chars.len());
            out.push(Token::Comment(chars[start..i].iter().collect()));
        } else if c == ';' {
            // A rest-of-line comment, kept as a brace comment.
            let start = i + 1;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            let body: String = chars[start..i].iter().collect();
            out.push(Token::Comment(format!("{{{}}}", body.trim())));
        } else if c == '(' {
            // Balanced, skipping parentheses inside comments.
            let start = i;
            let mut depth = 0;
            let mut in_comment = false;
            while i < chars.len() {
                match chars[i] {
                    '{' if !in_comment => in_comment = true,
                    '}' if in_comment => in_comment = false,
                    '(' if !in_comment => depth += 1,
                    ')' if !in_comment => {
                        depth -= 1;
                        if depth == 0 {
                            i += 1;
                            break;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            out.push(Token::Variation(chars[start..i].iter().collect()));
        } else if c == ')' {
            i += 1; // stray
        } else {
            let start = i;
            while i < chars.len() && !chars[i].is_whitespace() && !matches!(chars[i], '{' | '(' | ')' | ';') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if word.starts_with('$') {
                out.push(Token::Nag(word));
            } else if matches!(word.as_str(), "1-0" | "0-1" | "1/2-1/2" | "*") {
                out.push(Token::Result(word));
            } else {
                // A move, possibly behind its number ("12.", "12...", "12.e4");
                // "0-0" is castling, not a number.
                let digits = word.chars().take_while(|c| c.is_ascii_digit()).count();
                let mv = if digits > 0 && word[digits..].starts_with('.') {
                    word[digits..].trim_start_matches('.')
                } else {
                    word.as_str()
                };
                if !mv.is_empty() {
                    out.push(Token::Move(mv.to_string()));
                }
            }
        }
    }
    out
}

/// The main line's slots and the result token, if the movetext ends in one.
fn slots(text: &str) -> (Vec<Slot>, Option<String>) {
    let mut slots = vec![Slot::default()];
    let mut result = None;
    for t in tokenize(text) {
        let cur = slots.last_mut().expect("a slot");
        match t {
            Token::Move(m) => slots.push(Slot { mv: Some(m), ..Slot::default() }),
            Token::Nag(n) => cur.nags.push(n),
            Token::Comment(c) => cur.comments.push(c),
            Token::Variation(v) => cur.variations.push(v),
            Token::Result(r) => result = Some(r),
        }
    }
    (slots, result)
}

fn render(slots: &[Slot], result: Option<&str>) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for s in slots {
        if let Some(mv) = &s.mv {
            parts.push(mv);
        }
        parts.extend(s.nags.iter().map(String::as_str));
        parts.extend(s.comments.iter().map(String::as_str));
        parts.extend(s.variations.iter().map(String::as_str));
    }
    if let Some(r) = result {
        parts.push(r);
    }
    parts.join(" ")
}

/// Whitespace-insensitive identity, so a comment or variation both copies carry
/// is kept once.
fn same(a: &str, b: &str) -> bool {
    a.split_whitespace().eq(b.split_whitespace())
}

/// Add to `into` what `from` has that it hasn't.
fn add_missing(into: &mut Vec<String>, from: Vec<String>) {
    for x in from {
        if !into.iter().any(|y| same(y, &x)) {
            into.push(x);
        }
    }
}

/// `existing`'s movetext with `incoming`'s comments, NAGs and variations added
/// where it lacks them, its own moves and result kept. None when the two main
/// lines don't have the same number of moves (the caller has already checked
/// they are the same moves) or when there is nothing to add.
pub fn merge_movetext(existing: &str, incoming: &str) -> Option<String> {
    let (mut base, result) = slots(existing);
    let (extra, _) = slots(incoming);
    if base.len() != extra.len() {
        return None;
    }
    let before = render(&base, result.as_deref());
    for (b, e) in base.iter_mut().zip(extra) {
        add_missing(&mut b.nags, e.nags);
        add_missing(&mut b.comments, e.comments);
        add_missing(&mut b.variations, e.variations);
    }
    let after = render(&base, result.as_deref());
    (after != before).then_some(after)
}

#[cfg(test)]
mod tests {
    use super::merge_movetext;

    #[test]
    fn notes_are_added_to_a_bare_game() {
        assert_eq!(
            merge_movetext("e4 e6 b3 d5", "e4 e6 b3 {flexible} d5 $1 (d6 Bb2)").as_deref(),
            Some("e4 e6 b3 {flexible} d5 $1 (d6 Bb2)"),
        );
    }

    #[test]
    fn a_broadcasts_clock_times_stay_beside_the_notes() {
        assert!(
            merge_movetext("e4 {[%clk 1:00:55]} e6 {[%clk 1:00:51]}", "1. e4 e6 {French!} 2. d4").is_none(),
            "a different number of moves is no merge",
        );
        assert_eq!(
            merge_movetext("e4 {[%clk 1:00:55]} e6 {[%clk 1:00:51]}", "1. e4 e6 $5 {French!}").as_deref(),
            Some("e4 {[%clk 1:00:55]} e6 $5 {[%clk 1:00:51]} {French!}"),
        );
    }

    #[test]
    fn what_both_have_is_kept_once() {
        let game = "e4 {plan: f4} e5 (c5 Nf3) Nf3";
        assert_eq!(merge_movetext(game, "1. e4 {plan:  f4} e5 (c5   Nf3) 2. Nf3"), None, "nothing to add");
        assert_eq!(
            merge_movetext(game, "e4 {other plan} e5 (e6) Nf3").as_deref(),
            Some("e4 {plan: f4} {other plan} e5 (c5 Nf3) (e6) Nf3"),
        );
    }

    #[test]
    fn a_comment_before_the_first_move_and_the_result_survive() {
        assert_eq!(
            merge_movetext("e4 e5 1-0", "{A sharp game} 1. e4 e5 1-0").as_deref(),
            Some("{A sharp game} e4 e5 1-0"),
        );
    }

    #[test]
    fn variations_with_nested_lines_and_parentheses_in_comments() {
        assert_eq!(
            merge_movetext("e4 e5", "e4 e5 (c5 {Sicilian (open)} Nf3 (c3 d5) d6)").as_deref(),
            Some("e4 e5 (c5 {Sicilian (open)} Nf3 (c3 d5) d6)"),
        );
    }
}
