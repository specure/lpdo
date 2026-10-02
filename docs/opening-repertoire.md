# Opening repertoire

The **Repertoire** page organises the openings you play as **books** and
**chapters**, loosely the shape of an opening course: a book for a course or a
topic ("Najdorf for Black", with the colour you play it from and, if you like,
its author and a link to the course), chapters for its sections, each chapter
one tree of lines with variations and comments. The books are in a panel on
the left, the selected book's chapters in a panel beside it (« folds either
away to a strip, as the Players page's list), and the chapter being studied
is on the right, with the Analysis page's own layout — board, move
list, Reference, Games and Lines, the engines — so switching chapters, or
books, stays on the page. The design is in
[design/opening-repertoire.md](design/opening-repertoire.md); this is how it
is used.

## Books and chapters

**+ New** beside *Books* asks for a name, the author (optional) and the
colour. Under the list, the selected book's details: its author, colour,
chapter and line counts, the link to the course (a click opens it) and your
notes. Its ⋯ menu has **Edit…** to change them, **Move up** / **Move down**
to reorder the books, **Export PGN…** for all its chapters as one file, and
**Delete…** to delete it with its chapters. The author
goes into the chapters' PGN as `[Annotator]`.

**Import…** beside *Books* makes books again from a PGN LPDO exported — a
book's (Export PGN…) or a backup of them all (Maintenance → Repertoire →
Back up all books…): each as a new book, with its name, colour, author,
link, notes and active switch, its chapters in their order with their
names, lines, comments and switches — never added to the book that happens
to be selected. A PGN from elsewhere becomes one new book named after the
file (its colour from an `[Orientation]` tag, else White). Exported PGN
carries the book in tags of LPDO's own (`[LpdoBook]`, `[LpdoBookColor]`,
`[LpdoBookAuthor]`, `[LpdoBookUrl]`, `[LpdoBookNotes]`, `[LpdoChapter]`, …),
which other programs ignore.

A chapter is added to the selected book in one of three ways, from the
same ⋯ menu:

- **New empty chapter**, then play the lines in with *Edit lines…*;
- **Paste PGN…** — a PGN with several games becomes several chapters, named
  from their headers (a Lichess study exports its chapters this way;
  otherwise the players, or the event);
- **Import PGN files…** — the same from PGN files, one or several at once: each file
  becomes a chapter (or a chapter per game, for a file of several), named
  from its headers or else after the file.

The ⋯ above the chapters works on the chapter on the board: rename it
(or press **F2**),
export it as PGN, delete it. **Rearrange chapters** there puts the list in
a mode for ordering: drag a chapter to its place, or move it with ▲ ▼, and
**Done** when it is right. Every chapter
starts from the initial position.

**Rename chapters…** there renames many at once, by find and replace over
their names — to take out the book's name repeated in each, for instance,
which is what *Find* starts with. Every chapter's new name is shown before
anything changes; the spaces, dashes and colons a removal leaves at either
end are trimmed, and *Regular expression* allows patterns (`^\d+\s*` for a
leading number).

**Remove FENs from comments** there (or **in all chapters**) deletes the
FEN strings courses exported from other tools leave in the text
("…reminiscent of the King's Indian rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR
w KQkq - 0 1 1.d4 Nf6…"); the rest of each comment stays as written. It
counts them first — "25 FEN codes will be removed", per chapter — and
removes them when you say so; "No FEN codes found" otherwise.

**Merge chapters…** there folds several chapters into one — the same
section imported twice, or split over several files. Tick the chapters
(Shift-click ticks every chapter from the one clicked last) and **Merge**: the topmost keeps its name, its place and its main line, and
takes in the others' lines and comments; they are deleted after. A move it
lacks is added as a variation where it branches off; a comment, line intro
or move mark (!, ?, …) it lacks is taken over, arrows and circles are
joined, and a move switched off in any of them stays off. Where both have a
comment and they differ, a window lists each such place with the versions
side by side: keep one, or both one after the other — or pick a chapter's
version for all of them at once.

## Active books and chapters, and switching lines off

The checkbox on a chapter marks it **active** — part of the repertoire you are
playing now. A chapter switched off keeps its lines, ready to be switched on
again. The checkbox on a book does the same for the whole book: off, none of
its chapters count, whatever their own checkboxes say, and they keep them for
when the book is switched on again.

Within a chapter, a line can be switched **off**: "not in my repertoire from
here". In the **Lines** tab each line has an **off** button at its end (and
**on** to undo), which switches it off at the move where it branches. **Off:
my sidelines** above the lines does it for all your second choices at once:
wherever you have more than one move in the chapter (11.Nxf4, and 11.gxf4?!
as a variation), the first stays on and the others are switched off — your
opponent's alternatives stay on, as they are what you need to know. **All
on** switches every line back on. The move and everything below it stay in
the chapter, greyed, and count as inactive — for an alternative you are not
following for now, or a variation you play differently from another book. The switch is kept in the chapter's PGN (a
`[%rep off]` tag in the move's comment), so it survives export and import.

## Studying a chapter

Click a chapter and it is on the board, turned to the book's colour.
Everything the Analysis page offers for a game is there for the line: the **Reference** tab with how often each move is played from
the position, the **Engine** panel with the evaluation and lines, the move
list with the chapter's variations and comments (a ⋔ marks a move where
alternatives branch off).

The **Lines** tab lists the chapter's lines in reading order — the main
line, then each variation — each written out whole, from move 1: the moves
it shares with the line it branches off greyed, its own moves in black;
off ones greyed, marked "off". Click a line and the board is on its
branching move — or click any move in it, a greyed one too, and the board
and the move text go to that move. On the board, **→** steps through the
line and stops at its end, **End** goes to the end of the line the board is
on, and **↑ ↓** go to the previous and next line — the way to replay a
chapter on a physical board.

**Edit lines…** opens the editor: play moves on the board (a new move mid-line
asks whether it is a variation or the new main line), add comments and marks,
promote or demote variations, delete from a move on. **Done** saves the
chapter.

## Analysing chapters for practice

**Analyse chapter** and **Analyse all chapters**, in the ⋯ above the
chapters, prepare chapters for practice: for every position, how often the
database's games reached it and the moves played there with their share and
score. It runs in the background on the server, with its progress and a
Cancel above the chapters; a chapter takes a few seconds. Nothing is
analysed by itself: run it again to bring a chapter up to date after
editing it, or after many new games came into the database.

Your own games in a chapter's positions — how often, your wins, draws and
losses from there, your performance, and the moves you played — are not
part of the analysis: they are looked up each time (a fraction of a
second), so a game you add counts at once. They count your games with the
book's colour (a Black repertoire, your games as Black), from the last 12
months — the period is set on the Maintenance page, **Repertoire** tab
(0 for all). Your player is the one set on the Home page.

**Your games** show beside each chapter — when your player is set on the
Home page (otherwise its line count): how many of your games went into it,
your score (green from 55%, red up to 45%) and your performance rating (with
three rated opponents or more); a chapter's tooltip has its line count. A game counts for a chapter when it reached
a position only that chapter has in the book, by any move order — in a Black
book usually White's move that sets the chapter apart, 3.Nd2 for the
Tarrasch — so your older games in the line count too, even when you
deviated straight after (an earlier 3...c5 under a 3...a6 chapter: "you
deviated at 3...c5"). A position several chapters share counts for none of
them. Above the chapters, **The
whole book** has the same columns for all your games in the book's opening
(after 1...e6 in a French book); pick it, as a chapter, and the My games tab
lists them all, each with the chapter it went into — or the move that left
the book — a click putting that chapter on the board. The same period and
colour as everywhere: your games with the book's colour, from the last 12
months (Maintenance → Repertoire).

The **My games** tab, beside Lines when a chapter is on the board, lists
those games for the chapter — newest first, both players and the result
(green when you won, red when you lost), the event and the date — and how
far each followed it: to the end of a line, or where it left the chapter
and who left it ("you deviated at 8...b6", in red, or "your opponent
deviated at 5.Bf4"). A click puts the board on that position and previews
the game under the list — at the move that left the chapter — as the Games
tab does; a double-click opens the game.

A dot beside a chapter in the list shows it was analysed (its tooltip says
when), in another colour when its positions changed since — moves added or
removed; editing a comment, removing FENs or reordering variations does not
count. In the **Lines** tab, a line the analysis lacks is marked "not
analysed"; the header says how many are.

## What comes next

Marks in the Reference tab and the opening tree for moves in the active
repertoire, and the gaps in it; your own games checked against it (where you
or the opponent left the book); the opponent's games against your lines on the
Prep page; and spaced-repetition practice — see the design.
