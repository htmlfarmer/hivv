#!/usr/bin/env bash
# hivv_init_node.sh — Bootstrap any HIVV distributed compute node
# Usage: sudo ./hivv_init_node.sh [gateway_ip] [node_name]
# This agent can handle ANY task type: streaming, inference, voice, transcription, etc.
#
# Dependencies are installed automatically for your OS. When they can't be,
# the exact command to type is printed instead of a bare failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/lib/deps.sh
if [ -f "$SCRIPT_DIR/scripts/lib/deps.sh" ]; then
    . "$SCRIPT_DIR/scripts/lib/deps.sh"
else
    echo "ERROR: scripts/lib/deps.sh not found. Run from the hivv.org source directory."
    exit 1
fi

GATEWAY_IP=${1:-192.168.1.1}
NODE_NAME=${2:-"node-$(hostname)"}
NODE_PORT=8899
HIVV_DIR="/opt/hivv"

echo "╔══════════════════════════════════════╗"
echo "║   HIVV Distributed Compute Node      ║"
echo "║   Any-capability agent v2.0          ║"
echo "╚══════════════════════════════════════╝"
echo ""

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0 [gateway_ip] [node_name]"
  echo ""
  echo "  (No sudo? Install to \$HOME instead — see scripts/setup-local.sh)"
  exit 1
fi

detect_platform
printf '  Gateway : %s\n' "$GATEWAY_IP"
printf '  Name    : %s\n' "$NODE_NAME"
printf '  Port    : %s\n' "$NODE_PORT"
printf '  OS      : %s (%s) · pkg mgr: %s\n' "$D_OS" "$D_ARCH" "$D_PKG"
echo ""

# ── Check/Install dependencies ──────────────────────────────────────────
echo "==> Checking dependencies"
if ! d_install_node; then
  echo ""
  echo "Install Node.js 18+ with one of these, then re-run:"
  echo ""
  d_node_manual_hint
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "==> Installing curl"
  case "$D_PKG" in
    apt)    d_run_privileged apt-get update >/dev/null 2>&1 || true; d_run_privileged apt-get install -y curl >/dev/null 2>&1 ;;
    dnf)    d_run_privileged dnf install -y curl >/dev/null 2>&1 ;;
    yum)    d_run_privileged yum install -y curl >/dev/null 2>&1 ;;
    pacman) d_run_privileged pacman -S --noconfirm curl >/dev/null 2>&1 ;;
    apk)    d_run_privileged apk add --no-cache curl >/dev/null 2>&1 ;;
    zypper) d_run_privileged zypper --non-interactive install curl >/dev/null 2>&1 ;;
    brew)   brew install curl >/dev/null 2>&1 ;;
  esac
fi
if command -v curl >/dev/null 2>&1; then
  dok "curl ready"
else
  dwarn "curl not found — the node heartbeat needs it. Install with: sudo apt-get install -y curl"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Installing PM2"
  npm install -g pm2 --silent --no-audit --no-fund >/dev/null 2>&1
fi
if command -v pm2 >/dev/null 2>&1; then
  dok "pm2 ready"
else
  dwarn "pm2 install failed — the node can still run directly with node"
fi
echo ""

mkdir -p "$HIVV_DIR"
cp "$SCRIPT_DIR/hivv_node.js" "$HIVV_DIR/hivv_node.js" 2>/dev/null || {
  echo "ERROR: hivv_node.js not found. Run from hivv.org source directory."
  exit 1
}

TOKEN=$(node -e "console.log(require('crypto').randomUUID())")
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
IP=$(hostname -I 2>/dev/null | awk '{print $1}')

cat > "$HIVV_DIR/.env" <<EOF
HIVV_GATEWAY=http://${GATEWAY_IP}
NODE_IP=${IP}
NODE_TOKEN=${TOKEN}
NODE_SECRET=${SECRET}
NODE_NAME=${NODE_NAME}
NODE_PORT=${NODE_PORT}
NODE_ENV=production
EOF
chmod 600 "$HIVV_DIR/.env"

systemd_unit="hivv-node.service"
cat > "/etc/systemd/system/${systemd_unit}" <<UNIT
[Unit]
Description=HIVV Distributed Compute Node
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node ${HIVV_DIR}/hivv_node.js
WorkingDirectory=${HIVV_DIR}
EnvironmentFile=${HIVV_DIR}/.env
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hivv-node
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${systemd_unit}"
systemctl restart "${systemd_unit}"

echo "✅ Node registered!"
echo "   Status : $(systemctl is-active ${systemd_unit})"
echo "   Health : curl http://${IP}:${NODE_PORT}/health"
echo "   Logs   : journalctl -u ${systemd_unit} -f"
