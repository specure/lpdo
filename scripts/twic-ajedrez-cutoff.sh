#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Determine the optimal TWIC cut-off date when the Ajedrez reference DB is
# installed.  See GitHub issue #142 for the full write-up.
#
# Idea: Ajedrez is the deep historical OTB base; TWIC is the weekly live tail.
# For old games the two overlap almost entirely, so importing old TWIC issues
# is wasted work (games dedup removes them anyway).  This script measures, per
# month, what fraction of TWIC's games Ajedrez already contains ("coverage"),
# and reports the earliest month where coverage drops below a threshold — the
# date from which TWIC starts contributing new games.  That date is what you'd
# pass to `chess-db sources window twic --from <DATE>`.
#
# It is fully self-contained and repeatable: it builds a THROWAWAY database
# (never your real ~/.chess-db), so you can run it as often as you like.
#
# Requirements: a `chess-db` with the `sources overlap` / `sources items` /
# `search games --collection` additions and `sources sync --skip-dedup
# --max-position-depth` (LPDO >= 0.5.1 + PR for #142), plus `python3`.
#
# Usage:
#   scripts/twic-ajedrez-cutoff.sh                 # full run (downloads a lot)
#   BIN=./target/release/chess-db  scripts/twic-ajedrez-cutoff.sh
#   FROM_ISSUE=1400 TO_ISSUE=1650  scripts/twic-ajedrez-cutoff.sh
#   REUSE=1 scripts/twic-ajedrez-cutoff.sh         # re-analyse without re-syncing
#   FRESH_DB=1 scripts/twic-ajedrez-cutoff.sh      # rebuild DB from cached archives
#   CLEAN=1 scripts/twic-ajedrez-cutoff.sh         # wipe everything incl. cache
#
# Downloaded archives are CACHED and reused across runs.  `chess-db` reuses any
# archive already on disk (the download step skips a file that exists), so the
# ~740 MB Ajedrez base and the TWIC zips are fetched only once per machine as
# long as DATA points at a persistent directory.  DATA therefore defaults to a
# durable cache under $HOME, NOT /tmp (which is wiped on reboot).  Layout:
#     $DATA/ajedrez-otb/  $DATA/twic/   <- cached archives (kept)
#     $DATA/chess.db                    <- the experiment database (rebuildable)
#
# Env knobs (all optional):
#   BIN          chess-db binary            [./target/release/chess-db]
#   DATA         persistent cache + db dir  [${XDG_CACHE_HOME:-$HOME/.cache}/lpdo-experiments]
#   FROM_ISSUE   first TWIC issue to fetch  [1] (1 = full history; heavy!)
#   TO_ISSUE     last TWIC issue to fetch   [latest]
#   THRESHOLDS   coverage cut-offs (%)      ["90 95 99"]
#   REUSE=1      skip sync/import if the DB already has both collections
#   FRESH_DB=1   rebuild the DB from the CACHED archives (no re-download)
#   CLEAN=1      wipe EVERYTHING incl. cached archives (full from-scratch)
# ---------------------------------------------------------------------------
set -euo pipefail

BIN="${BIN:-./target/release/chess-db}"
DATA="${DATA:-${XDG_CACHE_HOME:-$HOME/.cache}/lpdo-experiments}"
DB="$DATA/chess.db"
FROM_ISSUE="${FROM_ISSUE:-1}"
TO_ISSUE="${TO_ISSUE:-}"
THRESHOLDS="${THRESHOLDS:-90 95 99}"
TWIC_COL="TWIC"
AJ_COL="Ajedrez OTB"
OUT="$DATA/overlap.jsonl"

# All commands run locally against the experiment DB (never proxy to a daemon).
export LPDO_LOCAL=1
export LPDO_DATA_DIR="$DATA"
run() { "$BIN" --db "$DB" "$@"; }

command -v python3 >/dev/null || { echo "python3 is required for the analysis step" >&2; exit 1; }
[ -x "$BIN" ] || { echo "chess-db not found/executable at: $BIN (set BIN=...)" >&2; exit 1; }

echo "== chess-db: $("$BIN" --version)  (data dir: $DATA) =="
if [ "${CLEAN:-0}" = 1 ]; then
  echo "== CLEAN: removing $DATA (including cached archives) =="
  rm -rf "$DATA"
elif [ "${FRESH_DB:-0}" = 1 ]; then
  echo "== FRESH_DB: removing only the database, keeping cached archives =="
  rm -f "$DB" "$DB".wal "$DB"-shm "$DB"-wal 2>/dev/null || true
fi
mkdir -p "$DATA"

have_both() {
  local a t
  a=$(run search games --collection "$AJ_COL"   --count 2>/dev/null || echo 0)
  t=$(run search games --collection "$TWIC_COL" --count 2>/dev/null || echo 0)
  [ "${a:-0}" -gt 0 ] && [ "${t:-0}" -gt 0 ]
}

if [ "${REUSE:-0}" = 1 ] && have_both; then
  echo "== REUSE: both collections already populated, skipping sync/import =="
else
  # --- 1. Ajedrez: the historical base ------------------------------------
  echo "== [1/3] syncing Ajedrez (bulk .7z; ~740 MB compressed) =="
  echo "         (--skip-dedup --max-position-depth 0: no dup-scan, no position index —"
  echo "          both are pure overhead for this overlap measurement)"
  run sources enable ajedrez-otb
  run sources sync   ajedrez-otb --skip-dedup --max-position-depth 0

  # --- 2. TWIC: the weekly tail -------------------------------------------
  echo "== [2/3] downloading + importing TWIC issues $FROM_ISSUE..${TO_ISSUE:-latest} =="
  echo "         (import --skip-dedup so TWIC games are NOT deduped away against"
  echo "          Ajedrez — both collections must survive for overlap to see them)"
  if [ -n "$TO_ISSUE" ]; then
    run download --from "$FROM_ISSUE" --to "$TO_ISSUE" --dir "$DATA/twic"
  else
    run download --from "$FROM_ISSUE" --dir "$DATA/twic"
  fi
  run import --dir "$DATA/twic" --skip-dedup --max-position-depth 0
fi

echo "== collection sizes =="
printf '  %-14s %s\n' "$AJ_COL"   "$(run search games --collection "$AJ_COL"   --count)"
printf '  %-14s %s\n' "$TWIC_COL" "$(run search games --collection "$TWIC_COL" --count)"

# --- 3. Overlap: coverage of TWIC by Ajedrez, per month --------------------
echo "== [3/3] computing overlap (TWIC covered by Ajedrez), per month =="
run --json sources overlap --a "$TWIC_COL" --b "$AJ_COL" --by month > "$OUT"
echo "   (raw monthly JSON -> $OUT)"
echo "== per-year summary =="
run sources overlap --a "$TWIC_COL" --b "$AJ_COL" --by year

# --- Analysis: pick D* per threshold ---------------------------------------
# D*(T) = the oldest month M such that, from M onward, MOST months fall below T
# coverage (i.e. the productive region). Robust to sparse/odd single months.
echo "== suggested cut-off D* per threshold =="
python3 - "$OUT" "$THRESHOLDS" <<'PY'
import json, sys
rows = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    o = json.loads(line)
    if o.get("bucket") == "TOTAL": continue
    b = o["bucket"]
    if len(b) != 7 or b[4] != '-' or '?' in b:   # keep clean YYYY-MM only
        continue
    rows.append((b, int(o["a_total"]), float(o["coverage"])))
rows.sort()
thresholds = [int(x) for x in sys.argv[2].split()]
if not rows:
    print("  no clean monthly buckets — widen the issue range?"); sys.exit(0)
for T in thresholds:
    t = T/100.0
    # Scan newest->oldest; the cut-off is where the well-covered tail begins.
    # D* = oldest month whose coverage < T with the region from it to the end
    # being majority-below-T (>=60% of its months under T).
    star = None
    for i in range(len(rows)):
        region = rows[i:]
        below = sum(1 for _,_,c in region if c < t)
        if rows[i][2] < t and below >= 0.6*len(region):
            star = rows[i][0]; break
    tot = sum(a for _,a,_ in rows)
    kept = sum(a for m,a,_ in rows if star and m >= star)
    print(f"  T={T:>2}%  D*={star or 'n/a':<8}  "
          f"TWIC games kept from D*: {kept:>8}/{tot} "
          f"({(100*kept/tot if tot else 0):.1f}%)")
PY

# --- Map D*(95%) back to a starting TWIC issue -----------------------------
DSTAR=$(python3 - "$OUT" <<'PY'
import json, sys
rows=[]
for line in open(sys.argv[1]):
    o=json.loads(line or "{}")
    if o.get("bucket")=="TOTAL": continue
    b=o.get("bucket","")
    if len(b)==7 and '?' not in b: rows.append((b,float(o["coverage"])))
rows.sort()
t=0.95; star=""
for i in range(len(rows)):
    region=rows[i:]; below=sum(1 for _,c in region if c<t)
    if rows[i][1]<t and below>=0.6*len(region): star=rows[i][0]; break
print(star)
PY
)
if [ -n "$DSTAR" ]; then
  echo "== D*(95%) = $DSTAR  ->  first TWIC issue on/after that month =="
  run --json sources items twic \
    | python3 - "$DSTAR-01" <<'PY'
import json,sys
cut=sys.argv[1]
best=None
for line in sys.stdin:
    o=json.loads(line or "{}")
    p=o.get("published_at")
    if p and p>=cut and (best is None or p<best[1]):
        best=(o.get("external_id"),p)
print(f"  download --from {best[0]}   (issue published {best[1]})" if best
      else "  (no TWIC issue found on/after the cut-off in the ledger)")
PY
  echo "== To apply the cut-off on a real install: =="
  echo "     chess-db sources window twic --from $DSTAR-01"
fi
echo "== done. DB: $DB  |  cached archives kept under $DATA (reused next run). =="
echo "   re-run: REUSE=1 (re-analyse) · FRESH_DB=1 (rebuild DB, no re-download) · CLEAN=1 (wipe all)"
