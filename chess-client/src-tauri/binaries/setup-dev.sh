#!/usr/bin/env bash
# Copy the compiled chess-db binary into the Tauri sidecar directory.
# Run this once after building chess-db, and again whenever chess-db is rebuilt.
#
# Usage: bash src-tauri/binaries/setup-dev.sh

set -e

TARGET=$(rustc -vV | grep host | awk '{print $2}')
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Workspace target dir — chess-db is a member of the top-level Cargo workspace,
# so its build artefacts land in <workspace>/target, not chess-db/target.
SRC="${SCRIPT_DIR}/../../../target/debug/chess-db"
DEST="${SCRIPT_DIR}/chess-db-${TARGET}"

if [ ! -f "$SRC" ]; then
  echo "chess-db binary not found at $SRC"
  echo "Build it first with: cargo build -p chess-db"
  exit 1
fi

cp "$SRC" "$DEST"
echo "Copied chess-db to $DEST"
