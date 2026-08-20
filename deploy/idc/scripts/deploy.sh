#!/usr/bin/env bash
#
# The whole update procedure for this host, in one script:
#
#   /opt/agent-studio/scripts/deploy.sh
#
# It rewrites `.env` and `.env.mcp` from three sources — the checked-in
# examples for configuration, argocd-env-demo for image versions, SSM for
# secrets — then logs Docker in to ECR, pulls and brings compose up. Neither
# generated file is edited by hand: change a setting in the example, a version
# in argocd-env-demo, a secret in SSM, and run this again. Every step is
# idempotent and a run that resolved nothing new recreates nothing, so it is
# safe on a timer.
#
# The one input a person supplies is `.env.aws`, the access key the containers
# use for AWS; this script uses the same key for SSM and ECR.
#
# Versions follow the cluster: each chart's `versions-alpha.json` in
# argocd-env-demo names what alpha runs, and this host runs the same. A chart
# whose file cannot be read keeps the version `.env` already has, so a GitHub
# outage never moves this host backwards.

set -euo pipefail

cd "$(dirname "$0")/.."

: "${AWS_REGION:=ap-northeast-2}"
: "${ECR_REGISTRY:=396608815058.dkr.ecr.ap-northeast-2.amazonaws.com}"
: "${VERSIONS_BASE:=https://raw.githubusercontent.com/opspresso/argocd-env-demo/refs/heads/main/charts}"
export AWS_REGION

# The AWS credentials live in .env.aws and nowhere else on this host, so the
# aws calls below need them sourced first — the CLI would otherwise look for a
# profile that does not exist here.
if [[ -f .env.aws ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.aws
  set +a
fi

for f in .env.example .env.mcp.example; do
  [[ -f "$f" ]] || { echo "$f is missing — this script generates .env from it" >&2; exit 1; }
done

# --- Versions -------------------------------------------------------------

# Every image compose names, and the argocd-env-demo chart that pins it. Ours
# and other people's alike: the cluster is the one place a version is chosen.
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

value_in() {  # value_in FILE VAR — the value a KEY=VALUE file holds, or nothing
  [[ -f "$1" ]] && grep -E "^$2=" "$1" | head -1 | cut -d= -f2- || true
}

echo "== versions (argocd-env-demo, alpha)"
declare -A tag_of=()
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

# --- Secrets --------------------------------------------------------------

# The same parameters External Secrets pulls into the cluster, so the two
# instances hold the same values — which for AES_ENCRYPTION_KEY is not a
# convenience but the requirement: it decrypts the stored credentials in the
# table both read.
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

# secret_lines VAR=PATH... — one `VAR='value'` line per argument, in order.
# Fetched ten at a time (get-parameters' limit) and quoted so a value carrying
# `$`, `#` or a space survives compose's env-file parser unchanged. A parameter
# SSM does not have is an error, not a blank: the app reports such a value as
# unset rather than wrong, and that is harder to see than a failed deploy.
secret_lines() {
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

echo "== secrets (SSM)"
app_secrets=$(secret_lines "${APP_SECRETS[@]}")
mcp_secrets=$(secret_lines "${MCP_SECRETS[@]}")
echo "   $(printf '%s\n' "$app_secrets" | grep -c '=') for the app, $(printf '%s\n' "$mcp_secrets" | grep -c '=') for MCP servers"

# --- Files ----------------------------------------------------------------

# Written whole, from the example: a setting is changed there and never here.
# Secrets go last so a name the example also carries resolves to SSM's value.
umask 077

{
  echo "# Generated by scripts/deploy.sh from .env.example — do not edit; edit the example and rerun."
  sed_script=""
  for var in "${IMAGE_VARS[@]}"; do
    sed_script+="s|^${var}=.*|${var}=${tag_of[$var]}|;"
  done
  sed -E "$sed_script" .env.example
  echo
  echo "# --- Secrets (SSM) --------------------------------------------------------"
  printf '%s\n' "$app_secrets"
} > .env.tmp
mv .env.tmp .env

{
  echo "# Generated by scripts/deploy.sh from .env.mcp.example — do not edit; edit the example and rerun."
  cat .env.mcp.example
  echo
  echo "# --- Secrets (SSM) --------------------------------------------------------"
  printf '%s\n' "$mcp_secrets"
} > .env.mcp.tmp
mv .env.mcp.tmp .env.mcp

echo "== wrote .env and .env.mcp"

# --- Containers -----------------------------------------------------------

# The ECR token lasts 12 hours, so this is part of every pull rather than a
# one-time setup step.
echo "== logging in to ECR"
aws ecr get-login-password |
  docker login --username AWS --password-stdin "$ECR_REGISTRY" > /dev/null

echo "== pulling"
docker compose pull --quiet

# Recreates only the services whose image or environment actually changed.
echo "== up"
docker compose up -d

echo
docker compose ps
