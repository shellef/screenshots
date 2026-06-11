#!/bin/bash
# One-time server setup for the screenshots capture service.
# Run as root: sudo bash bootstrap.sh
set -euo pipefail

APP_DIR="/home/ubuntu/screenshots"
DOMAIN="screenshot.updatenowapp.com"
PORT=8002

echo "==> Installing system packages"
apt-get update -q
apt-get install -y -q git nodejs npm

echo "==> Cloning repo"
if [ ! -d "$APP_DIR/.git" ]; then
    git clone -b main https://github.com/shellef/screenshots.git "$APP_DIR"
    chown -R ubuntu:ubuntu "$APP_DIR"
fi

echo "==> Installing npm dependencies (also installs Chromium + Hebrew/Arabic/emoji fonts)"
su - ubuntu -c "cd $APP_DIR && npm install"

echo "==> Installing Chromium system dependencies"
cd "$APP_DIR" && npx playwright install-deps chromium

echo "==> Updating Caddyfile"
if ! grep -q "$DOMAIN" /etc/caddy/Caddyfile 2>/dev/null; then
    cat "$APP_DIR/deploy/Caddyfile" >> /etc/caddy/Caddyfile
fi
systemctl reload caddy

echo "==> Installing systemd service"
cat > /etc/systemd/system/screenshots.service << EOF
[Unit]
Description=Screenshot Capture Service
After=network.target

[Service]
User=ubuntu
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now screenshots

echo ""
echo "=== Setup complete ==="
echo "App will be live at https://$DOMAIN"
