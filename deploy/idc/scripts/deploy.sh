#!/usr/bin/env bash
#
# Bring this host up to date: fresh secrets from SSM, the newest image tags from
# ECR, and a compose up that recreates only what changed.
#
# This host is outside the release automation — a version tag push moves the
# cluster, not this. That is what this script stands in for, and running it is
# the whole update procedure:
#
#   /opt/agentdure/scripts/deploy.sh
#
# Every step is safe to repeat. Nothing here is destructive: a tag that cannot be
# resolved leaves the current one alone, and `.env` is only rewritten when a tag
# actually changed (the previous file is kept as `.env.bak`).
#
#   -n    say what would change and stop
#   -s    skip the secret refresh (SSM is the slow part)

set -euo pipefail

cd "$(dirname "$0")/.."

dry_run=false
skip_secrets=false
while getopts "ns" opt; do
  case "$opt" in
    n) dry_run=true ;;
    s) skip_secrets=true ;;
    *) echo "usage: $0 [-n] [-s]" >&2; exit 2 ;;
  esac
done

if [[ ! -f .env ]]; then
  echo "no .env here — copy .env.example first (see README.md)" >&2
  exit 1
fi

: "${AWS_REGION:=ap-northeast-2}"
export AWS_REGION

# The AWS credentials live in .env.aws and nowhere else on this host, so every
# aws call below needs them sourced first — the CLI would otherwise look for a
# profile that does not exist here.
if [[ -f .env.aws ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.aws
  set +a
fi

# Only the images we build. The rest — brave, cloudwatch, argocd, grafana,
# kubernetes — come from other people's registries and stay pinned by hand:
# their releases are not ours to follow blindly.
declare -A repo_of=(
  [AGENTDURE_TAG]=agentdure
  [MCP_MEMORY_TAG]=mcp-memory
  [MCP_DOCUMENT_TAG]=mcp-document
  [MCP_YOUTUBE_TAG]=mcp-youtube
)

# The `v*` tag on the most recently pushed image. Ordering by push time rather
# than by version because that is what "latest" means for a registry — and it
# needs no opinion about how the version is spelled.
latest_tag() {
  local repo="$1" tags tag
  tags=$(aws ecr describe-images --repository-name "$repo" \
    --query 'sort_by(imageDetails,&imagePushedAt)[-1].imageTags' \
    --output text 2>/dev/null) || return 1
  for tag in $tags; do
    case "$tag" in
      v*) echo "$tag"; return 0 ;;
    esac
  done
  return 1
}

current_tag() {
  grep -E "^$1=" .env | head -1 | cut -d= -f2-
}

echo "== resolving image tags"
changes=()
for var in "${!repo_of[@]}"; do
  repo="${repo_of[$var]}"
  now=$(current_tag "$var")
  if ! new=$(latest_tag "$repo"); then
    echo "   $repo: could not read ECR, keeping $now"
    continue
  fi
  if [[ "$new" == "$now" ]]; then
    echo "   $repo: $now"
  else
    echo "   $repo: $now -> $new"
    changes+=("$var=$new")
  fi
done

if [[ "$dry_run" == true ]]; then
  echo "== dry run, stopping here"
  exit 0
fi

if [[ ${#changes[@]} -gt 0 ]]; then
  cp .env .env.bak
  for change in "${changes[@]}"; do
    var="${change%%=*}"
    value="${change#*=}"
    # The value is a tag, so no escaping games are needed — but anchor the match
    # so a variable whose name is a suffix of another is not caught.
    sed -i.tmp -E "s|^${var}=.*|${var}=${value}|" .env
    rm -f .env.tmp
  done
  echo "== .env updated (previous kept as .env.bak)"
fi

if [[ "$skip_secrets" == false ]]; then
  echo "== refreshing secrets from SSM"
  scripts/fetch-env.sh
fi

echo "== logging in to ECR"
scripts/ecr-login.sh > /dev/null

echo "== pulling"
docker compose pull --quiet

# Recreates only the services whose image or config actually changed. A run that
# resolved no new tag and no new secret is a no-op here, which is why this is
# safe to put on a timer.
echo "== up"
docker compose up -d

echo
docker compose ps
