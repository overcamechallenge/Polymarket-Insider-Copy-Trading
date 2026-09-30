import type { ClobClient } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import { withSilencedSdkConsole } from '../utils/clobSdkSilence';

type LiveBuyResult = { ok: boolean; filledUsd: number; tokens: number; avgPrice: number; message: string };

type OrderResp = { success?: boolean; errorMsg?: string; status?: string; makingAmount?: string; takingAmount?: string };

const run = <T>(fn: () => Promise<T>) => withSilencedSdkConsole(ENV.CLOB_SDK_SILENCE_ERRORS, fn);

/**
 * Pre-load tick size / neg-risk / fee info for a token so that order signing
 * later needs zero HTTP lookups. Safe to call repeatedly (SDK caches).
 */
export const warmToken = async (clobClient: ClobClient, tokenId: string): Promise<void> => {
    await run(() => clobClient.getTickSize(tokenId));
    await run(() => clobClient.getNegRisk(tokenId));
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
        return { ok: false, filledUsd: 0, tokens: 0, avgPrice: 0, message: resp?.errorMsg || resp?.status || 'order rejected' };
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
