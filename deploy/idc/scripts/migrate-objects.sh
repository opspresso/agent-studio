#!/usr/bin/env bash
#
# One-time migration of what runs produced, from an S3 bucket into this host's
# MinIO:
#
#   /opt/agent-studio/scripts/migrate-objects.sh s3://agent-studio-static
#
# Two steps, so neither store needs to reach the other: `aws s3 sync` brings
# the bucket's `artifacts/` and `images/` prefixes (the only ones the app
# ever wrote) to a directory on this host, then `mc mirror` pushes them into
# the bucket `.env` names. Both are resumable — rerunning copies only what
# changed. The AWS key comes from `.env.aws`, as every other AWS call here.

set -euo pipefail

cd "$(dirname "$0")/.."

source_bucket="${1:?usage: migrate-objects.sh s3://<bucket>}"
staging="${2:-./objects-migration}"

if [[ -f .env.aws ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.aws
  set +a
fi

mkdir -p "$staging"
for prefix in artifacts images; do
  echo "== $source_bucket/$prefix/ -> $staging/$prefix/"
  aws s3 sync "$source_bucket/$prefix/" "$staging/$prefix/" --only-show-errors
done

echo "== $staging -> minio"
docker compose run --rm -T -v "$(realpath "$staging"):/migrate:ro" minio-init \
  sh -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --quiet /migrate "local/$S3_BUCKET_NAME"'

echo "== done; $staging can be removed once the console shows the artifacts"
