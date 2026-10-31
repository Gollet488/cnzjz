import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createDeepSeekMiddleware, PROXY_BODY_LIMIT } from '../scripts/deepseek-proxy.mjs';
import { DeepSeekProvider } from '../src/agent/providers/deepseek.ts';
import { createServer as createViteServer, preview } from 'vite';

const fakeKey = 'test-only-proxy-secret';
const valid = { messages: [{ role: 'user', content: '查询质量' }], tools: [] };

test('development and production refuse a public bind before listening', async () => {
  await assert.rejects(
    createViteServer({ server: { host: '0.0.0.0' } }),
    /DEEPSEEK_PROXY_LOOPBACK_ONLY/,
  );
  await assert.rejects(preview({ preview: { host: '0.0.0.0' } }), /DEEPSEEK_PROXY_LOOPBACK_ONLY/);
});
async function fixture(options: any = {}) {
  const proxy = createDeepSeekMiddleware(options);
  const server = createServer((req, res) =>
    proxy.middleware(req, res, () => {
      res.writeHead(404);
      res.end();
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as any).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    proxy,
    origin,
    async close() {
      proxy.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function post(origin: string, body: any = valid, extra: any = {}) {
  return fetch(origin + '/__deepseek/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...extra.headers },
    body: JSON.stringify(body),
    ...extra,
  });
}

test('proxy enforces exact Host/Origin, same-origin metadata, POST/JSON and fixed route before provider IO', async () => {
  let calls = 0;
  const f = await fixture({
    providerFactory: () => {
      calls++;
      throw Error('must not reach IO');
    },
  });
  try {
    for (const headers of [
      { Origin: 'https://attacker.invalid' },
      { Origin: '' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ])
      assert.equal(
        (
          await post(f.origin, valid, {
            headers: { 'Content-Type': 'application/json', Origin: f.origin, ...headers },
          })
        ).status,
        403,
        JSON.stringify(headers),
      );
    assert.equal(
      await new Promise((resolve) => {
        const req = request(
          f.origin + '/__deepseek/complete',
          {
            method: 'POST',
            headers: {
              Host: 'attacker.invalid',
              Origin: f.origin,
              'Content-Type': 'application/json',
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.end(JSON.stringify(valid));
      }),
      403,
    );
    assert.equal(
      (await fetch(f.origin + '/__deepseek/complete', { headers: { Origin: f.origin } })).status,
      405,
    );
    assert.equal(
      (await post(f.origin, valid, { headers: { Origin: f.origin, 'Content-Type': 'text/plain' } }))
        .status,
      415,
    );
    assert.equal(
      (
        await fetch(f.origin + '/__deepseek/complete?url=https://attacker.invalid', {
          method: 'POST',
          headers: { Origin: f.origin },
        })
      ).status,
      404,
    );
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test('proxy rejects target/config/key overrides, malformed history, oversized declared and chunked bodies', async () => {
  let calls = 0;
  const f = await fixture({
    providerFactory: () => {
      calls++;
      throw Error('unexpected');
    },
  });
  try {
    for (const body of [
      { ...valid, url: 'https://attacker.invalid' },
      { ...valid, model: 'other' },
      { ...valid, apiKey: fakeKey },
      { ...valid, temperature: 1 },
      { ...valid, messages: [{ role: 'image', content: 'data:' }] },
      { ...valid, messages: [{ role: 'user', content: 'ok', extra: true }] },
      { ...valid, messages: [{ role: 'assistant', content: '', calls: [{ name: 'x' }] }] },
    ])
      assert.equal((await post(f.origin, body)).status, 400);
    assert.equal(
      (
        await post(f.origin, {
          ...valid,
          messages: [{ role: 'user', content: 'x'.repeat(PROXY_BODY_LIMIT) }],
        })
      ).status,
      413,
    );
    const status = await new Promise((resolve) => {
      const req = request(
        f.origin + '/__deepseek/complete',
        {
          method: 'POST',
          headers: {
            Origin: f.origin,
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', () => {});
      req.write('x'.repeat(PROXY_BODY_LIMIT));
      req.end('x');
    });
    assert.equal(status, 413);
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test('proxy reuses official adapter, fixes inference, preserves actual model/null fingerprint and keeps credentials server-only', async () => {
  const upstream: any[] = [];
  const f = await fixture({
    providerFactory: () =>
      new DeepSeekProvider(fakeKey, 'deepseek-flash', async (url: any, init: any) => {
        upstream.push({ url, init });
        assert.equal(url, 'https://api.deepseek.com/chat/completions');
        assert.equal(init.headers.Authorization, `Bearer ${fakeKey}`);
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'deepseek-flash');
        assert.equal(body.temperature, 0);
        assert.equal(body.max_tokens, 2048);
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.equal(body.stream, false);
        assert.equal(body.tool_choice, 'auto');
        assert.ok(!init.body.includes(fakeKey));
        return new Response(
          JSON.stringify({
            id: 'real-wire-test',
            model: 'returned-alias',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'c1',
                      type: 'function',
                      function: { name: 'connection_check', arguments: '{"echo":"kinetic"}' },
                    },
                  ],
                },
              },
            ],
          }),
        );
      }),
  });
  try {
    const result = await post(f.origin);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('access-control-allow-origin'), null);
    const text = await result.text();
    assert.ok(!text.includes(fakeKey));
    assert.equal(JSON.parse(text).response.systemFingerprint, null);
    assert.equal(JSON.parse(text).response.model, 'returned-alias');
    const probe = await fetch(f.origin + '/__deepseek/probe', {
      method: 'POST',
      headers: { Origin: f.origin, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).requests, 1);
    assert.equal(upstream.length, 2);
  } finally {
    await f.close();
  }
});

test('proxy never returns upstream diagnostics or echoed key and does not retry', async () => {
  let calls = 0;
  const f = await fixture({
    providerFactory: () =>
      new DeepSeekProvider(fakeKey, 'deepseek-flash', async () => {
        calls++;
        return new Response(fakeKey, { status: 401 });
      }),
  });
  try {
    const r = await post(f.origin);
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'DEEPSEEK_PROXY_REQUEST_FAILED' });
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test('proxy aborts upstream on timeout, browser disconnect and service close', async () => {
  for (const mode of ['timeout', 'disconnect', 'close']) {
    let started!: () => void, aborted!: () => void;
    const start = new Promise<void>((r) => {
        started = r;
      }),
      abort = new Promise<void>((r) => {
        aborted = r;
      });
    const f = await fixture({
      timeoutMs: mode === 'timeout' ? 40 : 1000,
      providerFactory: () => ({
        complete: ({ signal }: any) =>
          new Promise((_resolve, reject) => {
            started();
            signal.addEventListener(
              'abort',
              () => {
                aborted();
                reject(Error('aborted'));
              },
              { once: true },
            );
          }),
      }),
    });
    try {
      const controller = new AbortController();
      const pending = post(f.origin, valid, { signal: controller.signal }).catch(() => null);
      await start;
      if (mode === 'disconnect') controller.abort();
      if (mode === 'close') f.proxy.close();
      await Promise.race([
        abort,
        new Promise((_, reject) => setTimeout(() => reject(Error('abort missing')), 2000)),
      ]);
      const r = await pending;
      if (mode === 'timeout' && r) assert.equal(r.status, 504);
    } finally {
      await f.close();
    }
  }
});
