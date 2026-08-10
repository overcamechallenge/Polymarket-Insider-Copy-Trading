import type { ClobClient } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import createClobClient from '../utils/createClobClient';
import Logger from '../utils/logger';
import { configureSocksProxyFromEnv } from '../utils/proxy';
import {
    formatResolvedWatchlist,
    resolvePolymarketWatchlist,
    type ResolvedWatchTarget,
} from '../utils/resolvePolymarketWatchlist';
import { parseSlackMention, sendSlackTradeAlert } from '../utils/slackNotify';
import {
    FIFTEEN_MIN_COPY_CONFIG,
    FIFTEEN_MIN_DRY_RUN,
    FIFTEEN_MIN_MIN_TRADE_USD,
    FIFTEEN_MIN_PAPER_TRADING,
    FIFTEEN_MIN_RUNTIME,
    FIFTEEN_MIN_WATCH_LIST,
} from './config';
import { executeLiveOrDryTrade, executePaperTrade } from './execute/copyTrade';
import { loadPaperPortfolio, savePaperPortfolio } from './execute/paperStore';
import { isFifteenMinUpDownMarket } from './isFifteenMinMarket';
import type { RtdsActivityTrade } from './types';
import { tradeDedupKey } from './ws/parseTrade';
import { RtdsActivityClient } from './ws/rtdsClient';

configureSocksProxyFromEnv(ENV.SOCKS_PROXY_URL);

const DEDUP_MAX = 2_000;

type RuntimeState = {
    watchAddresses: Set<string>;
    targets: ResolvedWatchTarget[];
    clobClient: ClobClient | null;
    paper: ReturnType<typeof loadPaperPortfolio> | null;
    seen: Set<string>;
    seenOrder: string[];
    queue: Promise<void>;
    stats: {
        seen: number;
        walletHits: number;
        filteredOut: number;
        matched: number;
        copied: number;
        skipped: number;
        failed: number;
        reconnects: number;
    };
    /** ms from exchange trade timestamp to our order being placed. */
    lagSamples: number[];
    /** ms spent inside our own pipeline (frame received → order placed). */
    localSamples: number[];
};

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const LAG_SAMPLE_MAX = 500;

const pushSample = (samples: number[], value: number): void => {
    if (!Number.isFinite(value) || value < 0) return;
    samples.push(value);
    if (samples.length > LAG_SAMPLE_MAX) samples.shift();
};

const percentile = (samples: number[], p: number): number => {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
};

/** RTDS activity timestamps are epoch seconds. */
const tradeTimestampMs = (trade: RtdsActivityTrade): number =>
    trade.timestamp >= 1e12 ? trade.timestamp : trade.timestamp * 1000;

const enqueue = (state: RuntimeState, task: () => Promise<void>): void => {
    state.queue = state.queue.then(task).catch((err) => {
        Logger.error(
            `[15m Copy] Queue error: ${err instanceof Error ? err.message : String(err)}`
        );
    });
};

const remember = (state: RuntimeState, key: string): boolean => {
    if (state.seen.has(key)) return false;
    state.seen.add(key);
    state.seenOrder.push(key);
    if (state.seenOrder.length > DEDUP_MAX) {
        const old = state.seenOrder.shift();
        if (old) state.seen.delete(old);
    }
    return true;
};

const handleTrade = async (state: RuntimeState, trade: RtdsActivityTrade): Promise<void> => {
    if (!state.watchAddresses.has(trade.proxyWallet)) return;
    state.stats.walletHits += 1;

    if (
        !isFifteenMinUpDownMarket({
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            title: trade.title,
        })
    ) {
        state.stats.filteredOut += 1;
        Logger.info(
            `[15m Copy] Wallet trade skipped (not 5m/15m updown): ${trade.side} ${trade.slug || trade.title}`
        );
        return;
    }

    if (trade.usd < FIFTEEN_MIN_MIN_TRADE_USD) {
        Logger.info(
            `[15m Copy] Skip tiny $${trade.usd.toFixed(2)} ${trade.side} from ${shortAddr(trade.proxyWallet)}`
        );
        state.stats.skipped += 1;
        return;
    }

    const key = tradeDedupKey(trade);
    if (!remember(state, key)) return;

    state.stats.matched += 1;

    const label = trade.slug || trade.title || trade.asset;
    Logger.trade(trade.proxyWallet, trade.side, {
        asset: trade.asset,
        side: trade.side,
        amount: trade.usd,
        price: trade.price,
        eventSlug: trade.eventSlug || trade.slug,
        outcome: trade.outcome,
        title: label,
    });

    let result;
    if (state.paper) {
        result = executePaperTrade(state.paper, trade, FIFTEEN_MIN_COPY_CONFIG);
        savePaperPortfolio(state.paper);
    } else {
        result = await executeLiveOrDryTrade(
            state.clobClient,
            trade,
            FIFTEEN_MIN_RUNTIME.proxyWallet,
            FIFTEEN_MIN_COPY_CONFIG,
            FIFTEEN_MIN_DRY_RUN
        );
    }

    const doneAt = Date.now();
    const localMs = doneAt - trade.receivedAt;
    const totalMs = doneAt - tradeTimestampMs(trade);
    pushSample(state.localSamples, localMs);
    pushSample(state.lagSamples, totalMs);

    if (result.ok && !result.skipped) {
        state.stats.copied += 1;
        Logger.success(
            `[15m Copy] ${result.message} — ${label} (lag ${(totalMs / 1000).toFixed(1)}s, local ${localMs}ms)`
        );
        const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
        if (webhook) {
            const mode = state.paper ? 'PAPER' : FIFTEEN_MIN_DRY_RUN ? 'DRY' : 'LIVE';
            void sendSlackTradeAlert(
                webhook,
                {
                    wallet: trade.proxyWallet,
                    name: trade.name || trade.pseudonym,
                    side: trade.side,
                    title: label,
                    outcome: trade.outcome,
                    price: trade.price,
                    size: trade.size,
                    usdSize: trade.usd,
                    slug: trade.slug,
                    eventSlug: trade.eventSlug,
                    txHash: trade.transactionHash || undefined,
                    timestamp: trade.timestamp,
                    label: `15m Copy (${mode})`,
                },
                { mention: parseSlackMention(process.env.SLACK_MENTION) }
            ).catch(() => undefined);
        }
    } else if (result.skipped) {
        state.stats.skipped += 1;
        Logger.warning(`[15m Copy] ${result.message} — ${label}`);
    } else {
        state.stats.failed += 1;
        Logger.warning(`[15m Copy] ${result.message} — ${label}`);
    }
};

export const main = async (): Promise<void> => {
    if (!FIFTEEN_MIN_WATCH_LIST) {
        throw new Error(
            'FIFTEEN_MIN_WATCH_LIST (or WHALE_WATCH_LIST) is empty. Add wallets or @usernames to .env'
        );
    }

    Logger.header('15-Minute Up/Down Copy Trading (WebSocket)');
    Logger.info('[15m Copy] Resolving watchlist…');

    const targets = await resolvePolymarketWatchlist({
        watchlist: FIFTEEN_MIN_WATCH_LIST,
        socksProxyUrl: FIFTEEN_MIN_RUNTIME.socksProxyUrl,
        requestTimeoutMs: FIFTEEN_MIN_RUNTIME.requestTimeoutMs,
    });

    if (targets.length === 0) {
        throw new Error('No valid wallets resolved from FIFTEEN_MIN_WATCH_LIST');
    }

    Logger.success(`[15m Copy] Watching: ${formatResolvedWatchlist(targets)}`);

    const state: RuntimeState = {
        watchAddresses: new Set(targets.map((t) => t.address.toLowerCase())),
        targets,
        clobClient: null,
        paper: null,
        seen: new Set(),
        seenOrder: [],
        queue: Promise.resolve(),
        stats: {
            seen: 0,
            walletHits: 0,
            filteredOut: 0,
            matched: 0,
            copied: 0,
            skipped: 0,
            failed: 0,
            reconnects: 0,
        },
        lagSamples: [],
        localSamples: [],
    };

    if (FIFTEEN_MIN_PAPER_TRADING) {
        state.paper = loadPaperPortfolio();
        Logger.info('[15m Copy] Mode: PAPER — virtual portfolio, simulated fills');
    } else if (FIFTEEN_MIN_DRY_RUN) {
        Logger.info('[15m Copy] Mode: DRY RUN — logs only, no orders');
    } else {
        Logger.info('[15m Copy] Mode: LIVE — real FAK orders');
        state.clobClient = await createClobClient();
        Logger.success('[15m Copy] CLOB client ready');
    }

    if (ENV.SOCKS_PROXY_URL) {
        Logger.info('[15m Copy] SOCKS proxy enabled for HTTP + WebSocket');
    }

    const cc = FIFTEEN_MIN_COPY_CONFIG;
    Logger.info(
        `[15m Copy] Filters: 5m/15m up/down · min trade $${FIFTEEN_MIN_MIN_TRADE_USD} · ${cc.strategy} copySize=${cc.copySize} · order $${cc.minOrderSizeUSD}–$${cc.maxOrderSizeUSD}` +
            (cc.maxPositionSizeUSD ? ` · max pos $${cc.maxPositionSizeUSD}` : '')
    );
    Logger.info('[15m Copy] Streaming RTDS activity (no polling). Ctrl+C to stop.');
    Logger.separator();

    const client = new RtdsActivityClient({
        socksProxyUrl: ENV.SOCKS_PROXY_URL,
        walletFilter: state.watchAddresses,
        onActivity: () => {
            state.stats.seen += 1;
        },
        onTrade: (trade) => {
            enqueue(state, () => handleTrade(state, trade));
        },
        onClose: () => {
            state.stats.reconnects += 1;
        },
    });

    client.start();

    const statsTimer = setInterval(() => {
        const s = state.stats;
        const lag = state.lagSamples;
        const local = state.localSamples;
        const speed = lag.length
            ? ` | lag p50 ${(percentile(lag, 50) / 1000).toFixed(1)}s p95 ${(percentile(lag, 95) / 1000).toFixed(1)}s | local p50 ${percentile(local, 50)}ms p95 ${percentile(local, 95)}ms`
            : '';
        Logger.info(
            `[15m Copy] Stats — stream:${s.seen} wallet:${s.walletHits} filtered:${s.filteredOut} matched:${s.matched} copied:${s.copied} skipped:${s.skipped} failed:${s.failed} reconnects:${s.reconnects}${speed}`
        );
    }, 60_000);

    const shutdown = () => {
        Logger.info('[15m Copy] Shutting down…');
        clearInterval(statsTimer);
        client.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
};

if (require.main === module) {
    main().catch((error) => {
        Logger.error(`[15m Copy] Fatal: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
