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

# Compose owns dotenv quoting, interpolation and shell overrides.
services=$(docker compose config --services)
if [[ -z "$services" ]]; then
  echo "No profiles enabled. Configure COMPOSE_PROFILES in deploy/local/.env."
  exit 0
fi
docker compose config --format json | node scripts/check-config.mts

# --- Up -------------------------------------------------------------------

echo "== compose up"
docker compose pull --quiet
docker compose up -d
echo
docker compose ps
echo
echo "MCP servers are up. Run the app on the host: pnpm dev  (http://localhost:3000)"
