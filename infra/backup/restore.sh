#!/bin/sh
# Restaura una copia sobre una base. Destructivo: exige el nombre de la base como confirmación.
#
#   docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production run --rm \
#     --entrypoint /bin/sh backup /opt/backup/restore.sh /backups/abyss-AAAAMMDD-HHMMSS.dump <base_destino>
set -eu

FILE="${1:?uso: restore.sh <archivo.dump> <base_destino>}"
TARGET="${2:?indica la base destino (confirmación explícita)}"

[ -f "$FILE" ] || { echo "no existe $FILE" >&2; exit 1; }
pg_restore --list "$FILE" >/dev/null

if ! psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$TARGET'" | grep -q 1; then
  createdb "$TARGET"
fi
pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$TARGET" "$FILE"
echo "restaurado $(basename "$FILE") en $TARGET"
