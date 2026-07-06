import axios from 'axios';
import { configureSocksProxyFromEnv } from './proxy';

const isValidAddress = (address: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(address);

export type ResolvedWatchTarget = {
    input: string;
    address: string;
    name?: string;
    pseudonym?: string;
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const parseWatchlistInput = (input: string | undefined): string[] => {
    if (!input?.trim()) return [];
    const trimmed = input.trim();
    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (Array.isArray(parsed)) {
                return parsed.map((entry) => String(entry).trim()).filter(Boolean);
            }
        } catch {
            // fall through
        }
    }
    return trimmed
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
};

const normalizeUsername = (entry: string): string | null => {
    const trimmed = entry.trim();
    if (!trimmed) return null;

    const profileMatch = trimmed.match(/polymarket\.com\/@([^/?#]+)/i);
    if (profileMatch) {
        return profileMatch[1].toLowerCase();
    }

    const addressProfileMatch = trimmed.match(/polymarket\.com\/profile\/(0x[a-fA-F0-9]{40})/i);
    if (addressProfileMatch) {
        return null;
    }

    if (trimmed.startsWith('@')) {
        return trimmed.slice(1).toLowerCase();
    }

    if (/^[a-zA-Z0-9_-]{2,32}$/.test(trimmed) && !trimmed.startsWith('0x')) {
        return trimmed.toLowerCase();
    }

    return null;
};

const extractProxyWalletFromHtml = (html: string): string | undefined => {
    const patterns = [
        /"proxyWallet":"(0x[a-fA-F0-9]{40})"/i,
        /\\"proxyWallet\\":\\"(0x[a-fA-F0-9]{40})\\"/i,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        const address = match?.[1];
        if (address && isValidAddress(address)) {
            return address.toLowerCase();
        }
    }

    return undefined;
};

const resolveAddressProfile = async (
    address: string,
    socksProxyUrl: string | undefined,
    requestTimeoutMs: number
): Promise<ResolvedWatchTarget> => {
    const normalized = address.toLowerCase();
    const { httpAgent, httpsAgent } = configureSocksProxyFromEnv(socksProxyUrl);

    try {
        const res = await axios.get(`https://gamma-api.polymarket.com/public-profile?address=${normalized}`, {
            timeout: requestTimeoutMs,
            headers: { 'User-Agent': UA },
            proxy: false,
            httpAgent,
            httpsAgent,
        });
        const data = res.data as { name?: string; pseudonym?: string; proxyWallet?: string };
        const resolved = (data.proxyWallet || normalized).toLowerCase();
        return {
            input: address,
            address: resolved,
            name: data.name,
            pseudonym: data.pseudonym,
        };
    } catch {
        return { input: address, address: normalized };
    }
};

const resolveUsernameProfile = async (
    username: string,
    socksProxyUrl: string | undefined,
    requestTimeoutMs: number
): Promise<ResolvedWatchTarget> => {
    const { httpAgent, httpsAgent } = configureSocksProxyFromEnv(socksProxyUrl);

    const res = await axios.get(`https://polymarket.com/@${encodeURIComponent(username)}`, {
        timeout: requestTimeoutMs,
        headers: { 'User-Agent': UA },
        proxy: false,
        httpAgent,
        httpsAgent,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
    });

    const proxyWallet = extractProxyWalletFromHtml(String(res.data));
    if (!proxyWallet || !isValidAddress(proxyWallet)) {
        throw new Error(`Could not resolve @${username} to a Polymarket proxy wallet`);
    }

    try {
        const profile = await axios.get(
            `https://gamma-api.polymarket.com/public-profile?address=${proxyWallet}`,
            {
                timeout: requestTimeoutMs,
                headers: { 'User-Agent': UA },
                proxy: false,
                httpAgent,
                httpsAgent,
            }
        );
        const data = profile.data as { name?: string; pseudonym?: string };
        return {
            input: `@${username}`,
            address: proxyWallet,
            name: data.name || username,
            pseudonym: data.pseudonym,
        };
    } catch {
        return {
            input: `@${username}`,
            address: proxyWallet,
            name: username,
        };
    }
};

export const resolvePolymarketWatchlist = async (options?: {
    watchlist?: string;
    socksProxyUrl?: string;
    requestTimeoutMs?: number;
}): Promise<ResolvedWatchTarget[]> => {
    const entries = parseWatchlistInput(options?.watchlist);
    if (entries.length === 0) {
        return [];
    }

    const socksProxyUrl = options?.socksProxyUrl;
    const requestTimeoutMs = options?.requestTimeoutMs ?? 15_000;
    const resolved: ResolvedWatchTarget[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
        const addressMatch = entry.match(/^(0x[a-fA-F0-9]{40})$/i);
        if (addressMatch) {
            const target = await resolveAddressProfile(
                addressMatch[1],
                socksProxyUrl,
                requestTimeoutMs
            );
            if (!seen.has(target.address)) {
                seen.add(target.address);
                resolved.push(target);
            }
            continue;
        }

        const profileAddressMatch = entry.match(/(0x[a-fA-F0-9]{40})/i);
        if (profileAddressMatch && entry.toLowerCase().includes('polymarket.com/profile/')) {
            const target = await resolveAddressProfile(
                profileAddressMatch[1],
                socksProxyUrl,
                requestTimeoutMs
            );
            if (!seen.has(target.address)) {
                seen.add(target.address);
                resolved.push(target);
            }
            continue;
        }

        const username = normalizeUsername(entry);
        if (username) {
            const target = await resolveUsernameProfile(username, socksProxyUrl, requestTimeoutMs);
            if (!seen.has(target.address)) {
                seen.add(target.address);
                resolved.push(target);
            }
            continue;
        }

        throw new Error(
            `Invalid watchlist entry "${entry}". Use a 0x address, @username, or polymarket.com/@username URL.`
        );
    }

    return resolved;
};

export const formatResolvedWatchlist = (targets: ResolvedWatchTarget[]): string =>
    targets
        .map((target) => {
            const label = target.name || target.pseudonym || target.input;
            return `${label} (${target.address.slice(0, 6)}...${target.address.slice(-4)})`;
        })
        .join(', ');
