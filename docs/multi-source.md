# Design note: multiple reference-database sources

**Status:** design / not yet implemented. This note records the intended shape so
the dedup and ledger decisions are on record before any code is written.

## Goal

Today the reference database is fed by a single source (TWIC), with a small amount
of local-PGN import on the side. We want to support **several sources**, each a
user-selectable option:

- **TWIC** — weekly PGN issues (already implemented; the reference provider).
- **Lichess broadcasts** — a monthly dump of all games broadcast through Lichess.
- **Lumbra's Gigabase** — a large, occasionally-updated historical archive.
- **Bundesliga** — a static set of league games.
- room for further sources later.

The design generalizes TWIC's existing path behind a provider abstraction; the
scheduling/update model from the automatic-updates work is unchanged.

## What does *not* change: the update/scheduling model

The decision to keep database updates **pre-computed on disk and ready at app
launch** (rather than an in-app scheduler that only runs while the app is open)
stands.

> **Update:** the scheduling mechanism has since been decided in
> [`client-server-architecture.md`](client-server-architecture.md): updates are
> driven by a **scheduler inside the always-on server** (which owns the database
> read-write), not by an OS-level timer running a separate `chess-db update`
> writer. That supersedes the OS-timer + lock-guard approach sketched below, but
> the *property* — pre-computed and ready at launch — is unchanged, and the
> multi-source design below is unaffected by which mechanism drives it.

Concretely (pre-server-scheduler sketch, retained for context):

- A single `chess-db update` command does the whole refresh internally
  (download → import → index → normalise) with a built-in guard that **skips when
  the app is holding the DuckDB write lock** and retries on the next run.
- That command is driven by an **OS-level scheduled job** (systemd user timer on
  Linux, Task Scheduler on Windows, launchd on macOS), set up via a documented
  one-command install.

Either way, multi-source does not alter the model: the update path simply iterates
**every enabled incremental source** instead of being hardwired to TWIC, and each
provider knows its own cadence.

## Source providers

Each source is a provider implementing a common interface, roughly:

- **discover** → which units are available, with metadata (date, size).
- **download(unit)** → fetch a unit.
- **import(unit)** → ingest it into the DB.

A *unit* is whatever the source ships in one piece: a TWIC issue, a Lichess
monthly file, or "the whole archive" for a static source. TWIC, Lichess-broadcasts
and a generic static-archive provider each implement this; future sources are new
implementations only.

### Incremental vs static

- **Incremental** (TWIC weekly, Lichess monthly) participate in `chess-db update`.
  A single daily run asks each enabled source "anything new?" — TWIC answers
  weekly, Lichess monthly. The scheduler needs no per-source knowledge.
- **Static** (Gigabase, Bundesliga) are **not** part of the recurring update. They
  are a one-time `source add` import, re-run manually only when a new edition
  appears.

### The unit ledger (generalizing `issues`)

The current `issues` table is really *TWIC's per-unit import ledger*
(`id, filename, downloaded, imported, game_count, fetched_at, imported_at,
published_at`). Generalize it into a per-source unit ledger keyed by
`(source, unit_id)` carrying the same columns. TWIC's schema is already ~90% of
this shape.

**Hard requirement for dedup (see below):** every source's units must land in this
ledger with `imported = TRUE` and `imported_at` set. The dedup preload keys off
exactly that, so any source that populates the ledger inherits cross-source dedup
for free.

## Provenance = collections (no `source_id`)

`games.source_id` and the `sources` table were deliberately dropped in an earlier
simplification phase. We are **not** bringing them back. Instead, **each source
imports into its own named collection** and collection membership *is* the
provenance record. This is the right model because:

- collections are already many-to-many (the `game_collections` join), so one
  deduped game can legitimately belong to several sources at once — which a single
  `source_id` column cannot express;
- it reuses machinery that already exists end to end (import, serve, UI);
- it needs no new schema.

Out of scope for now (revisit later if wanted): removing a source's games, and
source-filtered preparation (e.g. "OTB only, no online blitz"). Removing a source
just means **no new games arrive from it**; existing games and the collection stay.

## Dedup and cross-collection tagging

This is the part that makes multi-source consistent, and it **already works in the
current importer** — it is not new code we have to write, only behaviour to
preserve as we generalize.

1. **Order-independent dedup via DB preload.** `ImportContext::new`
   (`chess-db/src/importer/mod.rs`) loads existing game fingerprints and ChessBase
   IDs from the database *before* importing, so a game TWIC imported last week is
   recognized when the same game arrives from Lichess this week — regardless of
   import order.

2. **A dedup hit still tags the existing game into the current collection.** Both
   skip branches call `tag_existing_match`, which does
   `INSERT INTO game_collections … ON CONFLICT DO NOTHING` (idempotent). So the
   single game row ends up in **both** the TWIC and Lichess collections, with no
   duplicate row and no dependence on which source imported first.

Result: the "did Lichess really miss this whole tournament?" inconsistency is
prevented by design.

### Three caveats to watch when generalizing

1. **The 1-year preload window.** The dedup preload only loads fingerprints from
   units imported in the **last year** (`imported_at > NOW() - INTERVAL '1 year'`),
   a performance guard so it doesn't hash all ~12M games every import. It keys on
   *when we imported*, not game age, so rolling weekly/monthly sources are fine.
   But a **one-time import of a static archive** (Gigabase, Bundesliga) that
   overlaps with something imported more than a year ago would slip past dedup and
   create duplicates *without* the cross-collection tag. When onboarding the static
   sources, widen or make this window source-aware for that import.

2. **Dedup is wired to the ledger.** The preload filters on
   `issue_id IN (SELECT id FROM issues WHERE imported = TRUE …)`. As `issues`
   becomes the generic unit ledger, the only requirement is that **every source's
   units are recorded there with `imported_at` set** (restated from above because
   it is the load-bearing invariant).

3. **The real weak point is player-name matching, not the dedup logic.** The
   fingerprint is `(white_id, black_id, date, result, opening_line, move_count)`,
   built on *normalized player IDs*. If the same player normalizes to different IDs
   across sources (TWIC "Carlsen, Magnus" vs a Lichess handle or "Magnus Carlsen"),
   the fingerprints differ and the game will not dedup. This is the most likely
   source of stray cross-source duplicates; watch it once Lichess data is flowing,
   and lean on FIDE-ID-based normalisation where the source provides IDs.

## Command surface (sketch)

- `chess-db update` — refresh all **enabled incremental** sources (the scheduled
  command).
- `chess-db source list` — show the catalog and per-source status.
- `chess-db source enable <name>` / `disable <name>` — toggle a source.
- `chess-db source add <name>` — one-shot import of a static source.

## Source catalog and UI

A built-in catalog of known sources, each carrying: name, description, type
(incremental/static), cadence, rough size, **license/attribution**, and a
per-user enabled flag. It drives:

- the **Setup Wizard** → "choose your sources" rather than "download TWIC";
- the **Maintenance panel** → per-source status (last updated, units imported,
  size on disk).

## Practical caveats

- **Licensing/attribution.** TWIC, Lichess (CC0), Gigabase and Bundesliga have
  different terms. The safe pattern is *fetch from origin at the user's request,
  never redistribute*, and show each source's license in the catalog. Decide this
  per source before shipping it as an option.
- **Unit size / streaming.** TWIC issues are small; a Lichess monthly dump or
  Gigabase is a large single file (often `.zst`). The provider's import path needs
  streaming/resumable handling and a disk-space check — something the small-unit
  TWIC model does not stress today.

## Summary

Insert a **provider layer** beneath `chess-db update` and a **source catalog**
beside it. Generalize `issues` into a per-source unit ledger that always records
`imported_at`. Use **collections as provenance** (no resurrected `source_id`).
Dedup and cross-collection tagging already give order-independent consistency;
the only dedup work is widening the 1-year window for one-time static imports and
keeping an eye on cross-source player normalisation.
