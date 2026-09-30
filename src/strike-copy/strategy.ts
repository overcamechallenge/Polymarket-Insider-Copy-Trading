/**
 * "Cheap strike leg" copy strategy — derived from a 1-year analysis of @coinman2.
 *
 * Findings that drive the rules (see trader-analysis-data/<name>/report.md):
 *  - The trader never sells: every position is held to resolution → copy BUYs only.
 *  - ~86% of volume is crypto price-strike ladders ("Bitcoin above $78k on Sep 11",
 *    "Solana between $80-$85", "Will ETH dip to …"). Daily Up/Down and 5m/15m are ~0 EV.
 *  - Legs bought below ~40¢ carry the edge (20–50% ROI on deployed capital);
 *    legs bought at 60–90¢ lose ~10%. Cheap legs bought ≥6h before resolution
 *    outperform last-hours scalps.
 *  - Hundreds of tiny fills per day → aggregate scaled fills per token until they
 *    reach the exchange minimum instead of flooring each to $1 (flooring
 *    over-weights lottery tickets ~5x and blew up small accounts in backtests).
 */

export type MarketCategory = 'strike' | 'updown' | 'short_updown' | 'other';

export type StrikeCopyStrategyConfig = {
    /** Slug/title must match (crypto price-strike markets). */
    includeRegex: RegExp;
    /** Slug/title must NOT match (daily / 5m / 15m up-or-down). */
    excludeRegex: RegExp;
    /** Inclusive lower bound for the trader's fill price. */
    minBuyPrice: number;
    /** Exclusive upper bound for the trader's fill price. */
    maxBuyPrice: number;
    /** Skip buys placed closer than this to market resolution. */
    minHoursToEnd: number;
    /** 0 = no upper bound. */
    maxHoursToEnd: number;
    /** Ignore trader fills below this notional before aggregation (0 = keep all). */
    minTraderTradeUsd: number;
    /** % of the trader's notional we copy. */
    copyPercent: number;
    /** Exchange minimum; aggregated fills are flushed once they reach this. */
    minOrderUsd: number;
    /** Hard per-order cap in USD. */
    maxOrderUsd: number;
    /** Hard per-token exposure cap in USD (0 = disabled). */
    maxPositionUsd: number;
    /** Per-order cap as % of equity (0 = disabled). Lower of this and maxOrderUsd applies. */
    maxOrderPctEquity: number;
    /** Per-token exposure cap as % of equity (0 = disabled). Lower of this and maxPositionUsd applies. */
    maxPositionPctEquity: number;
    /** Drop an unfilled aggregation bucket after this many seconds of inactivity. */
    aggregateTtlSec: number;
};

export const DEFAULT_INCLUDE_REGEX =
    /(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|doge|dogecoin|bnb|hyperliquid|hype|cardano|ada|crypto).*?(above|below|between|dip|hit|reach|price)|(above|below|between|dip|hit|reach|price).*?(bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|bnb|hype)/i;

export const DEFAULT_EXCLUDE_REGEX = /up-or-down|updown|up-down|(?:5|15)m-up/i;

export const DEFAULT_STRIKE_COPY_STRATEGY: StrikeCopyStrategyConfig = {
    includeRegex: DEFAULT_INCLUDE_REGEX,
    excludeRegex: DEFAULT_EXCLUDE_REGEX,
    minBuyPrice: 0.02,
    maxBuyPrice: 0.4,
    minHoursToEnd: 6,
    maxHoursToEnd: 0,
    minTraderTradeUsd: 0,
    copyPercent: 5,
    minOrderUsd: 1,
    maxOrderUsd: 25,
    maxPositionUsd: 50,
    maxOrderPctEquity: 1.5,
    maxPositionPctEquity: 3,
    aggregateTtlSec: 3600,
};

export const classifyMarket = (slug: string | undefined, title?: string): MarketCategory => {
    const hay = `${slug || ''} ${title || ''}`.toLowerCase();
    if (/updown-(?:5|15)m|up-or-down-(?:5|15)m|(?:5|15)m-up/.test(hay)) return 'short_updown';
    if (/up-or-down|updown|up-down/.test(hay)) return 'updown';
    if (
        /(bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|bnb|hype|crypto|cardano|ada)/.test(hay) &&
        /(above|below|between|dip|hit|reach|price)/.test(hay)
    ) {
        return 'strike';
    }
    return 'other';
};

export type CopyCandidate = {
    side: 'BUY' | 'SELL';
    price: number;
    usd: number;
    slug: string;
    title?: string;
    /** Market resolution time (epoch seconds) or null when unknown. */
    endTs: number | null;
    /** Trade time (epoch seconds). */
    ts: number;
};

/** Returns a human-readable skip reason, or null when the trade passes all filters. */
export const getCopySkipReason = (
    c: CopyCandidate,
    cfg: StrikeCopyStrategyConfig
): string | null => {
    if (c.side !== 'BUY') return 'sell (trader holds to resolution; sells not mirrored)';
    const hay = `${c.slug} ${c.title || ''}`;
    if (cfg.excludeRegex.test(hay)) return 'excluded market type (up/down)';
    if (!cfg.includeRegex.test(hay)) return 'not a crypto price-strike market';
    if (!Number.isFinite(c.price) || c.price <= 0) return 'invalid price';
    if (c.price < cfg.minBuyPrice) return `price ${(c.price * 100).toFixed(1)}¢ below min ${(cfg.minBuyPrice * 100).toFixed(0)}¢`;
    if (c.price >= cfg.maxBuyPrice) return `price ${(c.price * 100).toFixed(1)}¢ at/above max ${(cfg.maxBuyPrice * 100).toFixed(0)}¢`;
    if (cfg.minTraderTradeUsd > 0 && c.usd < cfg.minTraderTradeUsd) return `trader fill $${c.usd.toFixed(2)} below min`;
    if (c.endTs === null) {
        if (cfg.minHoursToEnd > 0) return 'market end time unknown';
    } else {
        const hours = (c.endTs - c.ts) / 3600;
        if (hours < cfg.minHoursToEnd) return `${hours.toFixed(1)}h to resolution < min ${cfg.minHoursToEnd}h`;
        if (cfg.maxHoursToEnd > 0 && hours > cfg.maxHoursToEnd) return `${hours.toFixed(1)}h to resolution > max ${cfg.maxHoursToEnd}h`;
    }
    return null;
};

export type AggregatedFill = { usd: number; vwap: number; fills: number };

/**
 * Accumulates our scaled share of the trader's fills per token and releases a
 * single order once the bucket reaches the exchange minimum.
 */
export class FillAggregator {
    private buckets = new Map<string, { usd: number; usdPrice: number; fills: number; lastTs: number }>();

    constructor(private readonly minOrderUsd: number, private readonly ttlSec: number) {}

    add(asset: string, scaledUsd: number, price: number, ts: number): AggregatedFill | null {
        let b = this.buckets.get(asset);
        if (b && ts - b.lastTs > this.ttlSec) b = undefined;
        if (!b) b = { usd: 0, usdPrice: 0, fills: 0, lastTs: ts };
        b.usd += scaledUsd;
        b.usdPrice += scaledUsd * price;
        b.fills += 1;
        b.lastTs = ts;
        if (b.usd >= this.minOrderUsd) {
            this.buckets.delete(asset);
            return { usd: b.usd, vwap: b.usdPrice / b.usd, fills: b.fills };
        }
        this.buckets.set(asset, b);
        return null;
    }

    pending(asset: string): number {
        return this.buckets.get(asset)?.usd ?? 0;
    }

    size(): number {
        return this.buckets.size;
    }
}

export type OrderSizing = { amount: number; reason: string };

/** Apply order / position / balance caps to an aggregated (already %-scaled) amount. */
export const sizeOrder = (
    cfg: StrikeCopyStrategyConfig,
    requestedUsd: number,
    equityUsd: number,
    cashUsd: number,
    currentPositionCostUsd: number
): OrderSizing => {
    let amount = requestedUsd;
    const notes: string[] = [`copy $${requestedUsd.toFixed(2)}`];

    let orderCap = cfg.maxOrderUsd;
    if (cfg.maxOrderPctEquity > 0) orderCap = Math.min(orderCap, (equityUsd * cfg.maxOrderPctEquity) / 100);
    if (amount > orderCap) {
        amount = orderCap;
        notes.push(`order cap $${orderCap.toFixed(2)}`);
    }

    let posCap = cfg.maxPositionUsd > 0 ? cfg.maxPositionUsd : Number.POSITIVE_INFINITY;
    if (cfg.maxPositionPctEquity > 0) posCap = Math.min(posCap, (equityUsd * cfg.maxPositionPctEquity) / 100);
    if (currentPositionCostUsd + amount > posCap) {
        amount = Math.max(0, posCap - currentPositionCostUsd);
        notes.push(`position cap $${posCap.toFixed(2)} (have $${currentPositionCostUsd.toFixed(2)})`);
    }

    const affordable = cashUsd * 0.99;
    if (amount > affordable) {
        amount = affordable;
        notes.push(`cash $${cashUsd.toFixed(2)}`);
    }

    if (amount < cfg.minOrderUsd) {
        return { amount: 0, reason: `${notes.join(' → ')} → below min $${cfg.minOrderUsd}` };
    }
    return { amount, reason: notes.join(' → ') };
};

/**
 * Polymarket taker fee on crypto markets scales with (1 - price):
 * fee ≈ rate × notional × (1 - p). Empirically ~5% × (1-p) on this trader's fills.
 */
export const estimateTakerFeeUsd = (notionalUsd: number, price: number, feeRate: number): number =>
    Math.max(0, notionalUsd * feeRate * (1 - price));
