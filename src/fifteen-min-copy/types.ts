export type TradeSide = 'BUY' | 'SELL';

/** Normalized trade from Polymarket RTDS activity stream. */
export type RtdsActivityTrade = {
    asset: string;
    conditionId: string;
    slug: string;
    eventSlug: string;
    title: string;
    outcome: string;
    outcomeIndex: number;
    price: number;
    size: number;
    side: TradeSide;
    proxyWallet: string;
    name?: string;
    pseudonym?: string;
    timestamp: number;
    transactionHash: string;
    /** USD notional = price * size */
    usd: number;
    /** Raw stream type: trades | orders_matched */
    sourceType: string;
    /** Local clock (ms) when the websocket frame arrived — used for latency stats. */
    receivedAt: number;
};

export type CopyTradeResult = {
    ok: boolean;
    skipped?: boolean;
    message: string;
};
