#!/bin/sh
# Refresh the MIME + desktop databases after removal so the association is
# cleaned up (#104/#210). Best-effort; never fail removal.
set -e

if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database /usr/share/mime >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

exit 0
