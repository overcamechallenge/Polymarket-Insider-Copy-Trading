import { SignatureTypeV2 } from '@polymarket/clob-client-v2';

export interface ClobSignatureConfig {
    signatureType: SignatureTypeV2;
    funderAddress: string | undefined;
}

/**
 * Resolve Polymarket CLOB signature mode.
 *
 * Standard Polymarket accounts (email / magic-link) use a proxy contract with POLY_PROXY.
 * Only set POLY_GNOSIS_SAFE when you imported a separate Gnosis Safe as your funder.
 */
export const resolveClobSignature = (
    signatureTypeEnv: string | undefined,
    proxyWallet: string | undefined
): ClobSignatureConfig => {
    const sig = (signatureTypeEnv || '').toUpperCase();
    const proxy = proxyWallet?.trim();

    if (sig === 'POLY_PROXY') {
        return { signatureType: SignatureTypeV2.POLY_PROXY, funderAddress: proxy };
    }
    if (sig === 'POLY_GNOSIS_SAFE') {
        return { signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE, funderAddress: proxy };
    }
    if (sig === 'EOA') {
        return { signatureType: SignatureTypeV2.EOA, funderAddress: undefined };
    }

    // Auto: PROXY_WALLET present → Polymarket proxy (not Gnosis Safe detection via getCode).
    if (proxy) {
        return { signatureType: SignatureTypeV2.POLY_PROXY, funderAddress: proxy };
    }

    return { signatureType: SignatureTypeV2.EOA, funderAddress: undefined };
};

export const describeClobSignature = (cfg: ClobSignatureConfig): string => {
    switch (cfg.signatureType) {
        case SignatureTypeV2.POLY_PROXY:
            return 'POLY_PROXY';
        case SignatureTypeV2.POLY_GNOSIS_SAFE:
            return 'POLY_GNOSIS_SAFE';
        default:
            return 'EOA';
    }
};
