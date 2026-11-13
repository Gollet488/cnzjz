import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudApiProvider } from '../src/agent/providers/cloudApi.ts';
import type { ModelMessage } from '../src/agent/provider.ts';
import { cloudConfiguration } from '../scripts/cloud-model-config.mjs';
import { fetchCloudModel } from '../scripts/cloud-transport.mjs';
import { createDeepSeekMiddleware } from '../scripts/deepseek-proxy.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const call = { name: 'compare_intervals', arguments: { joint: 'knee' } };
const messages: ModelMessage[] = [
  { role: 'system', content: 'Use only local tools' },
  { role: 'user', content: '比较左右膝 ROM' },
];
const tools = [
  { name: call.name, description: 'ROM', inputSchema: { type: 'object' }, outputSchema: {} },
];
const signal = new AbortController().signal;

test('cloud transport retries one short explicit rejection and preserves long waits and auth errors', async (t) => {
  const fetcher = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 200 }),
  );
  const send = () => fetchCloudModel('https://api.openai.com/v1/responses', { signal });
  const reply = (status: number, seconds: string) =>
    new Response(null, { status, headers: { 'Retry-After': seconds } });
  fetcher.mock.mockImplementationOnce(async () => reply(429, '0'));
  assert.equal((await send()).status, 200);
  assert.equal(fetcher.mock.callCount(), 2);
  fetcher.mock.mockImplementationOnce(async () => reply(503, '120'));
  assert.equal((await send()).status, 503);
  fetcher.mock.mockImplementationOnce(async () => reply(401, '0'));
  assert.equal((await send()).status, 401);
  assert.equal(fetcher.mock.callCount(), 4);
  fetcher.mock.mockImplementation(async () => reply(529, '0'));
  assert.equal((await send()).status, 529);
  assert.equal(fetcher.mock.callCount(), 6);
});

test('cloud retry stops when the user cancels and does not retry ambiguous transport failures', async (t) => {
  const controller = new AbortController();
  const fetcher = t.mock.method(globalThis, 'fetch', async () => {
    controller.abort();
    return new Response(null, { status: 503 });
  });
  const send = (signal: AbortSignal) =>
    fetchCloudModel('https://api.openai.com/v1/responses', { signal });
  await assert.rejects(send(controller.signal), { name: 'AbortError' });
  assert.equal(fetcher.mock.callCount(), 1);
  fetcher.mock.mockImplementation(async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(send(signal), /fetch failed/);
  assert.equal(fetcher.mock.callCount(), 2);
});

test('a server key alone enables the default preset; invalid region endpoints are never silently replaced', () => {
  const config = cloudConfiguration(tmpdir(), () => '', {
    OPENAI_API_KEY: 'example-configured-key',
    ZHIPU_API_KEY: 'example-glm-key',
    ZHIPU_ENDPOINT: 'https://api.z.ai/incorrect',
  });
  const openai = config.catalog.providers.find((p) => p.provider === 'openai')!;
  assert.equal(openai.models.length, 1);
  assert(config.create('openai', openai.models[0]));
  assert(
    config.catalog.providers
      .find((p) => p.provider === 'zhipu')
      ?.missing.includes('ZHIPU_ENDPOINT'),
  );
  assert.equal(config.create('zhipu', 'glm-5.3', 'example-temporary-key'), undefined);
});

test('GPT probe forces a real tool call without adding its response to analysis context', async () => {
  const bodies: any[] = [];
  const provider = new CloudApiProvider({
    kind: 'openai',
    model: 'gpt-test',
    key: 'example-test-key',
    endpoint: 'https://api.openai.com/v1/responses',
    fetcher: async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      bodies.push(body);
      const probe = body.tools[0].name === 'connection_check';
      return Response.json({
        id: 'resp_test',
        model: 'gpt-test',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_test',
            name: probe ? 'connection_check' : call.name,
            arguments: JSON.stringify(probe ? { echo: 'kinetic' } : call.arguments),
          },
        ],
      });
    },
  });
  assert.equal((await provider.probe(signal)).response?.model, 'gpt-test');
  await provider.complete({ messages, tools, signal });
  assert.deepEqual(bodies[0].tool_choice, { type: 'function', name: 'connection_check' });
  assert.equal(bodies[1].tool_choice, undefined);
  assert.deepEqual(bodies[1].input, messages);
});

test('GPT Responses replays native reasoning and function calls with matching bounded tool outputs', async () => {
  const bodies: any[] = [];
  const output = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-reasoning', summary: [] },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: call.name,
      arguments: JSON.stringify(call.arguments),
      status: 'completed',
    },
    {
      type: 'function_call',
      id: 'fc_2',
      call_id: 'call_2',
      name: call.name,
      arguments: '{}',
      status: 'completed',
    },
  ];
  const provider = new CloudApiProvider({
    kind: 'openai',
    model: 'gpt-test',
    endpoint: 'https://api.openai.com/v1/responses',
    key: 'test-secret',
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-secret');
      assert.equal(options?.signal, signal);
      bodies.push(JSON.parse(String(options?.body)));
      return Response.json({
        id: 'resp_1',
        model: 'gpt-test',
        status: 'completed',
        output,
        usage: { input_tokens: 9, output_tokens: 7 },
      });
    },
  });
  const reply = await provider.complete({ messages, tools, signal });
  assert.deepEqual(reply.calls, [
    { ...call, id: 'call_1' },
    { id: 'call_2', name: call.name, arguments: {} },
  ]);
  assert.deepEqual(reply.usage, { inputTokens: 9, outputTokens: 7 });
  assert.equal(bodies[0].store, false);
  assert.deepEqual(bodies[0].include, ['reasoning.encrypted_content']);
  assert.equal(bodies[0].tools[0].strict, false);
  await provider.complete({
    messages: [
      ...messages,
      { role: 'assistant', content: '', calls: reply.calls },
      { role: 'tool', toolName: call.name, toolCallId: 'call_2', content: 'right: 44' },
      { role: 'tool', toolName: call.name, toolCallId: 'call_1', content: 'left: 42' },
      { role: 'user', content: '继续完成任务' },
    ],
    tools,
    signal,
  });
  assert.deepEqual(bodies[1].input, [
    ...bodies[0].input,
    ...output,
    { type: 'function_call_output', call_id: 'call_1', output: 'left: 42' },
    { type: 'function_call_output', call_id: 'call_2', output: 'right: 44' },
    { role: 'user', content: messages[1]!.content },
    { role: 'user', content: '继续完成任务' },
  ]);
});

for (const kind of ['anthropic', 'zhipu', 'moonshot'] as const) {
  test(`${kind} round-trips native tool IDs and projected outputs`, async () => {
    const bodies: any[] = [];
    const claude = kind === 'anthropic';
    const endpoint = claude
      ? 'https://api.anthropic.com/v1/messages'
      : kind === 'zhipu'
        ? 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
        : 'https://api.moonshot.cn/v1/chat/completions';
    const id = claude ? 'toolu_123' : 'call_123';
    const provider = new CloudApiProvider({
      kind,
      model: kind + '-test',
      endpoint,
      key: 'test-secret',
      fetcher: async (url, options) => {
        assert.equal(url, endpoint);
        const headers = new Headers(options?.headers);
        assert.equal(
          headers.get(claude ? 'x-api-key' : 'authorization'),
          claude ? 'test-secret' : 'Bearer test-secret',
        );
        if (claude) assert.equal(headers.get('anthropic-version'), '2023-06-01');
        bodies.push(JSON.parse(String(options?.body)));
        return Response.json({
          id: 'r_1',
          model: kind + '-test',
          ...(claude
            ? {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id, name: call.name, input: call.arguments }],
              }
            : {
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          type: 'function',
                          id,
                          function: {
                            name: call.name,
                            arguments:
                              kind === 'zhipu' ? call.arguments : JSON.stringify(call.arguments),
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
        });
      },
    });
    const reply = await provider.complete({ messages, tools, signal });
    assert.deepEqual(reply.calls, [{ ...call, id }]);
    await provider.complete({
      messages: [
        ...messages,
        { role: 'assistant', content: '', calls: reply.calls },
        { role: 'tool', toolName: call.name, toolCallId: id, content: 'ROM 42' },
        { role: 'user', content: '请完成任务' },
      ],
      tools,
      signal,
    });
    const body = bodies[1];
    if (claude) {
      assert.equal(body.system, messages[0]!.content);
      assert.deepEqual(body.tools[0].input_schema, tools[0]!.inputSchema);
      assert.deepEqual(body.messages.at(-2).content, [
        { type: 'tool_use', id, name: call.name, input: call.arguments },
      ]);
      assert.deepEqual(body.messages.at(-1).content, [
        { type: 'tool_result', tool_use_id: id, content: 'ROM 42' },
        { type: 'text', text: '请完成任务' },
      ]);
    } else {
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.equal(body.messages.at(-3).tool_calls[0].id, id);
      assert.deepEqual(body.messages.at(-2), { role: 'tool', content: 'ROM 42', tool_call_id: id });
    }
  });
}

for (const [kind, model] of [
  ['zhipu', 'glm-5.3'],
  ['moonshot', 'kimi-k3.1-pro'],
] as const) {
  test(`${model} retains native thinking and matches tool IDs without exposing reasoning`, async () => {
    const bodies: any[] = [];
    const assistant = {
      role: 'assistant',
      content: null,
      reasoning_content: 'upstream-context',
      tool_calls: [
        {
          type: 'function',
          id: 'call_native',
          function: { name: call.name, arguments: '{ "joint": "knee" }' },
        },
      ],
    };
    const provider = new CloudApiProvider({
      kind,
      model,
      endpoint:
        kind === 'zhipu'
          ? 'https://api.z.ai/api/paas/v4/chat/completions'
          : 'https://api.moonshot.ai/v1/chat/completions',
      key: 'test-secret',
      fetcher: async (_url, options) => {
        bodies.push(JSON.parse(String(options?.body)));
        return Response.json({
          id: 'resp_1',
          model,
          choices: [{ finish_reason: 'tool_calls', message: assistant }],
        });
      },
    });
    const reply = await provider.complete({ messages, tools, signal });
    assert(!JSON.stringify(reply).includes(assistant.reasoning_content));
    assert.deepEqual(reply.calls, [{ ...call, id: 'call_native' }]);
    await provider.complete({
      messages: [
        ...messages,
        { role: 'assistant', content: '', calls: reply.calls },
        { role: 'tool', toolName: call.name, toolCallId: 'call_native', content: 'ROM 42' },
      ],
      tools,
      signal,
    });
    assert.equal(bodies[0].reasoning_effort, 'low');
    assert.deepEqual(
      bodies[0].thinking,
      kind === 'zhipu' ? { type: 'enabled', clear_thinking: false } : undefined,
    );
    assert.deepEqual(bodies[1].messages, [
      ...bodies[0].messages,
      assistant,
      { role: 'tool', tool_call_id: 'call_native', content: 'ROM 42' },
    ]);
  });
}

test('Node proxy uses temporary credentials only for their task and official endpoint', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kinetic-model-config-'));
  writeFileSync(
    join(root, '.env'),
    'OPENAI_API_KEY=file-test-secret\nOPENAI_MODELS=gpt-test,gpt-second,gpt-test\n',
  );
  const config = cloudConfiguration(root, () => '', {
    ZHIPU_API_KEY: 'glm-test-secret',
    ZHIPU_MODELS: 'glm-test',
    ZHIPU_ENDPOINT: 'https://api.z.ai/api/paas/v4/chat/completions',
  });
  assert.equal(config.catalog.envFile, join(root, '.env'));
  assert(!JSON.stringify(config.catalog).includes('file-test-secret'));
  assert.deepEqual(config.catalog.providers.find((p) => p.provider === 'openai')?.models, [
    'gpt-test',
    'gpt-second',
  ]);
  assert.equal(config.create('openai', 'not-enabled'), undefined);
  assert.equal(config.catalog.providers.find((p) => p.provider === 'zhipu')?.missing.length, 0);
  const localFetch = globalThis.fetch;
  const temporaryKey = 'temporary-test-secret';
  const upstream: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + temporaryKey);
    assert.equal(options.redirect, 'error');
    upstream.push(JSON.parse(String(options.body)).model);
    return Response.json({
      id: 'resp_test',
      model: 'gpt-custom',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          name: call.name,
          call_id: 'call_1',
          arguments: JSON.stringify({ ...call.arguments, echo: temporaryKey }),
        },
      ],
    });
  });
  let calls = 0;
  const cloud = {
    ...config,
    create(provider: string, model: string, apiKey?: string) {
      if (apiKey !== undefined) return config.create(provider, model, apiKey);
      if (provider !== 'openai' || model !== 'gpt-test') return;
      return {
        model,
        complete() {
          calls++;
          return { calls: [] };
        },
      };
    },
  };
  const proxy = createDeepSeekMiddleware({ cloud });
  const server = createServer((req, res) =>
    proxy.middleware(req, res, () => res.writeHead(404).end()),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  const origin = 'http://127.0.0.1:' + addr.port;
  const post = (route: string, body: object, from = origin) =>
    localFetch(origin + '/__models/' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: from },
      body: JSON.stringify(body),
    });
  try {
    const request = {
      provider: 'openai',
      model: 'gpt-test',
      task: crypto.randomUUID(),
      messages,
      tools,
    };
    assert.equal((await post('catalog', {}, 'https://other.invalid')).status, 403);
    assert.equal((await post('catalog', {})).status, 200);
    assert.equal(
      (await post('complete', { ...request, endpoint: 'https://other.invalid' })).status,
      400,
    );
    assert.equal((await post('complete', { ...request, model: 'not-enabled' })).status, 409);
    assert.equal(calls, 0);
    assert.equal((await post('complete', request)).status, 200);
    assert.equal(calls, 1);
    const followUp = {
      ...request,
      messages: [
        ...messages,
        { role: 'assistant', content: '', calls: [{ ...call, id: 'call_1' }] },
        { role: 'tool', content: '42', toolName: call.name, toolCallId: 'call_1' },
      ],
    };
    assert.equal((await post('complete', followUp)).status, 200);
    assert.equal((await post('release', { task: request.task })).status, 200);
    assert.equal((await post('complete', followUp)).status, 409);
    assert.equal(calls, 2);

    const temporary = {
      ...request,
      task: crypto.randomUUID(),
      model: 'gpt-custom',
      apiKey: temporaryKey,
    };
    assert.equal((await post('complete', temporary, 'https://other.invalid')).status, 403);
    assert.equal((await post('complete', { ...temporary, apiKey: 'bad key' })).status, 400);
    assert.equal(
      (await post('complete', { ...temporary, endpoint: 'https://other.invalid' })).status,
      400,
    );
    assert.deepEqual(upstream, []);
    const reply = await post('complete', temporary);
    assert.equal(reply.status, 200);
    assert(!(await reply.text()).includes(temporaryKey));

    const nextRound = { ...temporary, messages: followUp.messages };
    assert.equal((await post('complete', { ...nextRound, apiKey: 'other-key' })).status, 409);
    assert.equal((await post('complete', { ...nextRound, apiKey: undefined })).status, 409);
    assert.equal((await post('complete', nextRound)).status, 200);
    assert.deepEqual(upstream, ['gpt-custom', 'gpt-custom']);
    assert.equal((await post('release', { task: temporary.task })).status, 200);
    assert.equal((await post('complete', nextRound)).status, 409);
  } finally {
    proxy.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    unlinkSync(join(root, '.env'));
    rmdirSync(root);
  }
});
