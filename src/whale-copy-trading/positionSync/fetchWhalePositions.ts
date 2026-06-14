import fetchData from '../../utils/fetchData';
import type { WhalePositionRecord } from './types';

type ApiPosition = {
    asset?: string;
    conditionId?: string;
    size?: number;
    avgPrice?: number;
    currentValue?: number;
    curPrice?: number;
    title?: string;
    outcome?: string;
    slug?: string;
    eventSlug?: string;
    outcomeIndex?: number;
    redeemable?: boolean;
};

const isActivePosition = (pos: ApiPosition, minValueUsd: number): boolean =>
    pos.redeemable !== true &&
    Number(pos.size) > 0 &&
    Number(pos.curPrice) > 0 &&
    Number(pos.curPrice) < 1 &&
    Number(pos.currentValue) >= minValueUsd &&
    Boolean(pos.asset);

export const fetchActiveWhalePositions = async (
    wallet: string,
    minValueUsd = 0
): Promise<WhalePositionRecord[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=0.01&limit=500`;
    const data = (await fetchData(url)) as ApiPosition[];
    if (!Array.isArray(data)) return [];

    return data.filter((pos) => isActivePosition(pos, minValueUsd)).map((pos) => ({
        asset: String(pos.asset),
        conditionId: String(pos.conditionId || ''),
        size: Number(pos.size) || 0,
        avgPrice: Number(pos.avgPrice) || 0,
        currentValue: Number(pos.currentValue) || 0,
        curPrice: Number(pos.curPrice) || 0,
        title: pos.title || '',
        outcome: pos.outcome || '',
        slug: pos.slug,
        eventSlug: pos.eventSlug,
        outcomeIndex: pos.outcomeIndex,
    }));
};

export const positionsToMap = (
    positions: WhalePositionRecord[]
): Record<string, WhalePositionRecord> =>
    Object.fromEntries(positions.map((pos) => [pos.asset, pos]));
