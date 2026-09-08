#!/usr/bin/env bash
#
# Bring the local MCP servers up:
#
#   deploy/local/scripts/deploy.sh
#
# There is no app service here: the app is `pnpm dev` on the host. This script
# creates `.env` from the example on first run and starts the public image tags pinned in
# `.env`. Deployment repositories do not decide a developer's local versions.

set -euo pipefail

cd "$(dirname "$0")/.."

: "${AWS_REGION:=ap-northeast-2}"
export AWS_REGION

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example — review it (profiles, keys), then rerun."
  exit 0
fi

# The one declaration the host-side app needs, or the registry's MCP URLs are
# refused by the SSRF guard and every server syncs as an invalid-url skip. The
# value is checked, not just the key: a suffix list without this one fails the
# same way.
if ! grep -q "^MCP_INTERNAL_HOST_SUFFIXES=.*agent-mcps\.svc\.cluster\.local" ../../.env.local 2>/dev/null; then
  echo "WARNING: .env.local does not declare the MCP suffix — add:" >&2
  echo "  MCP_INTERNAL_HOST_SUFFIXES=agent-mcps.svc.cluster.local" >&2
fi

value_in() {  # value_in FILE VAR — the value a KEY=VALUE file holds, or nothing
  [[ -f "$1" ]] && grep -E "^$2=" "$1" | head -1 | cut -d= -f2- || true
}

# Refuse enabled services without their own credentials; never print values.
require_value() {
  [[ -n "$(value_in .env "$1")" ]] || { echo "$1 missing in deploy/local/.env" >&2; exit 1; }
}
services=$(docker compose config --services)
if grep -qx mcp-argocd <<< "$services"; then
  require_value ARGOCD_BASE_URL
  require_value ARGOCD_API_TOKEN
fi
if grep -qx mcp-grafana <<< "$services"; then
  require_value GRAFANA_URL
  require_value GRAFANA_SERVICE_ACCOUNT_TOKEN
fi
if grep -qx mcp-brave-search <<< "$services"; then
  require_value BRAVE_API_KEY
fi
if grep -qx mcp-kubernetes <<< "$services"; then
  require_value KUBECONFIG_PATH
  [[ -f "$(value_in .env KUBECONFIG_PATH)" ]] || { echo "KUBECONFIG_PATH must name an existing file" >&2; exit 1; }
fi
if [[ -z "$services" ]]; then
  echo "No profiles enabled. Configure COMPOSE_PROFILES in deploy/local/.env."
  exit 0
fi

# --- Up -------------------------------------------------------------------

echo "== compose up"
docker compose pull --quiet
docker compose up -d
echo
docker compose ps
echo
echo "MCP servers are up. Run the app on the host: pnpm dev  (http://localhost:3000)"
