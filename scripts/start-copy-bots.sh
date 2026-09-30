#!/usr/bin/env bash
# Start (or restart) both paper-copy bots in the background.
#   ./scripts/start-copy-bots.sh          # start both
#   ./scripts/start-copy-bots.sh stop     # stop both
#   ./scripts/start-copy-bots.sh status   # last stats line of each
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs strike-copy-data
export SOCKS_PROXY_URL=   # shell proxy in ~/.zprofile has bad credentials; direct works

stop() { pkill -f "strike-copy/bot.ts" 2>/dev/null || true; sleep 1; }

status() {
  for f in logs/strike-copy-paper.log logs/strike-copy-c03b.log; do
    [ -f "$f" ] || continue
    echo "== $f"
    sed 's/\x1b\[[0-9;]*m//g' "$f" | grep -E "stats —|PAPER BUY|PAPER SETTLE" | tail -3
  done
  echo "running processes: $(pgrep -f 'node.*strike-copy/bot.ts' | wc -l | tr -d ' ')"
}

case "${1:-start}" in
  stop)   stop; echo "stopped" ;;
  status) status ;;
  start)
    stop
    # 1) coinman2 — crypto strikes, settings from .env (2%, 2–40¢, ≥6h)
    nohup npx ts-node src/strike-copy/bot.ts >> logs/strike-copy-paper.log 2>&1 &
    # 2) C03B — WTI crude oil, buys <90¢, 10% copy, caps 5%/10% of equity
    STRIKE_COPY_WATCH_LIST='0x40604cb1f958c03bea0b18aa43e4cb0d62f33ec3' \
    STRIKE_COPY_INCLUDE_REGEX='wti|crude' \
    STRIKE_COPY_EXCLUDE_REGEX='^$' \
    STRIKE_COPY_MIN_BUY_PRICE=0.02 \
    STRIKE_COPY_MAX_BUY_PRICE=0.90 \
    STRIKE_COPY_MIN_HOURS_TO_END=0 \
    STRIKE_COPY_PERCENT=10 \
    STRIKE_COPY_MAX_ORDER_PCT_EQUITY=5 \
    STRIKE_COPY_MAX_POSITION_PCT_EQUITY=10 \
    STRIKE_COPY_PAPER_FILE=strike-copy-data/paper-c03b.json \
    nohup npx ts-node src/strike-copy/bot.ts >> logs/strike-copy-c03b.log 2>&1 &
    sleep 20; status ;;
  *) echo "usage: $0 [start|stop|status]"; exit 1 ;;
esac
