#!/bin/bash
# Pull latest and restart on server.
# Usage: ./deploy/deploy.sh <host>
# Example: ./deploy/deploy.sh ubuntu@stream-capture.updatenowapp.com
set -euo pipefail

HOST=${1:-ubuntu@stream-capture.updatenowapp.com}

echo "==> Deploying on server"
ssh -n "$HOST" '
    cd ~/screenshots
    git pull
    npm install
    sudo systemctl restart screenshots
'

echo ""
echo "==> Done."
ssh -n "$HOST" 'sudo systemctl status screenshots --no-pager | grep -E "Active|running|failed"'
