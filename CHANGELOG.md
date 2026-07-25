# Changelog

All notable changes to LPDO are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.1] - 2026-07-25

### Added
- **First-run setup resumes after a restart** — if the machine is shut down
  while the initial database load is still running (the deep-history Ajedrez
  download is large), the daemon now continues where it left off on the next
  start instead of dead-ending and forcing a full re-download. A progress-aware
  cap stops a genuinely stuck load from retrying forever. (#134)
- **Per-source update metrics** — the Home screen shows a "Latest updates" list
  (each enabled source's most recent item, date, and games), and the Maintenance
  page groups the same numbers per source under "By source". Replaces the
  TWIC-only "latest issue" readout. (#176)

### Changed
- **Enabling/disabling a source is immediate** — it's applied at once instead of
  queuing behind a running import, so it no longer piles up duplicate entries in
  the activity panel. Disabling a source also cancels its in-flight sync, and the
  coverage timeline updates the moment a source is turned off. (#191)
- **Ajedrez import shows real progress** — one continuous bar across all files
  with a "file N of M" label and a cumulative game count, instead of a frozen
  indeterminate spinner. (#189)
- **The Home profile picker is disabled until the database is ready** — on a
  fresh or still-importing database it shows a short explanation rather than a
  name search that can't match anyone yet. (#122)

### Fixed
- **Re-syncing Ajedrez no longer duplicates imported parts** — stopping and
  restarting the import used to multiply the "issues" to import (2 files × 3 runs
  = 6) and re-import the same games; registration is now idempotent. (#191)
- **Re-enabling a previously-used source works from the toggle** — it no longer
  sits disabled behind the acknowledgment gate. (#191)
- **A stale first-run marker on a populated database is safe** — it no longer
  skips the pre-operation safety snapshot or risks an auto-delete; the daemon
  clears it on startup. (#143)

### Security
- Updated `quinn-proto` to 0.11.16 (fixes a high-severity remote memory-
  exhaustion advisory) and `serde_with` to 3.21.0 (fixes a serialization panic).
  Also bumped `tauri` to 2.11.5, TypeScript to 7, and the GitHub Actions group.

## [0.9.0] - 2026-07-25

### Added
- **Redesigned first-run wizard** — setup is now two clear steps: pick a
  deep-history base (the free Ajedrez Data archive, or an empty database) and
  choose which live feeds to follow (TWIC and/or Lichess Broadcasts). Each
  source is included only if you explicitly tick "I accept these terms", with an
  "About & licence" link to the source's own page. The bring-your-own-Megabase
  path was dropped in favour of this simpler, licence-clear flow.
  (#123, #124, #127, #130, #148)
- **Automatic quality-based date cut-offs** — sources are seeded with windows
  that stitch the best available data together with no manual tuning: Ajedrez up
  to 2012-12-31 for deep history, TWIC from 2013-01-01 (~99% FIDE-identified
  from there), and Lichess Broadcasts from 2020-01-01 (the earliest available).
  You can still widen or narrow any window on the Sources screen. (#148)
- **Backup to a remembered folder** — the Backup panel keeps a backup folder
  (type a path or pick one with Browse) and reuses it, so repeat backups don't
  re-prompt; each file is named by date and collection. (#121)

### Changed
- **Clearer Sources & coverage** — date windows read in plain English
  ("up to 2012-12-31"), the coverage timeline is ordered by start date with the
  deep-history band on top, and each source links to its home page. Activity
  entries name the source being downloaded or imported.
- **Player deduplication shows real progress** — the merge-apply pass reports an
  advancing percentage instead of an indeterminate bar, while keeping the
  set-based speed. (#172)

### Fixed
- **Backup lands where you can open it** — backups are streamed to your chosen
  location (the hardened daemon can't write your home directory itself), and
  "Reveal in file manager" now opens the actual saved file. (#121)
- **Cancelling a large single-file import works** — cancelling an Ajedrez import
  now stops promptly at a safe point instead of running to completion; the
  interrupted archive is left unimported so a re-sync finishes it cleanly. (#157)
- **Collection list stays current** — the player-filter Collection dropdown and
  Home tiles refresh as background imports finish, instead of showing a stale
  count until the next poll.
- **Home statistics no longer flash** during an import.

## [0.8.0] - 2026-07-24

### Added
- **Identity-first maintenance pipeline** — after a large import (or first-run
  setup), the database is prepared in a single coalesced pass that runs in the
  right order: fetch missing FIDE IDs → merge duplicate players → normalise
  names → deduplicate games → build the position index. Weekly feed syncs run a
  lighter pass. Each step appears as its own job in the activity panel. (#167)
- **Manual maintenance tasks** — the Maintenance → Databases tab now offers each
  of these to run on demand: Fetch missing FIDE IDs, Merge duplicate players,
  Normalise player names, Deduplicate games, Position index, and Update FIDE
  list. (#160)
- **Job cancellation** — long-running jobs (imports, indexing, deduplication)
  can be cancelled and stop cleanly at a safe point; queued jobs can be cancelled
  before they start and leave the queue immediately. (#157, #140, #161)

### Changed
- **Updates are governed by Sources, not a global toggle** — enabling a
  reference source (TWIC, Lichess Broadcasts) opts it into automatic background
  refresh; if you enable nothing, nothing runs. The redundant "Automatic
  updates" schedule and the "Additional databases" importer were removed from
  Maintenance (use Add games for imports). The FIDE player list refreshes
  automatically about once a month, independent of feeds. (#160)
- **Merging duplicate players is now near-instant** — reworked from a per-player
  loop into a set-based operation (seconds instead of tens of minutes on a large
  database). (#172)
- **Clearer background progress** — import jobs end with a meaningful summary
  (games imported, into which collection) instead of "Import complete"; steps
  whose duration can't be measured (index rebuild, snapshot, game-count update)
  show an animated "working" bar instead of a stuck 100%; longer text no longer
  truncates to a single line. (#171)

### Fixed
- **Recent players opened the wrong player's games after a reimport** — the
  "Recent" list now re-resolves each player against the current database (by FIDE
  ID or name) instead of trusting a stored id that a reimport invalidates. (#178)
- The setup wizard's "I own a commercial database" step no longer shows two
  competing primary buttons. (#175)
- Import logs show a readable date window ("games dated up to 2024-08-01")
  instead of a cryptic `…..2024-08-01`. (#174)

## [0.7.0] - 2026-07-24

### Added
- **Large PGN import (Megabase-scale)** — the GUI now streams big PGN uploads to
  the daemon instead of failing at the 100 MB limit, accepts compressed
  `.zip`/`.zst`/`.7z` inputs, and runs the import in the background behind a
  non-blocking dialog. Large imports use the fast bulk path and defer duplicate
  detection to a single background pass. (#154)
- **Honest background progress** — the activity panel now shows a real
  byte-based percentage, an estimated time remaining, and the importing filename
  for long jobs, and shows queued work as "queued" with its position rather than
  "Running… 0%". (#158, #128)
- **Local FIDE-based name resolution** — player-name normalisation works from an
  official FIDE player list that the server downloads and refreshes automatically
  each month, entirely locally. Forward resolution canonicalises names for
  FIDE-tagged players; reverse resolution (`chess-db players resolve-fide`)
  assigns FIDE IDs to FIDE-less sources (e.g. Ajedrez) by single-exact name
  match, leaving ambiguous names unresolved. Replaces the previous online cache
  service and per-player scraping. (#162, #152)
- **Clean-slate commands** — `chess-db reset [--caches]` deletes the database
  (and, with `--caches`, downloaded source archives) for a fresh start, refusing
  while the daemon holds the database; `chess-db serve --fresh` wipes before
  serving.
- **Reference-source overlap analysis (CLI)** — new read-only tooling to measure
  how much two reference sources duplicate each other, so an installed deep base
  (e.g. Ajedrez) can inform a date window for a weekly feed (e.g. TWIC). See
  issue #142 and `scripts/twic-ajedrez-cutoff.sh`.
  - **`chess-db sources overlap --a <col> --b <col> [--by month|year|none] [--json]`** —
    reports, per date bucket, how many games in collection A already have a
    duplicate in collection B (using the exact `games dedup` match rule), with a
    coverage percentage.
  - **`chess-db sources items <key> [--limit N]`** — lists a source's tracked
    items (e.g. TWIC issues, or the Ajedrez base/increment files) with
    publication dates, download/import status, and each item's **imported-game
    count and game-date span**, to map a chosen cut-off date back to a starting
    issue number and see what date range each file actually covers.
  - **`chess-db sources fide-coverage [--collection <name>] [--by year]`** —
    reports the share of games with both / one / neither player FIDE-identified,
    plus distinct-player coverage; FIDE ID is the reliable cross-source join
    key, so this judges whether a source can back deep-history dedup.
  - **`chess-db search games --collection <name>`** — restrict search/count to a
    collection (works locally and via the daemon proxy).
  - **`chess-db sources sync --skip-dedup --max-position-depth <N>`** — sync a
    source without duplicate detection and/or without building the position
    index (both are unnecessary overhead for large bulk sources and for overlap
    measurement; `--max-position-depth 0` disables indexing).
- **`LPDO_DATA_DIR`** — set this environment variable to relocate all of
  `chess-db`'s data (database, TWIC zips, backups) from the default `~/.chess-db`
  to a chosen directory. Used by the packaged servers to keep data under a system
  path (Linux `/var/lib/lpdo`, Windows `C:\ProgramData\LPDO`); unset behaviour is
  unchanged.
- **Linux apt packages** — the release now also builds three `.deb`s so the GUI,
  server, and CLI can be installed separately: **`lpdo`** (the GUI; it bundles
  `chess-db`, so it `Provides`/`Conflicts`/`Replaces: lpdo-cli` and
  `Recommends: lpdo-server`, meaning `apt install lpdo` pulls the full desktop
  set), **`lpdo-server`** (the daemon as a systemd *system* service running as
  the `lpdo` user, data under `/var/lib/lpdo`), and **`lpdo-cli`** (the `chess-db`
  binary on `$PATH`). The AppImage is unchanged (portable, per-user
  `~/.chess-db`). Windows/macOS installers are unchanged.
- **CLI works while the server is running** — when the `lpdo-server` daemon is up
  (and holds the database), long-running `chess-db` commands (download, import,
  import-pgn, index-positions, games dedup/cleanup, players normalise/import/export,
  backup) now **proxy to the daemon over HTTP** and stream the same progress,
  instead of failing on the database lock. Falls back to direct access when no
  daemon is running. New `--local` (force direct), `--remote` (force proxy), and
  `--port` / `$LPDO_PORT` flags; Ctrl-C cancels the remote job; `--json` output is
  unchanged.
- **CLI edits work while the server is running too** — the quick game/player
  edit commands (`games soft-delete`/`restore`/`set-visibility`/`add-collection`/
  `remove-collection`/`set-moves`/`set-headers`/`delete`/`purge`, `players merge`/
  `merge-by-name`/`set-fide-id`) now proxy to the daemon's existing endpoints,
  with the same confirmation prompts.
- **CLI reads work while the server is running too** — `status`, `search games`,
  `search players` and `games show` now proxy to the daemon and render the same
  output. With this, essentially the whole CLI works whether or not the daemon is
  running (the only exceptions: `search games --moves-stats` and the admin-only
  `players dedup`/`update-game-counts`/`apply-corrections`, which need `--local`).
- **Background activity view** — a new indicator in the header expands into a
  panel showing the daemon's whole job pipeline: the active job, the queue
  behind it, and recent finishes, across every job type (source syncs, the
  scheduled update, and manual maintenance like dedup/index/backup). Background
  work runs on the daemon even with the app closed, so this is its always-visible
  home; running, interruptible jobs can be cancelled from here.
- **Enabling a source imports it automatically** — turning a source on in
  Maintenance → Sources no longer requires pressing "Sync now". The daemon's
  scheduler picks up enabled-but-not-yet-synced sources on its next tick (~1 min)
  and runs the import in the background, even with the GUI closed. "Sync now"
  remains as an optional manual trigger; a sync that fails or is cancelled is not
  auto-retried, while one interrupted by a restart resumes.

### Changed
- **Phased source syncs** — a source sync now runs Download → Import (fast) →
  visible maintenance (deduplicate, build position index, normalise), mirroring
  the Megabase/upload flow, with each phase shown as its own job in the activity
  panel instead of a hidden tail that left the bar stuck at 100%. Post-import
  maintenance is coalesced to run once after all pending imports drain. (#163,
  #147, #131)
- **Backups are now zip-compressed** — `chess-db backup` (and the GUI's Backup
  action) write a timestamped `.pgn.zip` (a single deflated `.pgn` entry) instead
  of a plain `.pgn`. PGN is text, so this typically shrinks backups several-fold;
  `.zip` opens natively on every OS, and the file re-imports through the existing
  zip reader. Games are streamed straight into the archive rather than assembled
  in memory first.

### Removed
- **Name-normalisation cache service** — the optional self-hosted cache service,
  its build-time API key (`CHESSVAULT_NORMALISE_API_KEY`), and per-player
  `ratings.fide.com` scraping are removed. Normalisation is now fully local
  against the downloaded FIDE list. (#162)

### Fixed
- Import/sync progress no longer appears "stuck at 100%": the deduplicate, index,
  and normalise tail now runs as its own visible jobs. (#147)
- An interrupted source sync no longer leaves the source recorded with zero
  imported items. (#163)

## [0.4.0] - 2026-06-21

Player merge in the app, a reorganised Maintenance screen, and a smarter
server-owned auto-updater.

### Added
- **Merge duplicate players in the app** — combine a full-name record and a
  surname-only one (or any two duplicates of the same person) into a single
  player. Start it from a player's profile (**Merge…**), by **Ctrl/Cmd-clicking
  two players** in the list, or from **Maintenance → Merge players**; all games
  move to the player you keep.

### Changed
- **Home screen shows the latest TWIC issue instead of a count** — the Database
  panel's TWIC tile now displays the most recently imported TWIC issue and its
  publication date (e.g. `#1649 (2026-06-15)`) rather than a tally of imported
  issues. The old count also included local PGN imports; the new figure is the
  latest real TWIC issue. Publication dates are read from the TWIC index and
  backfilled on download.
- **Maintenance "Additional databases" import matches the setup wizard** — the
  bare path text field is replaced by the wizard's import UI: a file/folder
  picker and a collection chooser. Both entry points now look and work the same.
- **Maintenance screen grouped into tabs** — the tools are split across
  **Databases**, **Players** and **Others** tabs (with the database overview
  pinned above) so the screen is no longer one long crowded grid.
- **Player reference file: export + a file picker for import** — the *Player
  reference file* card can now **export** your normalised players to a
  date-stamped CSV (e.g. `20260621-players.csv`) in a chosen folder, with a
  *Reveal in file manager* shortcut. The import path now has a **File…** picker
  instead of only a plain text field.
- **TWIC "Download from issue" is consistent across the wizard and Maintenance** —
  the Maintenance TWIC card now has the same starting-issue field as the setup
  wizard, and the value is shared between the two places (set it in one, it
  carries over to the other).
- **Automatic updates run at a time you choose, plus "Run update now"** — instead
  of firing at whatever time the last run happened to land, the daily update now
  runs at a clock time you set (e.g. 02:00) via a time picker in *Maintenance →
  Automatic updates*, and a **Run update now** button triggers it on demand with
  live progress. Catch-up after downtime still applies: a missed run fires when
  the server next starts.

### Fixed
- **TWIC download no longer re-fetches already-imported issues** — the download
  step only checked whether the local zip file was present, so a pruned zip cache
  made it re-download every past issue (hundreds of MB) even though they were
  already imported. It now skips any issue already imported in the database.
- A foreign key that a from-scratch position-index rebuild added to the index
  could make player merge (and game edits / soft-delete) fail on large databases
  with a "game_id … still referenced" error — DuckDB performs updates as
  delete+insert. The constraint is now removed automatically on startup (a
  one-time migration), and rebuilds no longer add it.
- **Automatic-updates status no longer sticks at "(running…)" after a restart** —
  if the server is restarted mid-update, the scheduler now reconciles the
  orphaned `running` state on startup (marking it `interrupted`) instead of
  leaving it stuck until the next due run.
- **Maintenance database tile no longer conflates local imports with TWIC** —
  the *TWIC issues* figure now counts only real, imported TWIC issues; local PGN
  imports (Megabase, Bundesliga, …) are shown as a separate **Local imports**
  stat, and **Latest TWIC** replaces the old *Downloaded*/*Imported* pair. The
  old counts mixed in local imports and TWIC ids that were registered but never
  downloadable, making the tile look inconsistent (e.g. 904 vs 853).

## [0.3.0] - 2026-06-12

Annotated PGN import.

### Added
- **Import keeps annotations** — PGN import now preserves comments, NAGs and
  variations (and ChessBase `[%cal]`/`[%csl]`/`[%eval]`/… directives) instead of
  flattening games to their main line, so your own annotated games keep their
  analysis. ChessBase's bulky whole-game `[%evp]` eval profile is dropped.
  Applies to newly imported games — games already in your database are left as
  they are, and re-importing under the default duplicate policy skips them, so
  it won't refresh them with annotations.

### Changed
- Updated to **Tauri 2.11** and applied dependency **security updates**
  (rustls-webpki, tar, and related crates).

## [0.2.0] - 2026-06-05

A major upgrade to the move editor.

### Added
- **macOS (Apple Silicon) build** — a signed and notarized `.dmg` for
  `aarch64-apple-darwin` now ships alongside the Linux and Windows installers,
  so it opens on macOS without a Gatekeeper warning. (Added to this release
  after the initial publish.)
- **Lossless editing with variations** — playing an alternative move mid-game
  offers **New variation**, **New main line**, or **Overwrite**
  (ChessBase/Lichess-style); the full move tree is preserved on save.
- **Promote / demote variations** and **delete-from-here**.
- **Comments** on moves and positions.
- **NAGs** for moves (`!`, `?`, `!!`, `?!`, …) and positions (`±`, `=`, `∞`, …),
  shown in the move list and round-tripped through PGN.
- **On-board NAG badge** — the move's glyph is drawn on the destination square,
  chess.com-style.
- **Graphical annotations** — **Ctrl+click** for a circle, **Ctrl+drag** for an
  arrow, in Green/Red/Yellow/Blue plus Magenta/Cyan/Orange; stored as standard
  PGN `[%cal]` / `[%csl]` tags.
- **Game-end / final-position analysis.**
- **In-app update notifier** — checks GitHub Releases on launch and shows a
  dismissible banner with *What's new* and *Download* links when a newer version
  is published. Notify-only: updating stays a manual reinstall, so it never
  conflicts with `apt`/`dpkg`.
- **CI: auto-generated release notes** — the release workflow fills each draft's
  body with a changelog from the commit log since the previous tag (without
  overwriting hand-written notes).

### Changed
- Aligned the view/edit move readout and last-move highlight.

### Removed
- Local dev helper scripts from the repository.

## [0.1.1] - 2026-06-04

### Added
- Wizard: the TWIC **Import** button appears only once the download completes.

### Changed
- Wizard: index positions with `--fast` (appender) to avoid an indexing hang.
- Indexing progress is reported per sub-chunk (no more 0%-until-done bar).
- CI: ship the NSIS `.exe` only; dropped the Windows `.msi`.

### Fixed
- chess-db: detect physical RAM on Windows so the DuckDB `memory_limit` is sane.
- Windows: suppress console windows for spawned chess-db subprocesses.
- Normalise: throttle cache-apply progress events (fixes a laggy progress bar).
- Wizard: disable **Back** while an operation is running.

## [0.1.0] - 2026-06-03

Initial public release — a cross-platform desktop chess database.

### Added
- Tauri desktop app with a chess-db sidecar (TWIC import, DuckDB-backed
  position search, player/tournament prep).
- Setup wizard with fast bulk database import.
- Release CI producing Debian/Linux (`.deb`, `.AppImage`) and Windows (NSIS
  `.exe`) builds, with the name-normalisation cache-service key baked in.

[Unreleased]: https://github.com/specure/lpdo/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/specure/lpdo/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/specure/lpdo/compare/v0.5.2...v0.7.0
[0.4.0]: https://github.com/specure/lpdo/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/specure/lpdo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/specure/lpdo/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/specure/lpdo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/specure/lpdo/releases/tag/v0.1.0
