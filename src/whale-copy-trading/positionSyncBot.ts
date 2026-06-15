import { ENV } from '../config/env';
import { configureSocksProxyFromEnv } from '../utils/proxy';
import Logger from '../utils/logger';
import {
    formatResolvedWatchlist,
    resolvePolymarketWatchlist,
} from '../utils/resolvePolymarketWatchlist';
import {
    WHALE_RUNTIME,
    WHALE_WATCH_LIST,
    WHALE_POSITION_PAPER_TRADING,
    WHALE_POSITION_DRY_RUN,
    getWhalePositionCheckIntervalMs,
    formatWhalePositionCheckInterval,
    formatWhaleChecksPerDay,
} from './config';
import { runPositionSyncCheck } from './positionSync/runCheck';

configureSocksProxyFromEnv(ENV.SOCKS_PROXY_URL);

export const main = async (): Promise<void> => {
    if (!WHALE_WATCH_LIST) {
        throw new Error('WHALE_WATCH_LIST is empty. Add whale addresses or @usernames to .env');
    }

    Logger.info('[Whale Positions] Resolving watchlist...');
    const targets = await resolvePolymarketWatchlist({
        watchlist: WHALE_WATCH_LIST,
        socksProxyUrl: WHALE_RUNTIME.socksProxyUrl,
        requestTimeoutMs: WHALE_RUNTIME.requestTimeoutMs,
    });

    if (targets.length === 0) {
        throw new Error('No valid whale wallets resolved from WHALE_WATCH_LIST');
    }

    Logger.success(`[Whale Positions] Watching: ${formatResolvedWatchlist(targets)}`);
    if (ENV.SOCKS_PROXY_URL) {
        Logger.info('[Whale Positions] SOCKS proxy enabled — CLOB, data-api, and watchlist traffic routed through proxy');
    }
    if (WHALE_POSITION_PAPER_TRADING) {
        Logger.info('[Whale Positions] Mode: PAPER — virtual portfolio, simulated fills');
    } else if (WHALE_POSITION_DRY_RUN) {
        Logger.info('[Whale Positions] Mode: DRY RUN — logs only, no orders');
    } else {
        Logger.info('[Whale Positions] Mode: LIVE — real orders');
    }
    Logger.info(
        `[Whale Positions] Scheduled checks every ${formatWhalePositionCheckInterval()} (${formatWhaleChecksPerDay()}x/day)`
    );
    Logger.info('[Whale Positions] First run per wallet saves baseline only. Copies start on the next check when positions differ.');
    Logger.separator();

    const intervalMs = getWhalePositionCheckIntervalMs();

    const logNextCheck = () => {
        const nextAt = new Date(Date.now() + intervalMs);
        Logger.info(
            `[Whale Positions] Next check in ${formatWhalePositionCheckInterval()} — ${nextAt.toLocaleString()}`
        );
    };

    const runOnce = async () => {
        Logger.header('[Whale Positions] Scheduled check');
        try {
            await runPositionSyncCheck(targets, { paperTrading: WHALE_POSITION_PAPER_TRADING });
        } catch (error) {
            Logger.error(
                `[Whale Positions] Check failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }
        Logger.separator();
        logNextCheck();
    };

    await runOnce();

    setInterval(() => {
        void runOnce();
    }, intervalMs);
};

if (require.main === module) {
    main().catch((error) => {
        Logger.error(`[Whale Positions] Fatal: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
