#!/usr/bin/env bash
#
# The whole update procedure for this host, in one script:
#
#   /opt/agent-studio/scripts/deploy.sh
#
# It rewrites `.env` and `.env.mcp` from three sources — the checked-in
# examples for configuration, argocd-env-demo for image versions (when GitHub
# is reachable), and secrets from `.env.secrets` on this host or from SSM —
# then pulls and brings compose up. Neither generated file is edited by hand:
# change a setting in the example, a version in argocd-env-demo, a secret in
# `.env.secrets` or SSM, and run this again. Every step is idempotent and a run
# that resolved nothing new recreates nothing, so it is safe on a timer.
#
# What a person supplies:
#   .env.secrets   the app's secrets (see .env.secrets.example); chmod 600
#   .env.aws       optional — an AWS access key, for ECR pulls, the `aws`
#                  profile's servers, Bedrock, and SSM as the secret source
#                  when .env.secrets is absent
#   .env.mcp       generated from .env.mcp.example; its own secrets come the
#                  same way as the app's
#
# What this script mints once and then keeps: `.env.host`, the credentials of
# the database and object store that live on this host. Never regenerated —
# losing it is losing access to the data.

set -euo pipefail

cd "$(dirname "$0")/.."

: "${AWS_REGION:=ap-northeast-2}"
: "${VERSIONS_BASE:=https://raw.githubusercontent.com/opspresso/argocd-env-demo/refs/heads/main/charts}"
export AWS_REGION

have_aws=false
if [[ -f .env.aws ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.aws
  set +a
  have_aws=true
fi

for f in .env.example .env.mcp.example; do
  [[ -f "$f" ]] || { echo "$f is missing — this script generates .env from it" >&2; exit 1; }
done

value_in() {  # value_in FILE VAR — the value a KEY=VALUE file holds, or nothing
  [[ -f "$1" ]] && grep -E "^$2=" "$1" | head -1 | cut -d= -f2- || true
}

# --- Host credentials -----------------------------------------------------

# Minted on the first run and never touched again. Compose reads these for the
# ${…} in compose.yaml, so they live in a file compose loads — `.env.host` is
# listed in the app's env_file and sourced here for the substitutions.
if [[ ! -f .env.host ]]; then
  umask 077
  {
    echo "# Minted by scripts/deploy.sh on $(date -u +%FT%TZ). Never regenerate: these open the data on this host."
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "MINIO_ROOT_USER=agent-studio"
    echo "MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)"
  } > .env.host
  echo "== minted .env.host (database and object store credentials)"
fi

# --- Versions -------------------------------------------------------------

# Every image compose names, and the argocd-env-demo chart that pins it. Ours
# and other people's alike: the cluster is the one place a version is chosen,
# and a host that can reach GitHub follows it.
IMAGE_VARS=(
  AGENT_STUDIO_TAG MCP_MEMORY_TAG MCP_DOCUMENT_TAG MCP_YOUTUBE_TAG
  MCP_BRAVE_TAG MCP_CLOUDWATCH_TAG MCP_ARGOCD_TAG MCP_GRAFANA_TAG MCP_KUBERNETES_TAG
)
declare -A chart_of=(
  [AGENT_STUDIO_TAG]=agent-studio
  [MCP_MEMORY_TAG]=mcp-memory
  [MCP_DOCUMENT_TAG]=mcp-document
  [MCP_YOUTUBE_TAG]=mcp-youtube
  [MCP_BRAVE_TAG]=mcp-brave-search
  [MCP_CLOUDWATCH_TAG]=mcp-cloudwatch
  [MCP_ARGOCD_TAG]=mcp-argocd
  [MCP_GRAFANA_TAG]=mcp-grafana
  [MCP_KUBERNETES_TAG]=mcp-kubernetes
)

# The newest entry of a chart's versions-alpha.json — the file the release
# automation appends to when it bumps alpha.
alpha_version() {
  curl -fsS --max-time 20 "$VERSIONS_BASE/$1/versions-alpha.json" |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["items"][0]["version"])'
}

echo "== versions"
declare -A tag_of=()
if [[ "${FOLLOW_VERSIONS:-true}" == "true" ]]; then
  for var in "${IMAGE_VARS[@]}"; do
    chart="${chart_of[$var]}"
    now=$(value_in .env "$var")
    if new=$(alpha_version "$chart" 2>/dev/null) && [[ -n "$new" ]]; then
      tag_of[$var]="$new"
      if [[ -z "$now" ]]; then echo "   $chart: $new"
      elif [[ "$new" == "$now" ]]; then echo "   $chart: $now"
      else echo "   $chart: $now -> $new"
      fi
    else
      # Fall back to what runs now, then to the example — never to nothing.
      tag_of[$var]="${now:-$(value_in .env.example "$var")}"
      echo "   $chart: could not read versions-alpha.json, keeping ${tag_of[$var]}"
    fi
  done
else
  # FOLLOW_VERSIONS=false: an air-gapped host, or one pinned on purpose. The
  # example is the pin.
  for var in "${IMAGE_VARS[@]}"; do
    tag_of[$var]="$(value_in .env.example "$var")"
    echo "   ${chart_of[$var]}: ${tag_of[$var]} (pinned)"
  done
fi

# --- Secrets --------------------------------------------------------------

# The app's secrets, by name, and where SSM keeps each for a host that reads
# them there. `.env.secrets` carries the same names as plain KEY=VALUE lines.
APP_SECRETS=(
  AES_ENCRYPTION_KEY=/k8s/common/agent-studio/aes-encryption-key
  BETTER_AUTH_SECRET=/k8s/common/agent-studio/better-auth-secret
  GOOGLE_CLIENT_ID=/k8s/common/agent-studio/google-client-id
  GOOGLE_CLIENT_SECRET=/k8s/common/agent-studio/google-client-secret
  LLM_API_KEY=/k8s/common/agent-studio/llm-api-key
  LLM_PROVIDER_OPENAI_API_KEY=/k8s/common/agent-studio/llm-provider-openai-api-key
  LLM_PROVIDER_ANTHROPIC_API_KEY=/k8s/common/agent-studio/llm-provider-anthropic-api-key
  LLM_PROVIDER_GOOGLE_API_KEY=/k8s/common/agent-studio/llm-provider-google-api-key
  LLM_PROVIDER_XAI_API_KEY=/k8s/common/agent-studio/llm-provider-xai-api-key
  LLM_PROVIDER_OPENROUTER_API_KEY=/k8s/common/agent-studio/llm-provider-openrouter-api-key
  A2A_API_KEY=/k8s/common/agent-studio/a2a-api-key
  GITHUB_TOKEN=/k8s/common/agent-studio/github-token
  # Read by the app and by the ticker: without it the three scan endpoints
  # answer 503 and nothing ticks this environment.
  SCHEDULE_SCAN_TOKEN=/k8s/common/agent-studio/schedule-scan-token
)
MCP_SECRETS=(
  BRAVE_API_KEY=/k8s/common/mcp-brave-search/brave-api-key
  ARGOCD_API_TOKEN=/k8s/common/mcp-argocd/argocd-api-token
)

# quote_line VAR VALUE — one `VAR='value'` line, quoted so a value carrying
# `$`, `#` or a space survives compose's env-file parser unchanged. The
# value travels through the environment, never the command line: an
# argument is visible to every local user in `ps` for as long as the
# interpreter runs.
quote_line() {
  QL_VAR="$1" QL_VALUE="$2" python3 -c '
import os
var, value = os.environ["QL_VAR"], os.environ["QL_VALUE"]
if "\x27" not in value:
    print(f"{var}=\x27{value}\x27")
else:
    escaped = value.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "$$")
    print(f"{var}=\"{escaped}\"")
'
}

# ssm_lines VAR=PATH... — one quoted line per argument, fetched ten at a time
# (get-parameters' limit). A parameter SSM does not have is an error, not a
# blank: the app reports such a value as unset rather than wrong, and that is
# harder to see than a failed deploy.
ssm_lines() {
  local paths=() batch json='[]'
  for pair in "$@"; do paths+=("${pair#*=}"); done
  local i
  for ((i = 0; i < ${#paths[@]}; i += 10)); do
    batch=$(aws ssm get-parameters --names "${paths[@]:i:10}" --with-decryption --output json)
    json=$(printf '%s\n%s' "$json" "$batch" | python3 -c '
import json, sys
acc, got = (json.loads(chunk) for chunk in sys.stdin.read().split("\n", 1))
missing = got.get("InvalidParameters") or []
if missing:
    sys.exit("SSM has no parameter named: " + ", ".join(missing))
print(json.dumps(acc + got["Parameters"]))
')
  done
  printf '%s\n' "$json" | python3 -c '
import json, sys
values = {p["Name"]: p["Value"].strip("\n") for p in json.load(sys.stdin)}
for pair in sys.argv[1:]:
    var, path = pair.split("=", 1)
    value = values[path]
    if "\x27" not in value:
        print(f"{var}=\x27{value}\x27")
    else:
        escaped = value.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "$$")
        print(f"{var}=\"{escaped}\"")
' "$@"
}

# file_lines FILE VAR=... — the named variables as quoted lines, from a
# KEY=VALUE file. A name the file lacks is left out: an optional provider key
# is simply not set, and the app says so for the ones it needs.
file_lines() {
  local file="$1"; shift
  local pair var value
  for pair in "$@"; do
    var="${pair%%=*}"
    value=$(value_in "$file" "$var")
    # Strip one layer of quotes a person may have written.
    value="${value#\'}"; value="${value%\'}"; value="${value#\"}"; value="${value%\"}"
    [[ -n "$value" ]] && quote_line "$var" "$value"
  done
  return 0
}

echo "== secrets"
if [[ -f .env.secrets ]]; then
  app_secrets=$(file_lines .env.secrets "${APP_SECRETS[@]}" BOOTSTRAP_ADMIN_PASSWORD=- OIDC_CLIENT_ID=- OIDC_CLIENT_SECRET=-)
  mcp_secrets=$(file_lines .env.secrets "${MCP_SECRETS[@]}")
  echo "   from .env.secrets"
elif [[ "$have_aws" == true ]]; then
  app_secrets=$(ssm_lines "${APP_SECRETS[@]}")
  mcp_secrets=$(ssm_lines "${MCP_SECRETS[@]}")
  echo "   from SSM"
else
  echo "neither .env.secrets nor .env.aws exists — nothing to read secrets from (see .env.secrets.example)" >&2
  exit 1
fi
echo "   $(printf '%s\n' "$app_secrets" | grep -c '=') for the app, $(printf '%s\n' "$mcp_secrets" | grep -c '=' || true) for MCP servers"

# --- Files ----------------------------------------------------------------

# Written whole, from the example: a setting is changed there and never here.
# Secrets go last so a name the example also carries resolves to the secret.
umask 077

{
  echo "# Generated by scripts/deploy.sh from .env.example — do not edit; edit the example and rerun."
  sed_script=""
  for var in "${IMAGE_VARS[@]}"; do
    sed_script+="s|^${var}=.*|${var}=${tag_of[$var]}|;"
  done
  sed -E "$sed_script" .env.example
  echo
  echo "# --- Host credentials (.env.host) ----------------------------------------"
  grep -E '^[A-Z_]+=' .env.host
  echo
  echo "# --- Secrets --------------------------------------------------------------"
  printf '%s\n' "$app_secrets"
} > .env.tmp
mv .env.tmp .env

{
  echo "# Generated by scripts/deploy.sh from .env.mcp.example — do not edit; edit the example and rerun."
  cat .env.mcp.example
  echo
  echo "# --- Secrets --------------------------------------------------------------"
  printf '%s\n' "$mcp_secrets"
} > .env.mcp.tmp
mv .env.mcp.tmp .env.mcp

echo "== wrote .env and .env.mcp"

# --- Containers -----------------------------------------------------------

# An ECR registry needs a login on every pull — the token lasts 12 hours.
# ghcr.io and a private mirror do not.
registry=$(value_in .env IMAGE_REGISTRY)
if [[ "$registry" == *.amazonaws.com ]]; then
  if [[ "$have_aws" != true ]]; then
    echo "IMAGE_REGISTRY is ECR but .env.aws is missing — cannot log in" >&2
    exit 1
  fi
  echo "== logging in to ECR"
  aws ecr get-login-password |
    docker login --username AWS --password-stdin "$registry" > /dev/null
fi

echo "== pulling"
docker compose pull --quiet --ignore-pull-failures

# ONLY=<services> brings up those services and nothing else — how a migration
# starts the new database and object store beside the running app, fills
# them, and only then switches the app over with a plain run.
if [[ -n "${ONLY:-}" ]]; then
  # shellcheck disable=SC2086
  echo "== up ($ONLY)"
  # shellcheck disable=SC2086
  docker compose up -d --no-deps $ONLY
else
  # Recreates only the services whose image or environment actually changed.
  echo "== up"
  docker compose up -d
fi

echo
docker compose ps
