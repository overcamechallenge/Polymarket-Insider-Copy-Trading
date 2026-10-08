# Polymarket Whale Tools

Tools for Polymarket whale research and copy-trading:

1. **`find-follow-wallets`** — Scan for new accounts making large cheap bets on short-dated event markets
2. **`whale-positions:watch`** — Watch whale wallets and copy position changes on a schedule
3. **`fifteen-min:copy`** — Real-time copy of 5m/15m crypto up/down trades
4. **`strike-copy`** — Real-time copy of cheap crypto price-strike legs (strategy derived from @coinman2)
5. **`trader:*`** — Download, analyze and backtest any trader's history

## Setup

```bash
cp .env.example .env
npm install
```

Edit `.env` and set `WHALE_WATCH_LIST` before running the position watcher.

## Commands

### Find follow wallets

Scans Polymarket for wallets worth following (new accounts, large cheap bets, non-politics/sports/geo markets). Results are saved to `insider_scan_results/`.

```bash
npm run find-follow-wallets
```

### Watch whale positions

Daemon that checks whale positions every N hours (default 4h). First check saves a baseline; later checks copy position changes.

```bash
npm run whale-positions:watch
```

**Modes** (set in `.env`):

| Mode | Env |
|------|-----|
| Dry run (default) | `WHALE_POSITION_DRY_RUN=true` — logs only |
| Paper | `WHALE_POSITION_PAPER_TRADING=true` — virtual portfolio |
| Live | `WHALE_POSITION_DRY_RUN=false` + wallet keys in `.env` |

## Data directories

- `insider_scan_results/` — follow-wallet scan JSON reports
- `whale-copy-trading-data/` — position snapshots and paper portfolio state
- `logs/` — runtime logs from the position watcher

## SOCKS proxy (live trading)

For live trading, set `SOCKS_PROXY_URL` in `.env` — same as the main copy-trading bot. All outbound traffic (CLOB orders, position fetches, watchlist resolution, follow-wallet scans) routes through the proxy.

```bash
SOCKS_PROXY_URL='socks5h://username:password@host:port'
```

Use `socks5h://` (not `socks5://`) so DNS lookups are proxied too.

## Requirements

- Node.js 20.10+
- No database required
- Live trading requires `PROXY_WALLET`, `PRIVATE_KEY`, Polygon RPC access, and usually `SOCKS_PROXY_URL`

## Strike copy (@coinman2 strategy)

Built from a 1-year analysis of @coinman2 (96k fills, $15.9M volume). Key facts: the trader never sells,
86% of volume is crypto price-strike ladders, and the edge sits in legs bought below ~40¢ at least 6h before
resolution. The 60–90¢ hedging legs lose money and daily Up/Down is break-even, so they are skipped.

```bash
# 1. Pull history and market metadata, write the analysis report
npm run trader:download -- @coinman2 --days 365
npm run trader:markets  -- coinman2 --days 45
npm run trader:analyze  -- coinman2            # → trader-analysis-data/coinman2/report.md

# 2. Backtest the copy strategy on the last 30 days
npm run trader:backtest -- coinman2 --days 30 --start-cash 1000 --slippage 0.01 --fee 0.05
#    → trader-analysis-data/coinman2/backtest-30d.md (+ equity CSV, positions JSON)

# 3. Run the bot (dry-run by default; paper / live via .env STRIKE_COPY_*)
npm run strike-copy
```

Strategy rules (all configurable through `STRIKE_COPY_*` in `.env`):

| Rule | Default | Why |
|---|---|---|
| Side | BUY, plus mirrored SELLs (`STRIKE_COPY_MIRROR_SELLS`) | sells copy the same % of shares the trader sold, capped at holdings; coinman2 never sells, but other wallets do |
| Markets | crypto strike (above/below/between/dip/reach) | daily Up/Down ≈ 0 EV, 5m/15m negative |
| Price band | 2–40¢ | <40¢ legs: +20–50% ROI; 60–90¢ legs: −10% |
| Time to resolution | ≥ 6h | last-hours scalps underperform |
| Sizing | 5% of trader notional, aggregated per token to $1 | hundreds of tiny fills/day; flooring each to $1 over-weights lottery tickets |
| Caps | order ≤ $25 / 1.5% equity, token ≤ $50 / 3% equity | ~25% win rate → cap variance |
| Live slippage | ≤ 2¢ over trader price | thin books on cheap tokens; skip instead of chase |

Winning tokens resolve to $1 but must be redeemed (Polymarket UI or a redeem transaction); the bot does not redeem.
The backtester models buy-and-hold only; mirrored sells are not simulated.

### Latency design (no polling in the copy path)

| Step | Source | Cost |
|---|---|---|
| Trader fill detected | RTDS `activity` websocket (`ws-live-data.polymarket.com`) | push |
| Market resolution time | parsed from slug instantly; gamma refines in background | 0 ms |
| Order book | CLOB market websocket (`ws-subscriptions-clob…/ws/market`), tokens subscribed as the trader touches them | push |
| Tick size / neg-risk / fees | SDK cache warmed on first sight of a token | 0 ms at order time |
| Order | one signed FAK BUY at the price cap; filled size read from the response | 1 HTTP POST |
| Balance / positions | updated locally from the fill; reconciled on a 60 s timer | off hot path |

Paper mode prices fills by walking the streamed book at or below the cap, so the paper PnL includes real slippage.
The bot logs `lag` (trader fill → our order) and `local` (frame received → order) percentiles every minute.
