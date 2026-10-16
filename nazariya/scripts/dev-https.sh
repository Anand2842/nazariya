#!/usr/bin/env bash
# HTTPS dev server on your Wi-Fi IP so a phone on the same network can use the camera and motion sensors
# (browsers only allow them on secure origins). Uses a self-signed certificate: accept the warning once.
set -euo pipefail
cd "$(dirname "$0")/.."
IP="${LAN_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')}"
if [ -z "$IP" ]; then echo "Could not detect a LAN IP. Set LAN_IP=192.168.x.x and retry."; exit 1; fi
PORT="${HTTPS_PORT:-3443}"
mkdir -p .certs
if [ ! -f .certs/dev.pem ] || ! openssl x509 -in .certs/dev.pem -noout -text 2>/dev/null | grep -q "IP Address:$IP"; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout .certs/dev-key.pem -out .certs/dev.pem \
    -subj "/CN=nazariya-dev" -addext "subjectAltName=IP:$IP,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
fi
echo ""
echo "  Nazariya (HTTPS):  https://$IP:$PORT"
echo "  Open it on this computer AND on your phone (same Wi-Fi). Accept the certificate warning once on each."
echo ""
APP_URL="https://$IP:$PORT" DEV_ORIGINS="$IP" exec npx next dev -H 0.0.0.0 -p "$PORT" \
  --experimental-https --experimental-https-key .certs/dev-key.pem --experimental-https-cert .certs/dev.pem
