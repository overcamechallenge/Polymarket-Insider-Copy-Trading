/**
 * Find wallets worth following: new accounts making large cheap bets on
 * short-dated event markets (not politics / sports / geopolitics).
 *
 * Criteria (env-tunable):
 *   - BUY trade notional >= $1,000
 *   - Entry price <= $0.50
 *   - Account joined within last 14 days
 *   - Market end date within next 30 days
 *   - Market is NOT politics, sports, or geopolitics
 *
 * Run:  npm run find-follow-wallets
 */
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
    gray: '\x1b[90m',
};
const c = {
    cyan: (t: string) => `${colors.cyan}${t}${colors.reset}`,
    green: (t: string) => `${colors.green}${t}${colors.reset}`,
    yellow: (t: string) => `${colors.yellow}${t}${colors.reset}`,
    red: (t: string) => `${colors.red}${t}${colors.reset}`,
    blue: (t: string) => `${colors.blue}${t}${colors.reset}`,
    gray: (t: string) => `${colors.gray}${t}${colors.reset}`,
    bold: (t: string) => `${colors.bold}${t}${colors.reset}`,
};

const num = (key: string, def: number) => {
    const v = process.env[key] ? Number(process.env[key]) : def;
    return Number.isFinite(v) && v > 0 ? v : def;
};

const POLITICS_REGEX =
    /(trump|biden|election|president|senate|congress|governor|nominee|cabinet|supreme court|scotus|fed\b|rate cut|government|parliament|prime minister|referendum|impeach|politic|democrat|republican|gop|dnc|harris|vance|macron|starmer|tariff|sanction|nato|white house|executive order|immigration|deportation|shutdown|debt ceiling|maduro|venezuela leader|regime fall|clarity act)/i;

const GEO_REGEX =
    /(iran|israel|syria|ukraine|russia|gaza|hamas|hezbollah|peace deal|nuclear deal|ceasefire|airspace|military clash|military|invasion|invade|missile|strike|troops|pentagon|hormuz|kharg|bab el-mandeb|diplomatic meeting|enriched uranium|netanyahu|zelensky|putin|khamenei|xi jinping out|taiwan|north korea|kim jong)/i;

const SPORTS_REGEX =
    /(^|[^a-z])(mlb|nba|wnba|nhl|nfl|ncaa|fif|epl|laliga|seriea|bundesliga|ligue|uefa|ucl|mls|ufc|mma|box|atp|wta|tennis|golf|pga|f1|nascar|motogp|cricket|crict|t20|ipl|nrl|afl|rugby|lol|csgo|cs2|dota|valorant|esports|fifwc|world cup|super bowl|stanley cup|march madness|vs\.|spread:|o\/u|total \d|iem |vct |bo3|bo5|knicks|lakers|celtics|spurs|yankees|ohtani|mvp award)([^a-z]|-|$)/i;

const EXCLUDE_SLUG_REGEX = /(up-or-down|up-down|updown|-1[0-9]{6,})/i;

const CONFIG = {
    MIN_TRADE_USD: num('FOLLOW_MIN_TRADE_USD', 1000),
    MAX_ENTRY_PRICE: num('FOLLOW_MAX_ENTRY_PRICE', 0.5),
    JOIN_DAYS: num('FOLLOW_JOIN_DAYS', 14),
    MARKET_END_DAYS: num('FOLLOW_MARKET_END_DAYS', 30),
    SWEEP_MARKETS: num('FOLLOW_SWEEP_MARKETS', 200),
    MIN_MARKET_VOLUME: num('FOLLOW_MIN_MARKET_VOLUME', 20000),
    MAX_TRADES_PER_MARKET: num('FOLLOW_MAX_TRADES_PER_MARKET', 500),
    TOP_N: num('FOLLOW_TOP_N', 30),
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const nowSec = () => Math.floor(Date.now() / 1000);

const parseTs = (raw: unknown): number => {
    if (!raw) return 0;
    const iso = String(raw).includes('T') ? String(raw) : String(raw).replace(' ', 'T');
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

const marketText = (slug: string, title: string) => `${slug} ${title}`.toLowerCase();

const isExcludedMarket = (slug: string, title: string): boolean => {
    const s = marketText(slug, title);
    return (
        POLITICS_REGEX.test(s) ||
        GEO_REGEX.test(s) ||
        SPORTS_REGEX.test(s) ||
        EXCLUDE_SLUG_REGEX.test(slug)
    );
};

interface EligibleMarket {
    conditionId: string;
    slug: string;
    question: string;
    volume: number;
    endDate: string;
    endSec: number;
}

interface CheapTrade {
    question: string;
    slug: string;
    outcome: string;
    price: number;
    usd: number;
    timestamp: number;
    endDate: string;
    endSec: number;
}

interface WalletAgg {
    address: string;
    name: string;
    trades: CheapTrade[];
}

interface ProfileInfo {
    name: string;
    createdAt: string | null;
    createdSec: number;
    joinedWithinWindow: boolean;
    daysSinceJoin: number | null;
}

interface MatchResult {
    address: string;
    name: string;
    joinedAt: string | null;
    daysSinceJoin: number | null;
    maxTradeUsd: number;
    totalCheapLargeUsd: number;
    tradeCount: number;
    topTrades: {
        title: string;
        outcome: string;
        price: number;
        usd: number;
        endDate: string;
        slug: string;
        tradedAt: string;
    }[];
    activePositions: {
        title: string;
        outcome: string;
        avgPrice: number;
        currentValue: number;
        endDate: string;
        slug: string;
    }[];
    profileUrl: string;
}

const profileCache = new Map<string, ProfileInfo>();

const fetchProfile = async (address: string): Promise<ProfileInfo> => {
    const key = address.toLowerCase();
    const cached = profileCache.get(key);
    if (cached) return cached;

    const joinCutoff = nowSec() - CONFIG.JOIN_DAYS * 86400;
    try {
        const res = await axios.get(
            `https://gamma-api.polymarket.com/public-profile?address=${key}`,
            { timeout: 12000, headers: { 'User-Agent': UA } }
        );
        const createdAt = res.data?.createdAt ? String(res.data.createdAt) : null;
        const createdSec = createdAt ? parseTs(createdAt) : 0;
        const info: ProfileInfo = {
            name: res.data?.name || res.data?.pseudonym || '',
            createdAt,
            createdSec,
            joinedWithinWindow: createdSec >= joinCutoff,
            daysSinceJoin: createdSec ? Math.floor((nowSec() - createdSec) / 86400) : null,
        };
        profileCache.set(key, info);
        return info;
    } catch {
        const info: ProfileInfo = {
            name: '',
            createdAt: null,
            createdSec: 0,
            joinedWithinWindow: false,
            daysSinceJoin: null,
        };
        profileCache.set(key, info);
        return info;
    }
};

const fetchEligibleMarkets = async (): Promise<EligibleMarket[]> => {
    const out: EligibleMarket[] = [];
    const endCutoff = nowSec() + CONFIG.MARKET_END_DAYS * 86400;
    let offset = 0;

    console.log(
        c.cyan(
            `\n📡 Collecting open markets (ends ≤ ${CONFIG.MARKET_END_DAYS}d, no politics/sports/geo)...`
        )
    );

    while (out.length < CONFIG.SWEEP_MARKETS && offset < 1200) {
        let batch: any[] = [];
        try {
            const res = await axios.get(
                `https://gamma-api.polymarket.com/markets?closed=false&order=volumeNum&ascending=false&limit=100&offset=${offset}`,
                { timeout: 20000, headers: { 'User-Agent': UA } }
            );
            batch = Array.isArray(res.data) ? res.data : [];
        } catch {
            break;
        }
        if (batch.length === 0) break;
        offset += 100;

        for (const m of batch) {
            const slug = String(m.slug || '');
            const question = String(m.question || '');
            const volume = Number(m.volumeNum ?? m.volume ?? 0);
            if (volume < CONFIG.MIN_MARKET_VOLUME) continue;
            if (isExcludedMarket(slug, question)) continue;

            const endSec = parseTs(m.endDate ?? m.umaEndDate);
            if (!endSec || endSec > endCutoff || endSec < nowSec() - 86400) continue;

            out.push({
                conditionId: String(m.conditionId),
                slug,
                question,
                volume,
                endDate: String(m.endDate ?? m.umaEndDate ?? ''),
                endSec,
            });
            if (out.length >= CONFIG.SWEEP_MARKETS) break;
        }

        process.stdout.write(c.gray(`\r   collected ${out.length}/${CONFIG.SWEEP_MARKETS} markets   `));
        await sleep(80);
    }

    console.log('');
    return out;
};

const fetchMarketTrades = async (conditionId: string): Promise<any[]> => {
    const all: any[] = [];
    let offset = 0;

    while (all.length < CONFIG.MAX_TRADES_PER_MARKET) {
        let batch: any[] = [];
        try {
            const res = await axios.get(
                `https://data-api.polymarket.com/trades?market=${conditionId}&limit=500&offset=${offset}&takerOnly=false`,
                { timeout: 15000, headers: { 'User-Agent': UA } }
            );
            batch = Array.isArray(res.data) ? res.data : [];
        } catch {
            break;
        }
        if (batch.length === 0) break;
        all.push(...batch);
        if (batch.length < 500) break;
        offset += 500;
        await sleep(50);
    }

    return all;
};

const scanMarkets = async (markets: EligibleMarket[]): Promise<Map<string, WalletAgg>> => {
    const wallets = new Map<string, WalletAgg>();

    for (let i = 0; i < markets.length; i++) {
        const market = markets[i];
        const trades = await fetchMarketTrades(market.conditionId);

        for (const t of trades) {
            if (t.side !== 'BUY') continue;
            const price = Number(t.price || 0);
            const usd = Number(t.usdcSize || t.size * t.price || 0);
            if (price <= 0 || price > CONFIG.MAX_ENTRY_PRICE || usd < CONFIG.MIN_TRADE_USD) continue;

            const address = String(t.proxyWallet || '').toLowerCase();
            if (!address) continue;

            let w = wallets.get(address);
            if (!w) {
                w = {
                    address,
                    name: t.pseudonym || t.name || '',
                    trades: [],
                };
                wallets.set(address, w);
            } else if (!w.name && (t.pseudonym || t.name)) {
                w.name = t.pseudonym || t.name;
            }

            w.trades.push({
                question: market.question,
                slug: market.slug,
                outcome: String(t.outcome || ''),
                price,
                usd,
                timestamp: Number(t.timestamp || 0),
                endDate: market.endDate,
                endSec: market.endSec,
            });
        }

        process.stdout.write(
            c.gray(
                `\r   scanned ${i + 1}/${markets.length} markets | ${wallets.size} wallets with ≥$${CONFIG.MIN_TRADE_USD} cheap buys   `
            )
        );
        await sleep(60);
    }

    console.log('');
    return wallets;
};

const fetchActivePositions = async (address: string) => {
    const endCutoff = nowSec() + CONFIG.MARKET_END_DAYS * 86400;
    try {
        const res = await axios.get(
            `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=1&limit=500`,
            { timeout: 15000, headers: { 'User-Agent': UA } }
        );
        return (Array.isArray(res.data) ? res.data : []).filter((p: any) => {
            const title = String(p.title || p.slug || '');
            const slug = String(p.slug || '');
            if (isExcludedMarket(slug, title)) return false;

            const endSec = parseTs(p.endDate);
            if (!endSec || endSec > endCutoff) return false;

            const avg = Number(p.avgPrice || 0);
            const value = Number(p.currentValue || 0);
            const cost = Number(p.size || 0) * avg;
            return (
                avg > 0 &&
                avg <= CONFIG.MAX_ENTRY_PRICE &&
                (value >= CONFIG.MIN_TRADE_USD || cost >= CONFIG.MIN_TRADE_USD) &&
                p.redeemable !== true &&
                Number(p.curPrice) > 0 &&
                Number(p.curPrice) < 1
            );
        });
    } catch {
        return [];
    }
};

const formatTradeTime = (ts: number): string => {
    const ms = ts >= 1e12 ? ts : ts * 1000;
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
};

const buildMatches = async (wallets: Map<string, WalletAgg>): Promise<MatchResult[]> => {
    const matches: MatchResult[] = [];

    for (const w of wallets.values()) {
        const profile = await fetchProfile(w.address);
        if (!profile.joinedWithinWindow) continue;

        const positions = await fetchActivePositions(w.address);
        const maxTradeUsd = Math.max(...w.trades.map((t) => t.usd));
        const totalCheapLargeUsd = w.trades.reduce((sum, t) => sum + t.usd, 0);

        matches.push({
            address: w.address,
            name: profile.name || w.name,
            joinedAt: profile.createdAt?.slice(0, 10) ?? null,
            daysSinceJoin: profile.daysSinceJoin,
            maxTradeUsd: Math.round(maxTradeUsd),
            totalCheapLargeUsd: Math.round(totalCheapLargeUsd),
            tradeCount: w.trades.length,
            topTrades: [...w.trades]
                .sort((a, b) => b.usd - a.usd)
                .slice(0, 5)
                .map((t) => ({
                    title: t.question,
                    outcome: t.outcome,
                    price: +t.price.toFixed(4),
                    usd: Math.round(t.usd),
                    endDate: t.endDate,
                    slug: t.slug,
                    tradedAt: formatTradeTime(t.timestamp),
                })),
            activePositions: positions
                .map((p: any) => ({
                    title: p.title,
                    outcome: p.outcome,
                    avgPrice: p.avgPrice,
                    currentValue: Math.round(Number(p.currentValue || 0)),
                    endDate: p.endDate,
                    slug: p.slug,
                }))
                .sort((a: any, b: any) => b.currentValue - a.currentValue),
            profileUrl: `https://polymarket.com/profile/${w.address}`,
        });

        await sleep(50);
    }

    return matches.sort(
        (a, b) => b.maxTradeUsd - a.maxTradeUsd || b.totalCheapLargeUsd - a.totalCheapLargeUsd
    );
};

const printReport = (matches: MatchResult[]) => {
    console.log('\n' + c.cyan('═'.repeat(110)));
    console.log(c.bold('  🎯  FOLLOW-WALLET SCAN (new accounts, large cheap bets, short-dated event markets)'));
    console.log(c.cyan('═'.repeat(110)));
    console.log(
        c.gray(
            `  min trade $${CONFIG.MIN_TRADE_USD} | max entry $${CONFIG.MAX_ENTRY_PRICE} | joined ≤ ${CONFIG.JOIN_DAYS}d | market end ≤ ${CONFIG.MARKET_END_DAYS}d | exclude politics/sports/geo\n`
        )
    );

    if (matches.length === 0) {
        console.log(c.yellow('  No wallets matched. Try lowering FOLLOW_MIN_TRADE_USD or FOLLOW_JOIN_DAYS.\n'));
        return;
    }

    matches.slice(0, CONFIG.TOP_N).forEach((m, i) => {
        const addr = `${m.address.slice(0, 8)}...${m.address.slice(-6)}`;
        console.log(
            c.cyan('─'.repeat(110)) +
                `\n${c.bold('#' + (i + 1))}  ${c.blue(addr)}  ${c.gray(m.name || '')}` +
                `   joined ${m.joinedAt ?? '?'} (${m.daysSinceJoin ?? '?'}d ago)` +
                `   max $${m.maxTradeUsd}   total $${m.totalCheapLargeUsd}` +
                `\n   ${c.gray(m.profileUrl)}`
        );

        const top = m.topTrades[0];
        if (top) {
            console.log(
                `   top trade: ${top.outcome} @ ${top.price} ($${top.usd}) — ${top.title.slice(0, 70)}`
            );
            console.log(c.gray(`              traded ${top.tradedAt} | ends ${top.endDate}`));
        }

        if (m.activePositions.length > 0) {
            const p = m.activePositions[0];
            console.log(
                c.green(
                    `   active:    ${p.outcome} @ ${Number(p.avgPrice).toFixed(3)} ($${p.currentValue}) — ${String(p.title).slice(0, 70)}`
                )
            );
        }
    });

    console.log(c.cyan('─'.repeat(110)));
    console.log(c.gray(`\n  ${matches.length} wallet(s) matched.\n`));
};

const saveReport = (markets: EligibleMarket[], matches: MatchResult[]) => {
    const dir = path.join(process.cwd(), 'insider_scan_results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `follow_wallets_${stamp}.json`);
    const payload = {
        scanDate: new Date().toISOString(),
        config: CONFIG,
        scannedMarkets: markets.length,
        matches: matches.length,
        wallets: matches,
    };

    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    console.log(c.green(`  💾 Report saved to ${c.blue(file)}\n`));
};

const main = async () => {
    console.log(c.bold(c.cyan('\n╔══════════════════════════════════════════════════════════════╗')));
    console.log(c.bold(c.cyan('║   🎯  Follow-Wallet Scanner                                   ║')));
    console.log(c.bold(c.cyan('╚══════════════════════════════════════════════════════════════╝')));

    const markets = await fetchEligibleMarkets();
    if (markets.length === 0) {
        console.log(c.red('\n❌ No eligible markets found.\n'));
        return;
    }
    console.log(c.green(`✓ ${markets.length} eligible markets\n`));

    const wallets = await scanMarkets(markets);
    console.log(c.green(`✓ ${wallets.size} wallets with ≥$${CONFIG.MIN_TRADE_USD} buys @ ≤$${CONFIG.MAX_ENTRY_PRICE}\n`));

    console.log(c.cyan('🔍 Checking join dates and active positions...\n'));
    const matches = await buildMatches(wallets);

    printReport(matches);
    saveReport(markets, matches);
    console.log(c.bold(c.green('✅ Scan complete.\n')));
};

main().catch((e) => {
    console.error(c.red('\n❌ Scan failed:'), e);
    process.exit(1);
});
