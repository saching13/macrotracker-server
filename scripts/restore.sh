#!/bin/sh
# Restores a dump from the backup service into this stack's database,
# replacing everything in the `app` and `auth` schemas (all accounts and data).
#
#   scripts/restore.sh backups/macrotracker-YYYYMMDDTHHMMSSZ.dump [compose args…]
#
# e.g. on a tunnel deployment: scripts/restore.sh <file> -p macrotracker -f compose.yaml -f compose.tunnel.yaml
# Stops the API and auth while it runs. The dump must come from this server
# version or older (the API migrates it forward when it starts).
set -eu
file=$1
shift
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }
dc() { docker compose "$@"; }
args="$*"

# shellcheck disable=SC2086
dc $args stop api auth
# shellcheck disable=SC2086
dc $args exec -T db psql -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
  -c 'SET client_min_messages = warning' \
  -c 'DROP SCHEMA IF EXISTS app CASCADE' -c 'DROP SCHEMA IF EXISTS auth CASCADE'
# shellcheck disable=SC2086
dc $args exec -T db pg_restore -U supabase_admin -d postgres --exit-on-error < "$file"
# shellcheck disable=SC2086
dc $args up -d --wait auth api
echo "restored $file"
