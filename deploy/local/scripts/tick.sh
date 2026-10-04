#!/bin/sh

set -u

APP="${TICK_TARGET:-http://host.docker.internal:3000}"

if [ -z "${SCHEDULE_SCAN_TOKEN:-}" ]; then
  echo "SCHEDULE_SCAN_TOKEN is unset — the scan endpoints answer 503; not ticking"
  while true; do sleep 3600; done
fi

post() {
  code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 -m 15 -X POST \
    -H "X-Scan-Token: $SCHEDULE_SCAN_TOKEN" "$APP$1")
  status=$?
  case "$code" in
    2*) [ "$status" -eq 0 ] && return 0 ;;
  esac
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1 -> HTTP $code (curl exit $status)" >&2
  return 1
}

trap 'exit 0' INT TERM
next_reindex=0
while true; do
  started=$(date +%s)
  # Each endpoint has its own result; a failed scan must not suppress plugin sync.
  failures=0
  post /api/triggers/scan || failures=$((failures + 1))
  post /api/plugins/sync/scan || failures=$((failures + 1))
  if [ "$started" -ge "$next_reindex" ]; then
    post /api/catalog/reindex || failures=$((failures + 1))
    next_reindex=$((started + 3600))
  fi
  [ "$failures" -eq 0 ] || echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ticker failed endpoints: $failures" >&2
  # Include request time in the minute. Do not replay ticks missed while stopped.
  delay=$((60 - ($(date +%s) - started)))
  [ "$delay" -gt 0 ] || delay=1
  sleep "$delay" &
  wait "$!"
done
