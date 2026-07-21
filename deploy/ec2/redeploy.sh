#!/bin/bash
#
# Redeploy agent-studio on the instance (run directly or via SSM Run Command):
#   ./redeploy.sh ghcr.io/opspresso/agent-studio v0.2.0
#
# Refreshes env from SSM, pulls the tag, and swaps the container. The old
# container gets 120s to drain in-flight SSE streams.
#
set -euo pipefail

readonly APP="agent-studio"
readonly INSTALL_DIR="/home/ec2-user/agent-studio"
readonly SSM_PARAM_NAME="/env/prod/agent-studio"
IMAGE="${1:?usage: redeploy.sh <image> <tag>}"
TAG="${2:?usage: redeploy.sh <image> <tag>}"

echo "Refreshing env from SSM"
aws ssm get-parameter --name "$SSM_PARAM_NAME" --with-decryption \
  --output text --query Parameter.Value > "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

echo "Pulling ${IMAGE}:${TAG}"
docker pull "${IMAGE}:${TAG}"

echo "Swapping container (120s drain)"
docker stop --time 120 "$APP" || true
docker rm "$APP" || true
docker run -d \
  --name "$APP" \
  --restart unless-stopped \
  --stop-timeout 120 \
  -p 127.0.0.1:3000:3000 \
  --env-file "$INSTALL_DIR/.env" \
  "${IMAGE}:${TAG}"

echo "Waiting for health"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/api/health > /dev/null; then
    echo "Healthy. Deployed ${IMAGE}:${TAG}"
    docker image prune -f > /dev/null
    exit 0
  fi
  sleep 2
done
echo "Health check failed after redeploy" >&2
exit 1
