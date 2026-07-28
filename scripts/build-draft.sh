#!/usr/bin/env bash
#
# build-draft.sh — build a local draft of all three LPDO .debs (GUI / cli /
# server) at a given version and drop them into ~/lpdo-drafts/ for hand-testing.
#
# Mirrors the CI release job (.github/workflows/release.yml): the GUI .deb comes
# from `tauri build`, and lpdo-cli / lpdo-server come from nfpm reusing the same
# release chess-db binary. Unlike CI it does NOT commit a version bump — it edits
# tauri.conf.json in place and reverts on exit, so the working tree is left clean.
#
# Usage:   scripts/build-draft.sh <version>      e.g. scripts/build-draft.sh 0.11.1
# Output:  ~/lpdo-drafts/{lpdo,lpdo-cli,lpdo-server}_<version>_amd64.deb
#          (override the dir with DRAFTS=/some/path)
#
# Pick a version strictly newer than what's installed on the test machine so
# `apt install ./lpdo*.deb` upgrades cleanly (dpkg version ordering).
set -euo pipefail

VER="${1:?usage: build-draft.sh <version> (e.g. 0.11.1)}"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version '$VER' is not X.Y.Z" >&2; exit 1; }

# Make cargo (rustup) and any user-local tools reachable in non-login shells.
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
export LPDO_VERSION="$VER"
DRAFTS="${DRAFTS:-$HOME/lpdo-drafts}"
TAURI_CONF=chess-client/src-tauri/tauri.conf.json
BUNDLE_DIR=target/release/bundle/deb

# nfpm is not always installed; fetch it to ~/.local/bin (no sudo) if missing.
if ! command -v nfpm >/dev/null 2>&1; then
  echo ">>> installing nfpm to ~/.local/bin"
  NFPM_VER=2.43.0
  mkdir -p "$HOME/.local/bin"
  curl -sSL "https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VER}/nfpm_${NFPM_VER}_Linux_x86_64.tar.gz" \
    | tar -xz -C "$HOME/.local/bin" nfpm
fi

echo ">>> draft version $VER  ->  $DRAFTS"

# Bump the GUI version (the GUI .deb takes its version from tauri.conf.json).
# Reverted on exit — the rest of the tree is already committed, so this is safe.
jq --arg v "$VER" '.version = $v' "$TAURI_CONF" > "$TAURI_CONF.tmp" && mv "$TAURI_CONF.tmp" "$TAURI_CONF"
trap 'git checkout -- "$TAURI_CONF" 2>/dev/null || true' EXIT

echo ">>> [1/6] prune stale bundle .debs"
# The bundler never cleans this dir, so old builds pile up and an ambiguous glob
# can pick the wrong one. Clear it so only this build's .deb remains afterwards.
rm -f "$BUNDLE_DIR"/*.deb 2>/dev/null || true

echo ">>> [2/6] build chess-db sidecar (release)"
cargo build -p chess-db --release
cp target/release/chess-db chess-client/src-tauri/binaries/chess-db-x86_64-unknown-linux-gnu

echo ">>> [3/6] build GUI .deb (tauri)"
( cd chess-client && npm run tauri build -- --bundles deb )

echo ">>> [4/6] build lpdo-cli / lpdo-server .debs (nfpm)"
OUT="$(mktemp -d)"                       # scratch — never the git-tracked dist-deb/
for pkg in cli server; do
  nfpm pkg -f "packaging/nfpm-$pkg.yaml" -p deb -t "$OUT/"
done

echo ">>> [5/6] collect GUI .deb under the lowercase lpdo_ name"
gui="$BUNDLE_DIR/LPDO_${VER}_amd64.deb"  # exact version name, not a glob
test -f "$gui" || { echo "error: GUI .deb $gui not found" >&2; exit 1; }
cp "$gui" "$OUT/lpdo_${VER}_amd64.deb"

echo ">>> [6/6] publish + verify"
mkdir -p "$DRAFTS"
# Clear any older draft .debs so the dir only ever holds the current build.
rm -f "$DRAFTS"/*.deb
cp "$OUT"/lpdo_${VER}_amd64.deb "$OUT"/lpdo-cli_${VER}_amd64.deb "$OUT"/lpdo-server_${VER}_amd64.deb "$DRAFTS/"
for f in "$DRAFTS"/lpdo_${VER}_amd64.deb "$DRAFTS"/lpdo-cli_${VER}_amd64.deb "$DRAFTS"/lpdo-server_${VER}_amd64.deb; do
  # dpkg-deb reports the *control* version — the authoritative one, not the filename.
  printf '  %-42s ' "$(dpkg-deb -f "$f" Package Version | tr '\n' ' ')"
  md5sum "$f" | cut -d' ' -f1
done
echo ">>> done. Install on the test machine with:"
echo "    sudo apt install $DRAFTS/lpdo_${VER}_amd64.deb $DRAFTS/lpdo-cli_${VER}_amd64.deb $DRAFTS/lpdo-server_${VER}_amd64.deb"
