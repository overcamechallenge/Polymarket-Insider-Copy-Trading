import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { ethers } from 'ethers';
import { ENV } from '../config/env';

const RPC_URL = ENV.RPC_URL;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const balanceIface = new ethers.utils.Interface(USDC_ABI);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * JSON-RPC over raw HTTP(S) with an explicit agent — does not use Node's globalAgent,
 * so SOCKS overrides from configureSocksProxyFromEnv do not apply. Required on Node 23+
 * where globalAgent is read-only, and avoids broken eth_call through SOCKS to Infura.
 */
async function postJsonRpc(rpcUrl: string, body: Record<string, unknown>): Promise<string> {
    const u = new URL(rpcUrl);
    const payload = JSON.stringify(body);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const port = u.port ? parseInt(u.port, 10) : defaultPort;
    const path = `${u.pathname || ''}${u.search || ''}` || '/';

    return new Promise((resolve, reject) => {
        const opts: http.RequestOptions = {
            hostname: u.hostname,
            port,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            agent: isHttps
                ? new https.Agent({ keepAlive: true })
                : new http.Agent({ keepAlive: true }),
        };

        const req = lib.request(opts, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (!raw) {
                    reject(new Error(`RPC empty body (HTTP ${res.statusCode ?? '?'})`));
                    return;
                }
                let json: { error?: { message?: string }; result?: unknown };
                try {
                    json = JSON.parse(raw) as typeof json;
                } catch {
                    reject(new Error(`RPC invalid JSON: ${raw.slice(0, 240)}`));
                    return;
                }
                if (json.error) {
                    reject(new Error(json.error.message || JSON.stringify(json.error)));
                    return;
                }
                if (typeof json.result !== 'string') {
                    reject(
                        new Error(
                            `RPC unexpected result type: ${JSON.stringify(json).slice(0, 240)}`
                        )
                    );
                    return;
                }
                resolve(json.result);
            });
        });

        req.on('error', reject);
        req.setTimeout(25_000, () => {
            req.destroy();
            reject(new Error('RPC request timeout'));
        });
        req.write(payload);
        req.end();
    });
}

async function readBalanceOnce(address: string): Promise<number> {
    const data = balanceIface.encodeFunctionData('balanceOf', [address]);
    const hex = await postJsonRpc(RPC_URL, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: USDC_CONTRACT_ADDRESS, data }, 'latest'],
    });
    const decoded = balanceIface.decodeFunctionResult('balanceOf', hex);
    const value = decoded[0] as ethers.BigNumber;
    return parseFloat(ethers.utils.formatUnits(value, 6));
}

const getMyBalance = async (address: string): Promise<number> => {
    const attempts = 3;
    let lastErr: unknown;

    for (let i = 0; i < attempts; i++) {
        try {
            return await readBalanceOnce(address);
        } catch (e) {
            lastErr = e;
            if (i < attempts - 1) {
                await sleep(400 * (i + 1));
            }
        }
    }

    const inner = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(
        `USDC balanceOf failed after ${attempts} attempts (${inner}). Check RPC_URL and network.`
    );
};

export default getMyBalance;
