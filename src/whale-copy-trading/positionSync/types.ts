export type WhalePositionRecord = {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    title: string;
    outcome: string;
    slug?: string;
    eventSlug?: string;
    outcomeIndex?: number;
};

export type WhalePositionSnapshot = {
    wallet: string;
    label: string;
    savedAt: string;
    positions: Record<string, WhalePositionRecord>;
};

export type PositionChangeType = 'opened' | 'increased' | 'decreased' | 'closed';

export type PositionChange = {
    type: PositionChangeType;
    wallet: string;
    label: string;
    asset: string;
    conditionId: string;
    title: string;
    outcome: string;
    slug?: string;
    eventSlug?: string;
    curPrice: number;
    prevSize: number;
    newSize: number;
    deltaSize: number;
    deltaUsd: number;
    position?: WhalePositionRecord;
};

export type PositionCheckResult = {
    wallet: string;
    label: string;
    isBaseline: boolean;
    changes: PositionChange[];
    snapshot: WhalePositionSnapshot;
};
