#!/usr/bin/env bash
#
# Install Grafana Alloy and apply this deployment's host/application metrics
# configuration. The Grafana Cloud token is kept outside the Alloy config in a
# root-only systemd environment file.

set -euo pipefail

cd "$(dirname "$0")/.."
config_source="$PWD/grafana/config.alloy"
config_target=/etc/alloy/config.alloy
environment_file=/etc/alloy/agent-studio.env
service_override=/etc/systemd/system/alloy.service.d/zz-agent-studio.conf

[[ -f "$config_source" ]] || { echo "$config_source is missing." >&2; exit 1; }

if ((EUID == 0)); then
  SUDO=()
else
  command -v sudo >/dev/null || { echo "sudo is required." >&2; exit 1; }
  sudo -v
  SUDO=(sudo)
fi

if [[ -z "${GCLOUD_RW_API_KEY:-}" ]]; then
  if [[ -t 0 ]]; then
    read -rsp "Grafana Cloud access policy token: " GCLOUD_RW_API_KEY
    echo
  else
    echo "GCLOUD_RW_API_KEY is required in non-interactive mode." >&2
    exit 1
  fi
fi
: "${GCLOUD_RW_API_KEY:?Grafana Cloud access policy token is empty}"
: "${GCLOUD_FM_COLLECTOR_ID:=byforce-318260}"

if [[ "$GCLOUD_RW_API_KEY" == *$'\n'* || "$GCLOUD_FM_COLLECTOR_ID" == *$'\n'* ]]; then
  echo "Grafana environment values must not contain newlines." >&2
  exit 1
fi

temp_dir=$(mktemp -d)
cleanup() {
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

echo "== Grafana Alloy package"
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y ca-certificates curl gnupg
"${SUDO[@]}" install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://apt.grafana.com/gpg.key -o "$temp_dir/grafana.asc"
gpg --dearmor --yes --output "$temp_dir/grafana.gpg" "$temp_dir/grafana.asc"
"${SUDO[@]}" install -m 0644 "$temp_dir/grafana.gpg" /etc/apt/keyrings/grafana.gpg
printf 'deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main\n' |
  "${SUDO[@]}" tee /etc/apt/sources.list.d/grafana.list >/dev/null
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y alloy

"${SUDO[@]}" env \
  GCLOUD_RW_API_KEY="$GCLOUD_RW_API_KEY" \
  GCLOUD_FM_COLLECTOR_ID="$GCLOUD_FM_COLLECTOR_ID" \
  alloy validate "$config_source"

escape_environment_value() {
  local value=${1//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

{
  printf 'GCLOUD_RW_API_KEY='
  escape_environment_value "$GCLOUD_RW_API_KEY"
  printf '\nGCLOUD_FM_COLLECTOR_ID='
  escape_environment_value "$GCLOUD_FM_COLLECTOR_ID"
  printf '\n'
} > "$temp_dir/agent-studio.env"

printf '%s\n' \
  '[Service]' \
  'EnvironmentFile=/etc/alloy/agent-studio.env' > "$temp_dir/agent-studio.conf"

echo "== Alloy configuration"
if [[ -f "$config_target" ]] && ! cmp -s "$config_source" "$config_target"; then
  backup="${config_target}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  "${SUDO[@]}" cp -a "$config_target" "$backup"
  echo "   backed up the previous config to $backup"
fi
"${SUDO[@]}" install -D -m 0644 "$config_source" "$config_target"
"${SUDO[@]}" install -D -m 0600 "$temp_dir/agent-studio.env" "$environment_file"
"${SUDO[@]}" install -D -m 0644 "$temp_dir/agent-studio.conf" "$service_override"

echo "== Alloy service"
"${SUDO[@]}" systemctl daemon-reload
"${SUDO[@]}" systemctl enable alloy >/dev/null
"${SUDO[@]}" systemctl restart alloy

for _ in {1..15}; do
  if curl -fsS http://127.0.0.1:12345/-/ready >/dev/null; then
    echo "Alloy is ready."
    break
  fi
  sleep 1
done

if ! curl -fsS http://127.0.0.1:12345/-/ready >/dev/null; then
  "${SUDO[@]}" systemctl status alloy --no-pager >&2 || true
  exit 1
fi

echo "Collector ID: $GCLOUD_FM_COLLECTOR_ID"
echo 'Verify in Grafana Explore with: up{job="integrations/node_exporter"}'
echo 'Verify application metrics with: up{job="agent-studio"}'
