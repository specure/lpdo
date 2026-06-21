# Design note: client/server architecture

**Status:** design / not yet implemented. This note records the intended
direction and the decisions taken so far, before any of it is built.

## Motivation

The reference database is DuckDB, and **DuckDB's locking is per-process**:

- *Across processes:* either one read-write process, **or** several read-only
  processes — never a writer plus anyone else.
- *Within one process:* multiple connections under MVCC — readers see a
  consistent snapshot **while** a write transaction proceeds.

Today the client/server split is only half-done, and that is the root of the
lock problems we keep patching. `chess-db serve` opens the DB **read-only** and
the client talks to it over HTTP, but every *write* — imports, downloads,
normalise, the daily updater — runs in a **separate** `chess-db` process that
wants its own read-write handle. DuckDB forbids that combination, so we have
worked around it repeatedly (serve's read-only reopen, the daily updater's
"skip if the app is running" guard, manual close-the-app dances). Each of those
patches is the architecture asking for this change.

## Target: the server owns *all* database access

The clean split is not "move the GUI further away" — it is:

> **The server is the sole owner of the database (read *and* write). The client
> holds no database handle at all.**

- **Server** — a single long-running process that owns the DuckDB file
  read-write. Every operation, query *and* mutation, goes through it.
- **Client (the Tauri GUI)** — a thin HTTP client against the server's API.
  Runs on demand; holds no DB connection.
- **Scheduled updates** — driven by a scheduler *inside* the server (see below),
  not by an external OS timer spawning its own writer.

Because all DB access lives in one process, DuckDB's in-process MVCC applies:
a long import can run **while** the server keeps serving queries. Consolidating
into one process is precisely what unlocks "import while querying" — the thing
that is impossible across processes today. The server already has the right
primitive for this: the single-threaded `DbHandle` DB actor in `serve.rs`. It
just needs to also own the write connection and run the mutation jobs.

## Components

### The server

- Owns the **read-write** connection (today `serve` opens read-only — that
  changes).
- A **job queue** for long-running mutations (import / download / index /
  normalise / dedup / delete / backup). The logic already exists as library
  functions in `chess-db`; today it is invoked as subprocesses, and instead
  moves to run in-process as jobs. Jobs are serialized; each emits progress.
- A **read path** for queries. To keep reads responsive during a long write,
  use separate read connections within the process (MVCC), so a 30-minute
  import does not freeze the UI.
- The **scheduler** (next section).
- **API surface:** existing read endpoints (`/status`, `/players`, …) + job
  endpoints (start job → stream progress via SSE/WebSocket → cancel) +
  scheduler status/control. The CLI already emits newline-delimited JSON
  progress (`--json`), which maps almost directly onto a progress stream.

### The clients

- **GUI:** connects to a configurable server URL (localhost by default), shows
  job progress by subscribing to the server, and surfaces scheduler status.
- **The daily updater is subsumed** — there is no separate writer process and
  no lock guard. "Update now" becomes an API call (or is driven entirely by the
  server's own scheduler).

### The server-side scheduler (decided)

Scheduling lives **inside the server**, not in an OS timer. Rationale: the
server is already going to be an always-on daemon for the client's sake, so the
scheduler is nearly free there, it is cross-platform with no per-OS setup, and
it shares the one job queue with GUI-triggered actions. It also gives integrated
status/control ("last updated / next due / update now / pause") instead of an
opaque `systemctl status`.

What the scheduler must implement (these are the things systemd timers gave for
free and which now move in-process):

- **Per-source cadence** — ask each enabled source "due?" (TWIC weekly, Lichess
  monthly), with jitter so we do not hit a source at its exact release minute.
- **Catch-up after downtime** — the `Persistent=true` behaviour. Persist
  last-run (or next-due) per source in the DB the server already owns; on
  startup, run anything overdue. Essential for laptops that are not always on.
- **Retry / backoff** on network failure, surfacing the last error in status.
- **No overlap / no thundering catch-up** — collapse multiple missed runs into
  one; never queue a pile of identical jobs.
- **Optional quiet hours** — so a large monthly import on a laptop can prefer
  idle/overnight.

Schedule state lives in the DB (e.g. alongside the per-source unit ledger), so
there is no extra state file.

## What this retires

- The OS-level timer + the per-OS scheduling docs (systemd / Task Scheduler /
  launchd) — the scheduler is in-process, identical everywhere.
- The "skip if the app is running" lock guard in `~/bin/chess-db-update.sh` —
  it exists only because separate processes fought over the lock.
- The standalone `chess-db update` command becomes a CLI/admin convenience and
  the job the scheduler runs internally, rather than the primary user path.

Until this is built, the current systemd-timer + lock-guard remains a fine
stopgap.

## What the OS is still needed for

A server-side scheduler only fires if the server is alive, so we still rely on
the OS to **keep the daemon up** — start on boot/login, restart on failure.
That is a much simpler, set-once **service** unit (e.g. a systemd user service
with `Restart=on-failure`, `WantedBy=default.target`), not a scheduling timer.
This is the one remaining OS integration, and it is the right place for it.

## Rollout: two phases

The local win and the remote capability are separable, so split the work:

### Phase 1 — local single-writer server (do this before multi-source)

Server becomes the sole long-running read-write owner; all mutations go through
its job queue; the in-process scheduler drives updates; the GUI and the updater
become clients. **Localhost-only, no auth.** This alone:

- dissolves the lock problem at the root (no more cross-process contention),
- gives **always-on scheduled updates whether or not the GUI is open** — the
  "ready at launch" goal, properly,
- and is the foundation multi-source needs, since multi-source is literally
  "several scheduled writers," which cannot be built cleanly on the current
  multi-process-lock model.

### Phase 2 — the dedicated machine (deferred until wanted)

Bind beyond `127.0.0.1`, add **auth** (token), **TLS**, package the server as a
standalone daemon, and add remote server configuration to the client. This is
where the real security surface lives: the server now exposes **write and
delete** endpoints, which must never be reachable unauthenticated. Independent
of Phase 1 and can come once Phase 1 has proven out.

## Keep the single-machine experience "just works"

Most users run everything on one laptop, and that must stay "install and it
works." The default install (the `lpdo-desktop` metapackage on Linux, or the
"Both" option on the Windows/macOS installer — see Packaging) lays down the GUI
plus a **local, always-on server** that the OS service manager keeps running;
the GUI just connects to it on localhost. Done right, Phase 1 *improves* even
the single-laptop case — the server runs
scheduled updates in the background and there are no lock conflicts — and it is
the same change that makes a dedicated server possible later.

## Packaging (decided)

The client and server are **always two separate binaries on every platform** —
`lpdo` (the Tauri GUI) and `lpdod` (the server daemon, today's `chess-db`
binary with `serve` plus the scheduler). "One package or two" is purely a
*delivery* question, and the answer differs by platform while the model stays
the same:

> **Two components everywhere.** Linux expresses the choice as two packages
> (`apt install lpdo` / `lpdod`); Windows and macOS express the same choice as
> selectable components inside one installer. The installer's component page
> *is* the desktop-OS analog of choosing packages on Linux.

This is the conventional Unix split (`postgresql-client`/`-server`,
`docker`/`dockerd`). Its main virtue: **daemon lifecycle lives with the OS, not
the GUI.** The service manager starts `lpdod` at boot and restarts it on
failure, whether or not the GUI is running — exactly the always-on property we
want — and `lpdo` becomes a pure thin client that always speaks HTTP to a
server (defaulting to localhost), with no bundled sidecar and no "should I start
a server?" logic. `lpdod` then behaves identically on a laptop and on a
dedicated box; only the host the client points at changes.

### Per-platform delivery

| Platform | Installer | Component selection | Server runs as |
|----------|-----------|---------------------|----------------|
| Linux    | two `.deb`s (`lpdo`, `lpdod`) + an `lpdo-desktop` metapackage | via package choice (`apt`) | systemd service |
| Windows  | one NSIS `.exe` (or MSI) | **yes** — NSIS components page / MSI feature tree | Windows Service |
| macOS    | one `.pkg` (not `.dmg`) | **yes** — Installer "Custom Install" pane | launchd daemon |

- **Linux** — two single-purpose packages. Keep the laptop install one command
  via a metapackage `lpdo-desktop` that depends on both (preferred), or
  `lpdo` `Recommends: lpdod` (apt installs recommends by default; a pure thin
  client is `--no-install-recommends`).
- **Windows** — one installer with a components page offering **Client /
  Server / Both** (default both). Selecting the server registers a Windows
  Service; a client-only install lays down no service. Needs a **custom Tauri
  NSIS template** (the auto-generated one doesn't do component sections), but
  NSIS supports it cleanly.
- **macOS** — a `.dmg` *cannot* offer choices (it is drag-to-Applications), so
  install-time component selection specifically requires moving to (or also
  shipping) a **`.pkg`** built with `productbuild`, whose "Custom Install" pane
  gives the checkboxes, with a **launchd** daemon for the server component.
  Notarization still applies.

Realistic choices on the desktop installers: **Full desktop (GUI + local
server)** as default, **Client only** (connect to a remote server, no local
daemon), and **Server only** — niche on Windows/macOS since servers are usually
Linux, but essentially free once the component mechanism exists.

### Data location

Going to a separate daemon forces one real decision: where `lpdod` keeps its
data. A system daemon (postgres-style: runs as an `lpdo` user, data under
`/var/lib/lpdo`) is the clean, consistent-local-and-remote choice — but today's
DB lives per-user at `~/.chess-db/chess.db` (~18 GB). Recommended: **system
daemon with a configurable data directory, whose migration adopts an existing
`~/.chess-db` if present.**

### Sequencing

Packaging is the most custom part of the plan on the desktop OSes, so stage it:

- **MVP** — desktop installers simply install **both** by default (GUI + a local
  server service); "client-only-remote" is handled by pointing the app at a
  remote URL with the local service left disabled. Minimal installer work.
- **Later polish** — add the real component picker: cheap-ish on Windows (NSIS
  sections), a bigger lift on macOS (the `.dmg → .pkg` switch).

This keeps the desktop story aligned with the Linux two-package model without
front-loading the trickiest installer work before Phase 2 (remote) needs it.

## Relationship to multi-source

Multi-source ([`multi-source.md`](multi-source.md)) rides directly on Phase 1:
each provider declares its cadence, the in-server scheduler enqueues its job,
and every write goes through the single server. The unit-ledger and
dedup/cross-collection guarantees in that note assume this single-writer server
process.

## Open questions / decisions deferred

- **Auth scheme** for Phase 2 (bearer token vs mTLS).
- **Local file access** — "Browse local PGN files" is a client-side feature
  today; in a remote-client world, decide whether file browsing/import is
  client-side or server-side.
- **Offline behaviour** when a remote server is unreachable (moot for the
  single-machine default).
- **Multiple concurrent clients** against one server — live updates / cache
  invalidation when one client's import changes what another is viewing.

## Summary

Consolidate **all** database access into a single always-on server process
(read *and* write), exposing queries and job-based mutations over an API, with
an **in-process scheduler** driving updates. The Tauri client and the updater
become thin API clients holding no DB handle. Do this locally first (Phase 1) —
it dissolves the lock problem, delivers always-on scheduled updates, and gives
multi-source the single-writer foundation it needs — and defer networking, auth
and TLS to a later, opt-in Phase 2 that turns the same server into one you can
run on a dedicated machine.
