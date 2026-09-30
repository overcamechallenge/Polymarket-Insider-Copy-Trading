/**
 * Analyze a downloaded trader history and write a markdown report.
 *
 *   npm run trader:analyze -- coinman2
 *
 * Output: trader-analysis-data/<name>/report.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyMarket } from '../strike-copy/strategy';
import { buildResolutionMap, loadTraderDataset } from './resolution';

type Agg = { n: number; usd: number; pnl: number; wins: number };
const newAgg = (): Agg => ({ n: 0, usd: 0, pnl: 0, wins: 0 });
const fmtUsd = (v: number): string => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

const priceBucket = (p: number): string => {
    const edges = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.01];
    let lo = 0;
    for (const hi of edges) {
        if (p < hi) return `${(lo * 100).toFixed(0)}–${Math.min(hi, 1) * 100}¢`;
        lo = hi;
    }
    return '?';
};
const hoursBucket = (h: number): string => {
    if (h < 0) return 'z after listed end';
    if (h < 1) return 'a <1h';
    if (h < 6) return 'b 1–6h';
    if (h < 24) return 'c 6–24h';
    if (h < 72) return 'd 1–3d';
    if (h < 168) return 'e 3–7d';
    return 'f >7d';
};
const sizeBucket = (u: number): string => {
    if (u < 50) return 'a <$50';
    if (u < 200) return 'b $50–200';
    if (u < 1000) return 'c $200–1k';
    if (u < 5000) return 'd $1k–5k';
    return 'e >$5k';
};

const table = (title: string, m: Map<string, Agg>, note?: string): string[] => {
    const lines = [`### ${title}`, ''];
    if (note) lines.push(note, '');
    lines.push('| Bucket | Fills | Spent | PnL | ROI | Win rate |', '|---|---|---|---|---|---|');
    for (const [k, a] of [...m.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
        lines.push(`| ${k.replace(/^[a-z] /, '')} | ${a.n} | ${fmtUsd(a.usd)} | ${fmtUsd(a.pnl)} | ${pct(a.usd ? a.pnl / a.usd : 0)} | ${pct(a.n ? a.wins / a.n : 0)} |`);
    }
    lines.push('');
    return lines;
};

const main = () => {
    const name = (process.argv[2] || 'coinman2').replace(/^@/, '');
    const ds = loadTraderDataset(name);
    const res = buildResolutionMap(ds);
    const now = Date.now() / 1000;
    const profile = (() => {
        try {
            return JSON.parse(fs.readFileSync(path.join(ds.dir, 'profile.json'), 'utf8')) as Record<string, unknown>;
        } catch {
            return {};
        }
    })();

    const trades = ds.trades;
    const first = trades[0]?.timestamp ?? now;
    const last = trades[trades.length - 1]?.timestamp ?? now;
    const buys = trades.filter((t) => t.side === 'BUY').length;
    const volume = trades.reduce((a, t) => a + t.usdcSize, 0);
    const markets = new Set(trades.map((t) => t.conditionId)).size;
    const events = new Set(trades.map((t) => t.eventSlug)).size;

    type Row = { ts: number; cat: string; price: number; usd: number; pnl: number; won: boolean; endTs: number; ev: string; cond: string };
    const rows: Row[] = [];
    let unresolved = 0;
    for (const t of trades) {
        if (t.side !== 'BUY') continue;
        const r = res.get(t.asset);
        if (!r || r.endTs > now) {
            unresolved += 1;
            continue;
        }
        rows.push({
            ts: t.timestamp,
            cat: classifyMarket(t.slug, t.title),
            price: t.price,
            usd: t.usdcSize,
            pnl: (r.won ? t.size : 0) - t.usdcSize,
            won: r.won,
            endTs: r.endTs,
            ev: t.eventSlug,
            cond: t.conditionId,
        });
    }

    const groupBy = (rs: Row[], key: (r: Row) => string): Map<string, Agg> => {
        const m = new Map<string, Agg>();
        for (const r of rs) {
            const k = key(r);
            const a = m.get(k) || newAgg();
            a.n += 1;
            a.usd += r.usd;
            a.pnl += r.pnl;
            a.wins += r.won ? 1 : 0;
            m.set(k, a);
        }
        return m;
    };

    const totalPnl = rows.reduce((a, r) => a + r.pnl, 0);
    const totalUsd = rows.reduce((a, r) => a + r.usd, 0);
    const byEvent = groupBy(rows, (r) => r.ev);
    const eventsSorted = [...byEvent.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
    const top2 = new Set(eventsSorted.slice(0, 2).map(([k]) => k));
    const base = rows.filter((r) => !top2.has(r.ev));
    const basePnl = base.reduce((a, r) => a + r.pnl, 0);
    const baseUsd = base.reduce((a, r) => a + r.usd, 0);

    // Both-sides / ladder behaviour
    const outcomesPerMarket = new Map<string, Set<string>>();
    for (const t of trades) {
        const s = outcomesPerMarket.get(t.conditionId) || new Set<string>();
        s.add(t.outcome);
        outcomesPerMarket.set(t.conditionId, s);
    }
    const bothSides = [...outcomesPerMarket.values()].filter((s) => s.size > 1).length;
    const marketsPerEvent = new Map<string, Set<string>>();
    for (const t of trades) {
        const s = marketsPerEvent.get(t.eventSlug) || new Set<string>();
        s.add(t.conditionId);
        marketsPerEvent.set(t.eventSlug, s);
    }
    const ladders = [...marketsPerEvent.values()].filter((s) => s.size > 1).length;

    // Activity
    const perDay = new Map<string, number>();
    for (const t of trades) {
        const d = new Date(t.timestamp * 1000).toISOString().slice(0, 10);
        perDay.set(d, (perDay.get(d) || 0) + 1);
    }
    const dayCounts = [...perDay.values()].sort((a, b) => a - b);
    const median = dayCounts[Math.floor(dayCounts.length / 2)] || 0;

    const L: string[] = [];
    L.push(`# Trader analysis — @${name}`);
    L.push('');
    L.push(`Wallet \`${(profile.proxyWallet as string) || ''}\` · joined ${(profile.createdAt as string | undefined)?.slice(0, 10) || '?'} · taker tier ${(profile.takerTierName as string) || '?'} · generated ${new Date().toISOString().slice(0, 16)}Z`);
    L.push('');
    L.push('## Overview');
    L.push('');
    L.push('| | |');
    L.push('|---|---|');
    L.push(`| Period | ${new Date(first * 1000).toISOString().slice(0, 10)} → ${new Date(last * 1000).toISOString().slice(0, 10)} |`);
    L.push(`| Fills | ${trades.length} (${buys} BUY / ${trades.length - buys} SELL) |`);
    L.push(`| Volume | ${fmtUsd(volume)} |`);
    L.push(`| Markets / events | ${markets} / ${events} |`);
    L.push(`| Markets where both outcomes were bought | ${bothSides} (${pct(bothSides / Math.max(markets, 1))}) |`);
    L.push(`| Events traded as multi-strike ladders | ${ladders} |`);
    L.push(`| Active days | ${perDay.size} · median ${median} fills/day |`);
    L.push(`| Resolved BUY fills analysed | ${rows.length} (${unresolved} unresolved/unknown skipped) |`);
    L.push(`| Trade-level PnL (buy → hold to resolution) | **${fmtUsd(totalPnl)}** on ${fmtUsd(totalUsd)} (${pct(totalUsd ? totalPnl / totalUsd : 0)}) |`);
    L.push(`| …excluding top-2 events (${[...top2].join(', ')}) | ${fmtUsd(basePnl)} on ${fmtUsd(baseUsd)} (${pct(baseUsd ? basePnl / baseUsd : 0)}) |`);
    L.push('');
    L.push(trades.length - buys === 0 ? '**The trader never sells** — every position is held to resolution, so a copier only needs to mirror BUYs.' : 'The trader sells occasionally; mirror sells proportionally.');
    L.push('');
    L.push('## Where the PnL comes from');
    L.push('');
    L.push(...table('By market category', groupBy(rows, (r) => r.cat)));
    L.push(...table('By entry price (excluding top-2 events)', groupBy(base, (r) => priceBucket(r.price)), 'Cheap legs carry the edge; 60–90¢ legs lose.'));
    L.push(...table('By entry price — strike markets only (excluding top-2 events)', groupBy(base.filter((r) => r.cat === 'strike'), (r) => priceBucket(r.price))));
    L.push(...table('By hours-to-resolution at entry (excluding top-2 events)', groupBy(base, (r) => hoursBucket((r.endTs - r.ts) / 3600))));
    L.push(...table('By fill size (excluding top-2 events)', groupBy(base, (r) => sizeBucket(r.usd))));
    L.push(...table('By month (entry month, all events)', groupBy(rows, (r) => new Date(r.ts * 1000).toISOString().slice(0, 7))));
    L.push('### Cheap strike legs (<40¢, ≥6h to resolution) by month');
    L.push('');
    L.push('| Month | Fills | Spent | PnL | ROI | Win rate |', '|---|---|---|---|---|---|');
    const cheap = base.filter((r) => r.cat === 'strike' && r.price < 0.4 && (r.endTs - r.ts) / 3600 >= 6);
    for (const [k, a] of [...groupBy(cheap, (r) => new Date(r.ts * 1000).toISOString().slice(0, 7)).entries()].sort()) {
        L.push(`| ${k} | ${a.n} | ${fmtUsd(a.usd)} | ${fmtUsd(a.pnl)} | ${pct(a.usd ? a.pnl / a.usd : 0)} | ${pct(a.wins / a.n)} |`);
    }
    L.push('');
    L.push('## Concentration');
    L.push('');
    L.push('| Event | Spent | PnL |', '|---|---|---|');
    for (const [k, a] of eventsSorted.slice(0, 8)) L.push(`| ${k} | ${fmtUsd(a.usd)} | ${fmtUsd(a.pnl)} |`);
    L.push('| … | | |');
    for (const [k, a] of eventsSorted.slice(-8)) L.push(`| ${k} | ${fmtUsd(a.usd)} | ${fmtUsd(a.pnl)} |`);
    L.push('');
    L.push('## Copy-trading implications');
    L.push('');
    L.push('1. Mirror **BUYs only** and hold to resolution — no sell logic is needed, but winning tokens must be redeemed.');
    L.push('2. Copy only **crypto price-strike markets** (above/below/between/dip/reach); skip daily and 5m/15m Up-or-Down.');
    L.push('3. Copy only fills **below ~40¢** and **≥6h before resolution**. Skip the 60–90¢ hedging legs entirely.');
    L.push('4. **Aggregate** the trader\'s many tiny fills per token until your scaled share reaches $1; never floor each fill to the $1 minimum (that over-weights lottery tickets ~5×).');
    L.push('5. Cap exposure **relative to equity** (≈1.5% per order, ≈3% per token). Win rate is ~20–30%; single months swing from −45% to +120%.');
    L.push('6. Expect ~1–3% taker fee drag on cheap tokens (fee ≈ 5% × (1 − price)).');
    L.push('');
    L.push('See `backtest-30d.md` for the simulated copy result with these rules.');

    const out = path.join(ds.dir, 'report.md');
    fs.writeFileSync(out, L.join('\n'));
    console.log(L.join('\n'));
    console.log(`\nSaved ${out}`);
};

if (require.main === module) {
    try {
        main();
    } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
}
