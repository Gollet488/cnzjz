import { createServer } from 'node:http';
import { publicCloudConfiguration } from './cloud-model-config.mjs';
import { createDeepSeekMiddleware } from './deepseek-proxy.mjs';

const origin = new URL(process.env.AGENT_PUBLIC_ORIGIN ?? '');
if (
  origin.protocol !== 'https:' ||
  origin.href !== `${origin.origin}/` ||
  origin.username ||
  origin.password
)
  throw new Error('AGENT_PUBLIC_ORIGIN must be an HTTPS origin without a path or credentials');

const port = Number(process.env.AGENT_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('AGENT_PORT must be a valid TCP port');

const cloud = publicCloudConfiguration();
if (cloud.catalog.providers.some((provider) => provider.missing.length))
  throw new Error('Cloud endpoint configuration must use provider-approved HTTPS URLs');

const proxy = createDeepSeekMiddleware({ cloud, publicOrigin: origin.origin });
const server = createServer(
  { headersTimeout: 5000, requestTimeout: 15_000, connectionsCheckingInterval: 1000 },
  (req, res) => {
    void proxy.middleware(req, res, () => res.writeHead(404).end());
  },
);
server.maxConnections = 256;
server.on('checkContinue', (_req, res) => res.writeHead(417).end());
server.listen(port, '127.0.0.1', () => console.log(`Agent API listening on 127.0.0.1:${port}`));

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    proxy.close();
    server.close();
    server.closeAllConnections();
  });
