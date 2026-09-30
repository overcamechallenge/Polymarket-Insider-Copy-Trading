import fs from 'node:fs';
import path from 'node:path';
import type { ClosedPosition, MarketInfo, OpenPosition, RawTrade } from './types';

export type AssetResolution = { won: boolean; endTs: number; source: 'gamma' | 'positions' };

/** Date-only end dates (daily crypto strikes) resolve at 12:00 ET ≈ 16:00 UTC. */
const parseEndTs = (endDate?: string): number | null => {
    if (!endDate) return null;
    if (endDate.includes('T')) {
        const t = Date.parse(endDate);
        return Number.isFinite(t) ? t / 1000 : null;
    }
    const t = Date.parse(`${endDate}T16:00:00Z`);
    return Number.isFinite(t) ? t / 1000 : null;
};

export type TraderDataset = {
    dir: string;
    trades: RawTrade[];
    markets: Record<string, MarketInfo>;
    closed: ClosedPosition[];
    open: OpenPosition[];
};

export const loadTraderDataset = (name: string): TraderDataset => {
    const dir = path.join(process.cwd(), 'trader-analysis-data', name);
    const read = <T>(f: string, def: T): T => {
        const p = path.join(dir, f);
        if (!fs.existsSync(p)) return def;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
        } catch {
            return def;
        }
    };
    const trades = read<RawTrade[]>('trades.json', []);
    if (trades.length === 0) {
        throw new Error(`No trades in ${dir}. Run: npm run trader:download -- @${name}`);
    }
    const rawMarkets = read<Record<string, MarketInfo | null>>('markets.json', {});
    const markets: Record<string, MarketInfo> = {};
    for (const [k, v] of Object.entries(rawMarkets)) if (v) markets[k] = v;
    return {
        dir,
        trades,
        markets,
        closed: read<ClosedPosition[]>('closed-positions.json', []),
        open: read<OpenPosition[]>('positions.json', []),
    };
};

/**
 * Build asset (token id) → resolution. Gamma market data wins (exact end time);
 * the trader's closed/open positions (curPrice 0/1) fill in the rest.
 */
export const buildResolutionMap = (ds: TraderDataset): Map<string, AssetResolution> => {
    const map = new Map<string, AssetResolution>();

    for (const m of Object.values(ds.markets)) {
        if (!m.resolved || !m.winningTokenId) continue;
        const endTs = parseEndTs(m.endDate);
        if (endTs === null) continue;
        for (const tokenId of m.tokenIds) {
            map.set(tokenId, { won: tokenId === m.winningTokenId, endTs, source: 'gamma' });
        }
    }

    const fromPosition = (p: { asset: string; curPrice: number; endDate?: string; oppositeAsset?: string }) => {
        if (p.curPrice !== 0 && p.curPrice !== 1) return;
        const endTs = parseEndTs(p.endDate);
        if (endTs === null) return;
        if (!map.has(p.asset)) map.set(p.asset, { won: p.curPrice === 1, endTs, source: 'positions' });
        if (p.oppositeAsset && !map.has(p.oppositeAsset)) {
            map.set(p.oppositeAsset, { won: p.curPrice === 0, endTs, source: 'positions' });
        }
    };
    for (const c of ds.closed) fromPosition(c as ClosedPosition & { oppositeAsset?: string });
    for (const o of ds.open) fromPosition(o as OpenPosition & { oppositeAsset?: string });

    return map;
};
