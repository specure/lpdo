# LPDO

LPDO is a free, open-source **desktop chess database** built around two things a
competitive player actually does:

1. **Manage your own database of your own games** — import your PGNs, keep them
   clean and de-duplicated, normalise player names, and explore your results and
   statistics over time.
2. **Prepare for tournaments** — research an upcoming opponent, pull in their
   recent games, and get ready for your next competition.

Around those two pillars it can also import weekly tournament data, normalise
player names against FIDE, and browse player profiles and statistics — all
locally, with your data staying on your machine.

It is built with [Tauri](https://tauri.app/) (a React front end and a Rust back
end) and uses an embedded [DuckDB](https://duckdb.org/) database for fast queries
over large collections (hundreds of thousands of games).

> **Status:** active development. Linux is the primary supported platform today.
> Grab the newest build from the [latest release](https://github.com/specure/lpdo/releases/latest)
> (`.deb`/`.AppImage` for Linux, `.exe` for Windows), and see the
> [changelog](CHANGELOG.md) for what's new in each version.

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
- **Download** weekly game collections from The Week in Chess (TWIC) to keep your
  reference data current — see the acknowledgement below.

## Repository layout

This is a Cargo workspace plus a Tauri app:

| Path | What it is |
|------|------------|
| `chess-client/`            | The Tauri desktop app — React/TypeScript front end (`src/`) and Rust back end (`src-tauri/`). |
| `chess-db/`                | The database engine. A Rust binary used both as a CLI and as the app's bundled **sidecar** (import, download, dedup, normalise, export, backup). |
| `fide-client/`             | Library for looking up players and games on FIDE. |
| `chess-results-client/`    | Library for fetching tournament data from chess-results.com. |

The desktop app runs `chess-db` as a sidecar binary and talks to it over a small
JSON event protocol.

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
cd chess-client
npm install

# Build the chess-db sidecar (release) and copy it into src-tauri/binaries/
npm run dev:prepare

# Launch the desktop app with hot-reloading
npm run tauri dev
```

`dev:prepare` compiles `chess-db` and copies the binary to
`src-tauri/binaries/chess-db-<target-triple>`, which Tauri bundles as a sidecar.
Re-run it whenever you change `chess-db`. The compiled sidecar is intentionally
**not** committed to the repository — it is a build artefact rebuilt from source.

### Production build

```bash
cd chess-client
npm run dev:prepare      # ensure the sidecar is up to date
npm run tauri build
```

### Use chess-db on its own

`chess-db` is a normal CLI and can be run without the GUI:

```bash
cargo run -p chess-db --release -- --help
```

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

LPDO can download and import data from **The Week in Chess (TWIC)**, published
weekly since 1994 by **Mark Crowther** at <https://theweekinchess.com/>. TWIC is a
free, invaluable, independent resource that this feature relies on. The app asks
you to review TWIC's terms — and consider supporting Mark's work — before
downloading. Please do.

## License

Licensed under the **Apache License, Version 2.0**. See [LICENSE](LICENSE) and
[NOTICE](NOTICE) for details.

Copyright 2026 Specure. "LPDO" is a trademark of Specure; the Apache-2.0 license
does not grant rights to the LPDO name or logo.
