# Duplicate games and duplicate players

The same game reaches your database from several places. TWIC publishes it the
week it was played, a Lichess broadcast carried it live, and a Megabase export
has it too. LPDO removes the copies by itself where it safely can, and leaves
the rest to you. This page explains which is which, and what to do about it.

## What LPDO removes by itself

Maintenance runs **Remove duplicate games** after every import, and you can
start it from the Maintenance panel. Two games are the same game when *all* of
this holds:

- **The same two players**, by their player records — see
  [duplicate players](#duplicate-players-the-same-person-under-several-names)
  below, because two spellings of one person are two records, and their games
  can never be paired.
- **The same result.**
- **The same moves**, either exactly or differing by one trailing half-move —
  one source sometimes stops a move earlier than another.
- **A date that doesn't contradict.** Two full dates may be up to a week apart:
  a broadcast copy often carries the day the file was published rather than the
  day the round was played. Where a date is partial (`2001-??-??`) only the
  parts both copies know are compared, and a month-only date also matches the
  months either side of it.
- **A round that doesn't contradict.** `7` and `7.2` are the same round —
  round 7, game 2 of it. Round 2 and round 7 are never the same game. A round
  of `?`, `-` or free text says nothing and blocks nothing.

Of the copies, the one with the longest PGN survives: the more complete game,
or the annotated one over a bare score.

### What it deliberately leaves alone

- **Games whose moves are written differently.** One source writes `Nge7`,
  another writes `Ne7` for the same move — both legal spellings. LPDO compares
  the moves as the source wrote them, so these are not recognised as the same
  game. See [rebuilding from sources](#rebuilding-the-database-from-sources).
- **Games with a plainly wrong date**, such as a 1993 world-championship game
  dated 1951 in one export. The years contradict, so the copies stay apart.
- **Knockout rounds numbered differently between sources**, such as `8.5`
  against `5` for the same game of a match.

These are safe refusals: a merge deletes a game for good, so anything
ambiguous is left for you to decide.

## Duplicate players: the same person under several names

Automatic dedup pairs games by player record, and it merges two player records
when their normalised names match exactly, when they share a FIDE ID, or when
one is the other written with a title the way online platforms do:

```
GM Magnus Carlsen          → Carlsen, Magnus
NM EAMON MONTGOMERY 2215   → Montgomery, Eamon
```

The title (GM, IM, FM, CM, NM, LM and the women's titles) and a trailing
rating are dropped. What is left must then be the plain record's name exactly
(`GM Torre, Eugenio` → `Torre, Eugenio`), or, without a comma, "Firstname …
Lastname" read as "Lastname, Firstname …" (`GM Allan Stig Rasmussen` →
`Rasmussen, Allan Stig`). No other word order counts. The merge happens only
when exactly one untitled record matches — `FM Wang Li` stays apart when both
`Wang, Li` and `Li, Wang` exist — and never across two different FIDE IDs.

Exports are also full of variants that none of these rules catch:

```
Karpov, Anatoly      5,427 games   FIDE 4100026
Karpov, A..          1,164 games
Karpov, A. (bl)         31 games
Karpov, A. (wh)         19 games
Karpov, Anatoly URS     12 games
```

Those records hold games that *are* duplicates of each other, but LPDO cannot
see it while the players differ. Merging the people fixes the games too: the
next dedup pass re-examines the survivor's games and removes the copies.

**To merge them:**

1. Go to **Players** and search for the player.
2. Click the main record, then **Ctrl-click** (Cmd-click on macOS) every
   variant that is the same person.
3. Click **Merge these N players…**.
4. The record with a FIDE ID is kept by default — **Keep instead** on any row
   makes that one the survivor, and **✕** drops a row from the list.
5. Check the summary, then **Merge**.

The dialog warns you when the records may not be the same person: a **different
FIDE ID** has to be acknowledged before the merge is allowed, since FIDE lists
those as two people, and a **different surname** is called out quietly. A merge
cannot be undone, so read those before continuing — `Karpov, Alexander` and
`Karpov, Arkadiy` are not Anatoly.

After merging, run **Remove duplicate games** from the Maintenance panel (or
let the next import's maintenance pass do it) to clear the duplicate games the
merge exposed.

## Rebuilding the database from sources

Games whose moves are spelled differently by two sources can only be matched
once the moves are stored in one canonical spelling. LPDO writes canonical
moves for games imported by recent versions, but it does not rewrite games that
are already in the database: that would mean rewriting the whole games table,
which is expensive and leaves the file permanently larger.

If you want those copies gone, rebuild the database from its sources:

1. Note which collections you'd lose that are not re-importable — your own
   imported PGNs, private games — and **export them first** (Games page →
   select the collection → export).
2. Start a fresh database (Maintenance → reset setup, or point the server at a
   new data directory).
3. Re-import the sources you use (TWIC, Lichess broadcasts, Ajedrez OTB and so
   on) and re-import your exported PGNs.

This is a long operation — hours for a large reference database — and only
worth it if the remaining duplicates bother you.

## Checking what a pass would do

Every dedup run can be previewed. From the machine running the server:

```sh
chess-db games dedup --dry-run
```

It reports how many games *would* be deleted and removes nothing. The run this
starts is incremental: it looks only at games that arrived since the last pass.
