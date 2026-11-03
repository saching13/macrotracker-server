#!/bin/sh
# Copies the engine golden vectors from a MacroTracker app checkout (written
# there by `make golden-engine`) into fixtures/engine/. The app repo is
# private, so CI can't fetch them; commit the copy.
#
#   scripts/sync-engine-fixtures.sh [path-to-MacroTracker]   (default ../MacroTracker)
set -eu
app=${1:-../MacroTracker}
src=$app/test/engine/golden/engine_vectors.json
dest=$(dirname "$0")/../fixtures/engine/engine_vectors.json
[ -f "$src" ] || { echo "no golden vectors at $src (run make golden-engine in the app)" >&2; exit 1; }
cp "$src" "$dest"
rev=$(git -C "$app" rev-parse --short HEAD 2>/dev/null || echo unknown)
printf '%s\n' "$rev" > "$(dirname "$dest")/SOURCE"
echo "copied $src (app $rev)"
