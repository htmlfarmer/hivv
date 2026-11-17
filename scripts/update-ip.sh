#!/bin/bash
# HIVV.org Local AI IP Updater
# Run this script on your local machine to keep your home IP updated
# Usage: ./update-ip.sh <your-api-key>

HIVV_API_KEY="${1:-}"
HIVV_API_URL="https://hivv.org/api/local-ip"

if [ -z "$HIVV_API_KEY" ]; then
    echo "Usage: $0 <your-api-key>"
    echo ""
    echo "Get your API key from https://hivv.org/account.html"
    echo "This script should run on your LOCAL machine (not the server)"
    exit 1
fi

get_public_ip() {
    local ip=""
    # Try multiple services to get public IP
    for service in \
        "https://api.ipify.org" \
        "https://icanhazip.com" \
        "https://ifconfig.me/ip" \
        "https://checkip.amazonaws.com"; do
        ip=$(curl -s --max-time 5 "$service" 2>/dev/null | tr -d '[:space:]')
        if [[ -n "$ip" && "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "$ip"
            return 0
        fi
    done
    return 1
}

echo "🔍 Getting public IP address..."
PUBLIC_IP=$(get_public_ip)

if [ -z "$PUBLIC_IP" ]; then
    echo "❌ Could not determine public IP address"
    exit 1
fi

echo "📡 Public IP: $PUBLIC_IP"

# Send IP to HIVV gateway
echo "📤 Updating HIVV gateway..."
RESPONSE=$(curl -s -X POST "$HIVV_API_URL" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $HIVV_API_KEY" \
    -d "{\"ip\": \"$PUBLIC_IP\", \"timestamp\": $(date +%s)}")

if echo "$RESPONSE" | grep -q '"success"'; then
    echo "✅ IP updated successfully!"
else
    echo "❌ Update failed: $RESPONSE"
fi
