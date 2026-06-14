import { ethers } from 'ethers';
import type { ClobClient } from '@polymarket/clob-client-v2';
import { AssetType } from '@polymarket/clob-client-v2';
import getMyBalance from './getMyBalance';

/**
 * USDC collateral deposited for trading in the Polymarket CLOB (matches UI "Cash").
 * Raw `balance` from the API is 6-decimal fixed-point (same as USDC).
 */
export async function getClobCollateralUsdc(clobClient: ClobClient): Promise<number> {
    const params = { asset_type: AssetType.COLLATERAL } as const;
    try {
        await clobClient.updateBalanceAllowance(params);
    } catch {
        // Continue — stale cache is still better than failing entirely.
    }
    const { balance } = await clobClient.getBalanceAllowance(params);
    return parseFloat(ethers.utils.formatUnits(balance, 6));
}

/**
 * USDC available for sizing CLOB BUY orders: prefer CLOB collateral (Polymarket cash);
 * if CLOB is zero, fall back to on-chain wallet USDC (EOA / proxy ERC20 balance).
 */
export async function getSpendableUsdcForBuys(
    clobClient: ClobClient,
    proxyWallet: string
): Promise<number> {
    let clob = 0;
    try {
        clob = await getClobCollateralUsdc(clobClient);
    } catch {
        // Fall back to on-chain only
    }
    if (clob > 0) {
        return clob;
    }
    return getMyBalance(proxyWallet);
}
