import fetchData from '../utils/fetchData';
import { PaperPortfolio, PaperSettlement } from './paperPortfolio';

export interface MarketResolution {
    slug: string;
    resolved: boolean;
    winningTokenId: string | null;
    outcomes: string[];
    outcomePrices: number[];
    tokenIds: string[];
}

interface GammaMarket {
    closed?: boolean;
    umaResolutionStatus?: string;
    outcomes?: string;
    outcomePrices?: string;
    clobTokenIds?: string;
}

interface CachedResolution {
    result: MarketResolution | null;
    at: number;
}

const resolutionCache = new Map<string, CachedResolution>();
const RESOLVED_CACHE_MS = 300_000;
const UNRESOLVED_CACHE_MS = 15_000;

const parseJsonArray = <T>(raw: string | undefined, fallback: T[]): T[] => {
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw) as T[];
        return Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
};

const isMarketResolved = (market: GammaMarket, prices: number[]): boolean => {
    if (market.closed !== true) return false;
    if (market.umaResolutionStatus === 'resolved') return true;
    const hasWinner = prices.some((p) => p >= 0.99);
    const hasLoser = prices.some((p) => p <= 0.01);
    return hasWinner && hasLoser;
};

export const fetchMarketResolution = async (slug: string): Promise<MarketResolution | null> => {
    const cached = resolutionCache.get(slug);
    if (cached) {
        const ttl = cached.result?.resolved ? RESOLVED_CACHE_MS : UNRESOLVED_CACHE_MS;
        if (Date.now() - cached.at < ttl) {
            return cached.result;
        }
    }

    try {
        const market = (await fetchData(
            `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`
        )) as GammaMarket;

        if (!market?.clobTokenIds) {
            return null;
        }

        const outcomes = parseJsonArray<string>(market.outcomes, []);
        const outcomePrices = parseJsonArray<string>(market.outcomePrices, []).map(Number);
        const tokenIds = parseJsonArray<string>(market.clobTokenIds, []);
        const resolved = isMarketResolved(market, outcomePrices);

        let winningTokenId: string | null = null;
        if (resolved) {
            for (let i = 0; i < tokenIds.length; i++) {
                if (outcomePrices[i] >= 0.99) {
                    winningTokenId = tokenIds[i];
                    break;
                }
            }
        }

        const result: MarketResolution = {
            slug,
            resolved,
            winningTokenId,
            outcomes,
            outcomePrices,
            tokenIds,
        };
        resolutionCache.set(slug, { result, at: Date.now() });
        return result;
    } catch {
        return null;
    }
};

export const settleResolvedPaperPositions = async (
    portfolio: PaperPortfolio
): Promise<PaperSettlement[]> => {
    const settled: PaperSettlement[] = [];
    const openPositions = portfolio.getOpenPositions();

    const slugs = [
        ...new Set(
            openPositions.map((p) => p.slug).filter((s): s is string => typeof s === 'string' && s.length > 0)
        ),
    ];

    for (const slug of slugs) {
        const resolution = await fetchMarketResolution(slug);
        if (!resolution?.resolved) continue;

        for (const pos of openPositions.filter((p) => p.slug === slug)) {
            if (!portfolio.hasOpenPosition(pos.asset)) continue;

            const won = resolution.winningTokenId === pos.asset;
            const result = portfolio.paperSettle({
                asset: pos.asset,
                conditionId: pos.conditionId,
                slug: pos.slug,
                outcome: pos.outcome,
                won,
            });

            if (result.ok) {
                settled.push(result.settlement);
            }
        }
    }

    return settled;
};
