# Opening repertoire — design

Tracking: [#327](https://github.com/specure/lpdo/issues/327).

An opening repertoire organised as **books** and **chapters**, loosely the
shape of an opening course — a Chessable course, a Lichess study — with the
chapters you are playing marked **active**, the lines studied with the
reference database and the engines beside them, and new lines added and
existing ones adjusted with the editor. Practice — training units taken to
the phone, see [Practice](#practice) — and the comparison of your own games
against the repertoire come later, on the same model.

## Baseline: what exists today

| Piece | State | Use here |
|---|---|---|
| PGN tree | `games.pgn` is the whole movetext; the client parses it into a tree of moves with variations, comments, NAGs, arrows and circles (`lib/parsePgnTree.ts`) and serialises it back (`lib/serializeMovetext.ts`) | a chapter is exactly one such tree |
| Editor | `MovesEditor.tsx` edits the tree without losing anything: new moves as main line or variation, promote/demote, delete from here, comments, marks, graphics; saves via `POST /games/{id}/moves` | adjusting lines, with a second save target |
| Analysis page | tabs of open games in a rail; board, move list, Reference tab (the database's moves from the position), Engine panel | the study view |
| Positions index | `positions(game_id, move_number, zobrist_hash, next_move)`, the main line only, ~40 plies | the model for a repertoire index of every variation |
| Collections | flat name tags on games; no order, kind or hierarchy | not used: books are not collections |
| Prep page | tournament and opponent prep from chess-results and the opponent's games | phase 2: the opponent's games against the active lines |

Nothing repertoire-specific exists.

## Model

- **Book** — one course or one topic: "Najdorf for Black", "Catalan (Chessable,
  Sielecki)". Has the colour you play it from, a name, an optional author,
  description and link to the course, an order among the books, and an
  active switch of its own.
- **Chapter** — an ordered section of a book, one move tree from the starting
  position (set-up positions are out of scope). Its content is a PGN game:
  moves, variations, comments, NAGs, arrows and circles — what the editor
  handles today.
- **Line** — a path from the chapter's start to a leaf of its tree. Named, as
  Chessable names them, by the move where it branches off the line before.
- **Active repertoire** — the chapters marked active in books marked active,
  less what is switched off inside them.
- **Off-switch** — a mark on any move, yours or the opponent's, meaning "not in
  my repertoire from here": the move and everything below it stay in the
  chapter, shown greyed, and count as inactive. For an alternative for your
  colour you are not following for now, or a variation you play differently
  from another book (switched off here; the other book's chapter is the active
  one for that position). Stored in the move's comment as a tag, `[%rep off]`,
  the way arrows (`[%cal]`) and circles (`[%csl]`) are, so it survives export
  and import and needs no bookkeeping outside the PGN.
- **Transpositions** — a line is studied as its chapter has it, whatever other
  chapter reaches the same position (Chessable style). A position active in two
  chapters counts in both; that matters only to the marks of phase 2.

### Tables

Separate from the games, so the games lists, statistics and duplicate
detection are untouched:

```sql
CREATE TABLE repertoire_books (
    id INTEGER PRIMARY KEY,
    name VARCHAR NOT NULL,
    color VARCHAR NOT NULL,           -- 'white' | 'black'
    author VARCHAR,
    description VARCHAR,
    url VARCHAR,                      -- the course, when there is one
    ord INTEGER NOT NULL,
    active BOOLEAN DEFAULT TRUE,      -- off: none of its chapters count
    created_at TIMESTAMP NOT NULL
);
CREATE TABLE repertoire_chapters (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    name VARCHAR NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    pgn VARCHAR NOT NULL,             -- headers + movetext, as games.pgn
    updated_at TIMESTAMP NOT NULL
);
-- Every position of every variation, for "in my repertoire" lookups (phase 2)
-- and transposition checks; rebuilt when a chapter is saved.
CREATE TABLE repertoire_positions (
    chapter_id INTEGER NOT NULL,
    zobrist_hash BIGINT NOT NULL,
    ply SMALLINT NOT NULL,
    next_move VARCHAR NOT NULL,       -- SAN
    mover VARCHAR NOT NULL,           -- 'white' | 'black': whose move next_move is
    active BOOLEAN NOT NULL           -- the book and chapter active, nothing switched off above
);
```

Ids from `id_high_water` as elsewhere. A chapter's headers carry what the
Analysis page shows in place of the players: `[Event "<book>"]`,
`[Round "<chapter order>"]`, `[White "<chapter name>"]`, and the book's colour
as `[Orientation "black"]`; the book's author, when there is one, as
`[Annotator]`.

### API

| Route | |
|---|---|
| `GET /repertoire` | books with their chapters: names, order, active, line counts (total and off) |
| `POST /repertoire/books`, `PUT /repertoire/books/{id}`, `DELETE …` | create, rename/recolour/relink/reorder, delete (with its chapters) |
| `POST /repertoire/books/{id}/chapters` | add a chapter: empty, or from PGN text; a file with several games gives one chapter per game |
| `GET /repertoire/chapters/{id}` | the chapter's PGN |
| `PUT /repertoire/chapters/{id}` | rename, reorder, move to another book, active on/off |
| `PUT /repertoire/chapters/{id}/moves` | save the movetext (the editor's second save target); reindexes `repertoire_positions` |
| `DELETE /repertoire/chapters/{id}` | |
| `GET /repertoire/books/{id}/pgn`, `GET /repertoire/chapters/{id}/pgn` | export |

Import: chapter names from the games' headers — a Lichess study export gives
`[Event "Study: Chapter"]` (the chapter part) and `[ChapterName]` where
present; otherwise `White – Black`, or the event; otherwise the name of the
file it came from. Several files can be imported at once. The book's colour
is asked for when the book is made.

## Studying a chapter

A chapter is studied **on the Repertoire page, with the Analysis page's
layout** beside the books and chapters panels (no rail of open games; the
header shows the book and chapter name in place of the players), the board
turned to the book's colour. That gives, for every position of a line, what a course cannot:
the Reference tab's moves with how often each is played, and the Engine
panel's evaluation and lines. The Analysis page's tab model gains a second kind
of document — a chapter — with its own load and save routes; the editor is
the existing one with the chapter's save target.

Two additions for reading:

- **Lines list** — a panel with the chapter's lines in order, named by their
  branching move, off ones greyed. Clicking a line puts the board on it; **→**
  steps through it and, at its end, starts the next line — the mode for
  replaying on a physical board.
- **Branch marks** — a small mark on each move in the move list that has
  alternatives (a variation there), so the places where you or the opponent
  can deviate stand out. The variations themselves are shown as today.

The off-switch is a toggle on the move in view mode (no need to enter the
editor), rendering its subtree greyed and updating the chapter's line counts.

## Repertoire page

A page of its own in the navigation: books in a panel on the left (name,
author, colour, active; the selected one's details — link, notes, counts —
under the list), the selected book's chapters in a panel beside it, in order, each with its **Active**
toggle, line counts ("12 lines, 3 off"), open, rename, reorder (drag), move to
another book, delete; add a chapter (empty, pasted PGN, PGN file); export the
book or a chapter. A **Repertoire card** on the Home page lists the active
books with their active chapter counts and opens the page.

## Practice

Learning the lines, not just reading them: **training units** planned on
the desktop, practised there or — the main case — on the phone, offline and
private. The practice today goes through ChessTempo: the chapter synced to
its servers first, online only, and other users' comments turning up on
one's own moves. That is a workaround; this replaces it.

### What a unit is

A **training unit** is a planned piece of study: the lines of a chapter (or
of several, or of one variation in a chapter) chosen for a purpose —
the topic an upcoming game suggests, a line lost in a game, a new opening,
or a systematic pass through the repertoire. The purpose is to study and
understand a line over months, not to cram for one opponent, so the
opponent's moves are weighted by the whole database; a game coming up only
picks the topic.

A unit is a **snapshot**: the lines, the chapter's comments and the
statistics of every position, as they were when it was made. Editing the
chapter afterwards does not change a unit already on the phone. On the
desktop a unit is send-and-forget: it is kept (to show again, or to note
when a topic was studied), not tracked.

### Choosing the lines

Only the opponent's moves are a matter of chance — one's own are the
repertoire's. A line's **likelihood** is the product, over the opponent's
moves in it, of the move's share of the games from its position (the
Reference tab's figures, from the positions index); a move not in the
database counts as rare, not impossible. Lines switched off are left out.

The lines are taken in order of likelihood until they reach a target, set
one of two ways, the other shown alongside:

- **Coverage** — the share of the games reaching the unit's start that stay
  within its lines ("12 of 20 lines, 75% of games"); the default, 75%.
- **Time** — "about 60 minutes": lines are added while the estimate stays
  under it.

The **estimate** counts **decisions**, not moves or lines: the distinct
positions where it is one's own move (lines share their beginnings — 20
lines may be 60 decisions). Time ≈ decisions × repetitions × seconds per
decision, with fixed guesses to start (say 3 repetitions, 15 s), shown as
an estimate.

The positions index covers each game's first ~40 plies; deeper positions
have no statistics and inherit their line's likelihood.

### Training: study and drill

- **Study** — the unit's lines one after another, with the chapter's
  comments; at each position, on demand, how many games reached it, the
  moves played there with their share and score, whether the repertoire's
  move is the main move or a side line, and the engine's evaluation where
  the database has one stored (no engine runs on the phone).
- **Drill** — the opponent's moves are played, chosen by their weight, and
  one's own moves are entered on the board. A wrong move shows the right one
  and the same figures ("the book move is Nf3 — 62% of games, scores 55%").
  Each decision is a **card**; a card missed comes back sooner, one known
  comes back later (spaced repetition, kept on the device where the drill
  runs).

The desktop has both in the Repertoire page from the first step; the
phone trainer is the same code.

### The unit format

One JSON document, documented and versioned, read by the desktop training,
the phone trainer and any later app alike:

```jsonc
{
  "format": "lpdo-unit", "version": 1,
  "id": "3f9c…",                     // random, stable: the unit's identity
  "name": "Classical English — 3…Nc6",
  "created": "2026-09-29T10:00:00Z",
  "color": "white",                  // the side trained
  "source": { "book": "Classical English", "chapters": ["21 3...Nc6"] },
  "selection": { "coverage": 0.75, "lines": 12, "of": 20, "decisions": 38, "minutes": 35 },
  "tree": [                          // from the initial position
    { "san": "c4",
      "card": "a1b2c3d4e5f60718:c2c4",  // own moves: position hash + UCI move
      "comment": "…", "nags": [1],
      "stats": { "games": 889516, "moves": [["e5", 0.31, 0.47], ["Nf6", 0.29, 0.45]], "eval": 12 },
      "children": [ … ] }            // in the chapter's order; the first is the main line
  ]
}
```

- `stats` is the position after the move: games reaching it, the moves
  from it (SAN, share, score for the side to move), and a stored evaluation
  in centipawns when there is one.
- `card` keys are position plus move, so a card's history survives a unit
  being rebuilt or sent again, and results could later be synced back by
  key without changing the format.
- An option leaves the comments out, roughly halving the size, for a unit
  only to be drilled.

### Taking a unit to the phone

The phone trainer is a **web app** published on a public HTTPS page
(GitHub Pages, next to the APT repository, or lpdo.com): static, no
accounts, no server, no analytics — everything stays on the phone, which the
open source lets anyone check. Added to the home screen it works offline;
units and progress live in the browser's storage (IndexedDB). One code base
for iPhone and Android, shared with the desktop's training view.

A unit gets there one way — nothing comes back:

- **Animated QR code** (the main way): the desktop shows the unit as a
  short loop of QR codes; the trainer scans it with the camera. A unit is
  roughly 5–15 KB compressed; at ~500 bytes a frame that is 10–30 frames, a
  few seconds. Fountain coding (as crypto wallets use to pass transactions
  between devices, e.g. BC-UR) lets the phone pick up frames in any order
  and miss some. No network is involved.
- **A file** (always works — large units, sending a unit to someone): the
  desktop saves `<name>.lpdo-unit.json`; the trainer imports it from the
  phone's files.

A QR code holding a link instead would not do: on the iPhone a scanned link
opens in Safari, whose storage is not the home-screen app's, and the app on
HTTPS may not fetch from a server on plain HTTP.

Caveats: on the iPhone the app must be on the home screen to keep its data
reliably, and storage can still be cleared after long disuse — that loses
the schedule, not the lines; sending the unit again restores it. Scanning
speed from a monitor needs a prototype on a real iPhone before the rest is
built on it.

### Later: a native app

The same code wrapped with Tauri mobile (F-Droid / Play Store easily; the
App Store takes a developer account and review). With it: practice results
synced back by card key, the desktop's own schedule of what is due, units
planned from weak spots and from one's own games (where a game left the
repertoire), and the time estimate calibrated from one's actual pace.

## Phases

1. **First version:** the tables and routes; the Repertoire page; import and
   export; the study view in the Analysis page with the lines list and branch
   marks; the editor saving to a chapter; the off-switch; active chapters; the
   Home card.
2. **Repertoire and the database:** marks in the Reference tab and the opening
   tree for moves in the active repertoire, and **gaps** — popular moves with
   no answer in it; your own games checked against the repertoire (where you or
   the opponent left the book); the opponent's games against your active lines
   on the Prep page; an engine pass over a chapter flagging moves it marks "?"
   (the queued analysis left open in #309).
3. **Practice** — see [Practice](#practice): (a) training units and training
   on the desktop, with the unit format; (b) the phone trainer, units carried
   over by animated QR code or file; (c) later, with a native app, results
   synced back and units planned from them.

## Out of scope

Chapters starting from a set-up position (a PGN `[FEN]` header) — every
chapter starts from the initial position; importing from Chessable (it has
no export); ChessBase repertoire files; sharing books between servers other
than as PGN. For practice: syncing with ChessTempo or any other online
trainer; accounts or a server of our own for the phone trainer; practice
results going back from the phone to the desktop before there is a native
app.
