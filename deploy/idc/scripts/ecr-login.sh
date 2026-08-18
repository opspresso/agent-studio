#!/usr/bin/env bash
#
# Log Docker in to ECR.
#
# The token ECR hands back is valid for 12 hours, so this is not a one-time
# setup step: without it on a schedule, a `docker compose pull` days later fails
# on the four private images with an authentication error that reads like the
# image is gone. Put it in cron ahead of any pull:
#
#   0 */6 * * * /opt/agentdure/scripts/ecr-login.sh >> /var/log/ecr-login.log 2>&1
#
# Needs iam/ecr-pull.json on the credentials this host holds.

set -euo pipefail

: "${AWS_REGION:=ap-northeast-2}"
: "${ECR_REGISTRY:=396608815058.dkr.ecr.ap-northeast-2.amazonaws.com}"

# The credentials come from .env.aws, which is the only place this host keeps
# them — the AWS CLI would otherwise look for a profile that does not exist here.
env_file="$(dirname "$0")/../.env.aws"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$ECR_REGISTRY"

echo "$(date -Is) logged in to $ECR_REGISTRY"
