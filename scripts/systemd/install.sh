#!/usr/bin/env bash
# Install both bots as systemd services that start on boot and restart on crash.
#   cd ~/polymarket-bot && sudo bash scripts/systemd/install.sh
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_DIR="$(dirname "$(command -v node)")"
[ -x "$NODE_DIR/npx" ] || { echo "npx not found next to node ($NODE_DIR)"; exit 1; }
mkdir -p "$PROJECT/logs"
sed -e "s#__PROJECT__#$PROJECT#g" -e "s#__NODE_DIR__#$NODE_DIR#g" \
  "$PROJECT/scripts/systemd/polymarket-bot@.service" > /etc/systemd/system/polymarket-bot@.service
# stop any nohup-started bots so they are not duplicated
pkill -f "strike-copy/bot.ts" 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now polymarket-bot@coinman2 polymarket-bot@c03b
sleep 5
systemctl --no-pager --lines=0 status polymarket-bot@coinman2 polymarket-bot@c03b | grep -E "polymarket-bot@|Active:"
cat <<MSG

Installed. Useful commands:
  systemctl status polymarket-bot@coinman2 polymarket-bot@c03b
  systemctl restart polymarket-bot@coinman2          # after editing .env
  systemctl stop polymarket-bot@coinman2 polymarket-bot@c03b
  tail -f $PROJECT/logs/strike-copy-coinman2.log
  tail -f $PROJECT/logs/strike-copy-c03b.log
MSG
