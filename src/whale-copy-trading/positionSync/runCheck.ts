import type { ClobClient } from '@polymarket/clob-client-v2';
import createClobClient from '../../utils/createClobClient';
import Logger from '../../utils/logger';
import { sendSlackMessage } from '../../utils/slackNotify';
import type { ResolvedWatchTarget } from '../../utils/resolvePolymarketWatchlist';
import {
    WHALE_COPY_CONFIG,
    WHALE_POSITION_MIN_DELTA_PCT,
    WHALE_POSITION_MIN_DELTA_USD,
    WHALE_POSITION_MIN_VALUE_USD,
    WHALE_POSITION_DRY_RUN,
    WHALE_POSITION_PAPER_TRADING,
    WHALE_POSITION_COPY_ON_FIRST_RUN,
    WHALE_RUNTIME,
} from '../config';
import { fetchActiveWhalePositions } from './fetchWhalePositions';
import { diffPositionSnapshots, formatPositionChange } from './diffPositions';
import { loadSnapshot, saveSnapshot } from './snapshotStore';
import { executePositionChanges } from './executeDiff';
import {
    executePaperPositionChanges,
    logPaperPortfolioSummary,
} from './paperExecute';
import { loadPaperPortfolio, savePaperPortfolio } from './paperPortfolioStore';
import { settleResolvedPaperPositions } from '../../lib/paperMarketResolution';
import type { PositionChange } from './types';

export type PositionSyncSummary = {
    targets: number;
    baselinesSaved: number;
    walletsWithChanges: number;
    totalChanges: number;
    executed: number;
    failed: number;
};

export const runPositionSyncCheck = async (
    targets: ResolvedWatchTarget[],
    options?: {
        clobClient?: ClobClient | null;
        dryRun?: boolean;
        paperTrading?: boolean;
        copyOnFirstRun?: boolean;
    }
): Promise<PositionSyncSummary> => {
    const paperTrading = options?.paperTrading ?? WHALE_POSITION_PAPER_TRADING;
    const dryRun = paperTrading ? false : (options?.dryRun ?? WHALE_POSITION_DRY_RUN);
    const copyOnFirstRun = options?.copyOnFirstRun ?? WHALE_POSITION_COPY_ON_FIRST_RUN;
    const summary: PositionSyncSummary = {
        targets: targets.length,
        baselinesSaved: 0,
        walletsWithChanges: 0,
        totalChanges: 0,
        executed: 0,
        failed: 0,
    };

    const allChanges: PositionChange[] = [];

    for (const target of targets) {
        const wallet = target.address.toLowerCase();
        const label = target.name || target.pseudonym || target.input;

        Logger.info(`[Whale Positions] Checking ${label} (${wallet.slice(0, 6)}...${wallet.slice(-4)})`);

        const currentPositions = await fetchActiveWhalePositions(wallet, WHALE_POSITION_MIN_VALUE_USD);
        const previous = loadSnapshot(wallet);
        const { isBaseline, changes, snapshot } = diffPositionSnapshots(
            wallet,
            label,
            previous,
            currentPositions,
            {
                minDeltaUsd: WHALE_POSITION_MIN_DELTA_USD,
                minDeltaPct: WHALE_POSITION_MIN_DELTA_PCT,
                copyOnFirstRun,
            }
        );

        const savedPath = saveSnapshot(snapshot);

        if (isBaseline) {
            summary.baselinesSaved += 1;
            Logger.success(
                `[Whale Positions] Baseline saved for ${label} — ${currentPositions.length} active position(s). No copy on first check.`
            );
            Logger.info(`[Whale Positions] Snapshot: ${savedPath}`);
            continue;
        }

        if (changes.length === 0) {
            Logger.info(
                `[Whale Positions] No meaningful changes for ${label} (${currentPositions.length} positions unchanged)`
            );
            continue;
        }

        summary.walletsWithChanges += 1;
        summary.totalChanges += changes.length;
        allChanges.push(...changes);

        for (const change of changes) {
            Logger.info(`[Whale Positions] ${formatPositionChange(change)}`);
        }
    }

    if (allChanges.length === 0) {
        if (paperTrading) {
            const portfolio = loadPaperPortfolio();
            const settled = await settleResolvedPaperPositions(portfolio);
            for (const s of settled) {
                Logger.info(
                    `[Whale Paper] Settled ${s.won ? 'WIN' : 'LOSS'} ${s.slug || s.asset.slice(0, 8)} — payout $${s.payoutUsd.toFixed(2)}`
                );
            }
            savePaperPortfolio(portfolio);
            const markPrices = new Map(
                portfolio.getOpenPositions().map((p) => [p.asset, p.avgPrice])
            );
            logPaperPortfolioSummary(portfolio, markPrices);
        }
        Logger.success(
            `[Whale Positions] Check complete — no position changes detected (${summary.targets} wallet(s) checked).`
        );
        return summary;
    }

    if (paperTrading) {
        Logger.info('[Whale Paper] Simulating copies with virtual portfolio (no real orders)...');
        const portfolio = loadPaperPortfolio();
        const execResult = executePaperPositionChanges(portfolio, allChanges, WHALE_COPY_CONFIG);
        summary.executed = execResult.executed;
        summary.failed = execResult.failed;

        const settled = await settleResolvedPaperPositions(portfolio);
        for (const s of settled) {
            Logger.info(
                `[Whale Paper] Settled ${s.won ? 'WIN' : 'LOSS'} ${s.slug || s.asset.slice(0, 8)} — payout $${s.payoutUsd.toFixed(2)}`
            );
        }

        const markPrices = new Map<string, number>();
        for (const change of allChanges) {
            markPrices.set(change.asset, change.curPrice);
        }
        for (const pos of portfolio.getOpenPositions()) {
            if (!markPrices.has(pos.asset)) {
                markPrices.set(pos.asset, pos.avgPrice);
            }
        }

        const savedPath = savePaperPortfolio(portfolio);
        logPaperPortfolioSummary(portfolio, markPrices);
        Logger.info(`[Whale Paper] Saved portfolio: ${savedPath}`);

        await notifySlack(allChanges, false, summary, 'PAPER');

        Logger.separator();
        Logger.info(
            `[Whale Positions] Done — ${summary.totalChanges} change(s), ${summary.executed} paper fill(s), ${summary.failed} failed`
        );
        return summary;
    }

    let clobClient = options?.clobClient ?? null;
    if (!dryRun && !clobClient) {
        Logger.info('[Whale Positions] Initializing CLOB client for copies...');
        clobClient = await createClobClient();
    }

    const execResult = await executePositionChanges(
        clobClient,
        allChanges,
        WHALE_RUNTIME.proxyWallet,
        WHALE_COPY_CONFIG,
        dryRun
    );
    summary.executed = execResult.executed;
    summary.failed = execResult.failed;

    await notifySlack(allChanges, dryRun, summary);

    Logger.separator();
    Logger.info(
        `[Whale Positions] Done — ${summary.totalChanges} change(s), ${summary.executed} executed, ${summary.failed} failed`
    );

    return summary;
};

const notifySlack = async (
    changes: PositionChange[],
    dryRun: boolean,
    summary: PositionSyncSummary,
    modeOverride?: string
): Promise<void> => {
    const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
    if (!webhook) return;

    const lines = changes.map((c) => `• ${formatPositionChange(c)}`);
    const mode = modeOverride ?? (dryRun ? 'DRY RUN' : 'LIVE');
    const text = [
        `*Whale position sync (${mode})*`,
        `${summary.totalChanges} change(s) across ${summary.walletsWithChanges} wallet(s)`,
        '',
        ...lines,
    ].join('\n');

    try {
        await sendSlackMessage(webhook, text);
    } catch (e) {
        Logger.warning(
            `[Whale Positions] Slack notify failed: ${e instanceof Error ? e.message : String(e)}`
        );
    }
};
