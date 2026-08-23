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
# changed. The AWS key comes from `.env.aws`, as every other AWS call here —
# and it needs `s3:ListBucket` on the source, which the app's own role does
# not carry; with a key that lacks it, run the `aws s3 sync` half elsewhere,
# `scp` the directory here, and run this script with that directory as the
# second argument (the sync then finds nothing to do).

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
# `--entrypoint sh`: the service's own entrypoint is the bucket-creating
# script, and `run` would append the command to it rather than replace it.
docker compose run --rm -T --entrypoint sh -v "$(realpath "$staging"):/migrate:ro" minio-init \
  -c 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --quiet /migrate "local/$S3_BUCKET_NAME"'

echo "== done; $staging can be removed once the console shows the artifacts"
