import type { ClobClient } from '@polymarket/clob-client-v2';
import { calculateOrderSize, CopyStrategyConfig } from '../../config/copyStrategy';
import fetchData from '../../utils/fetchData';
import { getSpendableUsdcForBuys } from '../../utils/getClobCollateralUsdc';
import Logger from '../../utils/logger';
import { withSilencedSdkConsole } from '../../utils/clobSdkSilence';
import { ENV } from '../../config/env';
import type { PositionChange } from './types';
import type { UserPositionInterface } from '../../interfaces/User';
import { getBuyPriceSkipReason } from './priceFilter';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const MIN_ORDER_SIZE_USD = 1.0;
const MIN_ORDER_SIZE_TOKENS = 1.0;
const CLOB_SDK_SILENCE_ERRORS = ENV.CLOB_SDK_SILENCE_ERRORS;

const runClobSdk = <T>(fn: () => Promise<T>): Promise<T> =>
    withSilencedSdkConsole(CLOB_SDK_SILENCE_ERRORS, fn);

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) return undefined;
    if (typeof response === 'string') return response;
    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;
        if (typeof data.error === 'string') return data.error;
        if (typeof data.errorMsg === 'string') return data.errorMsg;
        if (typeof data.message === 'string') return data.message;
    }
    return undefined;
};

const findMyPosition = (
    positions: UserPositionInterface[],
    asset: string
): UserPositionInterface | undefined => positions.find((p) => p.asset === asset);

export const fetchMyPositions = async (proxyWallet: string): Promise<UserPositionInterface[]> => {
    const data = await fetchData(`https://data-api.polymarket.com/positions?user=${proxyWallet}`);
    return Array.isArray(data) ? data : [];
};

export const executePositionChange = async (
    clobClient: ClobClient,
    change: PositionChange,
    proxyWallet: string,
    copyConfig: CopyStrategyConfig,
    dryRun: boolean
): Promise<{ ok: boolean; message: string }> => {
    const myPositions = await fetchMyPositions(proxyWallet);
    const myPosition = findMyPosition(myPositions, change.asset);

    if (change.type === 'opened' || change.type === 'increased') {
        const priceSkip = getBuyPriceSkipReason(change.curPrice);
        if (priceSkip) {
            return { ok: false, message: priceSkip };
        }

        const traderUsd =
            change.type === 'opened'
                ? change.position?.currentValue ?? change.deltaUsd
                : change.deltaUsd;

        let myBalance = 0;
        try {
            myBalance = await getSpendableUsdcForBuys(clobClient, proxyWallet);
        } catch (e) {
            return {
                ok: false,
                message: `balance read failed: ${e instanceof Error ? e.message : String(e)}`,
            };
        }

        const currentPositionValue = myPosition ? myPosition.size * myPosition.avgPrice : 0;
        const orderCalc = calculateOrderSize(
            copyConfig,
            traderUsd,
            myBalance,
            currentPositionValue
        );

        if (orderCalc.finalAmount === 0) {
            return { ok: false, message: `skip buy: ${orderCalc.reasoning}` };
        }

        if (dryRun) {
            return {
                ok: true,
                message: `[DRY RUN] BUY $${orderCalc.finalAmount.toFixed(2)} — ${orderCalc.reasoning}`,
            };
        }

        const bought = await marketBuy(clobClient, change.asset, orderCalc.finalAmount);
        return bought.ok
            ? { ok: true, message: `BUY $${orderCalc.finalAmount.toFixed(2)} — ${orderCalc.reasoning}` }
            : { ok: false, message: bought.message };
    }

    if (!myPosition || myPosition.size <= 0) {
        return { ok: true, message: 'no local position to sell' };
    }

    let sellTokens = myPosition.size;
    if (change.type === 'decreased' && change.prevSize > 0) {
        const soldPct = Math.abs(change.deltaSize) / change.prevSize;
        sellTokens = myPosition.size * soldPct;
    }

    sellTokens = Math.min(sellTokens, myPosition.size);
    if (sellTokens < MIN_ORDER_SIZE_TOKENS) {
        return { ok: true, message: 'sell size below minimum tokens' };
    }

    if (dryRun) {
        return {
            ok: true,
            message: `[DRY RUN] SELL ${sellTokens.toFixed(2)} tokens (${change.type})`,
        };
    }

    const sold = await marketSell(clobClient, change.asset, sellTokens);
    return sold.ok
        ? { ok: true, message: `SELL ${sellTokens.toFixed(2)} tokens (${change.type})` }
        : { ok: false, message: sold.message };
};

const marketBuy = async (
    clobClient: ClobClient,
    tokenId: string,
    usdAmount: number
): Promise<{ ok: boolean; message: string }> => {
    const sdk = await import('@polymarket/clob-client-v2');
    let remaining = usdAmount;
    let retry = 0;

    while (remaining >= MIN_ORDER_SIZE_USD && retry < RETRY_LIMIT) {
        const orderBook = await runClobSdk(() => clobClient.getOrderBook(tokenId));
        if (!orderBook.asks?.length) {
            return { ok: false, message: 'no asks in order book' };
        }

        const bestAsk = orderBook.asks.reduce((min, ask) =>
            parseFloat(ask.price) < parseFloat(min.price) ? ask : min
        );
        const askPrice = parseFloat(bestAsk.price);
        const priceSkip = getBuyPriceSkipReason(askPrice);
        if (priceSkip) {
            return { ok: false, message: `${priceSkip} (best ask ${(askPrice * 100).toFixed(1)}¢)` };
        }

        const maxOrderSize = parseFloat(bestAsk.size) * askPrice;
        const orderSize = Math.min(remaining, maxOrderSize);

        const resp = await runClobSdk(() =>
            clobClient.createAndPostMarketOrder(
                {
                    side: sdk.Side.BUY,
                    tokenID: tokenId,
                    amount: orderSize,
                    price: askPrice,
                },
                undefined,
                sdk.OrderType.FAK
            )
        );

        if (resp.success === true) {
            remaining -= orderSize;
            retry = 0;
            if (remaining < MIN_ORDER_SIZE_USD) {
                return { ok: true, message: 'buy filled' };
            }
            continue;
        }

        retry += 1;
        const err = extractOrderError(resp);
        if (retry >= RETRY_LIMIT) {
            return { ok: false, message: err || 'buy failed after retries' };
        }
    }

    return remaining < usdAmount ? { ok: true, message: 'partial buy filled' } : { ok: false, message: 'buy not filled' };
};

const marketSell = async (
    clobClient: ClobClient,
    tokenId: string,
    tokenAmount: number
): Promise<{ ok: boolean; message: string }> => {
    const sdk = await import('@polymarket/clob-client-v2');
    let remaining = tokenAmount;
    let retry = 0;

    while (remaining >= MIN_ORDER_SIZE_TOKENS && retry < RETRY_LIMIT) {
        const orderBook = await runClobSdk(() => clobClient.getOrderBook(tokenId));
        if (!orderBook.bids?.length) {
            return { ok: false, message: 'no bids in order book' };
        }

        const bestBid = orderBook.bids.reduce((max, bid) =>
            parseFloat(bid.price) > parseFloat(max.price) ? bid : max
        );
        const bidPrice = parseFloat(bestBid.price);
        const sellAmount = Math.min(remaining, parseFloat(bestBid.size));

        const resp = await runClobSdk(() =>
            clobClient.createAndPostMarketOrder(
                {
                    side: sdk.Side.SELL,
                    tokenID: tokenId,
                    amount: sellAmount,
                    price: bidPrice,
                },
                undefined,
                sdk.OrderType.FAK
            )
        );

        if (resp.success === true) {
            remaining -= sellAmount;
            retry = 0;
            if (remaining < MIN_ORDER_SIZE_TOKENS) {
                return { ok: true, message: 'sell filled' };
            }
            continue;
        }

        retry += 1;
        const err = extractOrderError(resp);
        if (retry >= RETRY_LIMIT) {
            return { ok: false, message: err || 'sell failed after retries' };
        }
    }

    return remaining < tokenAmount ? { ok: true, message: 'partial sell filled' } : { ok: false, message: 'sell not filled' };
};

export const executePositionChanges = async (
    clobClient: ClobClient | null,
    changes: PositionChange[],
    proxyWallet: string,
    copyConfig: CopyStrategyConfig,
    dryRun: boolean
): Promise<{ executed: number; skipped: number; failed: number }> => {
    let executed = 0;
    let skipped = 0;
    let failed = 0;

    for (const change of changes) {
        Logger.info(`[Whale Positions] ${change.type.toUpperCase()} — ${change.title} (${change.outcome})`);

        if (!clobClient && !dryRun) {
            Logger.warning('[Whale Positions] No CLOB client — skipping live execution');
            skipped += 1;
            continue;
        }

        if (dryRun && !clobClient) {
            if (change.type === 'opened' || change.type === 'increased') {
                const priceSkip = getBuyPriceSkipReason(change.curPrice);
                if (priceSkip) {
                    Logger.warning(`[Whale Positions] ${priceSkip} — ${change.title}`);
                    skipped += 1;
                    continue;
                }
            }

            const traderUsd =
                change.type === 'opened' || change.type === 'increased' ? change.deltaUsd : 0;
            Logger.success(
                `[Whale Positions] [DRY RUN] Would ${change.type === 'closed' || change.type === 'decreased' ? 'SELL' : 'BUY'} @ ${(change.curPrice * 100).toFixed(1)}¢ — ~$${traderUsd.toFixed(0)} notional (${change.title})`
            );
            executed += 1;
            continue;
        }

        const result = await executePositionChange(
            clobClient as ClobClient,
            change,
            proxyWallet,
            copyConfig,
            dryRun
        );

        if (result.ok) {
            executed += 1;
            Logger.success(`[Whale Positions] ${result.message}`);
        } else if (result.message.startsWith('skip buy:')) {
            skipped += 1;
            Logger.warning(`[Whale Positions] ${result.message} — ${change.title}`);
        } else {
            failed += 1;
            Logger.warning(`[Whale Positions] ${result.message}`);
        }
    }

    return { executed, skipped, failed };
};
