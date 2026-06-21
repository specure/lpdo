# Changelog

All notable changes to LPDO are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Merge duplicate players in the app** — combine a full-name record and a
  surname-only one (or any two duplicates of the same person) into a single
  player. Start it from a player's profile (**Merge…**), by **Ctrl/Cmd-clicking
  two players** in the list, or from **Maintenance → Merge players**; all games
  move to the player you keep.

### Fixed
- A foreign key that a from-scratch position-index rebuild added to the index
  could make player merge (and game edits / soft-delete) fail on large databases
  with a "game_id … still referenced" error — DuckDB performs updates as
  delete+insert. The constraint is now removed automatically on startup (a
  one-time migration), and rebuilds no longer add it.

### Changed
- **Home screen shows the latest TWIC issue instead of a count** — the Database
  panel's TWIC tile now displays the most recently imported TWIC issue and its
  publication date (e.g. `#1649 (2026-06-15)`) rather than a tally of imported
  issues. The old count also included local PGN imports; the new figure is the
  latest real TWIC issue. Publication dates are read from the TWIC index and
  backfilled on download.

### Fixed
- **Automatic-updates status no longer sticks at "(running…)" after a restart** —
  if the server is restarted mid-update, the scheduler now reconciles the
  orphaned `running` state on startup (marking it `interrupted`) instead of
  leaving it stuck until the next due run.

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

[Unreleased]: https://github.com/specure/lpdo/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/specure/lpdo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/specure/lpdo/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/specure/lpdo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/specure/lpdo/releases/tag/v0.1.0
