import { fetchMarketByConditionId } from '../trader-analysis/fetchMarkets';
import type { MarketInfo } from '../trader-analysis/types';

type Cached = { endTs: number | null; exact: boolean; at: number };
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<void>>();
const TTL_MS = 6 * 60 * 60_000;

const MONTHS: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
    september: 9, october: 10, november: 11, december: 12,
};

/**
 * Derive the resolution time from the slug without any network call.
 *  - `…-on-september-11-2026`            → daily strike, 12:00 ET = 16:00 UTC
 *  - `…-september-14-20-2026` (range)     → last day of range, 16:00 UTC
 *  - `…-by-december-31-2026`              → midnight ET after that day ≈ 05:00 UTC next day
 *  - `…-in-september-2026`                → last day of month, 16:00 UTC
 * Returns null when the slug does not match a known pattern.
 */
/** Midnight ET expressed in UTC hours (approximate DST: Apr–Oct → 04:00Z, otherwise 05:00Z). */
const midnightEtUtcHour = (monthIdx0: number): number => (monthIdx0 >= 3 && monthIdx0 <= 9 ? 4 : 5);

/**
 * Derive the resolution time from the slug without any network call.
 *  - daily strike `…-above-78k-on-september-11-2026`  → 12:00 ET = 16:00 UTC that day
 *  - dip/reach/hit `…-dip-to-75-on-august-18-2026`     → midnight ET after that day (04/05 UTC next day)
 *  - range `…-september-14-20-2026`                    → last day of range, midnight ET
 *  - `…-by-december-31-2026`                            → midnight ET after that day
 *  - `…-in-september-2026`                              → last day of month, midnight ET
 * Slugs without a year assume the current year. Returns null when nothing matches.
 * Gamma refines these in the background (see prefetchMarketEnd).
 */
export const endTsFromSlug = (slug: string | undefined): number | null => {
    if (!slug) return null;
    const s = slug.toLowerCase();
    const thisYear = new Date().getUTCFullYear();
    const midnightEt = /dip|reach|hit|-by-|-in-|between/.test(s);
    const at = (year: number, monthIdx0: number, day: number, midnight: boolean): number =>
        midnight
            ? Date.UTC(year, monthIdx0, day + 1, midnightEtUtcHour(monthIdx0), 0, 0) / 1000
            : Date.UTC(year, monthIdx0, day, 16, 0, 0) / 1000;

    let m = s.match(/-(on|by)-([a-z]+)-(\d{1,2})(?:-(\d{4}))?(?:-|$)/);
    if (m && MONTHS[m[2]]) {
        const [, kind, mon, day, year] = m;
        return at(year ? Number(year) : thisYear, MONTHS[mon] - 1, Number(day), kind === 'by' || midnightEt);
    }
    m = s.match(/-([a-z]+)-(\d{1,2})-(\d{1,2})-(\d{4})(?:-|$)/);
    if (m && MONTHS[m[1]]) {
        const [, mon, , d2, year] = m;
        return at(Number(year), MONTHS[mon] - 1, Number(d2), true);
    }
    m = s.match(/-in-([a-z]+)-(\d{4})(?:-|$)/);
    if (m && MONTHS[m[1]]) {
        const lastDay = new Date(Date.UTC(Number(m[2]), MONTHS[m[1]], 0)).getUTCDate();
        return at(Number(m[2]), MONTHS[m[1]] - 1, lastDay, true);
    }
    m = s.match(/-(?:by|in)-(\d{4})(?:-|$)/);
    if (m) return at(Number(m[1]), 11, 31, true);
    return null;
};

const endTsOf = (info: MarketInfo | null): number | null => {
    if (!info?.endDate) return null;
    const t = Date.parse(info.endDate.includes('T') ? info.endDate : `${info.endDate}T16:00:00Z`);
    return Number.isFinite(t) ? t / 1000 : null;
};

/** Kick off (or reuse) a background gamma fetch that upgrades the cache to the exact end time. */
export const prefetchMarketEnd = (conditionId: string): Promise<void> => {
    if (!conditionId) return Promise.resolve();
    const hit = cache.get(conditionId);
    if (hit?.exact && Date.now() - hit.at < TTL_MS) return Promise.resolve();
    const existing = inflight.get(conditionId);
    if (existing) return existing;
    const p = fetchMarketByConditionId(conditionId)
        .then((info) => {
            const endTs = endTsOf(info);
            if (endTs !== null) cache.set(conditionId, { endTs, exact: true, at: Date.now() });
        })
        .catch(() => undefined)
        .finally(() => inflight.delete(conditionId));
    inflight.set(conditionId, p);
    return p;
};

/**
 * Market end time (epoch seconds), instant: exact value if already fetched,
 * otherwise slug-derived. Starts a background fetch to refine. Null = unknown.
 */
export const getMarketEndTsFast = (conditionId: string, slug: string | undefined): number | null => {
    const hit = cache.get(conditionId);
    if (hit && Date.now() - hit.at < TTL_MS) {
        if (!hit.exact) void prefetchMarketEnd(conditionId);
        return hit.endTs;
    }
    const derived = endTsFromSlug(slug);
    cache.set(conditionId, { endTs: derived, exact: false, at: Date.now() });
    void prefetchMarketEnd(conditionId);
    return derived;
};
