#!/usr/bin/env python3
"""
HIVV.org Local AI IP Updater
Run this script on your local machine to keep your home IP updated.

Usage:
    python update-ip.py <your-api-key>

Requirements:
    pip install requests

Cron setup (run every 5 minutes):
    */5 * * * * /path/to/update-ip.py YOUR_API_KEY >> /var/log/hivv-ip-updater.log 2>&1
"""

import sys
import json
import time
import requests

HIVV_API_URL = "https://hivv.org/api/local-ip"

def get_public_ip():
    """Get the public IP address using multiple services."""
    services = [
        "https://api.ipify.org",
        "https://icanhazip.com",
        "https://ifconfig.me/ip",
        "https://checkip.amazonaws.com",
    ]

    for service in services:
        try:
            response = requests.get(service, timeout=5)
            if response.status_code == 200:
                ip = response.text.strip()
                if ip and ip.count('.') == 3:  # Basic IPv4 validation
                    return ip
        except Exception:
            continue
    return None

def main():
    if len(sys.argv) < 2:
        print("Usage: python update-ip.py <your-api-key>")
        print("\nGet your API key from https://hivv.org/account.html")
        print("This script should run on your LOCAL machine (not the server)")
        sys.exit(1)

    api_key = sys.argv[1]

    print("🔍 Getting public IP address...")
    public_ip = get_public_ip()

    if not public_ip:
        print("❌ Could not determine public IP address")
        sys.exit(1)

    print(f"📡 Public IP: {public_ip}")
    print("📤 Updating HIVV gateway...")

    try:
        response = requests.post(
            HIVV_API_URL,
            headers={
                "Content-Type": "application/json",
                "X-API-Key": api_key
            },
            json={
                "ip": public_ip,
                "timestamp": int(time.time()),
                "hostname": get_hostname()
            },
            timeout=10
        )

        if response.status_code == 200:
            data = response.json()
            if data.get("success"):
                print("✅ IP updated successfully!")
                return

        print(f"❌ Update failed: {response.text}")

    except requests.exceptions.RequestException as e:
        print(f"❌ Network error: {e}")

def get_hostname():
    """Get a friendly hostname for this machine."""
    import socket
    try:
        return socket.gethostname()
    except Exception:
        return "unknown"

if __name__ == "__main__":
    main()
