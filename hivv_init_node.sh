#!/bin/bash
# hivv_init_node.sh — Bootstrap any HIVV distributed compute node
# Usage: sudo ./hivv_init_node.sh [gateway_ip] [node_name]
# This agent can handle ANY task type: streaming, inference, voice, transcription, etc.

set -e

GATEWAY_IP=${1:-192.168.1.1}
NODE_NAME=${2:-"node-$(hostname)"}
NODE_PORT=8899
HIVV_DIR="/opt/hivv"

echo "╔══════════════════════════════════════╗"
echo "║   HIVV Distributed Compute Node      ║"
echo "║   Any-capability agent v2.0          ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  Gateway : $GATEWAY_IP"
echo "  Name    : $NODE_NAME"
echo "  Port    : $NODE_PORT"
echo ""

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0 [gateway_ip] [node_name]"
  exit 1
fi

# Check/Install dependencies
for cmd in node pm2 curl; do
  if ! command -v $cmd &>/dev/null; then
    echo "Installing $cmd..."
    case $cmd in
      node)
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
        ;;
      pm2) npm install -g pm2 ;;
      *) apt-get install -y $cmd ;;
    esac
  fi
done

mkdir -p "$HIVV_DIR"
cp "$(dirname "$0")/hivv_node.js" "$HIVV_DIR/hivv_node.js" 2>/dev/null || {
  echo "ERROR: hivv_node.js not found. Run from hivv.org source directory."
  exit 1
}

TOKEN=$(node -e "console.log(require('crypto').randomUUID())")
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
IP=$(hostname -I | awk '{print $1}')

cat > "$HIVV_DIR/.env" <<EOF
HIVV_GATEWAY=http://${GATEWAY_IP}
NODE_IP=${IP}
NODE_TOKEN=${TOKEN}
NODE_SECRET=${SECRET}
NODE_NAME=${NODE_NAME}
NODE_PORT=${NODE_PORT}
NODE_ENV=production
EOF

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
