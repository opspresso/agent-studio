#!/bin/bash
#
# agent-studio EC2 bootstrap (Amazon Linux 2023).
# Substitute __IMAGE__ / __TAG__ before launch (or export and envsubst).
#
# Installs Docker, fetches runtime env from SSM SecureString
# /env/prod/agent-studio, and starts the container bound to 127.0.0.1:3000.
# nginx (setup-nginx.sh) terminates TLS in front of it.
#
set -euo pipefail

readonly LOG_FILE="/var/log/user-data.log"
readonly APP="agent-studio"
readonly INSTALL_DIR="/home/ec2-user/agent-studio"
readonly DOCKER_IMAGE="__IMAGE__"   # e.g. ghcr.io/opspresso/agent-studio
readonly DOCKER_TAG="__TAG__"       # e.g. latest or a version tag
readonly SSM_PARAM_NAME="/env/prod/agent-studio"

exec > >(tee -a "$LOG_FILE") 2>&1
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

log "=== agent-studio bootstrap ==="
dnf update -y
dnf install -y docker nginx
systemctl enable docker nginx
systemctl start docker
usermod -aG docker ec2-user

mkdir -p "$INSTALL_DIR"

log "Fetching env from SSM: $SSM_PARAM_NAME"
aws ssm get-parameter --name "$SSM_PARAM_NAME" --with-decryption \
  --output text --query Parameter.Value > "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"
chown -R ec2-user:ec2-user "$INSTALL_DIR"

log "Pulling ${DOCKER_IMAGE}:${DOCKER_TAG}"
docker pull "${DOCKER_IMAGE}:${DOCKER_TAG}"

log "Starting container"
docker run -d \
  --name "$APP" \
  --restart unless-stopped \
  --stop-timeout 120 \
  -p 127.0.0.1:3000:3000 \
  --env-file "$INSTALL_DIR/.env" \
  "${DOCKER_IMAGE}:${DOCKER_TAG}"

log "Bootstrap complete. Point nginx at 127.0.0.1:3000 (see setup-nginx.sh)."
