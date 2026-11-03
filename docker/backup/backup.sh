#!/bin/bash
# Database backups for the compose stack: the `app` (our data) and `auth`
# (GoTrue accounts) schemas, in pg_dump's custom format, into /backups.
#
#   backup.sh         run forever: a dump every day at BACKUP_HOUR (UTC)
#   backup.sh now     one dump, then exit
#
# Keeps BACKUP_KEEP_DAYS days of dumps. Restore with scripts/restore.sh.
set -euo pipefail
BACKUP_HOUR=${BACKUP_HOUR:-3}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
export PGHOST=db PGUSER=supabase_admin PGDATABASE=postgres

dump() {
  local f
  f=/backups/macrotracker-$(date -u +%Y%m%dT%H%M%SZ).dump
  pg_dump --format=custom --schema=app --schema=auth --file="$f.part"
  chmod 600 "$f.part"
  mv "$f.part" "$f"
  find /backups -maxdepth 1 -name 'macrotracker-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -delete
  echo "backup: wrote $f ($(du -h "$f" | cut -f1))"
}

if [ "${1:-}" = now ]; then
  dump
  exit 0
fi

until pg_isready -q; do sleep 5; done
echo "backup: daily at ${BACKUP_HOUR}:00 UTC, keeping ${BACKUP_KEEP_DAYS} days"
while true; do
  next=$(date -u -d "$(date -u +%F) $(printf '%02d' "$BACKUP_HOUR"):00:00" +%s)
  [ "$next" -le "$(date -u +%s)" ] && next=$((next + 86400))
  sleep $((next - $(date -u +%s)))
  dump || echo "backup: FAILED" >&2
done
