# Polymarket Whale Tools

Two focused tools for Polymarket whale research and copy-trading:

1. **`find-follow-wallets`** — Scan for new accounts making large cheap bets on short-dated event markets
2. **`whale-positions:watch`** — Watch whale wallets and copy position changes on a schedule

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

## Requirements

- Node.js 20.10+
- No database required
- Live trading requires `PROXY_WALLET`, `PRIVATE_KEY`, and Polygon RPC access
