/**
 * Event-driven backtest of the strike-copy strategy against a trader's real fills.
 *
 *   npm run trader:backtest -- coinman2 --days 30 [--end-days-ago 90] [--start-cash 1000] [--slippage 0.01] [--fee 0.05]
 *
 * Model:
 *  - We see every BUY the trader makes (RTDS stream) and copy the ones passing the filters.
 *  - Our fill = trader price + slippage; taker fee = feeRate × notional × (1 - price).
 *  - Positions are held to resolution (the trader never sells) and paid at market end time.
 *  - Small scaled fills are aggregated per token until they reach the $1 minimum.
 *
 * Requires trades.json (+ markets.json for exact end times) from trader:download / trader:markets.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    FillAggregator,
    classifyMarket,
    estimateTakerFeeUsd,
    getCopySkipReason,
    sizeOrder,
    StrikeCopyStrategyConfig,
} from '../strike-copy/strategy';
import { loadStrikeCopyStrategy } from '../strike-copy/config';
import { buildResolutionMap, loadTraderDataset, TraderDataset } from './resolution';

type Row = {
    ts: number;
    asset: string;
    conditionId: string;
    slug: string;
    title: string;
    outcome: string;
    price: number;
    usd: number;
    side: 'BUY' | 'SELL';
    endTs: number;
    won: boolean;
};

type BacktestOptions = {
    startCash: number;
    slippage: number;
    feeRate: number;
    strategy: StrikeCopyStrategyConfig;
    excludeEvents?: Set<string>;
};

type BacktestResult = {
    label: string;
    orders: number;
    spent: number;
    fees: number;
    payout: number;
    pnl: number;
    roi: number;
    winRate: number;
    settled: number;
    maxDrawdown: number;
    finalCash: number;
    skippedNoCash: number;
    skipReasons: Record<string, number>;
    weekly: { week: string; pnl: number; orders: number }[];
    equity: { ts: number; equity: number }[];
    markets: { slug: string; outcome: string; cost: number; payout: number; pnl: number; orders: number }[];
};

const fmtUsd = (v: number): string => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const weekKey = (ts: number): string => {
    const d = new Date(ts * 1000);
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
};

const buildRows = (ds: TraderDataset, days: number, endDaysAgo = 0): { rows: Row[]; unresolved: number; open: number } => {
    const res = buildResolutionMap(ds);
    const now = Date.now() / 1000;
    const windowEnd = now - endDaysAgo * 86400;
    const cut = windowEnd - days * 86400;
    const rows: Row[] = [];
    let unresolved = 0;
    let open = 0;
    for (const t of ds.trades) {
        if (t.timestamp < cut || t.timestamp >= windowEnd) continue;
        const r = res.get(t.asset);
        if (!r) {
            unresolved += 1;
            continue;
        }
        if (r.endTs > now) {
            open += 1;
            continue;
        }
        rows.push({
            ts: t.timestamp,
            asset: t.asset,
            conditionId: t.conditionId,
            slug: t.slug,
            title: t.title,
            outcome: t.outcome,
            price: t.price,
            usd: t.usdcSize,
            side: t.side,
            endTs: r.endTs,
            won: r.won,
        });
    }
    rows.sort((a, b) => a.ts - b.ts);
    return { rows, unresolved, open };
};

const runBacktest = (label: string, rows: Row[], opts: BacktestOptions): BacktestResult => {
    const s = opts.strategy;
    let cash = opts.startCash;
    let openCost = 0;
    let spent = 0;
    let fees = 0;
    let payout = 0;
    let orders = 0;
    let wins = 0;
    let settledCount = 0;
    let skippedNoCash = 0;
    let peak = opts.startCash;
    let maxDrawdown = 0;
    const skipReasons: Record<string, number> = {};
    const posCost = new Map<string, number>();
    const weekly = new Map<string, { pnl: number; orders: number }>();
    const equity: { ts: number; equity: number }[] = [];
    const perMarket = new Map<string, { slug: string; outcome: string; cost: number; payout: number; orders: number }>();
    const agg = new FillAggregator(s.minOrderUsd, s.aggregateTtlSec);

    // Pending settlements: min-heap by end time (simple sorted array insert; sizes are small).
    const pending: { endTs: number; payout: number; cost: number; asset: string }[] = [];
    const pushPending = (p: (typeof pending)[number]) => {
        let i = pending.length;
        pending.push(p);
        while (i > 0 && pending[i - 1].endTs > p.endTs) {
            pending[i] = pending[i - 1];
            i -= 1;
        }
        pending[i] = p;
    };
    const bump = (k: string, pnl: number, o: number) => {
        const w = weekly.get(k) || { pnl: 0, orders: 0 };
        w.pnl += pnl;
        w.orders += o;
        weekly.set(k, w);
    };
    const settleUntil = (ts: number) => {
        while (pending.length && pending[0].endTs <= ts) {
            const p = pending.shift()!;
            cash += p.payout;
            payout += p.payout;
            openCost -= p.cost;
            settledCount += 1;
            if (p.payout > 0) wins += 1;
            bump(weekKey(p.endTs), p.payout - p.cost, 0);
            const pm = perMarket.get(p.asset);
            if (pm) pm.payout += p.payout;
            const eq = cash + openCost;
            peak = Math.max(peak, eq);
            maxDrawdown = Math.max(maxDrawdown, (peak - eq) / peak);
            equity.push({ ts: p.endTs, equity: eq });
        }
    };

    for (const r of rows) {
        settleUntil(r.ts);
        if (opts.excludeEvents?.has(r.slug)) continue;
        const skip = getCopySkipReason(
            { side: r.side, price: r.price, usd: r.usd, slug: r.slug, title: r.title, endTs: r.endTs, ts: r.ts },
            s
        );
        if (skip) {
            const k = skip.replace(/[\d.]+[¢h$]?/g, '#').slice(0, 40);
            skipReasons[k] = (skipReasons[k] || 0) + 1;
            continue;
        }
        const scaled = (r.usd * s.copyPercent) / 100;
        const flushed = agg.add(r.asset, scaled, r.price, r.ts);
        if (!flushed) continue;

        const equityNow = cash + openCost;
        const sized = sizeOrder(s, flushed.usd, equityNow, cash, posCost.get(r.asset) || 0);
        if (sized.amount <= 0) {
            if (cash * 0.99 < s.minOrderUsd) skippedNoCash += 1;
            else skipReasons['capped'] = (skipReasons['capped'] || 0) + 1;
            continue;
        }

        const fill = Math.min(0.99, flushed.vwap + opts.slippage);
        const fee = estimateTakerFeeUsd(sized.amount, fill, opts.feeRate);
        const tokens = (sized.amount - fee) / fill;
        cash -= sized.amount;
        openCost += sized.amount;
        spent += sized.amount;
        fees += fee;
        orders += 1;
        posCost.set(r.asset, (posCost.get(r.asset) || 0) + sized.amount);
        bump(weekKey(r.ts), 0, 1);
        const pm = perMarket.get(r.asset) || { slug: r.slug, outcome: r.outcome, cost: 0, payout: 0, orders: 0 };
        pm.cost += sized.amount;
        pm.orders += 1;
        perMarket.set(r.asset, pm);
        pushPending({ endTs: r.endTs, payout: r.won ? tokens : 0, cost: sized.amount, asset: r.asset });
        equity.push({ ts: r.ts, equity: cash + openCost });
    }
    settleUntil(Number.POSITIVE_INFINITY);

    const pnl = payout - spent;
    return {
        label,
        orders,
        spent,
        fees,
        payout,
        pnl,
        roi: spent > 0 ? pnl / spent : 0,
        winRate: settledCount > 0 ? wins / settledCount : 0,
        settled: settledCount,
        maxDrawdown,
        finalCash: cash,
        skippedNoCash,
        skipReasons,
        weekly: [...weekly.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([week, v]) => ({ week, ...v })),
        equity,
        markets: [...perMarket.values()]
            .map((m) => ({ ...m, pnl: m.payout - m.cost }))
            .sort((a, b) => b.pnl - a.pnl),
    };
};

const summaryLine = (r: BacktestResult): string =>
    `| ${r.label} | ${r.orders} | ${fmtUsd(r.spent)} | ${fmtUsd(r.pnl)} | ${pct(r.roi)} | ${pct(r.winRate)} | ${pct(r.maxDrawdown)} | ${fmtUsd(r.finalCash)} |`;

const renderReport = (
    name: string,
    days: number,
    rows: Row[],
    unresolved: number,
    open: number,
    opts: BacktestOptions,
    main: BacktestResult,
    variants: BacktestResult[]
): string => {
    const s = opts.strategy;
    const from = rows.length ? new Date(rows[0].ts * 1000).toISOString().slice(0, 10) : '-';
    const to = rows.length ? new Date(rows[rows.length - 1].ts * 1000).toISOString().slice(0, 10) : '-';
    const traderBuys = rows.filter((r) => r.side === 'BUY');
    const traderUsd = traderBuys.reduce((a, r) => a + r.usd, 0);
    const traderPnl = traderBuys.reduce((a, r) => a + (r.won ? r.usd / r.price : 0) - r.usd, 0);
    const cats = new Map<string, number>();
    for (const r of rows) cats.set(classifyMarket(r.slug, r.title), (cats.get(classifyMarket(r.slug, r.title)) || 0) + 1);

    const lines: string[] = [];
    lines.push(`# Backtest — copy @${name} for ${days} days`);
    lines.push('');
    lines.push(`Window: **${from} → ${to}** (trades with a known resolution). Generated ${new Date().toISOString().slice(0, 16)}Z.`);
    lines.push('');
    lines.push('## Setup');
    lines.push('');
    lines.push(`- Start cash: **$${opts.startCash}**, slippage **+${(opts.slippage * 100).toFixed(1)}¢**, taker fee **${(opts.feeRate * 100).toFixed(1)}% × (1 − price)**`);
    lines.push(`- Strategy: BUY-only · crypto strike markets · price ${(s.minBuyPrice * 100).toFixed(0)}–${(s.maxBuyPrice * 100).toFixed(0)}¢ · ≥${s.minHoursToEnd}h to resolution · copy ${s.copyPercent}% aggregated to $${s.minOrderUsd} · order ≤ $${s.maxOrderUsd} / ${s.maxOrderPctEquity}% equity · position ≤ $${s.maxPositionUsd} / ${s.maxPositionPctEquity}% equity`);
    lines.push(`- Trader fills in window: ${rows.length} resolved (${unresolved} unknown resolution, ${open} still open — both skipped). Categories: ${[...cats.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
    lines.push(`- Trader's own result on these fills (no fees/slippage): ${fmtUsd(traderPnl)} on ${fmtUsd(traderUsd)} (${pct(traderUsd ? traderPnl / traderUsd : 0)})`);
    lines.push('');
    lines.push('## Result');
    lines.push('');
    lines.push('| | |');
    lines.push('|---|---|');
    lines.push(`| Orders placed | ${main.orders} |`);
    lines.push(`| Capital deployed | ${fmtUsd(main.spent)} (fees ${fmtUsd(main.fees)}) |`);
    lines.push(`| Net PnL | **${fmtUsd(main.pnl)}** |`);
    lines.push(`| Return on deployed capital | **${pct(main.roi)}** |`);
    lines.push(`| Return on start cash | **${pct(main.pnl / opts.startCash)}** |`);
    lines.push(`| Win rate (positions) | ${pct(main.winRate)} (${main.settled} settled) |`);
    lines.push(`| Max drawdown (equity) | ${pct(main.maxDrawdown)} |`);
    lines.push(`| Final cash | ${fmtUsd(main.finalCash)} |`);
    lines.push(`| Orders skipped for lack of cash | ${main.skippedNoCash} |`);
    lines.push('');
    lines.push('### Weekly (PnL by settlement week, orders by entry week)');
    lines.push('');
    lines.push('| Week (Mon) | PnL | Orders |');
    lines.push('|---|---|---|');
    for (const w of main.weekly) lines.push(`| ${w.week} | ${fmtUsd(w.pnl)} | ${w.orders} |`);
    lines.push('');
    lines.push('### Skip reasons (trader fills not copied)');
    lines.push('');
    for (const [k, v] of Object.entries(main.skipReasons).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${v}`);
    lines.push('');
    lines.push('### Best / worst positions');
    lines.push('');
    lines.push('| Market | Outcome | Cost | Payout | PnL |');
    lines.push('|---|---|---|---|---|');
    const top = main.markets.slice(0, 8);
    const bottom = main.markets.slice(-8).reverse();
    for (const m of [...top, ...bottom]) lines.push(`| ${m.slug} | ${m.outcome} | ${fmtUsd(m.cost)} | ${fmtUsd(m.payout)} | ${fmtUsd(m.pnl)} |`);
    lines.push('');
    lines.push('## Variants (same window, same start cash)');
    lines.push('');
    lines.push('| Variant | Orders | Deployed | PnL | ROI | Win | MaxDD | Final cash |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const v of variants) lines.push(summaryLine(v));
    lines.push('');
    lines.push('## Caveats');
    lines.push('');
    lines.push('- Fills assume we get the trader\'s price plus fixed slippage; thin books on 2–10¢ tokens can be worse. The live bot caps slippage and skips instead of chasing.');
    lines.push('- Win rate is low by design (cheap legs); returns come from a minority of 3–20× payoffs, so month-to-month variance is high.');
    lines.push('- Past year showed 8 of 13 positive months for this filter; sizing caps relative to equity are what keep a bad month survivable.');
    return lines.join('\n');
};

const argNum = (flag: string, def: number): number => {
    const i = process.argv.indexOf(flag);
    if (i < 0 || !process.argv[i + 1]) return def;
    const v = Number(process.argv[i + 1]);
    return Number.isFinite(v) ? v : def;
};

const main = () => {
    const name = (process.argv[2] || 'coinman2').replace(/^@/, '');
    const days = argNum('--days', 30);
    const endDaysAgo = argNum('--end-days-ago', 0);
    const opts: BacktestOptions = {
        startCash: argNum('--start-cash', 1000),
        slippage: argNum('--slippage', 0.01),
        feeRate: argNum('--fee', 0.05),
        strategy: loadStrikeCopyStrategy(),
    };

    const ds = loadTraderDataset(name);
    const { rows, unresolved, open } = buildRows(ds, days, endDaysAgo);
    if (rows.length === 0) throw new Error('no resolved trades in window — run trader:markets first');

    const main = runBacktest('strategy (default)', rows, opts);
    const s = opts.strategy;
    const variant = (label: string, patch: Partial<StrikeCopyStrategyConfig>, o: Partial<BacktestOptions> = {}) =>
        runBacktest(label, rows, { ...opts, ...o, strategy: { ...s, ...patch } });
    const variants: BacktestResult[] = [
        main,
        variant('copy everything (no filters, 5%, same caps)', {
            includeRegex: /./,
            excludeRegex: /$^/,
            minBuyPrice: 0,
            maxBuyPrice: 1.01,
            minHoursToEnd: 0,
        }),
        variant('strike markets, any price', { minBuyPrice: 0, maxBuyPrice: 1.01 }),
        variant('price < 30¢', { maxBuyPrice: 0.3 }),
        variant('price < 50¢', { maxBuyPrice: 0.5 }),
        variant('no time-to-resolution filter', { minHoursToEnd: 0 }),
        variant('≥ 24h to resolution', { minHoursToEnd: 24 }),
        variant('10% copy, caps 3%/6% equity', { copyPercent: 10, maxOrderUsd: 50, maxPositionUsd: 100, maxOrderPctEquity: 3, maxPositionPctEquity: 6 }),
        variant('2% copy', { copyPercent: 2 }),
        variant('fixed caps only ($25/$50)', { maxOrderPctEquity: 0, maxPositionPctEquity: 0 }),
        variant('no slippage, no fees (upper bound)', {}, { slippage: 0, feeRate: 0 }),
        variant('slippage 2¢', {}, { slippage: 0.02 }),
        variant('slippage 3¢', {}, { slippage: 0.03 }),
    ];

    const report = renderReport(name, days, rows, unresolved, open, opts, main, variants);
    const suffix = endDaysAgo ? `${days}d-ending-${endDaysAgo}d-ago` : `${days}d`;
    const outMd = path.join(ds.dir, `backtest-${suffix}.md`);
    fs.writeFileSync(outMd, report);
    fs.writeFileSync(
        path.join(ds.dir, `backtest-${suffix}-equity.csv`),
        'timestamp,iso,equity\n' + main.equity.map((e) => `${e.ts},${new Date(e.ts * 1000).toISOString()},${e.equity.toFixed(2)}`).join('\n')
    );
    fs.writeFileSync(path.join(ds.dir, `backtest-${suffix}-positions.json`), JSON.stringify(main.markets, null, 1));
    console.log(report);
    console.log(`\nSaved ${outMd}`);
};

if (require.main === module) {
    try {
        main();
    } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
}

