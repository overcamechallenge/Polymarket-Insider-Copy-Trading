import type { ClobClient } from '@polymarket/clob-client-v2';
import { calculateOrderSize, CopyStrategy, CopyStrategyConfig } from '../../config/copyStrategy';
import { ENV } from '../../config/env';
import { PaperPortfolio } from '../../lib/paperPortfolio';
import { withSilencedSdkConsole } from '../../utils/clobSdkSilence';
import fetchData from '../../utils/fetchData';
import { getSpendableUsdcForBuys } from '../../utils/getClobCollateralUsdc';
import type { UserPositionInterface } from '../../interfaces/User';
import type { CopyTradeResult, RtdsActivityTrade } from '../types';
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

const fetchMyPositions = async (proxyWallet: string): Promise<UserPositionInterface[]> => {
    const data = await fetchData(`https://data-api.polymarket.com/positions?user=${proxyWallet}`);
    return Array.isArray(data) ? data : [];
};

const findMyPosition = (
    positions: UserPositionInterface[],
    asset: string
): UserPositionInterface | undefined => positions.find((p) => p.asset === asset);

/** How many of our tokens to sell when mirroring a whale SELL trade. */
const sellTokenAmount = (
    copyConfig: CopyStrategyConfig,
    traderSize: number,
    traderUsd: number,
    myTokens: number,
    price: number
): number => {
    if (myTokens <= 0) return 0;

    let tokens: number;
    if (copyConfig.strategy === CopyStrategy.FIXED) {
        tokens = price > 0 ? copyConfig.copySize / price : 0;
    } else if (copyConfig.strategy === CopyStrategy.ADAPTIVE) {
        // Mirror PERCENTAGE using copySize as base percent
        tokens = traderSize * (copyConfig.copySize / 100);
    } else {
        tokens = traderSize * (copyConfig.copySize / 100);
    }

    // Optional trade multiplier
    if (copyConfig.tradeMultiplier && copyConfig.tradeMultiplier !== 1) {
        tokens *= copyConfig.tradeMultiplier;
    }

    void traderUsd; // reserved for future tiered sell sizing
    return Math.min(myTokens, Math.max(0, tokens));
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

    return remaining < usdAmount
        ? { ok: true, message: 'partial buy filled' }
        : { ok: false, message: 'buy not filled' };
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

    return remaining < tokenAmount
        ? { ok: true, message: 'partial sell filled' }
        : { ok: false, message: 'sell not filled' };
};

export const executePaperTrade = (
    portfolio: PaperPortfolio,
    trade: RtdsActivityTrade,
    copyConfig: CopyStrategyConfig
): CopyTradeResult => {
    if (trade.side === 'BUY') {
        const priceSkip = getBuyPriceSkipReason(trade.price);
        if (priceSkip) return { ok: false, skipped: true, message: priceSkip };

        const paperPos = portfolio.getPosition(trade.asset);
        const currentPositionValue = paperPos
            ? paperPos.costUsd || paperPos.tokens * paperPos.avgPrice
            : 0;
        const orderCalc = calculateOrderSize(
            copyConfig,
            trade.usd,
            portfolio.getCashUsd(),
            currentPositionValue
        );

        if (orderCalc.finalAmount === 0) {
            return { ok: false, skipped: true, message: `skip buy: ${orderCalc.reasoning}` };
        }

        const result = portfolio.paperBuy({
            asset: trade.asset,
            conditionId: trade.conditionId,
            slug: trade.slug,
            outcome: trade.outcome,
            price: trade.price,
            usdcAmount: orderCalc.finalAmount,
        });

        if (!result.ok) {
            return { ok: false, message: `paper buy failed: ${result.reason}` };
        }

        return {
            ok: true,
            message: `PAPER BUY $${result.fill.usdcAmount.toFixed(2)} @ ${(result.fill.price * 100).toFixed(1)}¢ — ${orderCalc.reasoning}`,
        };
    }

    const paperPos = portfolio.getPosition(trade.asset);
    if (!paperPos || paperPos.tokens <= 0) {
        return { ok: true, skipped: true, message: 'no paper position to sell' };
    }

    const sellTokens = sellTokenAmount(
        copyConfig,
        trade.size,
        trade.usd,
        paperPos.tokens,
        trade.price
    );
    if (sellTokens < MIN_ORDER_SIZE_TOKENS) {
        return { ok: true, skipped: true, message: 'sell size below minimum tokens' };
    }

    const result = portfolio.paperSellTokens({
        asset: trade.asset,
        conditionId: trade.conditionId,
        slug: trade.slug,
        outcome: trade.outcome,
        price: trade.price,
        tokens: sellTokens,
    });

    if (!result.ok) {
        return { ok: false, message: `paper sell failed: ${result.reason}` };
    }

    return {
        ok: true,
        message: `PAPER SELL ${result.fill.tokens.toFixed(2)} tokens @ ${(result.fill.price * 100).toFixed(1)}¢ → $${result.fill.usdcAmount.toFixed(2)}`,
    };
};

export const executeLiveOrDryTrade = async (
    clobClient: ClobClient | null,
    trade: RtdsActivityTrade,
    proxyWallet: string,
    copyConfig: CopyStrategyConfig,
    dryRun: boolean
): Promise<CopyTradeResult> => {
    if (trade.side === 'BUY') {
        const priceSkip = getBuyPriceSkipReason(trade.price);
        if (priceSkip) return { ok: false, skipped: true, message: priceSkip };

        let myBalance = Number.MAX_SAFE_INTEGER;
        let currentPositionValue = 0;

        if (proxyWallet) {
            try {
                const myPositions = await fetchMyPositions(proxyWallet);
                const myPosition = findMyPosition(myPositions, trade.asset);
                currentPositionValue = myPosition
                    ? myPosition.currentValue || myPosition.size * myPosition.avgPrice
                    : 0;
            } catch {
                // assume no exposure
            }
        }

        if (!dryRun && clobClient) {
            try {
                myBalance = await getSpendableUsdcForBuys(clobClient, proxyWallet);
            } catch (e) {
                return {
                    ok: false,
                    message: `balance read failed: ${e instanceof Error ? e.message : String(e)}`,
                };
            }
        }

        const orderCalc = calculateOrderSize(
            copyConfig,
            trade.usd,
            myBalance,
            currentPositionValue
        );

        if (orderCalc.finalAmount === 0) {
            return { ok: false, skipped: true, message: `skip buy: ${orderCalc.reasoning}` };
        }

        if (dryRun || !clobClient) {
            return {
                ok: true,
                message: `[DRY RUN] BUY $${orderCalc.finalAmount.toFixed(2)} @ ${(trade.price * 100).toFixed(1)}¢ — ${orderCalc.reasoning}`,
            };
        }

        const bought = await marketBuy(clobClient, trade.asset, orderCalc.finalAmount);
        return bought.ok
            ? {
                  ok: true,
                  message: `BUY $${orderCalc.finalAmount.toFixed(2)} — ${orderCalc.reasoning}`,
              }
            : { ok: false, message: bought.message };
    }

    // SELL
    let myTokens = 0;
    if (proxyWallet) {
        try {
            const myPositions = await fetchMyPositions(proxyWallet);
            const myPosition = findMyPosition(myPositions, trade.asset);
            myTokens = myPosition?.size || 0;
        } catch {
            myTokens = 0;
        }
    }

    if (myTokens <= 0) {
        if (dryRun || !clobClient) {
            const estimated = sellTokenAmount(
                copyConfig,
                trade.size,
                trade.usd,
                trade.size,
                trade.price
            );
            return {
                ok: true,
                skipped: true,
                message: `[DRY RUN] SELL skip — no local position (would target ~${estimated.toFixed(2)} tokens)`,
            };
        }
        return { ok: true, skipped: true, message: 'no local position to sell' };
    }

    const sellTokens = sellTokenAmount(copyConfig, trade.size, trade.usd, myTokens, trade.price);
    if (sellTokens < MIN_ORDER_SIZE_TOKENS) {
        return { ok: true, skipped: true, message: 'sell size below minimum tokens' };
    }

    if (dryRun || !clobClient) {
        return {
            ok: true,
            message: `[DRY RUN] SELL ${sellTokens.toFixed(2)} tokens @ ${(trade.price * 100).toFixed(1)}¢`,
        };
    }

    const sold = await marketSell(clobClient, trade.asset, sellTokens);
    return sold.ok
        ? { ok: true, message: `SELL ${sellTokens.toFixed(2)} tokens` }
        : { ok: false, message: sold.message };
};
