import http from 'http';
import https from 'https';

let configured = false;

/**
 * Force ALL outbound HTTP/HTTPS from this Node process through a SOCKS proxy
 * by replacing the global agents. This catches every library (including
 * @polymarket/clob-client which bundles its own private axios).
 */
export const configureSocksProxyFromEnv = (socksProxyUrl?: string) => {
    if (!socksProxyUrl) {
        return {
            socksProxyUrl: undefined,
            httpAgent: undefined,
            httpsAgent: undefined,
        };
    }

    // Use require() to avoid TS/ts-node "exports" resolution issues.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SocksProxyAgent } = require('socks-proxy-agent') as {
        SocksProxyAgent: new (proxy: string) => unknown;
    };
    const agent = new SocksProxyAgent(socksProxyUrl);

    if (!configured) {
        // Override Node's global agents so every http(s) request
        // goes through the SOCKS tunnel — no library can bypass this.
        http.globalAgent = agent as unknown as http.Agent;
        https.globalAgent = agent as unknown as https.Agent;
        configured = true;
    }

    return {
        socksProxyUrl,
        httpAgent: agent,
        httpsAgent: agent,
    };
};
