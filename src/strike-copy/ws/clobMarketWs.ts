import WebSocket from 'ws';
import Logger from '../../utils/logger';

type BookLevel = { price: number; size: number };
export type BookTop = { bestAsk: number | null; bestBid: number | null; asks: BookLevel[]; bids: BookLevel[]; updatedAt: number };

type Options = {
    url?: string;
    socksProxyUrl?: string;
    label?: string;
};

const DEFAULT_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_MS = 10_000;
const RECONNECT_MS = 500;
const STALE_MS = 60_000;

/**
 * CLOB market channel: streams order books for the tokens we are copying so
 * fills can be priced/pre-checked without an HTTP round-trip. Tokens are added
 * dynamically as the watched trader touches new markets.
 */
export class ClobMarketWsClient {
    private ws: WebSocket | null = null;
    private subscribed = new Set<string>();
    private books = new Map<string, BookTop>();
    private stopped = false;
    private timers: NodeJS.Timeout[] = [];
    private reconnectTimer: NodeJS.Timeout | null = null;
    private lastMessageAt = 0;
    private readonly url: string;
    private readonly label: string;

    constructor(private readonly opts: Options = {}) {
        this.url = opts.url || DEFAULT_URL;
        this.label = opts.label || 'CLOB WS';
    }

    start(): void {
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        this.clearTimers();
        try {
            this.ws?.close(1000, 'shutdown');
        } catch {
            // ignore
        }
        this.ws = null;
    }

    /** Subscribe to a token's book (no-op if already subscribed). */
    subscribe(assetId: string): void {
        if (!assetId || this.subscribed.has(assetId)) return;
        this.subscribed.add(assetId);
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.send({ assets_ids: [assetId], operation: 'subscribe' });
        }
    }

    unsubscribe(assetId: string): void {
        if (!this.subscribed.delete(assetId)) return;
        this.books.delete(assetId);
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.send({ assets_ids: [assetId], operation: 'unsubscribe' });
        }
    }

    /** Latest top-of-book, or null if we have not received a snapshot yet. */
    getTop(assetId: string): BookTop | null {
        return this.books.get(assetId) ?? null;
    }

    /** USD needed to buy up to `usd` worth at or below `maxPrice`; returns fillable USD and VWAP. */
    simulateBuy(assetId: string, usd: number, maxPrice: number): { fillUsd: number; vwap: number } | null {
        const top = this.books.get(assetId);
        if (!top) return null;
        let remaining = usd;
        let cost = 0;
        let tokens = 0;
        for (const a of top.asks) {
            if (a.price > maxPrice || remaining <= 0) break;
            const levelUsd = a.price * a.size;
            const take = Math.min(levelUsd, remaining);
            cost += take;
            tokens += take / a.price;
            remaining -= take;
        }
        if (tokens === 0) return { fillUsd: 0, vwap: 0 };
        return { fillUsd: cost, vwap: cost / tokens };
    }

    size(): number {
        return this.subscribed.size;
    }

    private send(payload: unknown): void {
        try {
            this.ws?.send(JSON.stringify(payload));
        } catch {
            // ignore
        }
    }

    private connect(): void {
        if (this.stopped) return;
        const wsOpts: WebSocket.ClientOptions = {};
        if (this.opts.socksProxyUrl) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { SocksProxyAgent } = require('socks-proxy-agent') as { SocksProxyAgent: new (p: string) => unknown };
            wsOpts.agent = new SocksProxyAgent(this.opts.socksProxyUrl) as WebSocket.ClientOptions['agent'];
        }
        const ws = new WebSocket(this.url, wsOpts);
        this.ws = ws;

        ws.on('open', () => {
            this.lastMessageAt = Date.now();
            Logger.info(`[${this.label}] connected — ${this.subscribed.size} book subscriptions`);
            // Initial subscribe must carry type: market; an empty list is allowed.
            this.send({ assets_ids: [...this.subscribed], type: 'market' });
            this.clearTimers();
            this.timers.push(
                setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.send('PING');
                }, PING_MS)
            );
            this.timers.push(
                setInterval(() => {
                    if (this.ws !== ws) return;
                    if (this.subscribed.size > 0 && Date.now() - this.lastMessageAt > STALE_MS) {
                        Logger.warning(`[${this.label}] stale — reconnecting`);
                        try {
                            ws.terminate();
                        } catch {
                            // ignore
                        }
                    }
                }, 5_000)
            );
        });

        ws.on('message', (data) => {
            this.lastMessageAt = Date.now();
            this.handle(typeof data === 'string' ? data : data.toString());
        });

        ws.on('close', () => {
            this.clearTimers();
            this.ws = null;
            if (!this.stopped) this.scheduleReconnect();
        });

        ws.on('error', (err) => {
            Logger.warning(`[${this.label}] error: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    private handle(text: string): void {
        if (!text || text === 'PONG' || text === 'pong') return;
        let msg: unknown;
        try {
            msg = JSON.parse(text);
        } catch {
            return;
        }
        for (const e of Array.isArray(msg) ? msg : [msg]) {
            if (!e || typeof e !== 'object') continue;
            const m = e as Record<string, unknown>;
            const type = String(m.event_type || '');
            if (type === 'book') this.applyBook(m);
            else if (type === 'price_change') this.applyPriceChange(m);
        }
    }

    private static parseLevels(raw: unknown, desc: boolean): BookLevel[] {
        if (!Array.isArray(raw)) return [];
        const levels = raw
            .map((l) => ({ price: parseFloat(String((l as Record<string, unknown>).price)), size: parseFloat(String((l as Record<string, unknown>).size)) }))
            .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
        levels.sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
        return levels;
    }

    private applyBook(m: Record<string, unknown>): void {
        const assetId = String(m.asset_id || '');
        if (!assetId) return;
        const asks = ClobMarketWsClient.parseLevels(m.asks, false);
        const bids = ClobMarketWsClient.parseLevels(m.bids, true);
        const top: BookTop = { asks, bids, bestAsk: asks[0]?.price ?? null, bestBid: bids[0]?.price ?? null, updatedAt: Date.now() };
        this.books.set(assetId, top);
    }

    private applyPriceChange(m: Record<string, unknown>): void {
        const changes = Array.isArray(m.price_changes) ? m.price_changes : [];
        for (const c of changes) {
            const ch = c as Record<string, unknown>;
            const assetId = String(ch.asset_id || '');
            const top = this.books.get(assetId);
            if (!top) continue;
            const price = parseFloat(String(ch.price));
            const size = parseFloat(String(ch.size));
            const side = String(ch.side || '').toUpperCase();
            if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
            const levels = side === 'SELL' ? top.asks : side === 'BUY' ? top.bids : null;
            if (!levels) continue;
            const idx = levels.findIndex((l) => Math.abs(l.price - price) < 1e-9);
            if (size <= 0) {
                if (idx >= 0) levels.splice(idx, 1);
            } else if (idx >= 0) {
                levels[idx].size = size;
            } else {
                levels.push({ price, size });
                levels.sort((a, b) => (side === 'SELL' ? a.price - b.price : b.price - a.price));
            }
            const bestAsk = parseFloat(String(ch.best_ask));
            const bestBid = parseFloat(String(ch.best_bid));
            top.bestAsk = Number.isFinite(bestAsk) ? bestAsk : top.asks[0]?.price ?? null;
            top.bestBid = Number.isFinite(bestBid) ? bestBid : top.bids[0]?.price ?? null;
            top.updatedAt = Date.now();
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer || this.stopped) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, RECONNECT_MS);
    }

    private clearTimers(): void {
        this.timers.forEach(clearInterval);
        this.timers = [];
    }
}
