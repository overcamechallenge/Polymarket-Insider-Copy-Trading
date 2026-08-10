import { FIFTEEN_MIN_SLUG_REGEX } from './config';

/**
 * True for short-window crypto up/down markets (5m / 15m by default).
 * Example slugs: `btc-updown-5m-…`, `eth-updown-15m-…`
 * Example titles: `Bitcoin Up or Down - August 9, 10:55PM-11:00PM ET`
 */
export const isFifteenMinUpDownMarket = (input: {
    slug?: string;
    eventSlug?: string;
    title?: string;
}): boolean => {
    const hay = [input.slug, input.eventSlug, input.title]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join(' ');

    if (!hay) return false;
    if (FIFTEEN_MIN_SLUG_REGEX.test(hay)) return true;

    const lower = hay.toLowerCase();
    const upDown = /up-?or-?down|updown|up-down/.test(lower);
    if (!upDown) return false;

    // 5m / 15m windows (slug tokens or title ranges like 10:55PM-11:00PM)
    if (/\b(?:5|15)\s*m(?:in(?:ute)?s?)?\b/.test(lower)) return true;
    if (/updown-(?:5|15)m\b/.test(lower)) return true;
    if (/up-or-down-(?:5|15)m\b/.test(lower)) return true;

    return false;
};
