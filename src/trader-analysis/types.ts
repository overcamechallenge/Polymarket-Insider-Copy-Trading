export type RawTrade = {
    proxyWallet: string;
    timestamp: number; // epoch seconds
    conditionId: string;
    type: 'TRADE';
    size: number; // tokens
    usdcSize: number;
    transactionHash: string;
    price: number;
    asset: string;
    side: 'BUY' | 'SELL';
    outcomeIndex: number;
    title: string;
    slug: string;
    eventSlug: string;
    outcome: string;
};

export type ClosedPosition = {
    asset: string;
    conditionId: string;
    avgPrice: number;
    totalBought: number; // USD
    realizedPnl: number;
    curPrice: number;
    title: string;
    slug: string;
    eventSlug: string;
    outcome: string;
    outcomeIndex: number;
    endDate?: string;
    timestamp: number;
};

export type OpenPosition = {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    initialValue: number;
    currentValue: number;
    cashPnl: number;
    realizedPnl: number;
    totalBought: number;
    curPrice: number;
    redeemable: boolean;
    title: string;
    slug: string;
    eventSlug: string;
    outcome: string;
    outcomeIndex: number;
    endDate?: string;
};

export type MarketInfo = {
    conditionId: string;
    slug: string;
    question: string;
    closed: boolean;
    resolved: boolean;
    outcomes: string[];
    outcomePrices: number[];
    tokenIds: string[];
    winningTokenId: string | null;
    endDate?: string;
    startDate?: string;
    createdAt?: string;
};
