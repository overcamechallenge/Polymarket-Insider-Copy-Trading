import { ENV } from '../config/env';
import {
    CopyStrategy,
    CopyStrategyConfig,
    parseTieredMultipliers,
} from '../config/copyStrategy';

const num = (key: string, def: number, min = 0): number => {
    const v = process.env[key] ? Number(process.env[key]) : def;
    if (!Number.isFinite(v) || v < min) return def;
    return v;
};

/** Prefer dedicated FIFTEEN_MIN_* key; fall back to shared COPY_* / legacy key. */
const envStr = (primary: string, fallback?: string): string | undefined => {
    const a = process.env[primary]?.trim();
    if (a) return a;
    if (fallback) {
        const b = process.env[fallback]?.trim();
        if (b) return b;
    }
    return undefined;
};

const envFloat = (primary: string, fallback: string | undefined, def: number): number => {
    const raw = envStr(primary, fallback);
    if (raw === undefined) return def;
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : def;
};

const parsePriceBand = (key: string, def: number): number => {
    const v = parseFloat(process.env[key] || String(def));
    if (!Number.isFinite(v) || v <= 0 || v > 1) return def;
    return v;
};

/** Comma-separated wallets / @usernames / polymarket profile URLs to copy. */
export const FIFTEEN_MIN_WATCH_LIST =
    process.env.FIFTEEN_MIN_WATCH_LIST?.trim() ||
    process.env.WHALE_WATCH_LIST?.trim() ||
    '';

export const FIFTEEN_MIN_DRY_RUN =
    (process.env.FIFTEEN_MIN_DRY_RUN || 'true').toLowerCase() === 'true';

export const FIFTEEN_MIN_PAPER_TRADING =
    (process.env.FIFTEEN_MIN_PAPER_TRADING || 'false').toLowerCase() === 'true';

export const FIFTEEN_MIN_PAPER_START_USD = (() => {
    const v = parseFloat(process.env.FIFTEEN_MIN_PAPER_START_USD || '500');
    if (isNaN(v) || v <= 0) {
        throw new Error(
            `Invalid FIFTEEN_MIN_PAPER_START_USD: "${process.env.FIFTEEN_MIN_PAPER_START_USD}". Must be a positive number.`
        );
    }
    return v;
})();

export const FIFTEEN_MIN_MIN_TRADE_USD = num('FIFTEEN_MIN_MIN_TRADE_USD', 5);
export const FIFTEEN_MIN_MIN_BUY_PRICE = parsePriceBand('FIFTEEN_MIN_MIN_BUY_PRICE', 0.15);
export const FIFTEEN_MIN_MAX_BUY_PRICE = parsePriceBand('FIFTEEN_MIN_MAX_BUY_PRICE', 0.95);

/** RTDS endpoint for public activity (includes other users' trades). */
export const FIFTEEN_MIN_WS_URL =
    process.env.FIFTEEN_MIN_WS_URL?.trim() || 'wss://ws-live-data.polymarket.com';

export const FIFTEEN_MIN_WS_PING_MS = num('FIFTEEN_MIN_WS_PING_MS', 5_000, 1_000);
export const FIFTEEN_MIN_WS_RECONNECT_MS = num('FIFTEEN_MIN_WS_RECONNECT_MS', 300, 100);

/**
 * Optional slug/title filter (JS regex source). Default matches crypto 5m + 15m
 * up/down markets like `btc-updown-5m-…`, `eth-updown-15m-…`.
 */
export const FIFTEEN_MIN_SLUG_REGEX = (() => {
    const raw = process.env.FIFTEEN_MIN_SLUG_REGEX?.trim();
    if (!raw) {
        return /(updown-(?:5|15)m|up-or-down-(?:5|15)m|(?:5|15)m-up|up-down-(?:5|15))/i;
    }
    try {
        return new RegExp(raw, 'i');
    } catch {
        throw new Error(`Invalid FIFTEEN_MIN_SLUG_REGEX: ${raw}`);
    }
})();

/**
 * Reconnect if no RTDS activity messages arrive for this long (zombie socket).
 * The global activity feed normally delivers thousands of events per minute, so
 * even a few seconds of silence means the connection is dead.
 */
export const FIFTEEN_MIN_WS_STALE_MS = num('FIFTEEN_MIN_WS_STALE_MS', 8_000, 2_000);

/** How often the stale watchdog checks; keep well under the stale window. */
export const FIFTEEN_MIN_WS_STALE_CHECK_MS = num('FIFTEEN_MIN_WS_STALE_CHECK_MS', 1_000, 250);

/**
 * Dedicated copy-sizing for the 15m bot.
 * Uses FIFTEEN_MIN_* keys; falls back to shared COPY_* / MAX_* only if unset.
 */
const parseFifteenMinCopyConfig = (): CopyStrategyConfig => {
    const strategyStr = (
        envStr('FIFTEEN_MIN_COPY_STRATEGY', 'COPY_STRATEGY') || 'PERCENTAGE'
    ).toUpperCase();
    const strategy =
        CopyStrategy[strategyStr as keyof typeof CopyStrategy] || CopyStrategy.PERCENTAGE;

    const config: CopyStrategyConfig = {
        strategy,
        copySize: envFloat('FIFTEEN_MIN_COPY_SIZE', 'COPY_SIZE', 5.0),
        maxOrderSizeUSD: envFloat('FIFTEEN_MIN_MAX_ORDER_SIZE_USD', 'MAX_ORDER_SIZE_USD', 25.0),
        minOrderSizeUSD: envFloat('FIFTEEN_MIN_MIN_ORDER_SIZE_USD', 'MIN_ORDER_SIZE_USD', 1.0),
        maxPositionSizeUSD: (() => {
            const raw = envStr('FIFTEEN_MIN_MAX_POSITION_SIZE_USD', 'MAX_POSITION_SIZE_USD');
            if (raw === undefined || raw === '') return undefined;
            const v = parseFloat(raw);
            if (!Number.isFinite(v) || v <= 0) return undefined;
            return v;
        })(),
        maxDailyVolumeUSD: (() => {
            const raw = envStr('FIFTEEN_MIN_MAX_DAILY_VOLUME_USD', 'MAX_DAILY_VOLUME_USD');
            if (raw === undefined || raw === '') return undefined;
            const v = parseFloat(raw);
            if (!Number.isFinite(v) || v <= 0) return undefined;
            return v;
        })(),
    };

    if (strategy === CopyStrategy.ADAPTIVE) {
        config.adaptiveMinPercent = envFloat(
            'FIFTEEN_MIN_ADAPTIVE_MIN_PERCENT',
            'ADAPTIVE_MIN_PERCENT',
            config.copySize
        );
        config.adaptiveMaxPercent = envFloat(
            'FIFTEEN_MIN_ADAPTIVE_MAX_PERCENT',
            'ADAPTIVE_MAX_PERCENT',
            config.copySize
        );
        config.adaptiveThreshold = envFloat(
            'FIFTEEN_MIN_ADAPTIVE_THRESHOLD_USD',
            'ADAPTIVE_THRESHOLD_USD',
            500.0
        );
    }

    const tiers = envStr('FIFTEEN_MIN_TIERED_MULTIPLIERS', 'TIERED_MULTIPLIERS');
    if (tiers) {
        config.tieredMultipliers = parseTieredMultipliers(tiers);
    } else {
        const multRaw = envStr('FIFTEEN_MIN_TRADE_MULTIPLIER', 'TRADE_MULTIPLIER');
        if (multRaw) {
            const singleMultiplier = parseFloat(multRaw);
            if (Number.isFinite(singleMultiplier) && singleMultiplier !== 1.0) {
                config.tradeMultiplier = singleMultiplier;
            }
        }
    }

    return config;
};

export const FIFTEEN_MIN_COPY_CONFIG: CopyStrategyConfig = parseFifteenMinCopyConfig();

export const FIFTEEN_MIN_RUNTIME = {
    socksProxyUrl: ENV.SOCKS_PROXY_URL,
    proxyWallet: ENV.PROXY_WALLET,
    requestTimeoutMs: ENV.REQUEST_TIMEOUT_MS,
};
