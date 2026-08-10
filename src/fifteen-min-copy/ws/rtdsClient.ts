import WebSocket from 'ws';
import Logger from '../../utils/logger';
import {
    FIFTEEN_MIN_WS_PING_MS,
    FIFTEEN_MIN_WS_RECONNECT_MS,
    FIFTEEN_MIN_WS_STALE_CHECK_MS,
    FIFTEEN_MIN_WS_STALE_MS,
    FIFTEEN_MIN_WS_URL,
} from '../config';
import { parseRtdsActivityTrade, peekProxyWallet } from './parseTrade';
import type { RtdsActivityTrade } from '../types';

export type RtdsClientOptions = {
    url?: string;
    socksProxyUrl?: string;
    /** Only fully parse events from these wallets (lowercase). Empty = parse all. */
    walletFilter?: Set<string>;
    onTrade: (trade: RtdsActivityTrade) => void;
    /** Called for every activity event, before wallet filtering. */
    onActivity?: () => void;
    onOpen?: () => void;
    onClose?: (code: number, reason: string) => void;
    onError?: (error: Error) => void;
};

/**
 * Polymarket Real-Time Data Service client.
 * Subscribes to public `activity` trades so we can copy other wallets
 * (unlike the authenticated CLOB user channel, which only streams our own fills).
 */
export class RtdsActivityClient {
    private ws: WebSocket | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private staleTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private lastMessageAt = 0;
    private readonly url: string;
    private readonly socksProxyUrl?: string;
    private readonly walletFilter?: Set<string>;
    private readonly onTrade: (trade: RtdsActivityTrade) => void;
    private readonly onActivity?: () => void;
    private readonly onOpen?: () => void;
    private readonly onClose?: (code: number, reason: string) => void;
    private readonly onError?: (error: Error) => void;

    constructor(opts: RtdsClientOptions) {
        this.url = opts.url || FIFTEEN_MIN_WS_URL;
        this.socksProxyUrl = opts.socksProxyUrl;
        this.walletFilter = opts.walletFilter?.size ? opts.walletFilter : undefined;
        this.onTrade = opts.onTrade;
        this.onActivity = opts.onActivity;
        this.onOpen = opts.onOpen;
        this.onClose = opts.onClose;
        this.onError = opts.onError;
    }

    start(): void {
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        this.clearTimers();
        if (this.ws) {
            try {
                this.ws.close(1000, 'shutdown');
            } catch {
                // ignore
            }
            this.ws = null;
        }
    }

    private connect(): void {
        if (this.stopped) return;

        const wsOpts: WebSocket.ClientOptions = {};
        if (this.socksProxyUrl) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { SocksProxyAgent } = require('socks-proxy-agent') as {
                SocksProxyAgent: new (proxy: string) => unknown;
            };
            wsOpts.agent = new SocksProxyAgent(this.socksProxyUrl) as WebSocket.ClientOptions['agent'];
        }

        Logger.info(`[15m Copy] Connecting RTDS ${this.url}…`);
        const ws = new WebSocket(this.url, wsOpts);
        this.ws = ws;

        ws.on('open', () => {
            Logger.success('[15m Copy] RTDS connected — subscribing to activity trades');
            this.lastMessageAt = Date.now();
            this.subscribe(ws);
            this.startPing(ws);
            this.startStaleWatch(ws);
            this.onOpen?.();
        });

        ws.on('message', (data) => {
            this.lastMessageAt = Date.now();
            this.handleMessage(data);
        });

        ws.on('close', (code, reasonBuf) => {
            const reason = reasonBuf?.toString?.() || '';
            this.clearPing();
            this.clearStaleWatch();
            this.ws = null;
            this.onClose?.(code, reason);
            if (!this.stopped) {
                Logger.warning(
                    `[15m Copy] RTDS closed (${code}${reason ? ` ${reason}` : ''}) — reconnecting in ${FIFTEEN_MIN_WS_RECONNECT_MS}ms`
                );
                this.scheduleReconnect();
            }
        });

        ws.on('error', (err) => {
            const error = err instanceof Error ? err : new Error(String(err));
            Logger.error(`[15m Copy] RTDS error: ${error.message}`);
            this.onError?.(error);
        });
    }

    private subscribe(ws: WebSocket): void {
        // Subscribe to both — `trades` has been intermittently silent; `orders_matched` is reliable.
        const payload = {
            action: 'subscribe',
            subscriptions: [
                { topic: 'activity', type: 'trades' },
                { topic: 'activity', type: 'orders_matched' },
            ],
        };
        ws.send(JSON.stringify(payload));
    }

    private handleMessage(data: WebSocket.RawData): void {
        const receivedAt = Date.now();
        const text = typeof data === 'string' ? data : data.toString();
        if (!text || text === 'PONG' || text === 'pong') return;

        let msg: unknown;
        try {
            msg = JSON.parse(text);
        } catch {
            return;
        }

        // Batch arrays or single envelope
        const envelopes = Array.isArray(msg) ? msg : [msg];
        for (const env of envelopes) {
            if (!env || typeof env !== 'object') continue;
            const e = env as Record<string, unknown>;

            // Heartbeat / ack noise
            if (e.type === 'PONG' || e.type === 'pong') continue;

            const topic = String(e.topic || '');
            const type = String(e.type || '');
            if (topic !== 'activity') continue;
            if (type !== 'trades' && type !== 'orders_matched') continue;

            this.onActivity?.();

            const payload = e.payload ?? e;
            // Skip the expensive normalization for the ~99.9% of global activity
            // that belongs to wallets we do not follow.
            if (this.walletFilter) {
                const wallet = peekProxyWallet(payload);
                if (!wallet || !this.walletFilter.has(wallet)) continue;
            }

            const trade = parseRtdsActivityTrade(payload, type, receivedAt);
            if (trade) this.onTrade(trade);
        }
    }

    private startPing(ws: WebSocket): void {
        this.clearPing();
        this.pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send('PING');
                } catch {
                    // ignore
                }
            }
        }, FIFTEEN_MIN_WS_PING_MS);
    }

    private clearPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    /** Force reconnect when the socket stays open but stops delivering trades. */
    private startStaleWatch(ws: WebSocket): void {
        this.clearStaleWatch();
        this.staleTimer = setInterval(() => {
            if (this.stopped || this.ws !== ws) return;
            const idle = Date.now() - this.lastMessageAt;
            if (idle < FIFTEEN_MIN_WS_STALE_MS) return;
            Logger.warning(
                `[15m Copy] RTDS stale (${Math.round(idle / 1000)}s no messages) — forcing reconnect`
            );
            this.clearPing();
            this.clearStaleWatch();
            try {
                ws.terminate();
            } catch {
                // ignore
            }
            this.ws = null;
            if (!this.stopped) this.scheduleReconnect();
        }, FIFTEEN_MIN_WS_STALE_CHECK_MS);
    }

    private clearStaleWatch(): void {
        if (this.staleTimer) {
            clearInterval(this.staleTimer);
            this.staleTimer = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer || this.stopped) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, FIFTEEN_MIN_WS_RECONNECT_MS);
    }

    private clearTimers(): void {
        this.clearPing();
        this.clearStaleWatch();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
