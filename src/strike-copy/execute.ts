import type { ClobClient } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import { withSilencedSdkConsole } from '../utils/clobSdkSilence';

type LiveBuyResult = { ok: boolean; filledUsd: number; tokens: number; avgPrice: number; message: string };

type OrderResp = { success?: boolean; error?: unknown; errorMsg?: string; status?: string | number; makingAmount?: string; takingAmount?: string };

const describeError = (r: OrderResp | undefined): string => {
    if (!r) return 'empty response';
    if (typeof r.error === 'string') return r.error;
    if (r.error && typeof r.error === 'object') return JSON.stringify(r.error);
    if (r.errorMsg) return r.errorMsg;
    return `rejected (status ${String(r.status ?? '?')})`;
};

const run = <T>(fn: () => Promise<T>) => withSilencedSdkConsole(ENV.CLOB_SDK_SILENCE_ERRORS, fn);

/**
 * Pre-load everything the SDK touches when signing/posting an order so the
 * order path is a single HTTP POST: market info (tick size, neg-risk, fee
 * info, token→condition map), API version, and the market fee rate.
 * Safe to call repeatedly (SDK caches).
 */
export const warmToken = async (clobClient: ClobClient, tokenId: string, conditionId?: string): Promise<void> => {
    if (conditionId) await run(() => clobClient.getClobMarketInfo(conditionId));
    else {
        await run(() => clobClient.getTickSize(tokenId));
        await run(() => clobClient.getNegRisk(tokenId));
    }
    // resolveVersion is private in the SDK typings but cheap to call once; result is cached
    await run(() => (clobClient as unknown as { resolveVersion: () => Promise<unknown> }).resolveVersion()).catch(() => undefined);
    await run(() => clobClient.getFeeRateBps(tokenId)).catch(() => undefined);
};

/**
 * Single FAK BUY at the price cap: the exchange fills whatever is available at
 * or below `maxPrice` and cancels the rest. No order-book fetch, no retry loop —
 * one signed request. Filled size comes back in the response.
 */
export const liveMarketBuy = async (
    clobClient: ClobClient,
    tokenId: string,
    usdAmount: number,
    maxPrice: number
): Promise<LiveBuyResult> => {
    const sdk = await import('@polymarket/clob-client-v2');
    const tickSize = await run(() => clobClient.getTickSize(tokenId)); // cached after warmToken
    const negRisk = await run(() => clobClient.getNegRisk(tokenId));
    const tick = parseFloat(tickSize);
    const price = Math.max(tick, Math.floor(maxPrice / tick) * tick);

    const resp = (await run(() =>
        clobClient.createAndPostMarketOrder(
            { side: sdk.Side.BUY, tokenID: tokenId, amount: usdAmount, price: Number(price.toFixed(4)) },
            { tickSize, negRisk },
            sdk.OrderType.FAK
        )
    )) as OrderResp;

    const filledUsd = parseFloat(resp?.makingAmount ?? '0') || 0;
    const tokens = parseFloat(resp?.takingAmount ?? '0') || 0;
    if (resp?.success !== true) {
        return { ok: false, filledUsd: 0, tokens: 0, avgPrice: 0, message: describeError(resp) };
    }
    if (filledUsd <= 0) {
        return { ok: false, filledUsd: 0, tokens: 0, avgPrice: 0, message: `no fill ≤ ${(price * 100).toFixed(1)}¢ (${resp.status || 'unmatched'})` };
    }
    return {
        ok: true,
        filledUsd,
        tokens,
        avgPrice: tokens > 0 ? filledUsd / tokens : price,
        message: filledUsd + 0.01 < usdAmount ? `partial ${resp.status || ''}`.trim() : `filled ${resp.status || ''}`.trim(),
    };
};
