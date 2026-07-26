#!/bin/sh
# Refresh the MIME + desktop databases so the Chess PGN association (lpdo.xml +
# the .desktop MimeType) takes effect (#104/#210). Best-effort; never fail install.
set -e

if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database /usr/share/mime >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

exit 0
