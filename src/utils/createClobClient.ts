import { ethers } from 'ethers';
import type { ApiKeyCreds } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import Logger from './logger';
import { configureSocksProxyFromEnv } from './proxy';
import { withSilencedSdkConsole } from './clobSdkSilence';
import { describeClobSignature, resolveClobSignature } from './resolveClobSignature';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const CLOB_SIGNATURE_TYPE = ENV.CLOB_SIGNATURE_TYPE;

const isCompleteApiCreds = (c: ApiKeyCreds | undefined): c is ApiKeyCreds =>
    Boolean(
        c &&
            typeof c.key === 'string' &&
            c.key.trim() !== '' &&
            typeof c.secret === 'string' &&
            c.secret.trim() !== '' &&
            typeof c.passphrase === 'string' &&
            c.passphrase.trim() !== ''
    );

const createClobClient = async (): Promise<
    import('@polymarket/clob-client-v2').ClobClient
> => {
    const { ClobClient, Chain } = await import('@polymarket/clob-client-v2');
    const host = CLOB_HTTP_URL as string;
    const wallet = new ethers.Wallet(PRIVATE_KEY as string);
    configureSocksProxyFromEnv(ENV.SOCKS_PROXY_URL);

    let signatureType: import('@polymarket/clob-client-v2').SignatureTypeV2;
    let passProxyWallet: string | undefined;

    const resolved = resolveClobSignature(CLOB_SIGNATURE_TYPE, PROXY_WALLET);
    signatureType = resolved.signatureType;
    passProxyWallet = resolved.funderAddress;
    Logger.info(`CLOB signature type: ${describeClobSignature(resolved)}`);

    const clientOptsBase = {
        host,
        chain: Chain.POLYGON,
        signer: wallet,
        signatureType,
        funderAddress: passProxyWallet,
        useServerTime: true,
    };

    let clobClient = new ClobClient({ ...clientOptsBase });

    let creds: ApiKeyCreds | undefined = await withSilencedSdkConsole(
        ENV.CLOB_SDK_SILENCE_ERRORS,
        () => clobClient.createOrDeriveApiKey()
    );
    if (!isCompleteApiCreds(creds)) {
        const bad = creds as Partial<ApiKeyCreds> | undefined;
        const missing: string[] = [];
        if (!bad?.key?.trim()) missing.push('key');
        if (!bad?.secret?.trim()) missing.push('secret');
        if (!bad?.passphrase?.trim()) missing.push('passphrase');
        throw new Error(
            `CLOB API credentials incomplete after createOrDeriveApiKey (missing: ${missing.join(', ') || 'unknown'}). ` +
                'Fix: ensure PRIVATE_KEY matches your Polymarket account, or set CLOB_SIGNATURE_TYPE correctly.'
        );
    }

    clobClient = new ClobClient({
        ...clientOptsBase,
        creds,
    });

    return clobClient;
};

export default createClobClient;
