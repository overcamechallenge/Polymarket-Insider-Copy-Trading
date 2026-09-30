/**
 * Fetch gamma market metadata (end time, resolution, token ids) for every market
 * a trader touched in the last N days. Cached in trader-analysis-data/<name>/markets.json.
 *
 *   npx ts-node src/trader-analysis/fetchMarkets.ts coinman2 --days 45
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import { configureSocksProxyFromEnv } from '../utils/proxy';
import type { MarketInfo, RawTrade } from './types';

configureSocksProxyFromEnv(ENV.SOCKS_PROXY_URL);

const GAMMA = 'https://gamma-api.polymarket.com';

const parseArr = <T>(raw: unknown): T[] => {
    if (Array.isArray(raw)) return raw as T[];
    if (typeof raw !== 'string') return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? (v as T[]) : [];
    } catch {
        return [];
    }
};

type GammaMarket = {
    conditionId?: string;
    slug?: string;
    question?: string;
    closed?: boolean;
    umaResolutionStatus?: string;
    outcomes?: string;
    outcomePrices?: string;
    clobTokenIds?: string;
    endDate?: string;
    startDate?: string;
    createdAt?: string;
};

const toMarketInfo = (conditionId: string, m: GammaMarket): MarketInfo => {
    const outcomes = parseArr<string>(m.outcomes);
    const outcomePrices = parseArr<string>(m.outcomePrices).map(Number);
    const tokenIds = parseArr<string>(m.clobTokenIds);
    const hasWinner = outcomePrices.some((p) => p >= 0.99);
    const hasLoser = outcomePrices.some((p) => p <= 0.01);
    const resolved =
        m.closed === true && (m.umaResolutionStatus === 'resolved' || (hasWinner && hasLoser));
    const winIdx = resolved ? outcomePrices.findIndex((p) => p >= 0.99) : -1;
    return {
        conditionId,
        slug: m.slug || '',
        question: m.question || '',
        closed: m.closed === true,
        resolved,
        outcomes,
        outcomePrices,
        tokenIds,
        winningTokenId: winIdx >= 0 ? tokenIds[winIdx] ?? null : null,
        endDate: m.endDate,
        startDate: m.startDate,
        createdAt: m.createdAt,
    };
};

/** Gamma omits closed markets from `condition_ids` lookups unless `closed=true` is passed. */
export const fetchMarketByConditionId = async (conditionId: string): Promise<MarketInfo | null> => {
    for (const q of [`${GAMMA}/markets?condition_ids=${conditionId}&closed=true`, `${GAMMA}/markets?condition_ids=${conditionId}`]) {
        const rows = (await fetchData(q)) as GammaMarket[];
        if (Array.isArray(rows) && rows.length > 0) return toMarketInfo(conditionId, rows[0]);
    }
    return null;
};

const loadMarketCache = (dir: string): Record<string, MarketInfo> => {
    const f = path.join(dir, 'markets.json');
    if (!fs.existsSync(f)) return {};
    try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, MarketInfo | null>;
        const out: Record<string, MarketInfo> = {};
        for (const [k, v] of Object.entries(raw)) if (v && typeof v.resolved === 'boolean') out[k] = v;
        return out;
    } catch {
        return {};
    }
};

const ensureMarkets = async (
    dir: string,
    conditionIds: string[],
    onProgress?: (done: number, total: number) => void
): Promise<Record<string, MarketInfo>> => {
    const cache = loadMarketCache(dir);
    const f = path.join(dir, 'markets.json');
    // Re-fetch unresolved markets (they may have resolved since last run).
    const todo = conditionIds.filter((c) => !cache[c] || !cache[c].resolved);
    let done = 0;
    for (const c of todo) {
        try {
            const m = await fetchMarketByConditionId(c);
            if (m) cache[c] = m;
        } catch {
            // leave missing; backtest will skip
        }
        done += 1;
        if (done % 25 === 0) {
            fs.writeFileSync(f, JSON.stringify(cache));
            onProgress?.(done, todo.length);
        }
        await new Promise((r) => setTimeout(r, 80));
    }
    fs.writeFileSync(f, JSON.stringify(cache));
    onProgress?.(done, todo.length);
    return cache;
};

const main = async () => {
    const name = process.argv[2] || 'coinman2';
    const i = process.argv.indexOf('--days');
    const days = i >= 0 ? Number(process.argv[i + 1]) : 45;
    const dir = path.join(process.cwd(), 'trader-analysis-data', name);
    const trades = JSON.parse(fs.readFileSync(path.join(dir, 'trades.json'), 'utf8')) as RawTrade[];
    const cut = Math.floor(Date.now() / 1000) - days * 86400;
    const conds = [...new Set(trades.filter((t) => t.timestamp >= cut).map((t) => t.conditionId))];
    console.log(`${conds.length} markets in last ${days}d`);
    const cache = await ensureMarkets(dir, conds, (d, t) => console.log(`  ${d}/${t}`));
    const got = conds.filter((c) => cache[c]);
    console.log(
        `markets: ${got.length}/${conds.length} fetched, resolved: ${got.filter((c) => cache[c].resolved).length}`
    );
};

if (require.main === module) {
    main().catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
}
