#!/bin/sh
# Restore drill: on a throwaway stack (compose project mt-drill, test-only
# secrets), make an account and a diary entry, back up, destroy the stack and
# its volumes, start fresh, restore the dump and check the account signs in
# and the entry is back. Exits non-zero if anything is missing.
set -eu
cd "$(dirname "$0")/.."
export API_PORT=18083 PUBLIC_URL=http://localhost:18083 BACKUP_DIR BACKUP_UID BACKUP_GID
# Dumps are mode 600: write them as us so we can read them back.
BACKUP_UID=$(id -u)
BACKUP_GID=$(id -g)
BACKUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mt-drill.XXXXXX")
chmod 777 "$BACKUP_DIR"
dc() { docker compose -p mt-drill --env-file .env.test "$@"; }
trap 'dc down -v >/dev/null 2>&1 || true; rm -rf "$BACKUP_DIR"' EXIT
api=http://127.0.0.1:$API_PORT
json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
login() {
  curl -sf -X POST "$api/v1/auth/login" -H 'content-type: application/json' \
    -d '{"email":"drill@example.test","password":"drill-password-123","device":{"name":"drill","platform":"cli"},"client":"app"}'
}

echo '== a fresh server with an account and an entry'
dc up -d --build --wait db auth api backup >/dev/null
printf 'drill-password-123' | dc exec -T api node dist/cli/create-admin.js --email drill@example.test --password-stdin
token=$(login | json "['access_token']")
curl -sf -X POST "$api/v1/entries" -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d '{"date":"2026-11-03","kcal":432,"protein_g":21}' >/dev/null

echo '== back up, then lose everything'
dc exec -T backup /backup.sh now
dump=$(ls "$BACKUP_DIR"/macrotracker-*.dump | tail -1)
dc down -v >/dev/null 2>&1
dc up -d --wait db auth api backup >/dev/null
if login >/dev/null 2>&1; then echo 'the account survived a wipe?' >&2; exit 1; fi

echo '== restore'
scripts/restore.sh "$dump" -p mt-drill --env-file .env.test
token=$(login | json "['access_token']")
kcal=$(curl -sf "$api/v1/day?date=2026-11-03" -H "authorization: Bearer $token" | json "['totals']['kcal']")
[ "$kcal" = 432 ] || [ "$kcal" = 432.0 ] || { echo "expected 432 kcal after restore, got $kcal" >&2; exit 1; }
echo "restore drill passed: the account signs in and its diary is back ($kcal kcal)"
