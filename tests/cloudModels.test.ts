import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudApiProvider } from '../src/agent/providers/cloudApi.ts';
import type { ModelMessage } from '../src/agent/provider.ts';
import { cloudConfiguration } from '../scripts/cloud-model-config.mjs';
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

test('Node catalog is read-only and model selection cannot override credentials or endpoints', async () => {
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
  let calls = 0;
  const cloud = {
    ...config,
    create(provider: string, model: string) {
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
    fetch(origin + '/__models/' + route, {
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
  } finally {
    proxy.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    unlinkSync(join(root, '.env'));
    rmdirSync(root);
  }
});
