#!/usr/bin/env bash
#
# Bring the local deployment up:
#
#   deploy/local/scripts/deploy.sh
#
# The IDC script's shape without its secret machinery — there is no SSM here,
# the app's configuration is the repo root's `.env.local` plus the overrides
# in `.env`. What this script does: create `.env` from the example on first
# run (and stop, so it can be reviewed), refresh the MCP image tags from what
# argocd-env-demo pins for alpha, log Docker in to ECR with whatever AWS
# credentials the shell already has, and bring compose up with the app built
# from the working tree. Idempotent — rerun after any change.

set -euo pipefail

cd "$(dirname "$0")/.."

: "${AWS_REGION:=ap-northeast-2}"
: "${VERSIONS_BASE:=https://raw.githubusercontent.com/opspresso/argocd-env-demo/refs/heads/main/charts}"
export AWS_REGION

if [[ ! -f ../../.env.local ]]; then
  echo "repo root .env.local is missing — it is the app's base configuration" >&2
  echo "(cp .env.example .env.local at the repo root and fill in the boot vars)" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example — review it (LLM endpoint, profiles), then rerun."
  exit 0
fi

# --- Versions -------------------------------------------------------------
# The same source of truth as IDC: each chart's versions-alpha.json names what
# alpha runs, and the laptop runs the same MCP images. A chart whose file
# cannot be read keeps the tag `.env` already has.

IMAGE_VARS=(MCP_DOCUMENT_TAG MCP_YOUTUBE_TAG MCP_MEMORY_TAG MCP_CLOUDWATCH_TAG MCP_BRAVE_TAG)
declare -A chart_of=(
  [MCP_DOCUMENT_TAG]=mcp-document
  [MCP_YOUTUBE_TAG]=mcp-youtube
  [MCP_MEMORY_TAG]=mcp-memory
  [MCP_CLOUDWATCH_TAG]=mcp-cloudwatch
  [MCP_BRAVE_TAG]=mcp-brave-search
)

alpha_version() {
  curl -fsS --max-time 20 "$VERSIONS_BASE/$1/versions-alpha.json" |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["items"][0]["version"])'
}

value_in() {  # value_in FILE VAR — the value a KEY=VALUE file holds, or nothing
  [[ -f "$1" ]] && grep -E "^$2=" "$1" | head -1 | cut -d= -f2- || true
}

# set_in FILE VAR VALUE — replace the VAR= line in place. `.env` carries the
# user's own edits, so unlike IDC it is patched, never regenerated.
set_in() {
  local tmp
  tmp=$(mktemp)
  if grep -qE "^$2=" "$1"; then
    sed "s|^$2=.*|$2=$3|" "$1" > "$tmp"
  else
    cat "$1" > "$tmp"
    echo "$2=$3" >> "$tmp"
  fi
  mv "$tmp" "$1"
}

echo "== versions (argocd-env-demo, alpha)"
for var in "${IMAGE_VARS[@]}"; do
  chart="${chart_of[$var]}"
  now=$(value_in .env "$var")
  if new=$(alpha_version "$chart" 2>/dev/null) && [[ -n "$new" ]]; then
    if [[ "$new" == "$now" ]]; then echo "   $chart: $now"
    else
      echo "   $chart: ${now:-"(unset)"} -> $new"
      set_in .env "$var" "$new"
    fi
  else
    echo "   $chart: could not read versions-alpha.json, keeping ${now:-"(unset)"}"
  fi
done

# --- ECR ------------------------------------------------------------------
# The token lasts 12h, so log in on every run. Uses the shell's own AWS
# credentials (AWS_PROFILE or a default chain) — nothing is stored here.

ECR_REGISTRY=$(value_in .env ECR_REGISTRY)
echo "== ecr login ($ECR_REGISTRY)"
aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$ECR_REGISTRY" > /dev/null

# --- Up -------------------------------------------------------------------

echo "== compose up (app built from the working tree)"
docker compose pull --quiet --ignore-buildable
docker compose up -d --build
echo
docker compose ps
