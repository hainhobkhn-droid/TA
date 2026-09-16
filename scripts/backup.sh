#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
: "${AGE_RECIPIENT:?Export your age public recipient}"
: "${BACKUP_DIR:?Export an encrypted-backup destination; copy it off-host}"
command -v age >/dev/null
mkdir -p "$BACKUP_DIR"
helpa_stamp=$(date -u +%Y%m%dT%H%M%SZ)
helpa_tmp=$(mktemp -d)
helpa_services=()
while IFS= read -r helpa_service; do
  case "$helpa_service" in app|worker) helpa_services+=("$helpa_service");; esac
done < <(docker compose ps --status running --services)
helpa_services_stopped=false
cleanup() {
  rm -rf "$helpa_tmp"
  if [ "$helpa_services_stopped" = true ] && [ "${#helpa_services[@]}" -gt 0 ]; then docker compose start "${helpa_services[@]}" >/dev/null; fi
}
trap cleanup EXIT
# Brief maintenance window keeps database and media mutually consistent.
helpa_services_stopped=true
if [ "${#helpa_services[@]}" -gt 0 ]; then docker compose stop "${helpa_services[@]}" >/dev/null; fi
docker compose exec -T postgres pg_dump -U helpa -d helpa -Fc > "$helpa_tmp/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar app -C /app/media -cf - . > "$helpa_tmp/media.tar"
git rev-parse HEAD > "$helpa_tmp/revision.txt"
printf '%s\n' "$helpa_stamp" > "$helpa_tmp/created-at.txt"
COPYFILE_DISABLE=1 tar -C "$helpa_tmp" -cf - . | age -r "$AGE_RECIPIENT" -o "$BACKUP_DIR/helpa-$helpa_stamp.tar.age.partial"
mv "$BACKUP_DIR/helpa-$helpa_stamp.tar.age.partial" "$BACKUP_DIR/helpa-$helpa_stamp.tar.age"
echo "Encrypted backup created. Keep encryption/auth keys separately and verify the off-host copy."
