#!/usr/bin/env bash
#
# One-time, repeatable preparation for the Agent Studio IDC host. It installs
# the host tools used by deploy.sh, enables Docker, provisions swap, and creates
# the deployment directory. It does not copy application files or credentials.

set -euo pipefail

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot identify this operating system." >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
  echo "This script supports Ubuntu 24.04; found ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi

if ((EUID == 0)); then
  SUDO=()
  target_user="${SUDO_USER:-root}"
else
  command -v sudo >/dev/null || { echo "sudo is required." >&2; exit 1; }
  sudo -v
  SUDO=(sudo)
  target_user="${SUDO_USER:-$USER}"
fi

case "$(dpkg --print-architecture)" in
  amd64) aws_arch="x86_64" ;;
  arm64) aws_arch="aarch64" ;;
  *)
    echo "AWS CLI is not supported on architecture $(dpkg --print-architecture)." >&2
    exit 1
    ;;
esac

temp_dir=$(mktemp -d)
cleanup() {
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

echo "== base packages"
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y ca-certificates curl gnupg jq python3 unzip

echo "== Docker Engine"
"${SUDO[@]}" install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$temp_dir/docker.asc"
"${SUDO[@]}" install -m 0644 "$temp_dir/docker.asc" /etc/apt/keyrings/docker.asc
docker_arch=$(dpkg --print-architecture)
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
  "$docker_arch" "$VERSION_CODENAME" |
  "${SUDO[@]}" tee /etc/apt/sources.list.d/docker.list >/dev/null
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
"${SUDO[@]}" systemctl enable --now docker

if [[ "$target_user" != "root" ]] && ! id -nG "$target_user" | tr ' ' '\n' | grep -qx docker; then
  "${SUDO[@]}" usermod -aG docker "$target_user"
  docker_group_changed=true
else
  docker_group_changed=false
fi

echo "== AWS CLI"
if command -v aws >/dev/null && aws --version 2>&1 | grep -q '^aws-cli/2\.'; then
  echo "   $(aws --version 2>&1) is already installed"
else
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o "$temp_dir/awscliv2.zip"
  unzip -q "$temp_dir/awscliv2.zip" -d "$temp_dir"
  if [[ -d /usr/local/aws-cli ]]; then
    "${SUDO[@]}" "$temp_dir/aws/install" --update
  else
    "${SUDO[@]}" "$temp_dir/aws/install"
  fi
fi

echo "== swap"
if [[ ! -e /swapfile ]]; then
  "${SUDO[@]}" fallocate -l 4G /swapfile
  "${SUDO[@]}" chmod 600 /swapfile
  "${SUDO[@]}" mkswap /swapfile >/dev/null
fi
if ! swapon --show=NAME --noheadings | awk '{$1=$1};1' | grep -qx /swapfile; then
  "${SUDO[@]}" swapon /swapfile
fi
if ! grep -Eq '^/swapfile[[:space:]]+none[[:space:]]+swap[[:space:]]' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' | "${SUDO[@]}" tee -a /etc/fstab >/dev/null
fi

echo "== deployment directory"
"${SUDO[@]}" install -d -m 0755 -o "$target_user" -g "$target_user" /opt/agent-studio

echo
docker --version
docker compose version
aws --version
swapon --show
echo "Host preparation is complete."
if [[ "$docker_group_changed" == true ]]; then
  echo "Log out and back in before running Docker without sudo."
fi
