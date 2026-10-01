# Opening repertoire — design

Tracking: [#327](https://github.com/specure/lpdo/issues/327).

An opening repertoire organised as **books** and **chapters**, loosely the
shape of an opening course — a Chessable course, a Lichess study — with the
chapters you are playing marked **active**, the lines studied with the
reference database and the engines beside them, and new lines added and
existing ones adjusted with the editor. Practice — chapters taken to the
phone and trained there, see [Practice](#practice) — and the comparison of
your own games against the repertoire come later, on the same model.

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

Learning the lines, not just reading them: chapters taken to the phone —
offline and private — and practised there, or on the desktop. The practice
today goes through ChessTempo: the chapter synced to its servers first,
online only, and other users' comments turning up on one's own moves. That
is a workaround; this replaces it.

The purpose is to study and understand a line over months, not to cram for
one opponent: the opponent's moves are weighted by the whole database, and
a game coming up only picks the topic.

### What goes to the phone: the enriched chapter

What travels is a **whole chapter, enriched** with what the desktop knows
and the phone cannot look up: for every position, how many games reached
it, the moves played from it — the chapter's and the others — with their
share and score, and an evaluation where the database has one stored. The
chapter's comments and NAGs come with it; moves switched off come marked,
left out of practice by default.

It is a **snapshot**. Editing the chapter on the desktop does not change
the copy on the phone; sending it again replaces the tree there and keeps
the history of every card that still exists (cards are keyed by position
and move — see the format). The phone shows the version it holds ("chapter
of 2 October").

What to practise is decided **on the phone, when practising** — a
**session**, from the chapters it holds (below). There is no unit made on
the desktop: planning happens where the practice does, sized to the time at
hand, and studying the same chapter more thoroughly later needs nothing
sent again. The one thing the desktop can add is a **focus**: sent with the
chapter, a branch to start from ("prepare the 5...Nb6 line for Saturday"),
offered on the phone as a ready session.

### Preparing a chapter: the analysis job

What the phone gets is worked out beforehand, in a **background job** on
the server — **Analyse…** in a chapter's ⋯ menu, or a book's for all its
chapters — with its progress on the chapter and a Cancel, as the server's
other jobs. **Nothing runs by itself**: the analysis, and refreshing it
later, are always started by hand — running it again fetches the figures
anew and evaluates what is missing (or below stronger settings than before).
**Send to phone** only reads what is stored: instant, and it says how
complete the chapter is ("analysed: 110 of 110 positions").

**What has been processed shows** in colour: in the Lines tab per line —
not processed, figures only, figures and evaluations, changed since (moves
added after the last run); in the chapter list per chapter ("analysed
2 Oct", or partly); and in the move list, an evaluation beside a move that
has one.

**Settings** — a **Repertoire** tab on the Maintenance page, kept on the
server (`repertoire.json`, `GET/PUT /repertoire/settings`):

- **Your games**: how many months back one's own games count (default 12,
  0 for all).

- **Sources**, in order, each on or off: the Lichess cloud evaluation (deep,
  for positions popular there; rate-limited, with the rests after a 429 the
  Engine panel already has), chessdb (fast, wide coverage of openings), then
  the local engine for the rest — **Stockfish** (by depth, default 20), or
  **Lc0** where installed (by nodes; on a CPU, slow). Default: both cloud
  services, then Stockfish.
- **Lines** for one's own moves: 2 (to find the best alternative).
- **Which positions**: the **ends of lines**, always; **one's own moves** —
  only where the repertoire's move is **not a main move** (outside the moves
  making up 75% of the games there; the threshold adjustable) by default, or
  all; **the opponent's moves** — none by default, or the popular ones (above
  a share), to find their mistakes.

Every evaluation keeps its source — engine, depth or nodes — and the
trainer shows it ("+0.3, Stockfish d20"): different engines' numbers are not
comparable, Lc0's least of all.

The job and the **Engine panel** share the server's engine: while the panel
is analysing, the job's engine work **pauses** (the cloud lookups go on) and
resumes after — one's own analysis is never slowed.

- **The database's figures** for every position (the stats above), kept
  per chapter and made again when the chapter changes or the database grows.
  Measured on the real database (13.9 M games): 3–6 s a chapter, about the
  same for 20 lines as for 45 — a pass over the positions index — and the
  Reference tab's own requests slow from ~1.7 s to 3–4 s meanwhile; not
  something to do while one waits, and once stored, never again for the same
  chapter.
- **One's own games** are **not** part of the analysis: they change every
  week (2–3 games), so they are looked up **live** —
  `GET /repertoire/chapters/{id}/mine?player_id=` — from one's games (the
  players indexes) to their positions, never a scan of the whole index:
  measured at 0.11–0.12 s a chapter (287 games), against 3–6 s for the
  database's figures. For every position: how many of one's games went
  through it, one's score from there (wins, draws, losses, and a performance
  rating with three rated opponents or more), and the moves played — "you
  reached this 7 times, +3 =2 −2, and played 9.d4 twice instead of 9.b3":
  where one leaves the repertoire in practice. Only the games with **the
  book's colour** count (a Black repertoire is about one's games as Black;
  one's games as White against the same opening would mix in the
  opponent's moves), from the **last 12 months** by default — a recent
  switch of line then shows (setting below; 0 for all; games without a date
  left out when a period is set). One's player is the one set on the Home
  page, re-resolved by FIDE id — a stored player id goes stale when the
  players are renumbered (#249). Matching is by position, not by move order, so a game
  that transposes into a chapter is counted from where it joins it (and not
  at the chapter's positions it skipped); the Train view should also say so
  at the chapter's level — "your games in this chapter: 2 (1 by
  transposition)" — so a transposed game does not only show deep in a
  branch.
- **A book's overview of one's games** — "Your games" in the chapter list,
  `GET /repertoire/books/{id}/mine?player_id=`, live like the above: per
  chapter, the games that reached one of **its own positions** — no other
  chapter of the book has them, and one gets there **by a move of one's
  own** (so a game counts for the chapter one played, not for where the
  opponent went: a Winawer game does not count for a 3.Nc3 chapter) — with
  the score and performance; the games in the book's opening (the
  positions every chapter has, reached by one's own move — after 1...e6, so
  not a Sicilian after 1.e4); and those that **left the book**, by the move
  that left (the deepest book position's next move, "3...Bb4"). Where one's
  practice and the book part ways, and which chapter one scores worst in —
  the topics to train. The **My games** tab (a chapter's games,
  `GET /repertoire/chapters/{id}/games?player_id=`) lists them with how far
  each followed the chapter: to the end of a line, as far as the index
  goes, or where it left — the move, and whether one left it oneself or the
  opponent did; a click puts the board there.
- **Engine evaluations** (Stockfish, the server's own): the positions the
  database has no stored evaluation for — on three real chapters, none of
  their 176–669 positions had one; cloud evaluations are only kept where one
  has looked. In order of use:
  1. **the end of every line** — where the line leaves one ("+0.4, a
     comfortable position");
  2. **one's own moves** — the engine's best move and its evaluation in the
     position, beside the repertoire's move: the cost of the choice ("the
     engine prefers 9.d4, +0.2"), which is where a line's objective strength
     shows — and where a deliberately second-best move should be known as
     such;
  3. optionally, **the opponent's popular moves** — where the most played
     one is a mistake: where to punish it.

  Kept in the `engine_evals` table (so the Analysis page shows them too),
  with the engine, depth and multipv, so they are comparable and can be done
  again stronger; a run after an edit evaluates only the new positions. All
  of a 20-line chapter's own moves and line ends are ~110 positions — a few
  minutes at 1–2 s each; with the default (own moves only off the main
  moves) far fewer. A book of 26 chapters, all positions: about an hour.

This is the engine pass phase 2 lists for flagging questionable moves (#309):
one job for both — the desktop marks moves in the chapter, the package
carries the numbers. At opening depths a cost under ~0.3 is noise, and
courses choose practical moves on purpose: the trainer says what the engine
prefers and by how much, flags only clear drops, and never calls the
repertoire's move "wrong".

### A session: choosing the lines

Only the opponent's moves are a matter of chance — one's own are the
repertoire's. Lines are compared from the chapter's **trunk**: the moves
down to where the chapter first branches (or the focus, if deeper) — every
line shares them, and counted from move 1 every line of "21 3...Nc6" is
under 1% of the games. From there, at each opponent move:

- a line's **weight** takes the move's share **among the chapter's moves
  there** (the Reference tab's figures, shipped in the chapter; a move the
  database does not have counts as rare, not impossible). The weights of a
  chapter's lines add up to 100% — "of the games that stay in the
  chapter, this line takes 23%" — and a line is not favoured for ending
  early. This is what lines are ranked and covered by.
- a line's **likelihood** takes the move's share among all the moves
  played there: how many games follow it to its end. Shown as information,
  with the chapter's **reach** — how many games from the trunk stay in it to
  the end of a line.

One's own alternatives (a second move of one's own at a branch) rank after
the main repertoire. Lines switched off are left out.

A session starts from a chapter (several, or a branch — the focus, or one
picked in the tree) and takes its lines in order of weight until they reach
a target, set one of two ways, the other shown alongside:

- **Coverage** — the share of the chapter's games the lines chosen take
  in ("3 of 20 lines, 78%"); the default, 75% — always reachable.
- **Time** — "20 minutes": lines are added while the estimate stays under
  it.

The **estimate** counts **decisions**, not moves or lines: the distinct
positions where it is one's own move (lines share their beginnings — 20
lines may be 60 decisions). Time ≈ decisions × repetitions × seconds per
decision, with fixed guesses to start (say 3 repetitions, 15 s), shown as
an estimate. Cards already known and not yet due count for less.

A session can be kept as a **preset** ("Classical English — 3…Nc6, 75%") to
run again.

The positions index covers each game's first ~40 plies; deeper positions
have no statistics and inherit their line's likelihood.

### Training: study and drill

- **Study** — the session's lines one after another, with the chapter's
  comments; at each position, on demand, how many games reached it, the
  moves played there with their share and score, whether the repertoire's
  move is the main move or a side line, and the evaluation where there is
  one (no engine runs on the phone).
- **Drill** — the opponent's moves are played, chosen by their weight, and
  one's own moves are entered on the board. A wrong move shows the right one
  and the same figures ("the book move is Nf3 — 62% of games, scores 55%").
  Each decision is a **card** of the chapter, not of the session: a card
  missed comes back sooner, one known comes back later (spaced repetition,
  kept on the device where the drill runs), whatever session it turns up in.

The desktop has both, with the same session setup, in the Repertoire page
from the first step; the phone trainer is the same code.

### The chapter format

One JSON document, documented and versioned, read by the desktop training,
the phone trainer and any later app alike:

```jsonc
{
  "format": "lpdo-chapter", "version": 1,
  "chapter": { "id": 65, "updated": "2026-10-02 09:12:00" },  // which chapter, which version
  "sent": "2026-10-02T09:30:00Z",
  "book": { "name": "Classical English", "author": null, "color": "white" },  // the side trained
  "name": "21 3...Nc6",
  "focus": null,                     // or the SAN path to a branch: ["c4", "e5", "g3", "Nf6", …]
  "start": { "comment": "…", "stats": { … } },   // the initial position
  "tree": [                          // the moves from it
    { "san": "c4", "uci": "c2c4",
      "card": "a1b2c3d4e5f60718:c2c4",  // own moves: position hash + UCI move
      "comment": "…", "pre": "…", "nags": [1],
      "arrows": ["Gc4c5"], "circles": ["Rd4"], "off": true,   // only when there are any
      "stats": { "games": 889516, "moves": [["e5", 0.31, 0.47], ["Nf6", 0.29, 0.45]], "eval": { "cp": 12 } },
      "engine": { "eval": { "cp": 18 }, "best": ["d4", { "cp": 35 }], "depth": 24 },  // from the analysis job
      "mine": { "games": 7, "w": 3, "d": 2, "l": 2, "perf": 2180, "moves": [["d4", 2], ["b3", 5]] },
      "children": [ … ] }            // in the chapter's order; the first is the main line
  ]
}
```

- `stats` is the position after the move (`start.stats`: the initial
  position): games that reached it and went on, the moves from it — SAN,
  share of those games, score for the side playing it; the database's most
  played (up to eight) and every move the chapter has there — and a stored
  evaluation from White's side, `{ "cp": n }` or `{ "mate": n }` (Lichess's
  cloud evaluation where kept, else chessdb's), when there is one. Engine
  games are left out, as the Reference tab does by default. Served by
  `GET /repertoire/chapters/{id}/stats`; the desktop puts the package
  together (`chess-client/src/trainer/`).
- `engine` — from the analysis job, when it has run: the evaluation of the
  position after the move (White's side), and for one's own moves the
  engine's best move in the position before it with its evaluation, when it
  is not the repertoire's; the depth reached. Optional: a package without it
  is complete.
- `mine` — one's own games through the position after the move (looked up
  live when the package is made, one's player known): how many, wins, draws
  and losses from there, a performance rating when there are enough rated
  opponents, and the moves played next with how often. Which games: the
  package's top-level `"mine": { "color", "since", "games" }` — the book's
  colour, from `since` (null: all). Optional.
- `card` keys are position plus move, so a card's history survives the
  chapter being edited and sent again, and results could later be synced
  back by key without changing the format.
- A chapter is identified by its id — within one LPDO database; an
  identity for the database itself, for phones fed from more than one, is
  left for later. A newer `chapter.updated` replaces the copy on the phone.
- A **book** is a file of its chapters (`"format": "lpdo-book"`, the
  chapters in order) — for the file route only, see below.
- An option leaves the comments out, roughly halving the size, for a
  chapter only to be drilled.
- Later, optionally: evaluations filled in by the desktop when sending — a
  short engine pass over the positions of one's own moves where the
  database has none (minutes for a chapter).

### Taking chapters to the phone

The phone trainer is a **web app** published on a public HTTPS page
(GitHub Pages, next to the APT repository, or lpdo.com): static, no
accounts, no server, no analytics — everything stays on the phone, which the
open source lets anyone check. Added to the home screen it works offline;
chapters, presets and progress live in the browser's storage (IndexedDB).
One code base for iPhone and Android, shared with the desktop's training
view.

**Send to phone** on a chapter (the chapter's ⋯, optionally with the branch
on the board as its focus) or a book. It gets there one way — nothing comes
back:

- **Animated QR code** — one chapter at a time: the desktop shows it as a
  loop of QR codes; the trainer scans it with the camera. Fountain coding
  (BC-UR, as crypto wallets use to pass transactions between devices) lets
  the phone pick up frames in any order and miss some. No network is
  involved. Measured on real chapters: "21 3...Nc6" (20 lines, 176
  positions) is 9.7 KB compressed — ~35 frames, about 5 s at the steady
  setting below; the largest, 43–45 lines and ~600 positions, 41 KB —
  ~145 frames, 15–20 s; without comments half that. Worth trimming later
  (fewer moves a position) if the large ones are sent often.
- **A file** — a chapter or a whole book (a book of 26 chapters is a few
  hundred KB: minutes of scanning, so books go this way only), and for
  sending a chapter to someone: the desktop saves `<name>.lpdo.json`; the
  trainer imports it from the phone's files.

A QR code holding a link instead would not do: on the iPhone a scanned link
opens in Safari, whose storage is not the home-screen app's, and the app on
HTTPS may not fetch from a server on plain HTTP.

Caveats: on the iPhone the app must be on the home screen to keep its data
reliably, and storage can still be cleared after long disuse — that loses
the schedule, not the lines; sending the chapter again restores them.

**Measured** with a prototype (branch `qr-prototype`,
`prototypes/qr-transfer`: a sender page, a receiver page, and an automated
test playing the frames to headless Chrome as its camera). On an iPhone
(iOS 18.7, Safari, jsQR) reading the desktop's monitor:

| Bytes a frame | Frames/s | Time |
|---:|---:|---|
| 300 | 8 | 3.2 s |
| 400 | 10 | 3–4 s, consistently |
| 600 | 12 | 0.6–0.9 s at best, up to 6 s |

The denser, faster codes are missed more often when the camera is not
steady; the fountain code keeps going, only slower. So the trainer uses a
steady setting (300–400 bytes, 8–10 frames/s — a few seconds for a chapter)
and shows progress while it reads. A faster decoder than jsQR (ZXing as
WebAssembly) may make the fast settings reliable — to check when the
trainer is built.

Also found: Safari on iOS 18 does not accept a self-signed certificate at
all ("Continue" past its warning retries over plain HTTP). The trainer
therefore needs a host with a proper certificate — which the public HTTPS
page above has; serving it from one's own LPDO server would not work on
the iPhone without extra setup (a trusted certificate, e.g. Tailscale's).

### Later: a native app

The same code wrapped with Tauri mobile (F-Droid / Play Store easily; the
App Store takes a developer account and review). With it: practice results
synced back by card key, the desktop's own schedule of what is due,
sessions suggested from weak spots and from one's own games (where a game
left the repertoire), and the time estimate calibrated from one's actual
pace.

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
3. **Practice** — see [Practice](#practice): (a) the enriched chapter format
   and the database's figures (done: `GET /repertoire/chapters/{id}/stats`,
   `chess-client/src/trainer/`); the analysis job — figures stored, Stockfish
   at the ends of lines and on one's own moves; training on the desktop —
   sessions, study and drill — in the code the phone will share; (b) the phone trainer, chapters sent by animated QR code
   or file, with an optional focus; (c) later, with a native app, results
   synced back and sessions suggested from them.

## Out of scope

Chapters starting from a set-up position (a PGN `[FEN]` header) — every
chapter starts from the initial position; importing from Chessable (it has
no export); ChessBase repertoire files; sharing books between servers other
than as PGN. For practice: syncing with ChessTempo or any other online
trainer; accounts or a server of our own for the phone trainer; practice
results going back from the phone to the desktop before there is a native
app.
