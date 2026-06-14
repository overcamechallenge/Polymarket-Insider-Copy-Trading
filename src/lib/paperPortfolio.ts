export interface PaperPosition {
    asset: string;
    conditionId: string;
    slug?: string;
    outcome?: string;
    tokens: number;
    avgPrice: number;
    costUsd: number;
}

export interface PaperFill {
    timestamp: string;
    side: 'BUY' | 'SELL';
    asset: string;
    conditionId: string;
    slug?: string;
    outcome?: string;
    usdcAmount: number;
    price: number;
    tokens: number;
    cashAfter: number;
}

export interface PaperSettlement {
    timestamp: string;
    asset: string;
    conditionId: string;
    slug?: string;
    outcome?: string;
    tokens: number;
    costUsd: number;
    won: boolean;
    payoutUsd: number;
    pnlUsd: number;
    cashAfter: number;
}

export interface PaperPortfolioSnapshot {
    paperTrading: true;
    startBalanceUsd: number;
    cashUsd: number;
    positionsValueUsd: number;
    totalEquityUsd: number;
    pnlUsd: number;
    pnlPercent: number;
    openPositions: PaperPosition[];
    fills: PaperFill[];
    settlements: PaperSettlement[];
    settledCount: number;
    winsSettled: number;
    lossesSettled: number;
}

export interface PaperPortfolioPersisted {
    startBalanceUsd: number;
    cashUsd: number;
    positions: PaperPosition[];
    fills: PaperFill[];
    settlements: PaperSettlement[];
    settledAssets: string[];
}

export class PaperPortfolio {
    private cashUsd: number;
    private positions = new Map<string, PaperPosition>();
    private settledAssets = new Set<string>();
    readonly fills: PaperFill[] = [];
    readonly settlements: PaperSettlement[] = [];

    constructor(private readonly startBalanceUsd: number) {
        this.cashUsd = startBalanceUsd;
    }

    getCashUsd(): number {
        return this.cashUsd;
    }

    getPosition(asset: string): PaperPosition | undefined {
        return this.positions.get(asset);
    }

    getOpenPositions(): PaperPosition[] {
        return [...this.positions.values()];
    }

    hasOpenPosition(asset: string): boolean {
        return this.positions.has(asset) && !this.settledAssets.has(asset);
    }

    paperBuy(input: {
        asset: string;
        conditionId: string;
        slug?: string;
        outcome?: string;
        price: number;
        usdcAmount?: number;
    }): { ok: true; fill: PaperFill } | { ok: false; reason: string } {
        const price = input.price;
        if (price <= 0 || price >= 1) {
            return { ok: false, reason: `invalid price ${price}` };
        }

        const usdcAmount = input.usdcAmount;
        if (usdcAmount === undefined) {
            return { ok: false, reason: 'usdcAmount required' };
        }
        if (usdcAmount < 1) {
            return { ok: false, reason: 'below $1 minimum' };
        }
        if (this.cashUsd < usdcAmount) {
            return { ok: false, reason: `insufficient cash ($${this.cashUsd.toFixed(2)})` };
        }

        const tokens = usdcAmount / price;
        this.cashUsd -= usdcAmount;

        const existing = this.positions.get(input.asset);
        if (existing) {
            const totalTokens = existing.tokens + tokens;
            const totalCost = existing.costUsd + usdcAmount;
            existing.tokens = totalTokens;
            existing.costUsd = totalCost;
            existing.avgPrice = totalCost / totalTokens;
        } else {
            this.positions.set(input.asset, {
                asset: input.asset,
                conditionId: input.conditionId,
                slug: input.slug,
                outcome: input.outcome,
                tokens,
                avgPrice: price,
                costUsd: usdcAmount,
            });
        }

        const fill: PaperFill = {
            timestamp: new Date().toISOString(),
            side: 'BUY',
            asset: input.asset,
            conditionId: input.conditionId,
            slug: input.slug,
            outcome: input.outcome,
            usdcAmount,
            price,
            tokens,
            cashAfter: this.cashUsd,
        };
        this.fills.push(fill);
        return { ok: true, fill };
    }

    paperSettle(input: {
        asset: string;
        conditionId: string;
        slug?: string;
        outcome?: string;
        won: boolean;
    }): { ok: true; settlement: PaperSettlement } | { ok: false; reason: string } {
        if (this.settledAssets.has(input.asset)) {
            return { ok: false, reason: 'already settled' };
        }

        const pos = this.positions.get(input.asset);
        if (!pos || pos.tokens <= 0) {
            return { ok: false, reason: 'no position' };
        }

        const payoutUsd = input.won ? pos.tokens : 0;
        this.cashUsd += payoutUsd;
        this.positions.delete(input.asset);
        this.settledAssets.add(input.asset);

        const settlement: PaperSettlement = {
            timestamp: new Date().toISOString(),
            asset: input.asset,
            conditionId: input.conditionId,
            slug: input.slug ?? pos.slug,
            outcome: input.outcome ?? pos.outcome,
            tokens: pos.tokens,
            costUsd: pos.costUsd,
            won: input.won,
            payoutUsd,
            pnlUsd: payoutUsd - pos.costUsd,
            cashAfter: this.cashUsd,
        };
        this.settlements.push(settlement);
        return { ok: true, settlement };
    }

    paperSellTokens(input: {
        asset: string;
        conditionId: string;
        slug?: string;
        outcome?: string;
        price: number;
        tokens: number;
    }): { ok: true; fill: PaperFill } | { ok: false; reason: string } {
        const price = input.price;
        if (price <= 0 || price >= 1) {
            return { ok: false, reason: `invalid price ${price}` };
        }

        const pos = this.positions.get(input.asset);
        if (!pos || pos.tokens <= 0) {
            return { ok: false, reason: 'no position' };
        }

        const tokensToSell = Math.min(input.tokens, pos.tokens);
        if (tokensToSell < 0.01) {
            return { ok: false, reason: 'sell size too small' };
        }

        const usdcReceived = tokensToSell * price;
        const costRemoved = tokensToSell * pos.avgPrice;
        pos.tokens -= tokensToSell;
        pos.costUsd = Math.max(0, pos.costUsd - costRemoved);
        if (pos.tokens <= 0.0001) {
            this.positions.delete(input.asset);
        }

        this.cashUsd += usdcReceived;

        const fill: PaperFill = {
            timestamp: new Date().toISOString(),
            side: 'SELL',
            asset: input.asset,
            conditionId: input.conditionId,
            slug: input.slug,
            outcome: input.outcome,
            usdcAmount: usdcReceived,
            price,
            tokens: tokensToSell,
            cashAfter: this.cashUsd,
        };
        this.fills.push(fill);
        return { ok: true, fill };
    }

    snapshot(markPrices: Map<string, number>): PaperPortfolioSnapshot {
        let positionsValueUsd = 0;
        const openPositions: PaperPosition[] = [];

        for (const pos of this.positions.values()) {
            const mark = markPrices.get(pos.asset) ?? pos.avgPrice;
            positionsValueUsd += pos.tokens * mark;
            openPositions.push({ ...pos });
        }

        const totalEquityUsd = this.cashUsd + positionsValueUsd;
        const pnlUsd = totalEquityUsd - this.startBalanceUsd;
        const winsSettled = this.settlements.filter((s) => s.won).length;
        const lossesSettled = this.settlements.filter((s) => !s.won).length;

        return {
            paperTrading: true,
            startBalanceUsd: this.startBalanceUsd,
            cashUsd: this.cashUsd,
            positionsValueUsd,
            totalEquityUsd,
            pnlUsd,
            pnlPercent: (pnlUsd / this.startBalanceUsd) * 100,
            openPositions,
            fills: [...this.fills],
            settlements: [...this.settlements],
            settledCount: this.settlements.length,
            winsSettled,
            lossesSettled,
        };
    }

    toPersisted(): PaperPortfolioPersisted {
        return {
            startBalanceUsd: this.startBalanceUsd,
            cashUsd: this.cashUsd,
            positions: this.getOpenPositions(),
            fills: [...this.fills],
            settlements: [...this.settlements],
            settledAssets: [...this.settledAssets],
        };
    }

    static fromPersisted(data: PaperPortfolioPersisted): PaperPortfolio {
        const portfolio = new PaperPortfolio(data.startBalanceUsd);
        portfolio.cashUsd = data.cashUsd;
        portfolio.fills.push(...data.fills);
        portfolio.settlements.push(...data.settlements);
        for (const asset of data.settledAssets) {
            portfolio.settledAssets.add(asset);
        }
        for (const pos of data.positions) {
            portfolio.positions.set(pos.asset, { ...pos });
        }
        return portfolio;
    }
}
