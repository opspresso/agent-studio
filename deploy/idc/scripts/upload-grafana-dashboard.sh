#!/usr/bin/env bash
#
# Create or update the source-controlled IDC dashboard through Grafana's
# dashboard API. This token is intentionally separate from the metrics writer
# token used by Alloy.

set -euo pipefail

cd "$(dirname "$0")/.."
dashboard_file="$PWD/grafana/dashboards/agent-studio-idc.json"
: "${GRAFANA_URL:=https://nalbam.grafana.net}"
GRAFANA_URL=${GRAFANA_URL%/}

command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required." >&2; exit 1; }
jq -e 'type == "object" and (.uid | type == "string" and length > 0)' "$dashboard_file" >/dev/null

dashboard_uid=$(jq -r .uid "$dashboard_file")
lookup_url="$GRAFANA_URL/api/dashboards/uid/$dashboard_uid"
write_url="$GRAFANA_URL/api/dashboards/db"
temp_dir=$(mktemp -d)
cleanup() {
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

create_payload() {
  jq -n --slurpfile dashboard "$dashboard_file" \
    '{dashboard: $dashboard[0], folderUid: "", overwrite: true, message: "Update from agent-studio IDC deployment"}'
}

if [[ "${1:-}" == "--dry-run" ]]; then
  create_payload
  exit 0
fi
if (($# > 0)); then
  echo "Usage: $0 [--dry-run]" >&2
  exit 1
fi

: "${GRAFANA_SERVICE_ACCOUNT_TOKEN:?Set a Grafana service account token with dashboard write permission}"
auth_header="Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN"

status=$(curl -sS -o "$temp_dir/current.json" -w '%{http_code}' \
  -H "$auth_header" -H 'Accept: application/json' "$lookup_url")

case "$status" in
  200)
    action=updated
    ;;
  404)
    action=created
    ;;
  *)
    echo "Grafana dashboard lookup failed with HTTP $status:" >&2
    jq . "$temp_dir/current.json" >&2 2>/dev/null || sed -n '1,40p' "$temp_dir/current.json" >&2
    exit 1
    ;;
esac

create_payload > "$temp_dir/payload.json"
status=$(curl -sS -o "$temp_dir/response.json" -w '%{http_code}' \
  -X POST -H "$auth_header" -H 'Content-Type: application/json' \
  --data-binary "@$temp_dir/payload.json" "$write_url")

if [[ "$status" != 2* ]]; then
  echo "Grafana dashboard write failed with HTTP $status:" >&2
  jq . "$temp_dir/response.json" >&2 2>/dev/null || sed -n '1,40p' "$temp_dir/response.json" >&2
  exit 1
fi

dashboard_path=$(jq -r '.url // empty' "$temp_dir/response.json")
if [[ -n "$dashboard_path" ]]; then
  echo "Dashboard $action: $GRAFANA_URL$dashboard_path"
else
  echo "Dashboard $action: $GRAFANA_URL/d/$dashboard_uid"
fi
