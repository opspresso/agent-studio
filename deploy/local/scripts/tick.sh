#!/bin/sh

set -u

APP="${TICK_TARGET:-http://host.docker.internal:3000}"

if [ -z "${SCHEDULE_SCAN_TOKEN:-}" ]; then
  echo "SCHEDULE_SCAN_TOKEN is unset — the scan endpoints answer 503; not ticking"
  while true; do sleep 3600; done
fi

post() {
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 60 -X POST \
    -H "X-Scan-Token: $SCHEDULE_SCAN_TOKEN" "$APP$1" || echo 000)
  case "$code" in
    2*) ;;
    *) echo "$(date -Is) $1 -> $code" ;;
  esac
}

minute=0
while true; do
  post /api/triggers/scan
  post /api/plugins/sync/scan
  if [ "$((minute % 60))" -eq 0 ]; then
    post /api/catalog/reindex
  fi
  minute=$((minute + 1))
  sleep 60
done
