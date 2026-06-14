import {
    WHALE_POSITION_MAX_BUY_PRICE,
    WHALE_POSITION_MIN_BUY_PRICE,
} from '../config';

/** Returns a skip reason when price is outside the allowed buy band, otherwise null. */
export const getBuyPriceSkipReason = (price: number): string | null => {
    if (!Number.isFinite(price) || price <= 0) {
        return 'skip buy: invalid price';
    }
    if (price < WHALE_POSITION_MIN_BUY_PRICE) {
        return `skip buy: price ${(price * 100).toFixed(1)}¢ below min ${(WHALE_POSITION_MIN_BUY_PRICE * 100).toFixed(0)}¢`;
    }
    if (price > WHALE_POSITION_MAX_BUY_PRICE) {
        return `skip buy: price ${(price * 100).toFixed(1)}¢ above max ${(WHALE_POSITION_MAX_BUY_PRICE * 100).toFixed(0)}¢`;
    }
    return null;
};

export const isBuyPriceAllowed = (price: number): boolean => getBuyPriceSkipReason(price) === null;
