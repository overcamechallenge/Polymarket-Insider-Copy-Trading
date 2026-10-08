/**
 * Strike Copy — real-time copy of a trader's cheap crypto-strike BUYs.
 *
 *   npm run strike-copy
 *
 * Fully websocket-driven hot path:
 *  - Polymarket RTDS activity stream  → the trader's fills (no polling)
 *  - CLOB market channel              → live order books for tokens we copy
 *  - one signed FAK order at the price cap; fill size read from the response
 * The only HTTP in the copy path is the order POST itself. Market end times come
 * from the slug instantly (gamma refines in the background); SDK tick-size/neg-risk
 * caches are warmed the first time the trader touches a market.
 *
 * Modes: dry-run (default) · paper (STRIKE_COPY_PAPER_TRADING=true) · live (STRIKE_COPY_DRY_RUN=false).
 */
import type { ClobClient } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import { RtdsActivityClient } from '../fifteen-min-copy/ws/rtdsClient';
import type { RtdsActivityTrade } from '../fifteen-min-copy/types';
import { tradeDedupKey } from '../fifteen-min-copy/ws/parseTrade';
import { settleResolvedPaperPositions } from '../lib/paperMarketResolution';
import type { PaperPortfolio } from '../lib/paperPortfolio';
import type { UserPositionInterface } from '../interfaces/User';
import createClobClient from '../utils/createClobClient';
import fetchData from '../utils/fetchData';
import { getSpendableUsdcForBuys } from '../utils/getClobCollateralUsdc';
import Logger from '../utils/logger';
import { configureSocksProxyFromEnv } from '../utils/proxy';
import { formatResolvedWatchlist, resolvePolymarketWatchlist } from '../utils/resolvePolymarketWatchlist';
import { parseSlackMention, sendSlackTradeAlert } from '../utils/slackNotify';
import {
    describeStrategy,
    loadStrikeCopyStrategy,
    STRIKE_COPY_DRY_RUN,
    STRIKE_COPY_EQUITY_REFRESH_MS,
    STRIKE_COPY_MAX_SLIPPAGE,
    STRIKE_COPY_PAPER_TRADING,
    STRIKE_COPY_RUNTIME,
    STRIKE_COPY_SETTLE_INTERVAL_MS,
    STRIKE_COPY_WATCH_LIST,
    STRIKE_COPY_WS_STALE_MS,
    STRIKE_COPY_MAX_SLIPPAGE_PCT,
    STRIKE_COPY_MIRROR_SELLS,
    STRIKE_COPY_SELL_MIN_SHARES,
} from './config';
import { getMinOrderShares, liveMarketBuy, liveMarketSell, warmToken } from './execute';
import { getMarketEndTsOrFetch, prefetchMarketEnd } from './marketInfo';
import { loadPaper, savePaper } from './paperStore';
import { FillAggregator, getCopySkipReason, sizeOrder } from './strategy';
import { ClobMarketWsClient } from './ws/clobMarketWs';

configureSocksProxyFromEnv(ENV.SOCKS_PROXY_URL);

const TAG = 'Strike Copy';
const STRATEGY = loadStrikeCopyStrategy();
const LAG_SAMPLES = 500;

type LiveAccount = { cashUsd: number; positionCostUsd: Map<string, number>; positionShares: Map<string, number>; equityUsd: number; at: number };

export type State = {
    watch: Set<string>;
    clob: ClobClient | null;
    paper: PaperPortfolio | null;
    live: LiveAccount;
    agg: FillAggregator;
    /** Scaled sell shares per token, flushed at the exchange minimum. */
    sellAgg: FillAggregator;
    books: ClobMarketWsClient;
    warmed: Set<string>;
    seen: Set<string>;
    seenOrder: string[];
    queue: Promise<void>;
    lagMs: number[];
    localMs: number[];
    slipBps: number[];
    stats: { stream: number; wallet: number; skipped: number; aggregated: number; orders: number; sells: number; failed: number; reconnects: number };
};

const mode = () => (STRIKE_COPY_PAPER_TRADING ? 'PAPER' : STRIKE_COPY_DRY_RUN ? 'DRY' : 'LIVE');
const tradeTsSec = (t: RtdsActivityTrade): number => (t.timestamp >= 1e12 ? Math.floor(t.timestamp / 1000) : t.timestamp);
const push = (arr: number[], v: number) => {
    if (!Number.isFinite(v)) return;
    arr.push(v);
    if (arr.length > LAG_SAMPLES) arr.shift();
};
const pct = (arr: number[], p: number): number => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const remember = (s: State, k: string): boolean => {
    if (s.seen.has(k)) return false;
    s.seen.add(k);
    s.seenOrder.push(k);
    if (s.seenOrder.length > 5000) {
        const old = s.seenOrder.shift();
        if (old) s.seen.delete(old);
    }
    return true;
};

/** Background: subscribe the token's book and warm SDK caches. Never awaited on the hot path. */
const prepareToken = (s: State, t: RtdsActivityTrade): void => {
    s.books.subscribe(t.asset);
    if (t.conditionId) void prefetchMarketEnd(t.conditionId);
    if (s.clob && !s.warmed.has(t.asset)) {
        s.warmed.add(t.asset);
        warmToken(s.clob, t.asset, t.conditionId || undefined).catch(() => s.warmed.delete(t.asset));
    }
};

/** Periodic reconcile of cash/positions from the exchange (not on the hot path). */
const refreshLiveAccount = async (s: State): Promise<void> => {
    const wallet = STRIKE_COPY_RUNTIME.proxyWallet;
    if (!wallet) return;
    try {
        const positions = (await fetchData(`https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=0`)) as UserPositionInterface[];
        const cost = new Map<string, number>();
        const shares = new Map<string, number>();
        let value = 0;
        for (const p of Array.isArray(positions) ? positions : []) {
            const c = p.initialValue ?? p.size * p.avgPrice;
            cost.set(p.asset, c);
            shares.set(p.asset, p.size);
            value += p.currentValue ?? c;
        }
        let cash = s.live.cashUsd;
        if (s.clob) cash = await getSpendableUsdcForBuys(s.clob, wallet);
        s.live = { cashUsd: cash, positionCostUsd: cost, positionShares: shares, equityUsd: cash + value, at: Date.now() };
    } catch (e) {
        Logger.warning(`[${TAG}] account refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
};

const accountView = (s: State, asset: string): { cash: number; equity: number; posCost: number } => {
    if (s.paper) {
        const cash = s.paper.getCashUsd();
        const open = s.paper.getOpenPositions().reduce((a, p) => a + p.costUsd, 0);
        return { cash, equity: cash + open, posCost: s.paper.getPosition(asset)?.costUsd ?? 0 };
    }
    if (STRIKE_COPY_DRY_RUN || !s.clob) {
        const equity = s.live.equityUsd || 1000;
        return { cash: s.live.cashUsd || equity, equity, posCost: s.live.positionCostUsd.get(asset) ?? 0 };
    }
    return { cash: s.live.cashUsd, equity: s.live.equityUsd, posCost: s.live.positionCostUsd.get(asset) ?? 0 };
};

/** Shares of a token we hold right now (paper or live-tracked). */
const heldShares = (s: State, asset: string): number => {
    if (s.paper) return s.paper.getPosition(asset)?.tokens ?? 0;
    return s.live.positionShares.get(asset) ?? 0;
};

/**
 * Mirror a trader SELL: sell copyPercent of the shares they sold, aggregated per
 * token until the exchange minimum, never more than we hold. Price floor is the
 * trader's price minus the slippage cap.
 */
const handleSell = async (s: State, t: RtdsActivityTrade, label: string): Promise<void> => {
    const hay = `${t.slug} ${t.title || ''}`;
    if (STRATEGY.excludeRegex.test(hay) || !STRATEGY.includeRegex.test(hay)) {
        s.stats.skipped += 1;
        return;
    }
    const held = heldShares(s, t.asset);
    if (held <= 0) {
        s.stats.skipped += 1;
        Logger.info(`[${TAG}] skip SELL ${t.size.toFixed(0)} sh @ ${(t.price * 100).toFixed(1)}¢ ${label} — we hold none`);
        return;
    }
    const scaled = (t.size * STRATEGY.copyPercent) / 100;
    const flushed = s.sellAgg.add(t.asset, scaled, t.price, Math.floor(Date.now() / 1000));
    if (!flushed) {
        s.stats.aggregated += 1;
        Logger.info(`[${TAG}] +${scaled.toFixed(2)} sh → sell bucket ${s.sellAgg.pending(t.asset).toFixed(2)} sh (${t.outcome} @ ${(t.price * 100).toFixed(1)}¢) ${label}`);
        return;
    }
    const minShares = Math.max(STRIKE_COPY_SELL_MIN_SHARES, getMinOrderShares(t.asset));
    // If the remainder after this sell would be unsellable dust, sell it all.
    let shares = Math.min(flushed.usd, held);
    if (held - shares < minShares) shares = held;
    if (shares < minShares) {
        s.stats.skipped += 1;
        Logger.warning(`[${TAG}] skip SELL ${label} — ${shares.toFixed(2)} sh below exchange minimum ${minShares}`);
        return;
    }
    const slipAllowed = Math.max(STRIKE_COPY_MAX_SLIPPAGE, (flushed.vwap * STRIKE_COPY_MAX_SLIPPAGE_PCT) / 100);
    const minPrice = Math.max(0.01, flushed.vwap - slipAllowed);
    const top = s.books.getTop(t.asset);
    if (top?.bestBid != null && top.bestBid < minPrice) {
        s.stats.skipped += 1;
        Logger.warning(`[${TAG}] skip SELL ${label} — best bid ${(top.bestBid * 100).toFixed(1)}¢ < floor ${(minPrice * 100).toFixed(1)}¢`);
        return;
    }

    Logger.trade(t.proxyWallet, 'SELL', { asset: t.asset, side: 'SELL', amount: t.usd, price: t.price, eventSlug: t.eventSlug || t.slug, outcome: t.outcome, title: label });
    let ok = false;
    let msg = '';
    if (s.paper) {
        const px = top?.bestBid != null ? Math.max(top.bestBid, minPrice) : Math.max(0.01, flushed.vwap - 0.01);
        const r = s.paper.paperSellTokens({ asset: t.asset, conditionId: t.conditionId, slug: t.slug, outcome: t.outcome, price: px, tokens: shares });
        ok = r.ok;
        msg = r.ok ? `PAPER SELL ${r.fill.tokens.toFixed(2)} sh @ ${(r.fill.price * 100).toFixed(1)}¢ → $${r.fill.usdcAmount.toFixed(2)} (trader sold ${t.size.toFixed(0)} sh, we held ${held.toFixed(2)})` : `paper sell failed: ${r.reason}`;
        savePaper(s.paper);
    } else if (STRIKE_COPY_DRY_RUN || !s.clob) {
        ok = true;
        msg = `[DRY RUN] SELL ${shares.toFixed(2)} sh ≥ ${(minPrice * 100).toFixed(1)}¢ (trader sold ${t.size.toFixed(0)} sh, we held ${held.toFixed(2)})`;
    } else {
        const r = await liveMarketSell(s.clob, t.asset, shares, minPrice).catch((e) => ({ ok: false, soldShares: 0, receivedUsd: 0, avgPrice: 0, message: `exception: ${e instanceof Error ? e.message : String(e)}` }));
        ok = r.ok;
        msg = r.ok ? `SELL ${r.soldShares.toFixed(2)} of ${shares.toFixed(2)} sh @ ${(r.avgPrice * 100).toFixed(1)}¢ → $${r.receivedUsd.toFixed(2)} (${r.message})` : `sell failed — ${r.message}`;
        if (r.ok) {
            s.live.cashUsd += r.receivedUsd;
            const left = Math.max(0, held - r.soldShares);
            s.live.positionShares.set(t.asset, left);
            const cost = s.live.positionCostUsd.get(t.asset) ?? 0;
            s.live.positionCostUsd.set(t.asset, held > 0 ? cost * (left / held) : 0);
        }
    }
    if (ok) {
        s.stats.sells += 1;
        Logger.success(`[${TAG}] ${msg} — ${t.outcome} ${label}`);
    } else {
        s.stats.failed += 1;
        Logger.warning(`[${TAG}] ${msg} — ${label}`);
    }
};

export const handleTrade = async (s: State, t: RtdsActivityTrade): Promise<void> => {
    if (!s.watch.has(t.proxyWallet)) return;
    s.stats.wallet += 1;
    if (!remember(s, tradeDedupKey(t))) return;

    const label = t.slug || t.title || t.asset;
    if (t.side === 'SELL' && STRIKE_COPY_MIRROR_SELLS) {
        await handleSell(s, t, label);
        return;
    }
    if (STRATEGY.includeRegex.test(`${t.slug} ${t.title || ''}`) && !STRATEGY.excludeRegex.test(`${t.slug} ${t.title || ''}`)) prepareToken(s, t);

    const endTs = t.side === 'BUY' && t.conditionId ? await getMarketEndTsOrFetch(t.conditionId, t.slug) : null;
    const skip = getCopySkipReason(
        { side: t.side, price: t.price, usd: t.usd, slug: t.slug, title: t.title, endTs, ts: tradeTsSec(t) },
        STRATEGY
    );
    if (skip) {
        s.stats.skipped += 1;
        Logger.info(`[${TAG}] skip ${t.side} $${t.usd.toFixed(2)} @ ${(t.price * 100).toFixed(1)}¢ ${label} — ${skip}`);
        return;
    }

    const scaled = (t.usd * STRATEGY.copyPercent) / 100;
    const flushed = s.agg.add(t.asset, scaled, t.price, Math.floor(Date.now() / 1000));
    if (!flushed) {
        s.stats.aggregated += 1;
        Logger.info(`[${TAG}] +$${scaled.toFixed(2)} → bucket $${s.agg.pending(t.asset).toFixed(2)} (${t.outcome} @ ${(t.price * 100).toFixed(1)}¢) ${label}`);
        return;
    }

    const acct = accountView(s, t.asset);
    const sized = sizeOrder(STRATEGY, flushed.usd, acct.equity, acct.cash, acct.posCost);
    if (sized.amount <= 0) {
        s.stats.skipped += 1;
        Logger.warning(`[${TAG}] skip buy ${label} — ${sized.reason}`);
        return;
    }

    const slipAllowed = Math.max(STRIKE_COPY_MAX_SLIPPAGE, (flushed.vwap * STRIKE_COPY_MAX_SLIPPAGE_PCT) / 100);
    const maxPrice = Math.min(STRATEGY.maxBuyPrice, flushed.vwap + slipAllowed);
    const top = s.books.getTop(t.asset);
    const bookNote = top?.bestAsk != null ? ` book ${(top.bestAsk * 100).toFixed(1)}¢` : ' book n/a';

    // Pre-check from the streamed book: if nothing is offered at/below the cap, don't waste an order.
    if (top?.bestAsk != null && top.bestAsk > maxPrice) {
        s.stats.skipped += 1;
        Logger.warning(`[${TAG}] skip buy ${label} — best ask ${(top.bestAsk * 100).toFixed(1)}¢ > cap ${(maxPrice * 100).toFixed(1)}¢`);
        return;
    }

    Logger.trade(t.proxyWallet, 'BUY', { asset: t.asset, side: 'BUY', amount: t.usd, price: t.price, eventSlug: t.eventSlug || t.slug, outcome: t.outcome, title: label });

    let ok = false;
    let msg = '';
    let fillPrice = 0;
    if (s.paper) {
        // Paper fills walk the live streamed book (real slippage); fall back to trader price + 1¢.
        const sim = s.books.simulateBuy(t.asset, sized.amount, maxPrice);
        const usd = sim ? sim.fillUsd : sized.amount;
        fillPrice = sim && sim.fillUsd > 0 ? sim.vwap : Math.min(0.99, flushed.vwap + 0.01);
        if (usd < STRATEGY.minOrderUsd) {
            msg = `paper: only $${usd.toFixed(2)} available ≤ ${(maxPrice * 100).toFixed(1)}¢`;
        } else {
            const r = s.paper.paperBuy({ asset: t.asset, conditionId: t.conditionId, slug: t.slug, outcome: t.outcome, price: fillPrice, usdcAmount: usd });
            ok = r.ok;
            msg = r.ok ? `PAPER BUY $${r.fill.usdcAmount.toFixed(2)} @ ${(r.fill.price * 100).toFixed(1)}¢${sim ? ' (live book)' : ''} — ${flushed.fills} fills, ${sized.reason}` : `paper buy failed: ${r.reason}`;
            savePaper(s.paper);
        }
    } else if (STRIKE_COPY_DRY_RUN || !s.clob) {
        ok = true;
        fillPrice = top?.bestAsk ?? flushed.vwap;
        msg = `[DRY RUN] BUY $${sized.amount.toFixed(2)} ≤ ${(maxPrice * 100).toFixed(1)}¢${bookNote} — ${flushed.fills} fills, ${sized.reason}`;
    } else {
        const r = await liveMarketBuy(s.clob, t.asset, sized.amount, maxPrice).catch((e) => ({
            ok: false,
            filledUsd: 0,
            tokens: 0,
            avgPrice: 0,
            message: `exception: ${e instanceof Error ? e.message : String(e)}`,
        }));
        ok = r.ok;
        fillPrice = r.avgPrice;
        msg = r.ok
            ? `BUY $${r.filledUsd.toFixed(2)} of $${sized.amount.toFixed(2)} @ ${(r.avgPrice * 100).toFixed(1)}¢ (${r.message})`
            : `buy failed — ${r.message}`;
        if (r.ok) {
            s.live.cashUsd -= r.filledUsd;
            s.live.positionCostUsd.set(t.asset, (s.live.positionCostUsd.get(t.asset) ?? 0) + r.filledUsd);
            s.live.positionShares.set(t.asset, (s.live.positionShares.get(t.asset) ?? 0) + r.tokens);
        }
    }

    const done = Date.now();
    push(s.localMs, done - t.receivedAt);
    push(s.lagMs, done - tradeTsSec(t) * 1000);
    if (ok && fillPrice > 0) push(s.slipBps, ((fillPrice - flushed.vwap) / flushed.vwap) * 10_000);

    if (ok) {
        s.stats.orders += 1;
        Logger.success(`[${TAG}] ${msg} — ${t.outcome} ${label} (lag ${((done - tradeTsSec(t) * 1000) / 1000).toFixed(1)}s, local ${done - t.receivedAt}ms)`);
        const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
        if (webhook) {
            void sendSlackTradeAlert(
                webhook,
                { wallet: t.proxyWallet, name: t.name || t.pseudonym, side: 'BUY', title: label, outcome: t.outcome, price: t.price, size: t.size, usdSize: t.usd, slug: t.slug, eventSlug: t.eventSlug, txHash: t.transactionHash || undefined, timestamp: t.timestamp, label: `${TAG} (${mode()})` },
                { mention: parseSlackMention(process.env.SLACK_MENTION) }
            ).catch(() => undefined);
        }
    } else {
        s.stats.failed += 1;
        Logger.warning(`[${TAG}] ${msg} — ${label}`);
    }
};

export const createState = (watchAddresses: string[]): State => ({
    watch: new Set(watchAddresses.map((a) => a.toLowerCase())),
    clob: null,
    paper: null,
    live: { cashUsd: 0, positionCostUsd: new Map(), positionShares: new Map(), equityUsd: 0, at: 0 },
    agg: new FillAggregator(STRATEGY.minOrderUsd, STRATEGY.aggregateTtlSec),
    sellAgg: new FillAggregator(STRIKE_COPY_SELL_MIN_SHARES, STRATEGY.aggregateTtlSec),
    books: new ClobMarketWsClient({ socksProxyUrl: ENV.SOCKS_PROXY_URL, label: `${TAG} books` }),
    warmed: new Set(),
    seen: new Set(),
    seenOrder: [],
    queue: Promise.resolve(),
    lagMs: [],
    localMs: [],
    slipBps: [],
    stats: { stream: 0, wallet: 0, skipped: 0, aggregated: 0, orders: 0, sells: 0, failed: 0, reconnects: 0 },
});

export const main = async (): Promise<void> => {
    Logger.header('Strike Copy — cheap crypto-strike legs (WebSocket)');
    const targets = await resolvePolymarketWatchlist({ watchlist: STRIKE_COPY_WATCH_LIST, socksProxyUrl: STRIKE_COPY_RUNTIME.socksProxyUrl, requestTimeoutMs: STRIKE_COPY_RUNTIME.requestTimeoutMs });
    if (targets.length === 0) throw new Error('STRIKE_COPY_WATCH_LIST resolved to no wallets');
    Logger.success(`[${TAG}] Watching: ${formatResolvedWatchlist(targets)}`);

    const s = createState(targets.map((t) => t.address));

    if (STRIKE_COPY_PAPER_TRADING) {
        s.paper = loadPaper();
        Logger.info(`[${TAG}] Mode: PAPER — cash $${s.paper.getCashUsd().toFixed(2)}, ${s.paper.getOpenPositions().length} open positions (fills priced from live books)`);
        for (const p of s.paper.getOpenPositions()) s.books.subscribe(p.asset);
    } else if (STRIKE_COPY_DRY_RUN) {
        Logger.info(`[${TAG}] Mode: DRY RUN — logs only`);
        await refreshLiveAccount(s);
    } else {
        Logger.info(`[${TAG}] Mode: LIVE — single FAK order per copy, price-capped`);
        s.clob = await createClobClient();
        await refreshLiveAccount(s);
        Logger.success(`[${TAG}] CLOB ready — cash $${s.live.cashUsd.toFixed(2)}, equity $${s.live.equityUsd.toFixed(2)}`);
    }
    Logger.info(`[${TAG}] ${describeStrategy(STRATEGY)} · slippage cap ${(STRIKE_COPY_MAX_SLIPPAGE * 100).toFixed(0)}¢`);
    Logger.separator();

    s.books.start();
    const client = new RtdsActivityClient({
        label: TAG,
        staleMs: STRIKE_COPY_WS_STALE_MS,
        socksProxyUrl: ENV.SOCKS_PROXY_URL,
        walletFilter: s.watch,
        onActivity: () => {
            s.stats.stream += 1;
        },
        onTrade: (t) => {
            s.queue = s.queue.then(() => handleTrade(s, t)).catch((e) => Logger.error(`[${TAG}] ${e instanceof Error ? e.message : String(e)}`));
        },
        onClose: () => {
            s.stats.reconnects += 1;
        },
    });
    client.start();

    const timers: NodeJS.Timeout[] = [];
    timers.push(
        setInterval(() => {
            const st = s.stats;
            const acct = accountView(s, '');
            const speed = s.lagMs.length
                ? ` | lag p50 ${(pct(s.lagMs, 50) / 1000).toFixed(1)}s p95 ${(pct(s.lagMs, 95) / 1000).toFixed(1)}s · local p50 ${pct(s.localMs, 50)}ms · slip p50 ${(pct(s.slipBps, 50) / 100).toFixed(2)}%`
                : '';
            Logger.info(`[${TAG}] stats — stream:${st.stream} wallet:${st.wallet} skipped:${st.skipped} bucketed:${st.aggregated} orders:${st.orders} sells:${st.sells} failed:${st.failed} reconnects:${st.reconnects} | cash $${acct.cash.toFixed(0)} equity $${acct.equity.toFixed(0)} buckets:${s.agg.size()} books:${s.books.size()}${speed}`);
        }, 60_000)
    );
    if (s.paper) {
        timers.push(
            setInterval(async () => {
                if (!s.paper) return;
                try {
                    const settled = await settleResolvedPaperPositions(s.paper);
                    if (settled.length) {
                        savePaper(s.paper);
                        for (const x of settled) {
                            s.books.unsubscribe(x.asset);
                            Logger.success(`[${TAG}] PAPER SETTLE ${x.won ? 'WIN' : 'LOSS'} ${x.slug} ${x.outcome} pnl $${x.pnlUsd.toFixed(2)} → cash $${x.cashAfter.toFixed(2)}`);
                        }
                    }
                } catch (e) {
                    Logger.warning(`[${TAG}] settle failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }, STRIKE_COPY_SETTLE_INTERVAL_MS)
        );
    } else if (!STRIKE_COPY_DRY_RUN) {
        timers.push(setInterval(() => void refreshLiveAccount(s), STRIKE_COPY_EQUITY_REFRESH_MS));
    }

    const shutdown = () => {
        Logger.info(`[${TAG}] shutting down…`);
        timers.forEach(clearInterval);
        client.stop();
        s.books.stop();
        if (s.paper) savePaper(s.paper);
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
};

if (require.main === module) {
    main().catch((e) => {
        Logger.error(`[${TAG}] fatal: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    });
}
