#!/usr/bin/env bash
#
# A point-in-time copy of everything this host keeps:
#
#   /opt/compose/apps/agent-studio/scripts/backup.sh [DEST_DIR]      # default: ./backups
#
# Writes `<dest>/<timestamp>/db.sql.gz` (a `pg_dump` of the app's database
# through gzip), `<dest>/<timestamp>/mcp-memory.sql.gz` (the same for the
# database mcp-memory keeps its memories in — a second database on the same
# server, and a backup that skipped it lost every remembered thing while
# reporting success), and `<dest>/<timestamp>/objects/` (every object in the
# bucket, as files), plus a copy of `.env.host` — the credentials the data
# needs. Keeps the newest KEEP (default 7) backups.
#
# Restore, on a fresh host with compose up and `.env.host` restored:
#   gunzip -c db.sql.gz | docker compose exec -T postgres psql -U agent_studio agent_studio
#   gunzip -c mcp-memory.sql.gz | docker compose exec -T postgres psql -U agent_studio mcp_memory
#   docker compose run --rm --entrypoint sh -v "$PWD/objects:/restore:ro" minio-init \
#     -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mirror /restore "local/$S3_BUCKET_NAME"'

set -euo pipefail

cd "$(dirname "$0")/.."

dest="${1:-./backups}"
keep="${KEEP:-7}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$dest/$stamp"
mkdir -p "$out"
umask 077

bucket="$(grep -E '^S3_BUCKET_NAME=' .env | head -1 | cut -d= -f2-)"

echo "== database"
docker compose exec -T postgres pg_dump -U agent_studio --clean --if-exists agent_studio |
  gzip -9 > "$out/db.sql.gz"

# A database the app never opens, and the only copy of what agents remember.
# Absent on a host that has never run the `aws` profile — that is not a
# failure, and an empty file would be a worse answer than no file.
if docker compose exec -T postgres psql -U agent_studio -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = 'mcp_memory'" | grep -q 1; then
  echo "== database (mcp-memory)"
  docker compose exec -T postgres pg_dump -U agent_studio --clean --if-exists mcp_memory |
    gzip -9 > "$out/mcp-memory.sql.gz"
fi

echo "== objects ($bucket)"
mkdir -p "$out/objects"
# `--entrypoint sh`: the service's own entrypoint is the bucket-creating
# script, and `run` would append the command to it rather than replace it.
# `--user`: the image runs as root, and a root-owned mirror is one this
# script's own prune cannot delete. `mc` needs a writable config dir then.
docker compose run --rm -T --entrypoint sh --user "$(id -u):$(id -g)" -e MC_CONFIG_DIR=/tmp/mc \
  -v "$(realpath "$out/objects"):/backup" minio-init \
  -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --quiet "local/$S3_BUCKET_NAME" /backup' \
  > /dev/null

cp .env.host "$out/env.host"

echo "== wrote $out"
du -sh "$out"

# Prune: newest first, keep $keep.
ls -1d "$dest"/*/ 2>/dev/null | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
  echo "== pruning $old"
  rm -rf "$old"
done
