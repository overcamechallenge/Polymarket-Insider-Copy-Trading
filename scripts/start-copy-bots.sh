#!/usr/bin/env bash
# Start (or restart) both paper-copy bots in the background.
#   ./scripts/start-copy-bots.sh          # start both
#   ./scripts/start-copy-bots.sh stop     # stop both
#   ./scripts/start-copy-bots.sh status   # last stats line of each
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs strike-copy-data
# .env is the source of truth for the proxy; it overrides any stale shell export (e.g. ~/.zprofile).
if [ -f .env ]; then
  ENV_PROXY=$(grep -E '^SOCKS_PROXY_URL=' .env | tail -1 | cut -d= -f2- | tr -d "'\"" | tr -d '[:space:]')
  [ -n "$ENV_PROXY" ] && export SOCKS_PROXY_URL="$ENV_PROXY"
fi
# SOCKS proxy: the exchange geo-blocks order placement from many regions, so live
# trading normally needs it. Taken from .env or the shell environment as-is.
# To force direct access for a read-only/paper session:  SOCKS_PROXY_URL= ./scripts/start-copy-bots.sh
if [ -n "${SOCKS_PROXY_URL:-}" ]; then
  if curl -s -m 15 --proxy "$SOCKS_PROXY_URL" https://api.ipify.org >/dev/null 2>&1; then
    echo "proxy OK: $(echo "$SOCKS_PROXY_URL" | sed -E 's#//[^@]*@#//***@#') → exit IP $(curl -s -m 15 --proxy "$SOCKS_PROXY_URL" https://api.ipify.org)"
  else
    echo "WARNING: SOCKS_PROXY_URL is set but the proxy rejected the connection (bad credentials or IP not whitelisted)."
    echo "         Live orders will go through it and fail. Fix the proxy or unset it before starting."
  fi
else
  echo "NOTE: no SOCKS_PROXY_URL — connecting directly. Live orders will be geo-blocked unless this host is in an allowed region."
fi

stop() { pkill -f "strike-copy/bot.ts" 2>/dev/null || true; sleep 1; }

status() {
  for f in logs/strike-copy-paper.log logs/strike-copy-coinman2.log logs/strike-copy-c03b.log; do
    [ -f "$f" ] || continue
    echo "== $f"
    sed 's/\x1b\[[0-9;]*m//g' "$f" | grep -aE "stats —|PAPER BUY|PAPER SETTLE|BUY \$|buy failed|exception" | tail -4 || true
  done
  echo "running processes: $(pgrep -f 'node.*strike-copy/bot.ts' | wc -l | tr -d ' ')"
  if command -v systemctl >/dev/null 2>&1; then
    for u in polymarket-bot@coinman2 polymarket-bot@c03b; do
      st=$(systemctl is-active "$u" 2>/dev/null || true); [ -n "$st" ] && echo "systemd $u: $st"
    done
  fi
}

case "${1:-start}" in
  stop)   stop; echo "stopped" ;;
  status) status ;;
  start)
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet polymarket-bot@coinman2 2>/dev/null; then
      echo "Bots are managed by systemd. Use:  systemctl restart polymarket-bot@coinman2 polymarket-bot@c03b"
      echo "(starting them here as well would run two copies against the same wallet)"
      exit 1
    fi
    stop
    # 1) coinman2 — crypto strikes, settings from .env (2%, 2–40¢, ≥6h)
    nohup npx ts-node src/strike-copy/bot.ts >> logs/strike-copy-paper.log 2>&1 &
    # 2) C03B — WTI crude oil; settings in .env.c03b (override .env's STRIKE_COPY_* values)
    ( set -a; . ./.env.c03b; set +a
      nohup npx ts-node src/strike-copy/bot.ts >> logs/strike-copy-c03b.log 2>&1 & )
    sleep 20; status ;;
  *) echo "usage: $0 [start|stop|status]"; exit 1 ;;
esac
