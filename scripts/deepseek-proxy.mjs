import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { preservesCloudContext, temporaryApiKeyFormat } from '../src/agent/modelCatalog.ts';
import { ProviderResponseError } from '../src/agent/provider.ts';
import { DeepSeekProvider, DeepSeekRequestError } from '../src/agent/providers/deepseek.ts';
import { cloudConfiguration } from './cloud-model-config.mjs';

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
    { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

const failureCodes = {
  configuration: 'DEEPSEEK_PROXY_CONFIGURATION',
  request: 'DEEPSEEK_PROXY_REQUEST_PROTOCOL',
  transport: 'DEEPSEEK_PROXY_TRANSPORT',
  response: 'DEEPSEEK_PROXY_RESPONSE_PROTOCOL',
  probe: 'DEEPSEEK_PROXY_TOOL_PROBE_PROTOCOL',
};

function failureCode(error) {
  if (error instanceof DeepSeekRequestError && Object.hasOwn(failureCodes, error.stage))
    return failureCodes[error.stage];
  if (error instanceof ProviderResponseError) {
    const status = error.failure.httpStatus;
    if (Number.isInteger(status) && status >= 100 && status <= 599)
      return status >= 200 && status < 300
        ? failureCodes.response
        : `DEEPSEEK_PROXY_UPSTREAM_HTTP_${status}`;
  }
  return 'DEEPSEEK_PROXY_UNKNOWN';
}

function validInput(value, nativeIds = false) {
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
        Object.keys(m).every(
          (k) =>
            ['role', 'content', 'calls', 'toolName'].includes(k) ||
            (nativeIds && k === 'toolCallId' && validId(m[k])),
        ) &&
        (m.toolName === undefined || typeof m.toolName === 'string') &&
        (m.calls === undefined ||
          (Array.isArray(m.calls) &&
            m.calls.length <= 8 &&
            m.calls.every(
              (c) =>
                c &&
                typeof c.name === 'string' &&
                Object.hasOwn(c, 'arguments') &&
                Object.keys(c).every(
                  (k) =>
                    ['arguments', 'name'].includes(k) || (nativeIds && k === 'id' && validId(c[k])),
                ),
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

const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200;
const validTaskId = (id) => typeof id === 'string' && /^[\da-f-]{36}$/i.test(id);

export function createDeepSeekMiddleware({
  providerFactory = () => new DeepSeekProvider(userApiKey()),
  cloud,
  timeoutMs = 60_000,
  publicOrigin,
} = {}) {
  const active = new Set();
  const responses = new Map();
  const clients = new Map();
  const publicHost = publicOrigin && new URL(publicOrigin).host;
  let resetAt = 0;

  function allowPublicRequest(ip) {
    const now = Date.now();
    if (now >= resetAt) {
      clients.clear();
      resetAt = now + 60_000;
    }
    const count = clients.get(ip) ?? 0;
    if (count >= 90 || (!count && clients.size >= 4096)) return false;
    clients.set(ip, count + 1);
    return true;
  }

  const middleware = async (req, res, next) => {
    const cloudRoute = cloud && req.url?.startsWith('/__models/');
    if (!cloudRoute && (publicOrigin || !req.url?.startsWith('/__deepseek/'))) return next();
    const prefix = cloudRoute ? 'CLOUD' : 'DEEPSEEK_PROXY';
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
    const host = req.headers.host;
    const port = req.socket.localPort;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    // Public mode trusts forwarding headers only from a local TLS terminator.
    const client = req.headers['x-real-ip'];
    if (
      !loopback.has(req.socket.remoteAddress) ||
      !loopback.has(req.socket.localAddress) ||
      (publicOrigin
        ? host !== publicHost ||
          req.headers.origin !== publicOrigin ||
          req.headers['x-forwarded-proto'] !== 'https' ||
          typeof client !== 'string' ||
          !isIP(client)
        : !allowedHosts.includes(host) || req.headers.origin !== `http://${host}`) ||
      (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
    )
      return send(403, { error: prefix + '_ORIGIN_REJECTED' });
    if (req.method !== 'POST') return send(405, { error: 'DEEPSEEK_PROXY_POST_REQUIRED' });
    const routes = cloudRoute
      ? ['/__models/catalog', '/__models/probe', '/__models/complete', '/__models/release']
      : ['/__deepseek/probe', '/__deepseek/complete'];
    if (!routes.includes(req.url)) return send(404, { error: 'DEEPSEEK_PROXY_ROUTE_REJECTED' });
    if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'])
      return send(415, { error: 'DEEPSEEK_PROXY_JSON_REQUIRED' });
    if (Number(req.headers['content-length']) > PROXY_BODY_LIMIT)
      return send(413, { error: 'DEEPSEEK_PROXY_BODY_LIMIT' });
    if (publicOrigin && (!allowPublicRequest(client) || active.size >= 24))
      return send(429, { error: 'CLOUD_PROXY_BUSY' });
    const controller = new AbortController();
    active.add(controller);
    const stop = () => controller.abort();
    const timer = setTimeout(() => {
      controller.abort('timeout');
      // Let the 504 flush before closing a connection with an unfinished upload.
      if (!req.complete) res.once('finish', () => req.destroy());
      send(504, { error: prefix + '_TIMEOUT' });
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
      if (req.url === '/__models/catalog') return send(200, cloud.catalog);
      if (req.url === '/__models/release') {
        if (!validTaskId(input?.task) || Object.keys(input).join() !== 'task')
          return send(400, { error: 'CLOUD_INVALID_INPUT' });
        const state = responses.get(input.task);
        if (state) {
          clearTimeout(state.expiry);
          responses.delete(input.task);
          state.controller?.abort();
        }
        return send(200, { released: true });
      }
      const probe = req.url.endsWith('/probe');
      if (cloudRoute) {
        const { provider, model, task, apiKey, ...inputFields } = input ?? {};
        if (
          !validId(provider) ||
          !validId(model) ||
          (apiKey !== undefined &&
            (typeof apiKey !== 'string' ||
              !temporaryApiKeyFormat.test(apiKey) ||
              apiKey === model)) ||
          (probe
            ? task !== undefined || Object.keys(inputFields).length !== 0
            : !validInput(inputFields, provider !== 'deepseek') || !validTaskId(task))
        )
          return send(400, { error: 'CLOUD_INVALID_INPUT' });
        if (publicOrigin && !apiKey) return send(400, { error: 'CLOUD_KEY_REQUIRED' });
        controller.signal.throwIfAborted();
        let adapter = cloud.create(provider, model, apiKey);
        if (!adapter) return send(409, { error: 'CLOUD_CONFIGURATION' });
        let state;
        if (preservesCloudContext(provider, model) && !probe) {
          const keyDigest = apiKey && createHash('sha256').update(apiKey).digest('hex');
          state = responses.get(task);
          if (
            state?.controller ||
            (state &&
              (state.adapter.id !== adapter.id ||
                state.adapter.model !== model ||
                state.keyDigest !== keyDigest))
          )
            return send(409, { error: 'CLOUD_TASK_CONFLICT' });
          if (!state && responses.size >= 32) return send(429, { error: 'CLOUD_TASK_LIMIT' });
          if (!state && inputFields.messages.some((message) => message.toolCallId))
            return send(409, { error: 'CLOUD_TASK_EXPIRED' });
          state ??= { adapter, keyDigest };
          clearTimeout(state.expiry);
          adapter = state.adapter;
          state.controller = controller;
          responses.set(task, state);
        }
        try {
          const result = probe
            ? await adapter.probe(controller.signal, apiKey)
            : await adapter.complete({ ...inputFields, signal: controller.signal }, apiKey);
          if (!controller.signal.aborted) send(200, result);
          else if (state && responses.get(task) === state) responses.delete(task);
        } catch (error) {
          if (state && responses.get(task) === state) responses.delete(task);
          throw error;
        } finally {
          if (state && responses.get(task) === state) {
            state.controller = undefined;
            state.expiry = setTimeout(() => responses.delete(task), 240_000);
            state.expiry.unref();
          }
        }
        return;
      }
      if (
        probe
          ? !input || Array.isArray(input) || Object.keys(input).length !== 0
          : !validInput(input)
      )
        return send(400, { error: 'DEEPSEEK_PROXY_INVALID_INPUT' });
      let provider;
      try {
        provider = providerFactory();
      } catch {
        return send(502, { error: failureCodes.configuration });
      }
      const result = probe
        ? await provider.probe(controller.signal)
        : await provider.complete({ ...input, signal: controller.signal });
      if (!controller.signal.aborted) send(200, result);
    } catch (error) {
      // Do not propagate upstream bodies, network diagnostics, headers or credentials.
      if (controller.signal.reason === 'timeout') send(504, { error: prefix + '_TIMEOUT' });
      else if (controller.signal.aborted) send(503, { error: prefix + '_CANCELLED' });
      else {
        const legacy = failureCode(error);
        const code = cloudRoute
          ? /^CLOUD_(TRANSPORT|RESPONSE_PROTOCOL|RESPONSE_LIMIT|CONTEXT_LIMIT|TOOL_PROBE_FAILED)$/.test(
              error?.message,
            )
            ? error.message
            : legacy.replace('DEEPSEEK_PROXY_', 'CLOUD_')
          : legacy;
        send(502, { error: code });
      }
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
      for (const state of responses.values()) clearTimeout(state.expiry);
      responses.clear();
    },
  };
}

export function deepSeekProxy() {
  const proxies = new Set();
  const install = (server) => {
    const proxy = createDeepSeekMiddleware({
      cloud: cloudConfiguration(server.config.root, () => {
        try {
          return userApiKey();
        } catch {
          return '';
        }
      }),
    });
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
