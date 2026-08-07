# Changelog

All notable changes to LPDO are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.16] - 2026-08-07

### Changed
- **Position indexing commits ~25× less often and reads the games table once
  instead of ~140 times** — one transaction per 50k-game window (each commit is
  a WAL flush, the dominant cost on Windows) and fixed id-window paging in
  place of repeated tail-scans. On Windows the daemon also raises itself to
  Above Normal priority. Measured on the same 7.1M-game database: a full
  rebuild went from **2h 48m to 5m 38s** on Windows (~30× faster) and from
  4m 28s to **3m 07s** on Linux — closing a 36× platform gap to 1.8×. (#245)
- **Windows installer: full Client / Server / CLI component model** — the GUI
  is now a real optional component (server-only or CLI-only machines install no
  GUI, and a GUI-only install skips the chess-db binary entirely — it talks to
  a server over HTTP); the command-line component controls the PATH entry, with
  proper descriptions on the components page. (#67)
- **The Maintenance page shows what you're running** — a footer with the GUI
  version, the server version, and the API contract, so a client/server
  mismatch is visible at a glance.

### Fixed
- **The daily update no longer loops for hours after the scheduled time** — the
  refresh threshold is local wall-clock but the last-run stamp was written in
  UTC, so on (e.g.) UTC+2 every feed stayed "due" from 04:00 until 06:00 and
  the whole pipeline re-ran back-to-back. Long-standing; exposed by the full
  activity history in 0.14.15.
- **"Server offline" now recovers by itself** — the client retries every few
  seconds while disconnected (the daemon needs a moment to open a large
  database after an install or reboot); previously one failed check pinned the
  offline banner for up to 30 minutes.
- **Upgrades no longer race the running service** — the installer now waits for
  the Windows service to fully stop (up to 60s) before replacing its files,
  instead of failing with "Error opening file for writing".

## [0.14.15] - 2026-08-06

### Fixed
- **First-run setup on Windows is hours faster** — the "Merge duplicate
  players" step dropped from ~45 minutes to ~30 seconds (and from ~3 minutes to
  ~6 seconds on Linux). Root cause, found via CLI benchmarks on the real
  database: updating an ART-indexed column pays a per-row incremental index
  delete+insert (~4,600× slower than the same update without the index), so the
  player merge and game dedup now drop the affected `games` indexes and
  bulk-rebuild them afterwards. Game deduplication and name normalisation
  roughly halved on Windows too; feed imports run ~2× faster via a larger WAL
  checkpoint threshold. Position indexing improved ~3× on Windows (further work
  tracked in #244). (#244)
- **A fatal "Failed to delete all rows from index" during first-run dedup no
  longer invalidates the database** — collection reassignment avoids the
  composite-key upsert that corrupted the index, and the orphan sweep rebuilds
  `game_collections` instead of row-deleting from it (which also repairs a
  previously-corrupted index). (#244)
- **Interrupted manual imports no longer leak multi-GB `upload-*` spool files**
  — the daemon sweeps them from its data directory at startup.

### Changed
- **Source syncs show as separate Download and Import tasks** — each feed
  refresh (wizard, Sources page, daily scheduler) enqueues a Download + Import
  pair with individual durations in the activity panel, instead of one combined
  "Sync" entry. (#244)
- **The activity panel keeps the whole session's history** — the Recent list no
  longer trims to the last 8 entries; the panel scrolls through every job since
  the daemon started.
- **Windows: upgrades are seamless** — installing a newer version no longer
  asks about uninstalling the previous one or about application data (whose
  checkbox could delete the database mid-update); it updates in place, keeping
  all data. Same-version repair and downgrades keep the interactive flow.
- **Windows: the installer offers a components page** — the background database
  server (Windows service) is now an optional, default-on component, and
  `chess-db.exe` is added to the system PATH. (#67)

## [0.14.10] - 2026-08-03

### Added
- **Collection filter on the Players page** — the same collection selector from
  the Games filters rail now appears on the Players page, scoping the player
  search (and the selected player's games and opening explorer) to a chosen
  collection. (#219)

### Changed
- **Home "My games" opens your player, not a collection** — the quick link now
  scopes the Players view to your configured profile player only, instead of
  also filtering by a "My games" collection that may not exist. It's disabled
  until a profile player is set, with a hint to configure one.

### Fixed
- **Importing a folder works again** — selecting a folder in the Add-games
  dialog failed with "not a file"; the client now expands the folder into its
  PGN / `.zip` / `.zst` / `.7z` files and imports each. (#236)
- **Recent players list drops stale entries** — opening the Players view now
  reconciles the Recent list against the database, removing players that were
  merged or purged and collapsing duplicate rows that resolve to the same
  player.

## [0.14.5] - 2026-08-01

### Added
- **Collection filter in the Games filters rail** — pick a collection to
  restrict both the game list and the opening explorer to it (or "All
  collections"); the explorer's popularity stats now respect the selected
  collection too, matching the game list. (#219)
- **Lichess analysis settings** — a ⚙ popover in the Lichess panel to toggle the
  chessdb-style Replies/Strong per-move fetches on or off (off gives plain
  Stockfish lines with no child-position requests) and to choose how many lines
  to show (3/5/8/12); both persist, letting you dial Lichess request volume
  down. (#221)

## [0.14.1] - 2026-07-31

### Changed
- **Faithful Lichess power-move marks** — the `!`/`?` marks now use chessdb's
  real, measured constants: a three-tier scale (`!` best, no mark within ~0.05,
  `?` beyond), plus a lost-position gate that marks everything `?` once the best
  move is clearly losing so the opponent isn't implied to have good options.
  (#221)
- **Steadier, lighter Lichess requests** — outbound requests are throttled per
  source, the top-move Replies/Strong fan-out is capped at 5, and cloud evals
  are cached for 24h with a reload (⟳) button to refresh on demand. (#221)

### Fixed
- **Lichess rate-limit poison** — bursts of per-move fetches were tripping
  Lichess's 429, and the daemon cached that as "unknown", so even popular
  positions (including the start position) wrongly showed "not in Lichess's
  cloud" for the whole cache window; non-answers (429/5xx/parse failures) are no
  longer cached. (#221)

## [0.14.0] - 2026-07-31

### Added
- **Cloud engine in the Games engine panel** — analyse the explorer's current
  position against chessdb.cn (crowd evals) or Lichess/Stockfish, toggled per
  source and persisted; unknown positions offer a "Request analysis" queue.
  (#221)
- **Multi-move lines you can click into** — each candidate renders as a single
  move-plus-continuation line with the eval right-aligned; every move in a line
  is clickable and jumps to the position after it. chessdb top moves get
  Stockfish-style continuation lines. (#221)
- **Power-move Replies/Strong for both sources** — each move gets a quality mark
  by eval loss, with Replies (opponent's legal moves) and Strong (how many are
  near-best) shown for chessdb and brought to Lichess/Stockfish. (#221)
- **Deepen and watch for deeper analysis** — queue a position for further
  chessdb crowd analysis and watch it in the background; when a deeper result
  lands you get an in-app notification and the panel refreshes live. (#221)
- **Copy FEN** — a button below the board flip control copies the current
  position's FEN to the clipboard. (#221)
- **Games-page state persistence** — the Games page restores your last analysed
  line, cursor, applied filters, rail state, and selected game when you leave
  and return, surviving a restart. (#221)

### Changed
- **Lichess/Stockfish is the default engine** — it gives deep, real Stockfish
  evals for popular positions as the better first impression; chessdb stays one
  toggle away, and an explicit switch still persists. (#221)

## [0.13.1] - 2026-07-30

### Added
- **APT repository for easy Linux updates** — released `.deb` packages are now
  published to a signed APT repo on GitHub Pages, so after a one-time setup
  Linux users can update with `apt update && apt upgrade`. (#216)

### Fixed
- **Upgrading from pre-0.5.0 builds no longer errors** — `lpdo-cli` now takes
  over `/usr/bin/chess-db` from the obsolete monolithic `lpdo` package and
  removes it automatically instead of failing with a file conflict. (#216)

## [0.13.0] - 2026-07-30

### Added
- **New Analysis workbench** — a top-level Analysis tab for working across
  several games at once: one mini-board tab per open game, the active game as a
  fully editable board (comments, NAGs, graphical annotations, notation),
  reference-DB moves and related games that follow the current position
  (transposition-aware), and resizable panels throughout. Open a game via "Open
  in Analysis" from the Games or Players lists. Open tabs and the active tab
  persist across restarts. (#220)
- **Players page analysis layout** — the Players view now shows the full
  analysis mosaic (position board, opening explorer, game list, mini board, move
  list) scoped to the selected player, with a collapsible player list, and shows
  the player's name in the game-list header even when the list is collapsed.
  (#219)

### Changed
- **Export warns about unsaved edits** — exporting a game while the moves editor
  has unsaved changes now asks you to confirm first, offering to save via Done
  so the edits are included.

### Fixed
- **Faster, cancellable position-index rebuild** — the incremental index pass no
  longer re-scans the multi-million-row positions table on every batch, turning
  a multi-hour job back into roughly three minutes, and a cancel is now honored
  mid-batch instead of requiring a server restart. (#212)
- **PGNs page collapse toggles and dividers respect light mode** — they used
  hardcoded dark colors and stayed dark; they now follow the active theme.
- **Lichess Broadcast shows the real publish date** — the "Latest" date now
  comes from the newest file's actual Last-Modified time instead of a synthetic
  start-of-month placeholder.

## [0.12.0] - 2026-07-29

### Added
- **New Games analysis layout** — the Games page is reorganized into a six-panel
  analysis board showing everything at once: position board with opening
  explorer, DB move stats, game list, and a read-only mini board plus move list
  for the selected game. Panels are resizable with drag handles that persist
  their sizes, and a collapsible filter rail (players, colour, event, year) sits
  on the left. The explorer and the selected game are independent, so exploring
  moves no longer clears the selected game. (#219, #222)

### Changed
- **Unified board navigation and move lists** — both boards use the same
  ⏮ ‹ › ⏭ controls, move lists are scrollable and clickable, focused move lists
  respond to ←/→ and Home/End, and the game list uses aligned columns you can
  drag to resize (widths persisted). Future moves are no longer greyed out.
  (#219)

### Fixed
- **Mini-board move animations are correct** — pieces no longer overshoot to
  double distance and snap back; each board now has a unique id and explicit
  sizing so react-chessboard animates the right squares. (#219)

## [0.11.0] - 2026-07-28

### Added
- **Games page** — a new database-wide game browser: search the whole database
  without picking a player first, with Player 1 / Player 2 autocomplete, event
  and year-range filters, and infinite scroll. It includes an always-on opening
  explorer that shows move statistics over all matching games and filters the
  list to games reaching the current position.
- **`chess-db --system` flag and empty-database hint** — `--system` resolves the
  database path to the server's system-service database so you can read it while
  the daemon is stopped, and a stderr hint now points there when a local command
  would otherwise show a confusing "0 games". (#214)

### Changed
- **Opening explorers now number their moves** — the Games and Players explorers
  prefix each move-stats row with its move number (White "N.", Black "N...").
- **`search games --moves-stats` is now proxyable** — it works while the daemon
  holds the database lock, proxied to the server's `/position/moves` instead of
  returning "not proxyable". (#213)

## [0.10.0] - 2026-07-27

### Added
- **Open large and compressed PGN files locally** — a new DuckDB-free engine
  opens huge PGN files (including `.zip` / `.zst` / `.gz`) instantly, with a
  header index that grows while you browse, an LRU cache so flipping between
  files is instant, and header search/replay. Validated on an 11M-game / 12 GB
  database. (#104)
- **`.pgn` file association** — double-clicking a `.pgn` (or `.pgn.gz` /
  `.pgn.zst`) file opens it in LPDO's PGN browser; registered as a handler so
  ChessX/SCID and other apps keep working. (#104, #210)
- **Job timestamps and durations in the activity panel** — recent jobs show when
  they finished and how long they took, and a running job shows its elapsed
  time. (#170)

### Changed
- **Offline network jobs pause and retry instead of failing** — downloads and
  syncs that fail because the machine is offline now pause and offer "Retry now"
  rather than erroring, using a cluster/network dependency-ordered queue so
  unrelated local work no longer stalls behind a paused job. (#206)
- **Clearer sync completion message** — reports the actual number of games
  imported (with thousands separators) instead of a vague "preparing the
  database in the background".
- **Home "preparing" banner shows overall progress** — the bar now climbs across
  the whole pipeline instead of resetting as each task finishes.

## [0.9.3] - 2026-07-26

### Added
- **Feeds now import every game with no date cutoff** — TWIC and Lichess pull
  all games from each issue (a weekly/monthly issue can carry games dated in an
  earlier period); only Ajedrez still caps at 2012-12-31. The coverage timeline
  still draws each feed from roughly its first-issue date.

### Changed
- **Much faster deduplication** — duplicates are now matched by move fingerprints
  in SQL and removed set-based, with no per-game PGN parsing; on a
  heavily-overlapping dataset a dedup run drops from minutes to seconds. The
  longer (more complete or annotated) copy is kept as the survivor.
- **"Latest update" per source shows the newest published item** — rather than
  the last imported one, so it no longer counts backwards during an initial
  import or sticks on the oldest month.

### Fixed
- **Player game counts refresh after deduplication** — removing duplicate games
  no longer leaves a player's total overstated. (#205)

## [0.9.2] - 2026-07-26

### Added
- **Enabling a feed starts an immediate sync** — turning on TWIC or Lichess
  Broadcasts kicks off a download and import right away instead of waiting for
  the scheduler's next tick, and the enabled state stays responsive even while
  another source is still importing. (#195)
- **Ajedrez has a one-shot "Download & import" action** — the deep-history base
  uses a single download-and-import button (with licence acknowledgment) instead
  of an enable/disable toggle, is excluded from the daily scheduler, and re-runs
  import only the parts not yet imported. (#196)
- **Configurable daily update-check time** — set one time for all feeds to be
  checked for updates, with a readout of the next check and the FIDE-list
  refresh status. (#194)
- **Per-source metrics on each source card** — each card shows its own latest
  item, date, and games imported, replacing the aggregated Home and Maintenance
  blocks. (#197)
- **Incremental/Full switch for manual deduplication** — the Maintenance
  deduplication panel lets you re-check every game (Full) or only games added
  since the last pass (Incremental).

### Changed
- **Deduplication is incremental and unified into one maintenance pass** — a
  `deduped` marker lets a run examine only games added since the last pass, and
  identity-first maintenance (resolve FIDE, dedup players, normalise, dedup
  games, index) now runs once in the background for every source.
- **Deduplication matches the same game across differently-annotated sources** —
  a game shipped as bare SAN by TWIC now matches its Lichess broadcast copy
  (with eval/clock comments and NAGs) via a canonical move comparison; the
  manual "Run deduplication" re-checks all games to clean up copies earlier
  passes missed.

### Fixed
- **Sync progress bar no longer sticks at 100%** — the bar switches to an
  indeterminate animation during an import's initialization instead of lingering
  at the download stage's final 100%.
- **Source enable/disable state survives navigation** — toggling a feed while
  another is importing no longer reverts the toggle after switching pages and
  back.
- **FIDE card reflects background refreshes** — the player-list card updates its
  last-refreshed date and due status after a scheduled or post-sync refresh,
  without needing a manual page reload.

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

## [0.5.2] - 2026-07-23

### Added
- **Filter game searches by collection** — `search games --collection <name>`
  restricts results to a single source's collection, available locally, through
  the daemon proxy, and on the server. (#144)
- **Reference-source overlap diagnostics** — new read-only CLI commands to judge
  how much two sources duplicate each other before importing: `sources overlap`
  (per-bucket duplicate counts and coverage), `sources items` (each tracked
  item's dates, import status, and game-date span), and `sources fide-coverage`
  (how many games and players carry FIDE IDs). (#142)

### Changed
- **Bulk-import mode is chosen by download size, not item count** —
  coarse-grained sources like Lichess monthly packages, and single multi-GB
  PGNs, now correctly take the fast bulk path instead of appearing stuck at 100%
  on the slow inline one. (#146)
- **A freshly synced source is searchable right away** — the position indexing
  and player normalisation that a large sync defers now run immediately after
  it, instead of waiting for the next daily update. (#146)

### Fixed
- **Adding games from a file or paste works against the hardened daemon again** —
  the GUI now uploads the PGN content itself rather than a path the sandboxed
  system daemon can't read under your home directory or `/tmp`. (#153)

## [0.5.1] - 2026-07-23

### Added
- **Multi-source import with a Sources catalog** — the database can now be built
  from a curated catalog of sources beyond TWIC, including the Lichess
  Broadcasts monthly feed and the Ajedrez OTB deep-history archive, each managed
  from a new Sources screen with enable toggles, an attribution acknowledgment,
  and a configurable per-source game-date window so sources partition the
  timeline instead of re-importing overlapping games. (#40)
- **Onboarding wizard rebuilt around the multi-source model** — a simple
  populate-vs-empty choice with a deep-history option, and a first-run pipeline
  that imports and prepares the database as a visible background queue with a
  live readiness banner. (#98, #109)
- **Background auto-sync and an activity dashboard** — enabling a source is
  enough; the daemon picks it up and syncs it in the background (even with the
  GUI closed), and a header activity panel shows the whole job pipeline with the
  ability to cancel running work. (#99)
- **The CLI works while the daemon is running** — long-running jobs, quick edits,
  and read/query commands now transparently proxy to the daemon over HTTP
  (previously every command failed on the database writer lock), falling back to
  direct access when no daemon is running. (#58)
- **Cross-platform system-service installers** — a Windows installer that sets up
  the server as a service and puts the CLI on PATH, a signed and notarized macOS
  `.pkg` that registers a launchd daemon (plus a `chess-db service` command), and
  a Linux apt package family split into `lpdo` / `lpdo-server` / `lpdo-cli`.
  (#65, #67, #68)
- **`chess-db --version`** — the CLI now reports its version instead of erroring
  on the flag. (#77)

### Changed
- **Backups are compressed** — `backup` (and the GUI Backup action) now writes a
  timestamped `.pgn.zip` instead of a plain `.pgn`, typically several times
  smaller, opening natively on every OS and round-tripping back through the
  importer. (#91)
- **Large PGN imports stream instead of loading the whole file into memory** —
  memory is now bounded by the parse batch rather than the file size, so a
  multi-GB import no longer spikes memory by the file's size. (#95)
- **Position indexing is fast by default and crash-safe** — the fast path is now
  guarded by a safety snapshot; the CLI's `index-positions` runs fast by
  default, with the old `--fast` opt-in replaced by an opt-out `--safe`. (#139)
- **Fresh installs no longer import the same games twice** — Ajedrez and TWIC
  ship complementary default date windows that dovetail at their coverage
  boundary instead of both importing the full span. (#126)

### Fixed
- **The daemon recovers from a database invalidation instead of staying dead
  until restart** — a fatal DuckDB error now triggers an in-process reconnect,
  so the server keeps serving rather than requiring a manual `systemctl restart`.
  (#82)
- **The GUI no longer creates a hidden second database** — it is now a pure
  client of the OS-managed system daemon rather than spawning its own embedded
  server against a separate data directory. (#79)
- **A single corrupt archive no longer fails an entire feed sync** — bad items
  are skipped with a warning and summarised at the end, and stay unimported so a
  re-sync retries them, instead of flipping the whole sync to failed. (#133)
- **Add-games surfaces import failures** — a failed submission now shows an
  "Import failed" banner instead of silently reappearing the button and looking
  like a no-op. (#132)
- **Upgrading the CLI package restarts the server** — `lpdo-server` is now
  restarted when `lpdo-cli` is upgraded, so it runs the new binary immediately
  instead of the old one until the next reboot. (#120)

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

[Unreleased]: https://github.com/specure/lpdo/compare/v0.14.16...HEAD
[0.14.16]: https://github.com/specure/lpdo/compare/v0.14.15...v0.14.16
[0.14.15]: https://github.com/specure/lpdo/compare/v0.14.10...v0.14.15
[0.14.10]: https://github.com/specure/lpdo/compare/v0.14.5...v0.14.10
[0.14.5]: https://github.com/specure/lpdo/compare/v0.14.1...v0.14.5
[0.14.1]: https://github.com/specure/lpdo/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/specure/lpdo/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/specure/lpdo/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/specure/lpdo/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/specure/lpdo/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/specure/lpdo/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/specure/lpdo/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/specure/lpdo/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/specure/lpdo/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/specure/lpdo/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/specure/lpdo/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/specure/lpdo/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/specure/lpdo/compare/v0.5.2...v0.7.0
[0.5.2]: https://github.com/specure/lpdo/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/specure/lpdo/compare/v0.4.0...v0.5.1
[0.4.0]: https://github.com/specure/lpdo/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/specure/lpdo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/specure/lpdo/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/specure/lpdo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/specure/lpdo/releases/tag/v0.1.0
