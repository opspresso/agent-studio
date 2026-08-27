#!/bin/sh
#
# The three CronJobs as one loop, for the `ticker` profile.
#
# What each tick has to satisfy is in docs/OPERATIONS.md: at most a minute
# between schedule scans (the scan looks back over a fixed 10-minute make-up
# window, so a missed tick loses nothing), duplicates are safe everywhere
# (each firing is claimed by a conditional write, and a plugins sync that loses
# the race is refused rather than doubled), and the catalog reindex has no
# window to miss — hourly is ample, and a minute-by-minute reindex would probe
# every MCP server that often for nothing.
#
# Never exits on a failed request. A ticker that dies on one 500 stops firing
# schedules, and the next tick is the recovery for almost everything here.

set -u

APP="${TICK_TARGET:-http://agent-studio:3000}"

if [ -z "${SCHEDULE_SCAN_TOKEN:-}" ]; then
  echo "SCHEDULE_SCAN_TOKEN is unset — the scan endpoints answer 503; not ticking"
  # Sleep rather than exit: `restart: unless-stopped` would otherwise spin.
  while true; do sleep 3600; done
fi

post() {
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 60 -X POST \
    -H "X-Scan-Token: $SCHEDULE_SCAN_TOKEN" "$APP$1" || echo 000)
  # 401 means the token this container holds is not the one the app holds; the
  # app logs its own warning, and it will not fix itself.
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
