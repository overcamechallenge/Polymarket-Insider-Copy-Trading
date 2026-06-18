import * as dotenv from 'dotenv';
import { CopyStrategy, CopyStrategyConfig, parseTieredMultipliers } from './copyStrategy';

dotenv.config();

const isValidEthereumAddress = (address: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(address);

const liveTrading =
    (process.env.WHALE_POSITION_DRY_RUN || 'true').toLowerCase() !== 'true' &&
    (process.env.WHALE_POSITION_PAPER_TRADING || 'false').toLowerCase() !== 'true';

const validateRequiredEnv = (): void => {
    const required: string[] = [];

    if (liveTrading) {
        required.push(
            'PROXY_WALLET',
            'PRIVATE_KEY',
            'CLOB_HTTP_URL',
            'RPC_URL',
            'USDC_CONTRACT_ADDRESS'
        );
    }

    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
};

const validateAddresses = (): void => {
    if (process.env.PROXY_WALLET && !isValidEthereumAddress(process.env.PROXY_WALLET)) {
        throw new Error(`Invalid PROXY_WALLET address format: ${process.env.PROXY_WALLET}`);
    }

    if (
        process.env.USDC_CONTRACT_ADDRESS &&
        !isValidEthereumAddress(process.env.USDC_CONTRACT_ADDRESS)
    ) {
        throw new Error(
            `Invalid USDC_CONTRACT_ADDRESS format: ${process.env.USDC_CONTRACT_ADDRESS}`
        );
    }
};

const validateUrls = (): void => {
    if (process.env.CLOB_HTTP_URL && !process.env.CLOB_HTTP_URL.startsWith('http')) {
        throw new Error(`Invalid CLOB_HTTP_URL: ${process.env.CLOB_HTTP_URL}`);
    }

    if (process.env.RPC_URL && !process.env.RPC_URL.startsWith('http')) {
        throw new Error(`Invalid RPC_URL: ${process.env.RPC_URL}`);
    }

    if (process.env.SOCKS_PROXY_URL) {
        const v = process.env.SOCKS_PROXY_URL;
        const ok =
            v.startsWith('socks://') || v.startsWith('socks5://') || v.startsWith('socks5h://');
        if (!ok) {
            throw new Error('Invalid SOCKS_PROXY_URL. Use socks5h://username:password@host:port');
        }
    }
};

const parseCopyStrategy = (): CopyStrategyConfig => {
    const strategyStr = (process.env.COPY_STRATEGY || 'PERCENTAGE').toUpperCase();
    const strategy =
        CopyStrategy[strategyStr as keyof typeof CopyStrategy] || CopyStrategy.PERCENTAGE;

    const config: CopyStrategyConfig = {
        strategy,
        copySize: parseFloat(process.env.COPY_SIZE || '10.0'),
        maxOrderSizeUSD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '100.0'),
        minOrderSizeUSD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1.0'),
        maxPositionSizeUSD: (() => {
            const raw = process.env.MAX_POSITION_SIZE_USD;
            if (raw === undefined || raw.trim() === '') return undefined;
            const v = parseFloat(raw);
            if (!Number.isFinite(v) || v <= 0) return undefined;
            return v;
        })(),
        maxDailyVolumeUSD: process.env.MAX_DAILY_VOLUME_USD
            ? parseFloat(process.env.MAX_DAILY_VOLUME_USD)
            : undefined,
    };

    if (strategy === CopyStrategy.ADAPTIVE) {
        config.adaptiveMinPercent = parseFloat(
            process.env.ADAPTIVE_MIN_PERCENT || config.copySize.toString()
        );
        config.adaptiveMaxPercent = parseFloat(
            process.env.ADAPTIVE_MAX_PERCENT || config.copySize.toString()
        );
        config.adaptiveThreshold = parseFloat(process.env.ADAPTIVE_THRESHOLD_USD || '500.0');
    }

    if (process.env.TIERED_MULTIPLIERS) {
        config.tieredMultipliers = parseTieredMultipliers(process.env.TIERED_MULTIPLIERS);
    } else if (process.env.TRADE_MULTIPLIER) {
        const singleMultiplier = parseFloat(process.env.TRADE_MULTIPLIER);
        if (singleMultiplier !== 1.0) {
            config.tradeMultiplier = singleMultiplier;
        }
    }

    return config;
};

validateRequiredEnv();
validateAddresses();
validateUrls();

export const ENV = {
    PROXY_WALLET: process.env.PROXY_WALLET || '',
    PRIVATE_KEY: process.env.PRIVATE_KEY || '',
    CLOB_HTTP_URL: process.env.CLOB_HTTP_URL || 'https://clob.polymarket.com/',
    CLOB_SIGNATURE_TYPE: (process.env.CLOB_SIGNATURE_TYPE || '').toUpperCase(),
    RETRY_LIMIT: parseInt(process.env.RETRY_LIMIT || '3', 10),
    COPY_STRATEGY_CONFIG: parseCopyStrategy(),
    REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10),
    NETWORK_RETRY_LIMIT: parseInt(process.env.NETWORK_RETRY_LIMIT || '3', 10),
    SOCKS_PROXY_URL: process.env.SOCKS_PROXY_URL,
    RPC_URL: process.env.RPC_URL || 'https://polygon-rpc.com',
    USDC_CONTRACT_ADDRESS:
        process.env.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    CLOB_SDK_SILENCE_ERRORS: process.env.CLOB_SDK_SILENCE_ERRORS === 'true',
};
