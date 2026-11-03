#!/bin/sh
# Copies the golden files from a MacroTracker app checkout (written there by
# `make golden-engine`): the engine's vectors into fixtures/engine/ and the
# rows the app uploads into fixtures/sync/. The app repo is private, so CI
# can't fetch them; commit the copies.
#
#   scripts/sync-engine-fixtures.sh [path-to-MacroTracker]   (default ../MacroTracker)
set -eu
app=${1:-../MacroTracker}
root=$(dirname "$0")/..
rev=$(git -C "$app" rev-parse --short HEAD 2>/dev/null || echo unknown)
for pair in engine/golden/engine_vectors.json:engine sync/golden/wire_rows.json:sync; do
  src=$app/test/${pair%%:*}
  dir=$root/fixtures/${pair##*:}
  [ -f "$src" ] || { echo "no golden file at $src (run make golden-engine in the app)" >&2; exit 1; }
  mkdir -p "$dir"
  cp "$src" "$dir/"
  printf '%s\n' "$rev" > "$dir/SOURCE"
  echo "copied $src (app $rev)"
done
