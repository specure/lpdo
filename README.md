<h1 align="center">LPDO</h1>

<p align="center">
  <strong>A free, open-source desktop chess database.</strong><br>
  Your games, your opponents, your preparation — on your own machine.
</p>

<p align="center">
  <a href="https://github.com/specure/lpdo/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/specure/lpdo?color=2563eb"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS-lightgrey">
  <img alt="Built with" src="https://img.shields.io/badge/built%20with-Rust%20%2B%20Tauri%20%2B%20DuckDB-orange">
</p>

<p align="center">
  <img src="docs/images/screenshot-games.png" alt="LPDO showing a player's games, an interactive board and the game score" width="100%">
</p>

---

LPDO is built around two things a competitive player actually does:

1. **Manage your own database of your own games** — import your PGNs, keep them
   clean and de-duplicated, normalise player names against FIDE, and explore
   your results and statistics over time.
2. **Prepare for tournaments** — research an upcoming opponent, pull in their
   recent games, and study what you will be facing.

Around those two pillars it keeps a **reference database** current from public
sources, so the opponent you look up tomorrow already has last week's games in
it. Everything runs locally: your data stays on your machine.

> **Status:** active development. Linux is the primary supported platform today.
> Grab the newest build from the
> [latest release](https://github.com/specure/lpdo/releases/latest), and see the
> [changelog](CHANGELOG.md) for what's new in each version.

## Highlights

### Browse games on a real board

Search a player, filter their games, and step through any of them with the
score alongside the board. Edit headers, fix a game, or export it back out as
PGN. Light and dark themes, adjustable text size, and a board that keeps up
with fast clicking through hundreds of moves.

### See what an opponent actually plays

<p align="center">
  <img src="docs/images/screenshot-openings.png" alt="Opening tree: candidate moves with game counts, score percentages and performance, with arrows drawn on the board" width="100%">
</p>

Walk the opening tree move by move. Each candidate move shows how often it was
played, the win/loss split, when it was last used and the performance rating —
and the game list underneath narrows to exactly the games that reached that
position. This is the tournament-prep loop: pick your opponent, follow their
repertoire, find the branch they are least comfortable in.

### Four ways in, and a database that stays current

<p align="center">
  <img src="docs/images/screenshot-home.png" alt="LPDO home screen with four entry points, database totals and the latest source update" width="100%">
</p>

The home screen puts the four things you actually open the app for one click
away — your own games, preparation for your next round, a player lookup, and
browsing PGN files straight off disk without touching the database. Underneath
it, the current size of your database and what came in most recently.

That "latest updates" line is the reference database keeping itself fed. LPDO
pulls from several public sources — **The Week in Chess**, **Lichess
Broadcasts** and **Ajedrez Data (OTB)** — each behind its own switch, checks
them on a schedule you choose, de-duplicates the overlap between them
automatically, and reports progress on long syncs without blocking the rest of
the app.

## Features

**Manage your own games**

- **Import** games from PGN files into a local database.
- **De-duplicate** a collection, with a readable log of exactly which games were
  removed and which copy was kept.
- **Normalise player names** against FIDE, so the same player isn't split across
  spelling variants. An optional shared cache service can make the first run much
  faster (see [Name-normalisation cache](#name-normalisation-cache-optional)).
- **Player profiles & statistics**, including a personalised home screen scoped to
  your own games.
- **Backup** your private "My games" collection to a timestamped PGN file.

**Prepare for tournaments**

- **Match preparation** against an upcoming opponent — look them up, pull their
  recent games, and study what you'll be facing.
- **Opening tree** over any position, with game counts, scores and performance.
- **Position search** across the whole database, backed by a position index.

**Keep it current**

- **Multiple reference sources** (TWIC, Lichess Broadcasts, Ajedrez Data), each
  toggled on or off independently — see the acknowledgements below.
- **Scheduled feed checks** at a time you choose, with a missed check (machine
  off) picked up at the next start.
- **Automatic maintenance** — dedup, indexing and normalisation run as part of a
  sync instead of being chores you have to remember.

## Install

Download from the [latest release](https://github.com/specure/lpdo/releases/latest):

| Platform | Package |
|----------|---------|
| **Linux** | `lpdo_<version>_amd64.deb` (desktop app), `lpdo-server_<version>_amd64.deb` (background server), `lpdo-cli_<version>_amd64.deb` (`chess-db` CLI) |
| **Windows** | `LPDO_<version>_x64-setup.exe` (installer, includes the server as a Windows service) |
| **macOS** | `LPDO_<version>_aarch64.pkg` (Apple Silicon) |

On Linux the desktop app is a thin client — install **`lpdo-server`** as well
(or run `chess-db serve` yourself) so there is a database for it to talk to.

## Architecture

LPDO is a client/server application:

- The **server** (`chess-db serve`) is the sole owner of the DuckDB database,
  for both reads and writes. Every long-running mutation — import, download,
  dedup, index, normalise, backup — runs in-process as a job that streams its
  progress, and an in-process scheduler drives the daily feed checks.
- The **desktop client** is a [Tauri](https://tauri.app/) app (React/TypeScript
  front end, Rust back end) that holds no database handle at all and talks to
  the server over HTTP.

Consolidating all database access into one process is what makes "import while
you keep querying" possible — DuckDB's locking is per-process. See
[docs/client-server-architecture.md](docs/client-server-architecture.md) for
the full design note.

### Repository layout

This is a Cargo workspace plus a Tauri app:

| Path | What it is |
|------|------------|
| `chess-client/`            | The Tauri desktop app — React/TypeScript front end (`src/`) and Rust back end (`src-tauri/`). |
| `chess-db/`                | The database engine: a Rust binary used both as the CLI and as the server (`chess-db serve`). |
| `fide-client/`             | Library for looking up players and games on FIDE. |
| `chess-results-client/`    | Library for fetching tournament data from chess-results.com. |
| `packaging/`               | `.deb` (nfpm), systemd units and installer scripts. |

## Building from source

### Prerequisites

- **Rust** (stable) — <https://rustup.rs/>
- **Node.js** 18+ and **npm**
- **Tauri system dependencies** for your OS — see the
  [Tauri prerequisites guide](https://tauri.app/start/prerequisites/). On
  Debian/Ubuntu this is roughly `webkit2gtk`, `librsvg`, `build-essential`, and
  related `-dev` packages.

### Run the app (development)

```bash
# 1. Build and start the server (owns the database)
cargo run -p chess-db --release -- serve

# 2. In another terminal, launch the desktop client with hot-reloading
cd chess-client
npm install
npm run tauri dev
```

### Production build

```bash
cd chess-client
npm run tauri build
```

### Use chess-db on its own

`chess-db` is a normal CLI and can be run without the GUI:

```bash
cargo run -p chess-db --release -- --help
```

Set `LPDO_DATA_DIR` to relocate the database, downloads and backups away from
the default `~/.chess-db`.

## Design notes

Longer-form design documents for planned or in-progress work live in
[`docs/`](docs/):

- [Client/server architecture](docs/client-server-architecture.md) — why the
  server owns the database, and how jobs and the scheduler fit around that.
- [Multiple reference-database sources](docs/multi-source.md) — how LPDO
  supports several reference sources behind a common provider abstraction, using
  collections as provenance and deduplication for cross-source consistency.

## Name-normalisation cache (optional)

Normalising player names is the slowest first-time task, because it scrapes FIDE
once per player. LPDO can optionally consult a small self-hosted **cache service**
that returns pre-computed canonical names for a batch of FIDE IDs in a single
request; only the misses fall back to per-player FIDE lookups.

- The service lives in a **separate repository** and is **not** part of this repo.
- The client reaches it only when an **API key** is provided at build time via the
  `CHESSVAULT_NORMALISE_API_KEY` environment variable (see `.env.example`). The key
  is never committed — it is read from the build environment.
- A build **without** that key (e.g. a contributor's clone) simply uses the
  standard FIDE-only normalisation. Nothing breaks.

## Acknowledgements

LPDO downloads and imports data from public chess archives that other people
maintain, often for free and for decades:

- **[The Week in Chess](https://theweekinchess.com/)** — published weekly since
  1994 by **Mark Crowther**. A free, invaluable, independent resource that this
  feature relies on. The app asks you to review TWIC's terms — and consider
  supporting Mark's work — before downloading. Please do.
- **[Lichess Broadcasts](https://database.lichess.org/)** — over-the-board
  tournament games relayed live on Lichess and packaged monthly.
- **[Ajedrez Data — OTB](https://ajedrezdata.com/)** — a free public-domain
  archive of over-the-board games, used as the deep historical base.

## License

Licensed under the **Apache License, Version 2.0**. See [LICENSE](LICENSE) and
[NOTICE](NOTICE) for details.

Copyright 2026 Specure. "LPDO" is a trademark of Specure; the Apache-2.0 license
does not grant rights to the LPDO name or logo.
