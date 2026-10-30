import { execFileSync } from 'node:child_process';
import { DeepSeekProvider } from '../src/agent/providers/deepseek.ts';

export const PROXY_BODY_LIMIT = 256_000;
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Read the actual Windows user environment when Codex predates the key setup.
// The result stays in this Node process; never print it or write it to disk.
export function userApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (process.platform !== 'win32') return '';
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[Console]::Write([Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User'))",
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 },
  ).trim();
}

function validInput(value) {
  if (!value || Object.keys(value).sort().join() !== 'messages,tools') return false;
  if (
    !Array.isArray(value.messages) ||
    !value.messages.length ||
    value.messages.length > 100 ||
    !Array.isArray(value.tools) ||
    value.tools.length > 32
  )
    return false;
  return (
    value.messages.every(
      (m) =>
        m &&
        ['system', 'user', 'assistant', 'tool'].includes(m.role) &&
        typeof m.content === 'string' &&
        Object.keys(m).every((k) => ['role', 'content', 'calls', 'toolName'].includes(k)) &&
        (m.toolName === undefined || typeof m.toolName === 'string') &&
        (m.calls === undefined ||
          (Array.isArray(m.calls) &&
            m.calls.length <= 8 &&
            m.calls.every(
              (c) =>
                c &&
                typeof c.name === 'string' &&
                Object.keys(c).sort().join() === 'arguments,name',
            ))),
    ) &&
    value.tools.every(
      (t) =>
        t &&
        typeof t.name === 'string' &&
        typeof t.description === 'string' &&
        t.inputSchema &&
        typeof t.inputSchema === 'object' &&
        Object.keys(t).every((k) =>
          ['name', 'description', 'inputSchema', 'outputSchema'].includes(k),
        ),
    )
  );
}

export function createDeepSeekMiddleware({
  providerFactory = () => new DeepSeekProvider(userApiKey()),
  timeoutMs = 60_000,
} = {}) {
  const active = new Set();
  const middleware = async (req, res, next) => {
    if (!req.url?.startsWith('/__deepseek/')) return next();
    const send = (status, data) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.end(JSON.stringify(data));
    };
    // Exact Host/Origin plus socket checks prevent DNS rebinding and cross-site use.
    const host = req.headers.host;
    const port = req.socket.localPort;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (
      !loopback.has(req.socket.remoteAddress) ||
      !loopback.has(req.socket.localAddress) ||
      !allowedHosts.includes(host) ||
      req.headers.origin !== `http://${host}` ||
      (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
    )
      return send(403, { error: 'DEEPSEEK_PROXY_ORIGIN_REJECTED' });
    if (req.method !== 'POST') return send(405, { error: 'DEEPSEEK_PROXY_POST_REQUIRED' });
    if (!['/__deepseek/probe', '/__deepseek/complete'].includes(req.url))
      return send(404, { error: 'DEEPSEEK_PROXY_ROUTE_REJECTED' });
    if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'])
      return send(415, { error: 'DEEPSEEK_PROXY_JSON_REQUIRED' });
    if (Number(req.headers['content-length']) > PROXY_BODY_LIMIT)
      return send(413, { error: 'DEEPSEEK_PROXY_BODY_LIMIT' });
    const controller = new AbortController();
    active.add(controller);
    const stop = () => controller.abort();
    const timer = setTimeout(() => {
      controller.abort();
      send(504, { error: 'DEEPSEEK_PROXY_TIMEOUT' });
      req.destroy();
    }, timeoutMs);
    req.once('aborted', stop);
    res.once('close', stop);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > PROXY_BODY_LIMIT) {
          send(413, { error: 'DEEPSEEK_PROXY_BODY_LIMIT' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: 'DEEPSEEK_PROXY_INVALID_JSON' });
      }
      const probe = req.url === '/__deepseek/probe';
      if (
        probe
          ? !input || Array.isArray(input) || Object.keys(input).length !== 0
          : !validInput(input)
      )
        return send(400, { error: 'DEEPSEEK_PROXY_INVALID_INPUT' });
      const provider = providerFactory();
      const result = probe
        ? await provider.probe(controller.signal)
        : await provider.complete({ ...input, signal: controller.signal });
      if (!controller.signal.aborted) send(200, result);
    } catch {
      // Do not propagate upstream bodies, network diagnostics, headers or credentials.
      send(controller.signal.aborted ? 504 : 502, {
        error: controller.signal.aborted
          ? 'DEEPSEEK_PROXY_TIMEOUT'
          : 'DEEPSEEK_PROXY_REQUEST_FAILED',
      });
    } finally {
      clearTimeout(timer);
      active.delete(controller);
      req.off('aborted', stop);
      res.off('close', stop);
    }
  };
  return {
    middleware,
    close: () => {
      for (const c of active) c.abort();
    },
  };
}

export function deepSeekProxy() {
  const proxies = new Set();
  const install = (server) => {
    const proxy = createDeepSeekMiddleware();
    proxies.add(proxy);
    server.middlewares.use(proxy.middleware);
    server.httpServer?.once('close', proxy.close);
  };
  return {
    name: 'loopback-deepseek-proxy',
    configResolved(config) {
      for (const host of [config.server.host, config.preview.host])
        if (!['127.0.0.1', 'localhost', '::1'].includes(host))
          throw new Error('DEEPSEEK_PROXY_LOOPBACK_ONLY');
    },
    configureServer: install,
    configurePreviewServer: install,
    closeBundle() {
      for (const proxy of proxies) proxy.close();
      proxies.clear();
    },
  };
}
