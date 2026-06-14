import fs from 'node:fs';
import path from 'node:path';
import type { WhalePositionSnapshot } from './types';

const DEFAULT_DIR = path.join(process.cwd(), 'whale-copy-trading-data', 'position-snapshots');

export const getSnapshotDir = (): string =>
    process.env.WHALE_POSITION_SNAPSHOT_DIR?.trim() || DEFAULT_DIR;

export const snapshotPathForWallet = (wallet: string): string =>
    path.join(getSnapshotDir(), `${wallet.toLowerCase()}.json`);

export const loadSnapshot = (wallet: string): WhalePositionSnapshot | null => {
    const filePath = snapshotPathForWallet(wallet);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as WhalePositionSnapshot;
    } catch {
        return null;
    }
};

export const saveSnapshot = (snapshot: WhalePositionSnapshot): string => {
    const dir = getSnapshotDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = snapshotPathForWallet(snapshot.wallet);
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    return filePath;
};

export const hasSnapshot = (wallet: string): boolean =>
    fs.existsSync(snapshotPathForWallet(wallet));
