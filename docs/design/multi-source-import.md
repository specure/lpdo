# Multi-source curated import — design

Tracking: [#40](https://github.com/specure/lpdo/issues/40).

LPDO currently imports games from a single source (TWIC, *The Week in Chess*).
This design generalizes import to **multiple, explicitly-curated sources** so
onboarding is a matter of picking from a catalog. It covers auto-updating
**feeds** (TWIC-like) and static **bulk** databases now, with online **APIs**
(Chess.com / Lichess) as a later kind.

## Baseline: the TWIC-shaped stack today

| Layer | State | TWIC coupling |
|---|---|---|
| Acquisition | `twic::download` + `twic::index` | URLs, `twicNg.zip`, issue-number ids |
| Ledger | `issues` table | TWIC ids `<1e6`; local PGN imports at id `≥1e6` (already overloaded) |
| Import | `importer::import` (ledger → "TWIC" collection); `importer::import_pgn` (any file → named collection) | `import` is TWIC-coupled; `import_pgn` is already generic |
| Provenance | `games.issue_id → issues.id`; grouping via `collections`/`game_collections` ("TWIC" seeded) | clean |
| Orchestration | `update` job = hardcoded 4-step TWIC pipeline; daily scheduler | fully TWIC |
| Frontend | wizard `TwicStep` + maintenance `TwicSection` POST `download`/`import`; one global schedule | hardcoded TWIC; hook/API generic |

Two facts shape the design: the import → DB-writer path is already
source-agnostic (only acquisition + orchestration are TWIC-bound), and
source→collection is effectively 1:1 already.

## Model: code **catalog** + per-DB **state**

- **Catalog (compiled in)** — the curated list users pick from; holds metadata +
  an acquisition strategy (code, so it can't live in the DB):

  ```rust
  struct CatalogSource {
      key: &'static str,        // "twic", "lumbras", "lichess-broadcasts", …
      name: &'static str,       // "The Week in Chess"
      kind: SourceKind,         // Feed | Bulk   (Api later)
      description: &'static str,
      homepage: &'static str,
      credit: &'static str,     // attribution shown before first download
      acquire: Acquire,         // Feed(Box<dyn FeedDriver>) | Bulk(BulkSpec)
  }
  ```

- **Per-DB state (tables)**:
  - `sources` — lean state table: `key, enabled, credit_acked, last_run,
    last_status`. (This is *not* the old `games.source_id` that Phase 2 removed;
    no per-game column returns.)
  - `source_items` — the ledger, renamed from `issues`, with a `source_key`
    column.

## Source kinds

- **Feed** (TWIC-like): publishes numbered/dated items; incremental; schedulable.

  ```rust
  #[async_trait]
  trait FeedDriver {
      async fn list_items(&self) -> Result<Vec<FeedItem>>;            // (external_id, published, url)
      async fn fetch_item(&self, item: &FeedItem, dest: &Path) -> Result<()>;
  }
  ```

  TWIC is the first impl (list = scrape index; fetch = download zip). The generic
  download loop, dedup-skip, and `source_items` bookkeeping move out of `twic/`
  into a shared `sources/` runner.

- **Bulk** (Lumbra's Gigabase, Bundesliga, …): one/few large files fetched by a
  known URL (`BulkSpec`), imported via `import_pgn` into the source's collection.
  Curated bulk entries are **free / redistributable** sets only. Not part of the
  daily auto-update (one-shot / manual refresh). Ad-hoc local files keep using the
  existing `import_pgn` path.

## Decisions (locked)

1. **Source = its collection (1:1).** Each source's games go to one auto-managed
   collection named after it (as TWIC does). "Filter by source" reuses the
   collection UI. Provenance stays `games.issue_id → source_items.source_key`.
2. **Rename `issues` → `source_items` + `source_key`.** Migrate rows: `id<1e6 →
   'twic'` (external_id = issue number), `id≥1e6 → 'manual'`. `games.issue_id`
   keeps pointing at it.
3. **Bulk catalog = free auto-downloadable sets only** (`BulkSpec` = a download
   URL). Redistributability vetted when entries are picked (Phase B).

## Orchestration

- **Generalized `update` job:** iterate **enabled Feed sources** → for each:
  `list_items` → download new → import into its collection → then a **single**
  global `index-positions` + `normalise`. Bulk sources excluded (manual).
- **Scheduler:** unchanged single daily tick calling the generalized update.
  Per-source schedules = future.
- **Jobs/CLI gain `source`** (default `"twic"` for back-compat). New `sources
  list | enable <key> | sync <key>` and (later) `sources add`.

## Frontend (Phase C)

- A **Sources catalog** screen (cards per curated source: kind, description,
  credit link, Enable/Sync, per-source status).
- Wizard: a **"Choose your sources"** multi-select step (TWIC pre-checked).
- Maintenance: `TwicSection` → `SourcesSection` (per-source rows).
- `StatusInfo` gains `sources: [{key, name, kind, items, last_imported}]`;
  `DatabaseInfo` shows a per-source breakdown. Hook/API already generic.

## Phasing (each a PR)

- **Phase A — backend foundation** (this PR): `source_items` migration +
  `sources` state table + catalog + `FeedDriver` + TWIC ported + generalized
  `update`/scheduler + CLI `sources` + `source` job param. UI untouched; TWIC
  keeps working. Also folds in the **#82 root cause** (make a `--fast` import fail
  gracefully so it can't poison the writer) into the new generic runner.
- **Phase B — bulk sources:** curated bulk catalog entries + bulk acquisition +
  catalog UI.
- **Phase C — UI polish:** wizard step, per-source maintenance, status breakdown.
- **Phase D — one's own online games** ([#90](https://github.com/specure/lpdo/issues/90)),
  the server side done 2026-10-13: see "Online accounts" below.

## Online accounts (#90)

Not a catalog source: one's **accounts** on Lichess and Chess.com, linked to
a local player (`accounts`: platform, username, the handle's own player row,
the owner, enabled, last sync and status — `chess-db/src/accounts.rs`).

- A handle is a **virtual player**: its own `players` row with `platform`
  set (`lichess` / `chesscom`), found and made apart from every other player
  by the importer (the platform is part of its key), so a handle never lands
  on a real name spelt the same. The FIDE resolution, the normalisation from
  the FIDE list and the player dedup leave such rows alone. The link to one's
  identity is the account; `identity_ids` widens a player id to its handles,
  which is how "my games" in the repertoire takes online games in — within a
  **scope**: all (the default), over the board only, online only (`scope=`
  on the chapter/book `mine` and `games` endpoints).
- The **sync** (`sync_accounts` job: one account, or every enabled one; run
  by the daily `update` too, and by hand through `POST /accounts/{id}/sync`,
  `POST /accounts/sync`): Lichess streams the user's games as PGN from a
  timestamp; Chess.com's monthly archives are fetched from the month of the
  last sync on, the current month's a live list. Both from a day before the
  last sync; games already held — by their address in `games.site` (Lichess's
  Site, Chess.com's Link, written into Site) — are dropped, the rest go
  through `import_pgn` into the private collection **My online games**, the
  positions indexed, as the platform's games (`games.platform`). No tokens:
  public games only.
- **Time control** is stored with every game from now on, from any PGN that
  has it: `games.time_control` as written, `games.time_class` bullet / blitz /
  rapid / classical / correspondence (Lichess's bounds on base + 40 ×
  increment). No filtering at import; the user filters.
- The **reference figures** (the Reference query, a chapter's figures) leave
  games with a platform out: platform ratings are not FIDE ratings, and these
  games are private.
- **Recent games**: `GET /players/{id}/recent?days=7&scope=all` — one's games
  of the last days, the handles' too, newest first, each with its match
  against the books (`match_line`: the chapter, how far, who left it where),
  the time control and the platform. The phone-less review of today's games.
- Out of scope: bots, variants, Lichess tokens for private games. The UI
  (accounts on the Sources page, the Recent games view) is phase 2.

## Candidate sources (from #40)

Lumbra's Gigabase, Lichess Broadcasts, Lichess general DB (>7B games — size needs
a streaming/sampling strategy), Bundesliga AT. Redistributability + size to be
vetted per entry in Phase B.
