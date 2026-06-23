#!/usr/bin/env bash
# Self-contained test for the #82 auto-recovery path.
# Starts a clean server (fault injection on, scheduler off) on a throwaway DB,
# fires the injected invalidation, and shows that the server recovers in-process.
set -u

PORT=7787
DATA=/tmp/lpdo-fault-test
BIN=./target/release/chess-db
LOG=/tmp/lpdo-fault-test.log

echo "== killing any stray test server / freeing the port =="
pkill -f "target/release/chess-db serve --port $PORT" 2>/dev/null
sleep 1
rm -rf "$DATA" "$LOG"; mkdir -p "$DATA"

echo "== starting server (LPDO_FAULT_INJECTION=1, LPDO_DISABLE_SCHEDULER=1) =="
LPDO_DATA_DIR="$DATA" LPDO_FAULT_INJECTION=1 LPDO_DISABLE_SCHEDULER=1 \
  "$BIN" serve --port "$PORT" > "$LOG" 2>&1 &
SRV=$!

# wait for it to listen
for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/status" >/dev/null 2>&1 && break
  sleep 0.25
done

echo "== status BEFORE =="
curl -s "http://127.0.0.1:$PORT/status" | head -c 140; echo

echo "== firing the injected invalidation =="
curl -s -X POST "http://127.0.0.1:$PORT/jobs" \
  -H 'content-type: application/json' -d '{"type":"__fault_invalidate"}'; echo
sleep 1

echo "== job error (expect: '...invalidated (injected fault)...') =="
curl -s "http://127.0.0.1:$PORT/jobs/job-1" | grep -o '"error":"[^"]*"'; echo

echo "== status AFTER (server must still answer => recovered) =="
curl -s "http://127.0.0.1:$PORT/status" | head -c 140; echo
echo "== a read query AFTER (writer + readers alive) =="
curl -s "http://127.0.0.1:$PORT/players?limit=1"; echo

echo "== SERVER CONSOLE LOG =="
cat "$LOG"

kill "$SRV" 2>/dev/null
echo "== done (server stopped) =="
