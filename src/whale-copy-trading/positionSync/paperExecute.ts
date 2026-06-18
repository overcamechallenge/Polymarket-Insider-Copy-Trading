import { calculateOrderSize, CopyStrategyConfig } from '../../config/copyStrategy';
import { PaperPortfolio } from '../../lib/paperPortfolio';
import Logger from '../../utils/logger';
import type { PositionChange } from './types';
import { getBuyPriceSkipReason } from './priceFilter';

export type PaperExecResult = {
    ok: boolean;
    skipped?: boolean;
    message: string;
};

export const executePaperPositionChange = (
    portfolio: PaperPortfolio,
    change: PositionChange,
    copyConfig: CopyStrategyConfig
): PaperExecResult => {
    if (change.type === 'opened' || change.type === 'increased') {
        const priceSkip = getBuyPriceSkipReason(change.curPrice);
        if (priceSkip) {
            return { ok: false, skipped: true, message: priceSkip };
        }

        const traderUsd =
            change.type === 'opened'
                ? change.position?.currentValue ?? change.deltaUsd
                : change.deltaUsd;

        const paperPos = portfolio.getPosition(change.asset);
        const currentPositionValue = paperPos
            ? paperPos.costUsd || paperPos.tokens * paperPos.avgPrice
            : 0;
        const orderCalc = calculateOrderSize(
            copyConfig,
            traderUsd,
            portfolio.getCashUsd(),
            currentPositionValue
        );

        if (orderCalc.finalAmount === 0) {
            return { ok: false, message: `skip buy: ${orderCalc.reasoning}` };
        }

        const result = portfolio.paperBuy({
            asset: change.asset,
            conditionId: change.conditionId,
            slug: change.slug,
            outcome: change.outcome,
            price: change.curPrice,
            usdcAmount: orderCalc.finalAmount,
        });

        if (!result.ok) {
            return { ok: false, message: `paper buy failed: ${result.reason}` };
        }

        return {
            ok: true,
            message: `PAPER BUY $${result.fill.usdcAmount.toFixed(2)} @ ${(result.fill.price * 100).toFixed(1)}¢ → cash $${result.fill.cashAfter.toFixed(2)} (${orderCalc.reasoning})`,
        };
    }

    const paperPos = portfolio.getPosition(change.asset);
    if (!paperPos || paperPos.tokens <= 0) {
        return { ok: true, skipped: true, message: 'no paper position to sell' };
    }

    let sellTokens = paperPos.tokens;
    if (change.type === 'decreased' && change.prevSize > 0) {
        const soldPct = Math.abs(change.deltaSize) / change.prevSize;
        sellTokens = paperPos.tokens * soldPct;
    }

    const result = portfolio.paperSellTokens({
        asset: change.asset,
        conditionId: change.conditionId,
        slug: change.slug,
        outcome: change.outcome,
        price: change.curPrice,
        tokens: sellTokens,
    });

    if (!result.ok) {
        return { ok: false, message: `paper sell failed: ${result.reason}` };
    }

    return {
        ok: true,
        message: `PAPER SELL ${result.fill.tokens.toFixed(2)} tokens @ ${(result.fill.price * 100).toFixed(1)}¢ → $${result.fill.usdcAmount.toFixed(2)} → cash $${result.fill.cashAfter.toFixed(2)} (${change.type})`,
    };
};

export const executePaperPositionChanges = (
    portfolio: PaperPortfolio,
    changes: PositionChange[],
    copyConfig: CopyStrategyConfig
): { executed: number; skipped: number; failed: number } => {
    let executed = 0;
    let skipped = 0;
    let failed = 0;

    for (const change of changes) {
        Logger.info(`[Whale Paper] ${change.type.toUpperCase()} — ${change.title} (${change.outcome})`);

        const result = executePaperPositionChange(portfolio, change, copyConfig);
        if (result.ok) {
            executed += 1;
            Logger.success(`[Whale Paper] ${result.message}`);
        } else if (result.skipped || result.message.startsWith('skip buy:')) {
            skipped += 1;
            Logger.warning(`[Whale Paper] ${result.message} — ${change.title}`);
        } else {
            failed += 1;
            Logger.warning(`[Whale Paper] ${result.message}`);
        }
    }

    return { executed, skipped, failed };
};

export const logPaperPortfolioSummary = (
    portfolio: PaperPortfolio,
    markPrices: Map<string, number>
): void => {
    const snap = portfolio.snapshot(markPrices);
    Logger.separator();
    Logger.info(
        `[Whale Paper] Portfolio — cash $${snap.cashUsd.toFixed(2)} | positions $${snap.positionsValueUsd.toFixed(2)} | equity $${snap.totalEquityUsd.toFixed(2)} | PnL ${snap.pnlUsd >= 0 ? '+' : ''}$${snap.pnlUsd.toFixed(2)} (${snap.pnlPercent.toFixed(2)}%)`
    );
    Logger.info(
        `[Whale Paper] ${snap.openPositions.length} open position(s) | ${snap.fills.length} fill(s) | ${snap.settledCount} settled (${snap.winsSettled}W/${snap.lossesSettled}L)`
    );

    for (const pos of snap.openPositions.slice(0, 8)) {
        const mark = markPrices.get(pos.asset) ?? pos.avgPrice;
        const value = pos.tokens * mark;
        Logger.info(
            `[Whale Paper]   • ${pos.outcome || '?'} — ${pos.slug || pos.asset.slice(0, 10)}… — ${pos.tokens.toFixed(1)} tokens @ ${(mark * 100).toFixed(1)}¢ ($${value.toFixed(2)})`
        );
    }
    if (snap.openPositions.length > 8) {
        Logger.info(`[Whale Paper]   … and ${snap.openPositions.length - 8} more`);
    }
    Logger.separator();
};
