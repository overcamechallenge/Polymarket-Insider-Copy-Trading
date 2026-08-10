import type { RtdsActivityTrade, TradeSide } from '../types';

const asString = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

const asNumber = (v: unknown): number => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return NaN;
};

const normalizeSide = (side: unknown): TradeSide | null => {
    const s = asString(side).toUpperCase();
    if (s === 'BUY' || s === 'SELL') return s;
    return null;
};

/**
 * RTDS activity payloads vary slightly between `trades` and `orders_matched`.
 * Accept both camelCase and snake_case field names.
 */
/** Cheap wallet extraction so hot-path filtering can skip full parsing. */
export const peekProxyWallet = (payload: unknown): string | null => {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const wallet = p.proxyWallet ?? p.proxy_wallet;
    return typeof wallet === 'string' ? wallet.toLowerCase() : null;
};

export const parseRtdsActivityTrade = (
    payload: unknown,
    sourceType: string,
    receivedAt: number = Date.now()
): RtdsActivityTrade | null => {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;

    const asset = asString(p.asset ?? p.asset_id ?? p.assetId);
    const proxyWallet = asString(p.proxyWallet ?? p.proxy_wallet).toLowerCase();
    const side = normalizeSide(p.side);
    const price = asNumber(p.price);
    const size = asNumber(p.size);

    if (!asset || !proxyWallet || !side) return null;
    if (!Number.isFinite(price) || price <= 0) return null;
    if (!Number.isFinite(size) || size <= 0) return null;

    const usd = price * size;
    const timestamp = asNumber(p.timestamp);
    const transactionHash = asString(p.transactionHash ?? p.transaction_hash ?? p.txHash);

    return {
        asset,
        conditionId: asString(p.conditionId ?? p.condition_id ?? p.market),
        slug: asString(p.slug ?? p.market_slug ?? p.marketSlug),
        eventSlug: asString(p.eventSlug ?? p.event_slug),
        title: asString(p.title),
        outcome: asString(p.outcome),
        outcomeIndex: Number.isFinite(asNumber(p.outcomeIndex ?? p.outcome_index))
            ? asNumber(p.outcomeIndex ?? p.outcome_index)
            : -1,
        price,
        size,
        side,
        proxyWallet,
        name: asString(p.name) || undefined,
        pseudonym: asString(p.pseudonym) || undefined,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        transactionHash,
        usd,
        sourceType,
        receivedAt,
    };
};

/** Dedup key — same fill can arrive on both trades + orders_matched. */
export const tradeDedupKey = (trade: RtdsActivityTrade): string => {
    if (trade.transactionHash) {
        return `${trade.transactionHash}:${trade.asset}:${trade.side}:${trade.size}:${trade.price}`;
    }
    return `${trade.proxyWallet}:${trade.asset}:${trade.side}:${trade.size}:${trade.price}:${trade.timestamp}`;
};
