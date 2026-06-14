import type { PositionChange, PositionChangeType, WhalePositionRecord, WhalePositionSnapshot } from './types';
import { positionsToMap } from './fetchWhalePositions';

const sizeDeltaMeaningful = (
    prevSize: number,
    newSize: number,
    curPrice: number,
    minDeltaUsd: number,
    minDeltaPct: number
): boolean => {
    const deltaSize = Math.abs(newSize - prevSize);
    const deltaUsd = deltaSize * curPrice;
    if (deltaUsd >= minDeltaUsd) return true;
    if (prevSize <= 0) return newSize > 0;
    return deltaSize / prevSize >= minDeltaPct;
};

const buildChange = (
    type: PositionChangeType,
    wallet: string,
    label: string,
    asset: string,
    prev: WhalePositionRecord | undefined,
    next: WhalePositionRecord | undefined
): PositionChange | null => {
    const position = next || prev;
    if (!position) return null;

    const prevSize = prev?.size ?? 0;
    const newSize = next?.size ?? 0;
    const deltaSize = newSize - prevSize;
    const curPrice = next?.curPrice ?? prev?.curPrice ?? 0;
    const deltaUsd = Math.abs(deltaSize) * curPrice;

    return {
        type,
        wallet,
        label,
        asset,
        conditionId: position.conditionId,
        title: position.title,
        outcome: position.outcome,
        slug: position.slug,
        eventSlug: position.eventSlug,
        curPrice,
        prevSize,
        newSize,
        deltaSize,
        deltaUsd,
        position: next,
    };
};

export const diffPositionSnapshots = (
    wallet: string,
    label: string,
    previous: WhalePositionSnapshot | null,
    currentPositions: WhalePositionRecord[],
    options: { minDeltaUsd: number; minDeltaPct: number }
): { isBaseline: boolean; changes: PositionChange[]; snapshot: WhalePositionSnapshot } => {
    const snapshot: WhalePositionSnapshot = {
        wallet: wallet.toLowerCase(),
        label,
        savedAt: new Date().toISOString(),
        positions: positionsToMap(currentPositions),
    };

    if (!previous) {
        return { isBaseline: true, changes: [], snapshot };
    }

    const prevMap = previous.positions;
    const nextMap = snapshot.positions;
    const changes: PositionChange[] = [];

    for (const [asset, next] of Object.entries(nextMap)) {
        const prev = prevMap[asset];
        if (!prev) {
            const change = buildChange('opened', wallet, label, asset, undefined, next);
            if (change && change.deltaUsd >= options.minDeltaUsd) {
                changes.push(change);
            }
            continue;
        }

        if (
            next.size > prev.size &&
            sizeDeltaMeaningful(prev.size, next.size, next.curPrice, options.minDeltaUsd, options.minDeltaPct)
        ) {
            const change = buildChange('increased', wallet, label, asset, prev, next);
            if (change) changes.push(change);
            continue;
        }

        if (
            next.size < prev.size &&
            sizeDeltaMeaningful(prev.size, next.size, next.curPrice, options.minDeltaUsd, options.minDeltaPct)
        ) {
            const change = buildChange('decreased', wallet, label, asset, prev, next);
            if (change) changes.push(change);
        }
    }

    for (const [asset, prev] of Object.entries(prevMap)) {
        if (nextMap[asset]) continue;
        const change = buildChange('closed', wallet, label, asset, prev, undefined);
        if (change) changes.push(change);
    }

    return { isBaseline: false, changes, snapshot };
};

export const formatPositionChange = (change: PositionChange): string => {
    const market = `${change.title} (${change.outcome})`.trim();
    switch (change.type) {
        case 'opened':
            return `[NEW] ${change.label}: ${market} — ${change.newSize.toFixed(1)} shares (~$${change.deltaUsd.toFixed(0)})`;
        case 'increased':
            return `[ADD] ${change.label}: ${market} — +${change.deltaSize.toFixed(1)} shares (~$${change.deltaUsd.toFixed(0)})`;
        case 'decreased':
            return `[TRIM] ${change.label}: ${market} — -${Math.abs(change.deltaSize).toFixed(1)} shares (~$${change.deltaUsd.toFixed(0)})`;
        case 'closed':
            return `[EXIT] ${change.label}: ${market} — closed ${change.prevSize.toFixed(1)} shares (~$${(change.prevSize * change.curPrice).toFixed(0)})`;
    }
};
