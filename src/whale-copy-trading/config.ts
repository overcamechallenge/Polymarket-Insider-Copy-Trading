import { ENV } from '../config/env';
import { CopyStrategyConfig } from '../config/copyStrategy';

const num = (key: string, def: number, min = 0): number => {
    const v = process.env[key] ? Number(process.env[key]) : def;
    if (!Number.isFinite(v) || v < min) return def;
    return v;
};

export const WHALE_POSITION_CHECK_INTERVAL_HOURS = num('WHALE_POSITION_CHECK_INTERVAL_HOURS', 4, 1);

export const WHALE_POSITION_DRY_RUN =
    (process.env.WHALE_POSITION_DRY_RUN || 'true').toLowerCase() === 'true';

export const WHALE_POSITION_PAPER_TRADING =
    (process.env.WHALE_POSITION_PAPER_TRADING || 'false').toLowerCase() === 'true';

export const WHALE_POSITION_PAPER_START_USD = (() => {
    const v = parseFloat(process.env.WHALE_POSITION_PAPER_START_USD || '500');
    if (isNaN(v) || v <= 0) {
        throw new Error(
            `Invalid WHALE_POSITION_PAPER_START_USD: "${process.env.WHALE_POSITION_PAPER_START_USD}". Must be a positive number.`
        );
    }
    return v;
})();

export const WHALE_POSITION_MIN_DELTA_USD = num('WHALE_POSITION_MIN_DELTA_USD', 25);

export const WHALE_POSITION_MIN_DELTA_PCT = (() => {
    const v = parseFloat(process.env.WHALE_POSITION_MIN_DELTA_PCT || '0.02');
    return Number.isFinite(v) && v >= 0 ? v : 0.02;
})();

export const WHALE_POSITION_MIN_VALUE_USD = num('WHALE_POSITION_MIN_VALUE_USD', 10);

const parsePriceBand = (key: string, def: number): number => {
    const v = parseFloat(process.env[key] || String(def));
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
        return def;
    }
    return v;
};

export const WHALE_POSITION_MIN_BUY_PRICE = parsePriceBand('WHALE_POSITION_MIN_BUY_PRICE', 0.2);
export const WHALE_POSITION_MAX_BUY_PRICE = parsePriceBand('WHALE_POSITION_MAX_BUY_PRICE', 0.9);

export const WHALE_WATCH_LIST = process.env.WHALE_WATCH_LIST?.trim() || '';

export const WHALE_COPY_CONFIG: CopyStrategyConfig = ENV.COPY_STRATEGY_CONFIG;

export const WHALE_RUNTIME = {
    socksProxyUrl: ENV.SOCKS_PROXY_URL,
    proxyWallet: ENV.PROXY_WALLET,
    requestTimeoutMs: ENV.REQUEST_TIMEOUT_MS,
};
