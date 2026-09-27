# Opening repertoire

The **Repertoire** page organises the openings you play as **books** and
**chapters**, loosely the shape of an opening course: a book for a course or a
topic ("Najdorf for Black", with the colour you play it from and, if you like,
a link to the course), chapters for its sections, each chapter one tree of
lines with variations and comments. The books and chapters are in a panel on
the left (« folds it away, as the Players page's list), and the chapter being
studied is on the right, with the Analysis page's own layout — board, move
list, Reference, Games and Lines, the engines — so switching chapters, or
books, stays on the page. The design is in
[design/opening-repertoire.md](design/opening-repertoire.md); this is how it
is used.

## Books and chapters

**+ New** beside *Books* asks for a name and the colour. A chapter is added
to the selected book in one of three ways, with the buttons under its
chapters:

- **+ Empty**, then play the lines in with *Edit lines…*;
- **Paste PGN…** — a PGN with several games becomes several chapters, named
  from their headers (a Lichess study exports its chapters this way;
  otherwise the players, or the event);
- **Import…** — the same from a PGN file.

A chapter's ⋯ renames, reorders (▲ ▼), exports and deletes it; **Book…**
above the chapters renames the book, sets its colour and link, exports all
its chapters as one PGN, or deletes it. Every chapter starts from the initial
position.

## Active chapters, and switching lines off

The checkbox on a chapter marks it **active** — part of the repertoire you are
playing now. A chapter switched off keeps its lines, ready to be switched on
again.

Within a chapter, any move can be switched **off**: "not in my repertoire from
here". Open the chapter, put the cursor on the move, and click the small
**off** button beside it in the move list (and **on** to undo). The move and
everything below it stay in the chapter, greyed, and count as inactive — for
an alternative you are not following for now, or a variation you play
differently from another book. The switch is kept in the chapter's PGN (a
`[%rep off]` tag in the move's comment), so it survives export and import.

## Studying a chapter

Click a chapter and it is on the board, turned to the book's colour.
Everything the Analysis page offers for a game is there for the line: the **Reference** tab with how often each move is played from
the position, the **Engine** panel with the evaluation and lines, the move
list with the chapter's variations and comments (a ⋔ marks a move where
alternatives branch off).

The **Lines** tab lists the chapter's lines in reading order — the main
line, then each variation, named by the move where it branches off, off ones
greyed. Click a line and the board is on it; **→** steps through it and, at
its end, goes on to the next line — the way to replay a chapter on a physical
board.

**Edit lines…** opens the editor: play moves on the board (a new move mid-line
asks whether it is a variation or the new main line), add comments and marks,
promote or demote variations, delete from a move on. **Done** saves the
chapter.

## What comes next

Marks in the Reference tab and the opening tree for moves in the active
repertoire, and the gaps in it; your own games checked against it (where you
or the opponent left the book); the opponent's games against your lines on the
Prep page; and spaced-repetition practice — see the design.
