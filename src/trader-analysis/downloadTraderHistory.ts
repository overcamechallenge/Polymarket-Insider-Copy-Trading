/**
 * Download a Polymarket trader's full history for offline analysis / backtesting.
 *
 *   npx ts-node src/trader-analysis/downloadTraderHistory.ts @coinman2 [--days 365]
 *
 * Output: trader-analysis-data/<name>/{profile,trades,closed-positions,positions}.json
 *
 * The data-api activity endpoint caps `offset` at 5000, so we page backwards in
 * time using the `end` cursor (500 rows per call) and dedup on (tx, asset, side, size, price).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import { configureSocksProxyFromEnv } from '../utils/proxy';
import { resolvePolymarketWatchlist } from '../utils/resolvePolymarketWatchlist';
import type { RawTrade, ClosedPosition, OpenPosition } from './types';

configureSocksProxyFromEnv(ENV.SOCKS_PROXY_URL);

const DATA_API = 'https://data-api.polymarket.com';
const PAGE = 500;

const arg = (flag: string, def: string): string => {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const tradeKey = (t: RawTrade): string =>
    `${t.transactionHash}:${t.asset}:${t.side}:${t.size}:${t.price}:${t.timestamp}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const downloadTrades = async (
    wallet: string,
    startTs: number,
    onProgress?: (n: number, oldest: number) => void
): Promise<RawTrade[]> => {
    const seen = new Set<string>();
    const out: RawTrade[] = [];
    let end = Math.floor(Date.now() / 1000) + 60;

    for (;;) {
        // Within one `end` window we can still use offset (<=5000) to go deeper
        // when many trades share the same second.
        let offset = 0;
        let pageOldest = end;
        let gotNew = false;

        for (;;) {
            const url = `${DATA_API}/activity?user=${wallet}&type=TRADE&limit=${PAGE}&offset=${offset}&end=${end}&sortBy=TIMESTAMP&sortDirection=DESC`;
            const rows = (await fetchData(url)) as RawTrade[];
            if (!Array.isArray(rows) || rows.length === 0) break;

            for (const t of rows) {
                const k = tradeKey(t);
                if (seen.has(k)) continue;
                seen.add(k);
                out.push(t);
                gotNew = true;
                if (t.timestamp < pageOldest) pageOldest = t.timestamp;
            }

            if (rows.length < PAGE) break;
            offset += PAGE;
            // If the oldest row in this page is strictly older than `end`, we can
            // safely move the cursor instead of paging deeper.
            if (pageOldest < end) break;
            if (offset >= 5000) break;
            await sleep(120);
        }

        onProgress?.(out.length, pageOldest);
        if (!gotNew || pageOldest <= startTs) break;
        // Move the cursor to the oldest timestamp seen (inclusive; dedup handles overlap).
        if (pageOldest >= end) end -= 1;
        else end = pageOldest;
        await sleep(150);
    }

    return out.filter((t) => t.timestamp >= startTs).sort((a, b) => a.timestamp - b.timestamp);
};

const downloadClosedPositions = async (wallet: string): Promise<ClosedPosition[]> => {
    const out: ClosedPosition[] = [];
    for (let offset = 0; ; offset += 50) {
        const rows = (await fetchData(
            `${DATA_API}/closed-positions?user=${wallet}&limit=50&offset=${offset}`
        )) as ClosedPosition[];
        if (!Array.isArray(rows) || rows.length === 0) break;
        out.push(...rows);
        if (rows.length < 50) break;
        await sleep(100);
    }
    return out;
};

const downloadOpenPositions = async (wallet: string): Promise<OpenPosition[]> => {
    const out: OpenPosition[] = [];
    for (let offset = 0; ; offset += 500) {
        const rows = (await fetchData(
            `${DATA_API}/positions?user=${wallet}&limit=500&offset=${offset}&sizeThreshold=0`
        )) as OpenPosition[];
        if (!Array.isArray(rows) || rows.length === 0) break;
        out.push(...rows);
        if (rows.length < 500) break;
        await sleep(100);
    }
    return out;
};

const main = async () => {
    const target = process.argv[2] || '@coinman2';
    const days = Number(arg('--days', '365'));
    const [resolved] = await resolvePolymarketWatchlist({
        watchlist: target,
        socksProxyUrl: ENV.SOCKS_PROXY_URL,
    });
    if (!resolved) throw new Error(`could not resolve ${target}`);

    const name = (resolved.name || resolved.address).replace(/[^a-z0-9_-]/gi, '_');
    const dir = path.join(process.cwd(), 'trader-analysis-data', name);
    fs.mkdirSync(dir, { recursive: true });

    // Anonymous wallets have no public profile (404); don't let that stop the download.
    const profile = await fetchData(
        `https://gamma-api.polymarket.com/public-profile?address=${resolved.address}`
    ).catch(() => ({ proxyWallet: resolved.address }));
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile, null, 2));
    console.log(`Trader: ${resolved.name} ${resolved.address} → ${dir}`);

    const startTs = Math.floor(Date.now() / 1000) - days * 86400;
    let lastLog = 0;
    const trades = await downloadTrades(resolved.address, startTs, (n, oldest) => {
        if (Date.now() - lastLog > 3000) {
            lastLog = Date.now();
            console.log(`  trades: ${n}  oldest: ${new Date(oldest * 1000).toISOString().slice(0, 10)}`);
        }
    });
    fs.writeFileSync(path.join(dir, 'trades.json'), JSON.stringify(trades));
    console.log(`Saved ${trades.length} trades (${days}d)`);

    const closed = await downloadClosedPositions(resolved.address);
    fs.writeFileSync(path.join(dir, 'closed-positions.json'), JSON.stringify(closed));
    console.log(`Saved ${closed.length} closed positions`);

    const open = await downloadOpenPositions(resolved.address);
    fs.writeFileSync(path.join(dir, 'positions.json'), JSON.stringify(open));
    console.log(`Saved ${open.length} open positions`);
};

if (require.main === module) {
    main().catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
}
