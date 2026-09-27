# Opening repertoire — design

Tracking: [#327](https://github.com/specure/lpdo/issues/327).

An opening repertoire organised as **books** and **chapters**, loosely the
shape of an opening course — a Chessable course, a Lichess study — with the
chapters you are playing marked **active**, the lines studied with the
reference database and the engines beside them, and new lines added and
existing ones adjusted with the editor. Practice (spaced repetition) and the
comparison of your own games against the repertoire come later, on the same
model.

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
  Sielecki)". Has the colour you play it from, a name, an optional description
  and link to the course, and an order among the books.
- **Chapter** — an ordered section of a book, one move tree from the starting
  position (set-up positions are out of scope). Its content is a PGN game:
  moves, variations, comments, NAGs, arrows and circles — what the editor
  handles today.
- **Line** — a path from the chapter's start to a leaf of its tree. Named, as
  Chessable names them, by the move where it branches off the line before.
- **Active repertoire** — the chapters marked active, less what is switched
  off inside them.
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
    description VARCHAR,
    url VARCHAR,                      -- the course, when there is one
    ord INTEGER NOT NULL,
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
    active BOOLEAN NOT NULL           -- the chapter active and nothing switched off above
);
```

Ids from `id_high_water` as elsewhere. A chapter's headers carry what the
Analysis page shows in place of the players: `[Event "<book>"]`,
`[Round "<chapter order>"]`, `[White "<chapter name>"]`, and the book's colour
as `[Orientation "black"]`.

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
present; otherwise `White – Black`, to rename. The book's colour is asked for
on import.

## Studying a chapter

A chapter opens **in the Analysis page** as a tab beside games (the rail shows
the book and chapter name in place of the players), the board turned to the
book's colour. That gives, for every position of a line, what a course cannot:
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

A page of its own in the navigation: books on the left (name, colour, link),
the selected book's chapters on the right in order, each with its **Active**
toggle, line counts ("12 lines, 3 off"), open, rename, reorder (drag), move to
another book, delete; add a chapter (empty, pasted PGN, PGN file); export the
book or a chapter. A **Repertoire card** on the Home page lists the active
books with their active chapter counts and opens the page.

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
3. **Practice:** spaced repetition per line — the opponent's moves played for
   you, yours entered on the board; a review schedule per line, "due today" on
   the Home card.

## Out of scope

Chapters starting from a set-up position (a PGN `[FEN]` header) — every
chapter starts from the initial position; importing from Chessable (it has
no export); ChessBase repertoire files; sharing books between servers other
than as PGN.
