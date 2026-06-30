# Changelog

All notable changes to LPDO are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- **Backups are now zip-compressed** — `chess-db backup` (and the GUI's Backup
  action) write a timestamped `.pgn.zip` (a single deflated `.pgn` entry) instead
  of a plain `.pgn`. PGN is text, so this typically shrinks backups several-fold;
  `.zip` opens natively on every OS, and the file re-imports through the existing
  zip reader. Games are streamed straight into the archive rather than assembled
  in memory first.

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

[Unreleased]: https://github.com/specure/lpdo/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/specure/lpdo/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/specure/lpdo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/specure/lpdo/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/specure/lpdo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/specure/lpdo/releases/tag/v0.1.0
