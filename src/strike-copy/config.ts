import { ENV } from '../config/env';
import {
    DEFAULT_EXCLUDE_REGEX,
    DEFAULT_INCLUDE_REGEX,
    DEFAULT_STRIKE_COPY_STRATEGY,
    StrikeCopyStrategyConfig,
} from './strategy';

const str = (key: string): string | undefined => process.env[key]?.trim() || undefined;
const num = (key: string, def: number, min = 0): number => {
    const raw = str(key);
    if (raw === undefined) return def;
    const v = Number(raw);
    return Number.isFinite(v) && v >= min ? v : def;
};
const bool = (key: string, def: boolean): boolean => {
    const raw = str(key);
    if (raw === undefined) return def;
    return raw.toLowerCase() === 'true';
};
const regex = (key: string, def: RegExp): RegExp => {
    const raw = str(key);
    if (!raw) return def;
    try {
        return new RegExp(raw, 'i');
    } catch {
        throw new Error(`Invalid regex in ${key}: ${raw}`);
    }
};

export const STRIKE_COPY_WATCH_LIST = str('STRIKE_COPY_WATCH_LIST') || '@coinman2';
export const STRIKE_COPY_DRY_RUN = bool('STRIKE_COPY_DRY_RUN', true);
export const STRIKE_COPY_PAPER_TRADING = bool('STRIKE_COPY_PAPER_TRADING', false);
export const STRIKE_COPY_PAPER_START_USD = num('STRIKE_COPY_PAPER_START_USD', 1000, 1);
/** Max cents above the trader's price we are willing to lift asks at (live mode). */
export const STRIKE_COPY_MAX_SLIPPAGE = num('STRIKE_COPY_MAX_SLIPPAGE', 0.02, 0);
export const STRIKE_COPY_SETTLE_INTERVAL_MS = num('STRIKE_COPY_SETTLE_INTERVAL_MS', 10 * 60_000, 30_000);
export const STRIKE_COPY_EQUITY_REFRESH_MS = num('STRIKE_COPY_EQUITY_REFRESH_MS', 60_000, 10_000);

export const loadStrikeCopyStrategy = (): StrikeCopyStrategyConfig => {
    const d = DEFAULT_STRIKE_COPY_STRATEGY;
    return {
        includeRegex: regex('STRIKE_COPY_INCLUDE_REGEX', DEFAULT_INCLUDE_REGEX),
        excludeRegex: regex('STRIKE_COPY_EXCLUDE_REGEX', DEFAULT_EXCLUDE_REGEX),
        minBuyPrice: num('STRIKE_COPY_MIN_BUY_PRICE', d.minBuyPrice),
        maxBuyPrice: num('STRIKE_COPY_MAX_BUY_PRICE', d.maxBuyPrice),
        minHoursToEnd: num('STRIKE_COPY_MIN_HOURS_TO_END', d.minHoursToEnd),
        maxHoursToEnd: num('STRIKE_COPY_MAX_HOURS_TO_END', d.maxHoursToEnd),
        minTraderTradeUsd: num('STRIKE_COPY_MIN_TRADER_TRADE_USD', d.minTraderTradeUsd),
        copyPercent: num('STRIKE_COPY_PERCENT', d.copyPercent),
        minOrderUsd: num('STRIKE_COPY_MIN_ORDER_USD', d.minOrderUsd),
        maxOrderUsd: num('STRIKE_COPY_MAX_ORDER_USD', d.maxOrderUsd),
        maxPositionUsd: num('STRIKE_COPY_MAX_POSITION_USD', d.maxPositionUsd),
        maxOrderPctEquity: num('STRIKE_COPY_MAX_ORDER_PCT_EQUITY', d.maxOrderPctEquity),
        maxPositionPctEquity: num('STRIKE_COPY_MAX_POSITION_PCT_EQUITY', d.maxPositionPctEquity),
        aggregateTtlSec: num('STRIKE_COPY_AGGREGATE_TTL_SEC', d.aggregateTtlSec),
    };
};

export const STRIKE_COPY_RUNTIME = {
    socksProxyUrl: ENV.SOCKS_PROXY_URL,
    proxyWallet: ENV.PROXY_WALLET,
    requestTimeoutMs: ENV.REQUEST_TIMEOUT_MS,
};

export const describeStrategy = (s: StrikeCopyStrategyConfig): string =>
    `BUY-only · crypto strike markets · price ${(s.minBuyPrice * 100).toFixed(0)}–${(s.maxBuyPrice * 100).toFixed(0)}¢ · ≥${s.minHoursToEnd}h to resolution` +
    ` · copy ${s.copyPercent}% (aggregate to $${s.minOrderUsd}) · order ≤ $${s.maxOrderUsd}${s.maxOrderPctEquity ? ` / ${s.maxOrderPctEquity}% eq` : ''}` +
    ` · position ≤ $${s.maxPositionUsd}${s.maxPositionPctEquity ? ` / ${s.maxPositionPctEquity}% eq` : ''}`;
