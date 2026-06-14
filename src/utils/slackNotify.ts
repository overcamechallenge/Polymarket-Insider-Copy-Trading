import axios from 'axios';

/** Slack mention markup for notifications. Empty string = no mention. */
export type SlackMention = string;

const shortAddress = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

/** Parse SLACK_MENTION env: channel | here | everyone | none | U0123ABC (user id) */
export const parseSlackMention = (raw?: string): SlackMention => {
    const v = (raw ?? 'channel').trim();
    if (!v || ['none', 'off', 'false'].includes(v.toLowerCase())) return '';
    const lower = v.toLowerCase();
    if (lower === 'channel') return '<!channel>';
    if (lower === 'here') return '<!here>';
    if (lower === 'everyone') return '<!everyone>';
    if (v.startsWith('<') && v.endsWith('>')) return v;
    if (/^U[A-Z0-9]+$/i.test(v)) return `<@${v.toUpperCase()}>`;
    return `<!${lower}>`;
};

const withMention = (text: string, mention: SlackMention): string =>
    mention ? `${mention} ${text}` : text;

const mentionBlocks = (mention: SlackMention): Record<string, unknown>[] =>
    mention
        ? [{ type: 'section', text: { type: 'mrkdwn', text: mention } }]
        : [];

export interface SlackNotifyOptions {
    mention?: SlackMention;
}

export interface PositionAlertDetails {
    wallet: string;
    name?: string;
    title?: string;
    outcome?: string;
    size?: number;
    avgPrice?: number;
    curPrice?: number;
    currentValue?: number;
    cashPnl?: number;
    percentPnl?: number;
    slug?: string;
    eventSlug?: string;
    endDate?: string;
    profileUrl?: string;
    label?: string;
}

const positionMarketUrl = (pos: PositionAlertDetails): string | undefined => {
    if (pos.eventSlug) return `https://polymarket.com/event/${pos.eventSlug}`;
    if (pos.slug) return `https://polymarket.com/market/${pos.slug}`;
    return undefined;
};

export const sendSlackPositionAlert = async (
    webhookUrl: string,
    pos: PositionAlertDetails,
    options: SlackNotifyOptions = {}
): Promise<void> => {
    const mention = options.mention ?? '';
    const wallet = pos.wallet.toLowerCase();
    const profile = pos.profileUrl || `https://polymarket.com/profile/${wallet}`;
    const displayName = pos.name?.trim() || shortAddress(wallet);
    const title = pos.title || 'Unknown market';
    const mktUrl = positionMarketUrl(pos);

    const fields: Array<{ type: 'mrkdwn'; text: string }> = [
        { type: 'mrkdwn', text: `*Trader:*\n<${profile}|${displayName}>` },
    ];

    if (pos.outcome) {
        fields.push({ type: 'mrkdwn', text: `*Outcome:*\n${pos.outcome}` });
    }
    if (pos.size != null) {
        fields.push({ type: 'mrkdwn', text: `*Size:*\n${pos.size.toFixed(2)} shares` });
    }
    if (pos.avgPrice != null) {
        fields.push({ type: 'mrkdwn', text: `*Avg entry:*\n$${pos.avgPrice.toFixed(4)}` });
    }
    if (pos.curPrice != null) {
        fields.push({ type: 'mrkdwn', text: `*Current:*\n$${pos.curPrice.toFixed(4)}` });
    }
    if (pos.currentValue != null) {
        fields.push({ type: 'mrkdwn', text: `*Value:*\n$${pos.currentValue.toFixed(2)}` });
    }
    if (pos.percentPnl != null) {
        const sign = pos.percentPnl >= 0 ? '+' : '';
        fields.push({ type: 'mrkdwn', text: `*PnL:*\n${sign}${pos.percentPnl.toFixed(1)}%` });
    }
    if (pos.endDate) {
        fields.push({ type: 'mrkdwn', text: `*End date:*\n${pos.endDate}` });
    }

    const header = pos.label
        ? `📊 ${pos.label}: ${displayName} — active position`
        : `📊 ${displayName} — active position`;

    const blocks: Record<string, unknown>[] = [
        ...mentionBlocks(mention),
        {
            type: 'header',
            text: { type: 'plain_text', text: header, emoji: true },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: mktUrl ? `*${title}*\n<${mktUrl}|View market>` : `*${title}*`,
            },
        },
        { type: 'section', fields },
    ];

    const fallback = withMention(
        `${displayName} holds ${pos.outcome || 'position'} on ${title}${pos.currentValue != null ? ` ($${pos.currentValue.toFixed(2)})` : ''}`,
        mention
    );

    await axios.post(
        webhookUrl,
        { text: fallback, blocks },
        { timeout: 10_000, headers: { 'Content-Type': 'application/json' } }
    );
};

export interface TradeAlertDetails {
    wallet: string;
    name?: string;
    side: string;
    title?: string;
    outcome?: string;
    price?: number;
    size?: number;
    usdSize?: number;
    slug?: string;
    eventSlug?: string;
    txHash?: string;
    timestamp?: number;
    profileUrl?: string;
    label?: string;
}

const formatEastern = (timestampMs: number): string =>
    new Date(timestampMs).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'medium',
        timeStyle: 'short',
    });

const sideEmoji = (side: string): string => {
    const s = side.toUpperCase();
    if (s === 'BUY') return '🟢';
    if (s === 'SELL') return '🔴';
    return '⚪';
};

const marketUrl = (trade: TradeAlertDetails): string | undefined => {
    if (trade.eventSlug) return `https://polymarket.com/event/${trade.eventSlug}`;
    if (trade.slug) return `https://polymarket.com/market/${trade.slug}`;
    return undefined;
};

export const sendSlackTradeAlert = async (
    webhookUrl: string,
    trade: TradeAlertDetails,
    options: SlackNotifyOptions = {}
): Promise<void> => {
    const mention = options.mention ?? '';
    const wallet = trade.wallet.toLowerCase();
    const profile = trade.profileUrl || `https://polymarket.com/profile/${wallet}`;
    const displayName = trade.name?.trim() || shortAddress(wallet);
    const side = (trade.side || 'TRADE').toUpperCase();
    const usd =
        trade.usdSize ??
        (trade.price != null && trade.size != null ? trade.price * trade.size : undefined);
    const tsMs =
        trade.timestamp != null
            ? trade.timestamp >= 1e12
                ? trade.timestamp
                : trade.timestamp * 1000
            : Date.now();

    const title = trade.title || 'Unknown market';
    const mktUrl = marketUrl(trade);

    const fields: Array<{ type: 'mrkdwn'; text: string }> = [
        { type: 'mrkdwn', text: `*Trader:*\n<${profile}|${displayName}>` },
        { type: 'mrkdwn', text: `*Side:*\n${sideEmoji(side)} ${side}` },
    ];

    if (trade.outcome) {
        fields.push({ type: 'mrkdwn', text: `*Outcome:*\n${trade.outcome}` });
    }
    if (trade.price != null) {
        fields.push({ type: 'mrkdwn', text: `*Price:*\n$${trade.price.toFixed(4)}` });
    }
    if (trade.size != null) {
        fields.push({ type: 'mrkdwn', text: `*Size:*\n${trade.size.toFixed(2)} shares` });
    }
    if (usd != null) {
        fields.push({ type: 'mrkdwn', text: `*Notional:*\n$${usd.toFixed(2)}` });
    }
    fields.push({ type: 'mrkdwn', text: `*Time (ET):*\n${formatEastern(tsMs)}` });

    const header = trade.label
        ? `${sideEmoji(side)} ${trade.label}: ${displayName} ${side}`
        : `${sideEmoji(side)} ${displayName} started trading — ${side}`;

    const blocks: Record<string, unknown>[] = [
        ...mentionBlocks(mention),
        {
            type: 'header',
            text: { type: 'plain_text', text: header, emoji: true },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: mktUrl ? `*${title}*\n<${mktUrl}|View market>` : `*${title}*`,
            },
        },
        { type: 'section', fields },
    ];

    if (trade.txHash) {
        blocks.push({
            type: 'context',
            elements: [
                {
                    type: 'mrkdwn',
                    text: `<https://polygonscan.com/tx/${trade.txHash}|Polygonscan tx> · \`${trade.txHash.slice(0, 10)}...\``,
                },
            ],
        });
    }

    const fallback = withMention(
        `${displayName} ${side} ${title}${usd != null ? ` ($${usd.toFixed(2)})` : ''}`,
        mention
    );

    await axios.post(
        webhookUrl,
        { text: fallback, blocks },
        { timeout: 10_000, headers: { 'Content-Type': 'application/json' } }
    );
};

export const sendSlackMessage = async (
    webhookUrl: string,
    text: string,
    options: SlackNotifyOptions = {}
): Promise<void> => {
    const mention = options.mention ?? '';
    await axios.post(
        webhookUrl,
        { text: withMention(text, mention) },
        { timeout: 10_000 }
    );
};
