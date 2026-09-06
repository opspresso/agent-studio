#!/usr/bin/env bash
#
# Bring the local MCP servers up:
#
#   deploy/local/scripts/deploy.sh
#
# There is no app service here: the app is `pnpm dev` on the host. This script
# creates `.env` from the example on first run, logs Docker in to ECR with the
# shell's AWS credentials, and starts the image tags explicitly pinned in
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

# --- ECR ------------------------------------------------------------------
# The token lasts 12h, so log in on every run. Uses the shell's own AWS
# credentials (AWS_PROFILE or a default chain) — nothing is stored here.

ECR_REGISTRY=$(value_in .env ECR_REGISTRY)
[[ -n "$ECR_REGISTRY" ]] || { echo "ECR_REGISTRY missing in .env — restore it from .env.example" >&2; exit 1; }
echo "== ecr login ($ECR_REGISTRY)"
aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$ECR_REGISTRY" > /dev/null

# --- PostgreSQL -----------------------------------------------------------

# mcp-memory v0.9 stores everything in PostgreSQL. The root compose project
# owns that server and network; ensure the separate database on every deploy
# because initdb hooks do not run again for an existing volume.
if docker compose config --services | grep -qx mcp-memory; then
  studio=(docker compose -f ../../compose.yaml)
  echo "== mcp-memory database"
  COMPOSE_IGNORE_ORPHANS=true "${studio[@]}" up -d --no-deps postgres > /dev/null
  ready=false
  for _ in {1..60}; do
    if "${studio[@]}" exec -T postgres pg_isready -U agent_studio -d agent_studio > /dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    echo "postgres did not become ready — run docker compose logs postgres from the repository root" >&2
    exit 1
  fi
  if "${studio[@]}" exec -T postgres psql -U agent_studio -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = 'mcp_memory'" | grep -q 1; then
    echo "   mcp_memory: present"
  else
    "${studio[@]}" exec -T postgres createdb -U agent_studio -O agent_studio mcp_memory
    echo "   mcp_memory: created"
  fi
fi

# --- Up -------------------------------------------------------------------

echo "== compose up"
docker compose pull --quiet
docker compose up -d
echo
docker compose ps
echo
echo "MCP servers are up. Run the app on the host: pnpm dev  (http://localhost:3000)"
