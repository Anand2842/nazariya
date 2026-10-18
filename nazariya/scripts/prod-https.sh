#!/usr/bin/env bash
# Production build on your Wi-Fi IP over HTTPS, for testing on a real phone without dev-server recompiles and
# page reloads (which look like a stuck capture). Run `npx next build` first; stop `npm run dev:https` (both use .next).
# Login codes are shown on screen (ALLOW_DEV_TOOLS_IN_PROD): local testing only, never on a real deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
IP="${LAN_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)}"
PORT="${HTTPS_PORT:-3443}"
mkdir -p .certs
if [ ! -f .certs/dev.pem ] || ! openssl x509 -in .certs/dev.pem -noout -text 2>/dev/null | grep -q "IP Address:$IP"; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout .certs/dev-key.pem -out .certs/dev.pem \
    -subj "/CN=nazariya-dev" -addext "subjectAltName=IP:$IP,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
fi
echo ""
echo "  Nazariya (production build, HTTPS):  https://$IP:$PORT"
echo ""
APP_URL="https://$IP:$PORT" INTERNAL_APP_URL="http://127.0.0.1:3100" CAPTURE_LIVE_LOG=1 DEV_TOOLS=1 ALLOW_DEV_TOOLS_IN_PROD=1 npx next start -H 127.0.0.1 -p 3100 &
APP=$!
trap 'kill $APP 2>/dev/null' EXIT
node scripts/https-proxy.mjs "$PORT" 3100
