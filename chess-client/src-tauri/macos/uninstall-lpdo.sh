#!/bin/bash
# Uninstall LPDO (macOS). Removes the app + the system server daemon, but KEEPS
# the database (large/expensive to rebuild) — mirrors the Linux/Windows behaviour.
# Installed to /usr/local/bin/lpdo-uninstall by the .pkg. Run:  sudo lpdo-uninstall
set -uo pipefail

LABEL="com.specure.lpdo.server"
DATA_DIR="/Library/Application Support/LPDO"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo:  sudo lpdo-uninstall" >&2
  exit 1
fi

# Stop + unload the system daemon (no-op if not loaded).
launchctl bootout "system/${LABEL}" 2>/dev/null || true
rm -f "/Library/LaunchDaemons/${LABEL}.plist"

# Also boot out a stale per-user agent, if the user ever ran `chess-db service install`.
if [ -n "${SUDO_UID:-}" ]; then
  launchctl bootout "gui/${SUDO_UID}/${LABEL}" 2>/dev/null || true
fi

rm -f /usr/local/bin/chess-db
rm -rf /Applications/LPDO.app

echo "LPDO removed. The database is kept at:"
echo "  ${DATA_DIR}"
echo "To delete it too:  sudo rm -rf \"${DATA_DIR}\""
rm -f /usr/local/bin/lpdo-uninstall   # remove self last
