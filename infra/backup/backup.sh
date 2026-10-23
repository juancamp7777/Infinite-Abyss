#!/bin/sh
# Copias de Postgres: pg_dump en formato custom cada BACKUP_INTERVAL_HOURS, verificadas con pg_restore -l,
# retención local de BACKUP_KEEP_DAYS y, si RESTIC_REPOSITORY está definido, copia externa cifrada con restic.
set -eu

INTERVAL_H="${BACKUP_INTERVAL_HOURS:-24}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
DIR=/backups

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: $*"; }

if [ -n "${RESTIC_REPOSITORY:-}" ] && ! command -v restic >/dev/null 2>&1; then
  apk add --no-cache restic >/dev/null
fi

run_once() {
  ts=$(date -u +%Y%m%d-%H%M%S)
  file="$DIR/abyss-$ts.dump"
  # Con DATABASE_URL (Supabase u otro Postgres administrado) se copia esa base; si no, la local (PG*).
  if [ -n "${DATABASE_URL:-}" ]; then
    pg_dump --format=custom --compress=6 --no-owner --no-privileges --schema=public --dbname="$DATABASE_URL" --file="$file.tmp"
  else
    pg_dump --format=custom --compress=6 --no-owner --file="$file.tmp"
  fi
  # Una copia que no se puede leer no es una copia: se verifica antes de darla por buena.
  pg_restore --list "$file.tmp" >/dev/null
  mv "$file.tmp" "$file"
  log "ok $(basename "$file") ($(du -h "$file" | cut -f1))"
  find "$DIR" -name 'abyss-*.dump' -type f -mtime +"$KEEP_DAYS" -delete
  if [ -n "${RESTIC_REPOSITORY:-}" ]; then
    restic snapshots >/dev/null 2>&1 || restic init
    restic backup --quiet --tag abyss "$file"
    restic forget --quiet --tag abyss --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
    log "copia externa subida"
  fi
}

if [ "${1:-}" = "--once" ]; then
  run_once
  exit 0
fi

while true; do
  run_once || log "ERROR: la copia falló (se reintenta en el próximo ciclo)"
  sleep $((INTERVAL_H * 3600))
done
