// Mocked transport and synthetic poses only; never API model acceptance.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DeepSeekProvider, DEEPSEEK_ADDRESS } from '../src/agent/providers/deepseek.ts';
import { ProviderResponseError } from '../src/agent/provider.ts';
import type { ModelMessage } from '../src/agent/provider.ts';
import { parseEvaluationArgs, runEvaluation } from '../scripts/evaluate-agent.mjs';
import { runAgentScreen } from '../scripts/run-agent-screen.mjs';

const key = 'test-only-secret-never-a-real-key';
const directory = await mkdtemp(join(tmpdir(), 'deepseek-protocol-'));
after(async () => {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith('deepseek-protocol-'));
  await rm(target, { recursive: true, force: true });
});
const tools = [
  {
    name: 'query_metrics',
    description: '读取真实证据',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false as const },
    outputSchema: {},
  },
];
const input = (messages: ModelMessage[] = [{ role: 'user', content: '查询质量' }]) => ({
  messages,
  tools,
  signal: new AbortController().signal,
});
const wireReply = (calls: { name: string; arguments: unknown }[] = [], extra = {}) => ({
  id: 'completion-test',
  model: 'deepseek-flash',
  system_fingerprint: 'test-1017-not-real',
  choices: [
    {
      finish_reason: calls.length ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content: 'This unverified text must not be presented as analysis.',
        tool_calls: calls.map((call, index) => ({
          id: `server-${index}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      },
    },
  ],
  usage: { prompt_tokens: 17, completion_tokens: 9 },
  ...extra,
});
const json = (value: unknown) => new Response(JSON.stringify(value));

test('DeepSeek serializes native tool history with matching unique IDs, exact args and bounded config', async () => {
  let body: any;
  const request = input([
    { role: 'system', content: '规则' },
    { role: 'user', content: '比较左右膝' },
    {
      role: 'assistant',
      content: '',
      calls: [
        { name: 'query_metrics', arguments: { taskRef: '原始标识', side: 'left' } },
        { name: 'query_metrics', arguments: { taskRef: '原始标识', side: 'right' } },
      ],
    },
    { role: 'tool', toolName: 'query_metrics', content: '{"ok":true,"left":1}' },
    { role: 'tool', toolName: 'query_metrics', content: '{"ok":false,"error":"original"}' },
  ]);
  const provider = new DeepSeekProvider(key, 'deepseek-flash', async (url, init) => {
    assert.equal(url, `${DEEPSEEK_ADDRESS}/chat/completions`);
    assert.equal((init!.headers as any).Authorization, `Bearer ${key}`);
    assert.equal(init!.signal, request.signal);
    assert.equal(init!.redirect, 'error');
    body = JSON.parse(init!.body as string);
    assert.equal(provider.requestBytes(request), Buffer.byteLength(init!.body as string));
    return json(wireReply([{ name: 'query_metrics', arguments: { taskRef: 'fresh' } }]));
  });
  const reply = await provider.complete(request);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.stream, false);
  assert.ok(!('response_format' in body));
  assert.deepEqual(body.tools[0].function.parameters, tools[0]!.inputSchema);
  const calls = body.messages[2].tool_calls;
  assert.notEqual(calls[0].id, calls[1].id);
  assert.equal(body.messages[3].tool_call_id, calls[0].id);
  assert.equal(body.messages[4].tool_call_id, calls[1].id);
  assert.deepEqual(
    JSON.parse(calls[0].function.arguments),
    request.messages[2]!.calls![0]!.arguments,
  );
  assert.equal(body.messages[4].content, request.messages[4]!.content);
  assert.deepEqual(reply.calls, [{ name: 'query_metrics', arguments: { taskRef: 'fresh' } }]);
  assert.deepEqual(reply.usage, { inputTokens: 17, outputTokens: 9 });
  assert.equal(reply.response!.systemFingerprint, 'test-1017-not-real');
  assert.ok(!JSON.stringify(reply).includes('unverified'));
  assert.ok(!JSON.stringify(body).includes(key));
  assert.ok(!JSON.stringify(provider).includes(key));
});

test('DeepSeek refuses orphan/incomplete histories without making a request or inventing results', async () => {
  let requests = 0;
  const provider = new DeepSeekProvider(key, 'deepseek-flash', async () => {
    requests++;
    return json(wireReply());
  });
  await assert.rejects(
    provider.complete(input([{ role: 'tool', toolName: 'query_metrics', content: '{}' }])),
    /ORPHAN_TOOL_RESULT/,
  );
  await assert.rejects(
    provider.complete(
      input([
        { role: 'assistant', content: '', calls: [{ name: 'query_metrics', arguments: {} }] },
      ]),
    ),
    /MISSING_TOOL_RESULT/,
  );
  assert.equal(requests, 0);
});

for (const status of [401, 429, 500]) {
  test(`DeepSeek HTTP ${status} is counted once, never retried, with a redacted failure`, async () => {
    let requests = 0;
    const provider = new DeepSeekProvider(key, 'deepseek-flash', async () => {
      requests++;
      return new Response(JSON.stringify({ error: `rejected ${key}` }), { status });
    });
    await assert.rejects(provider.complete(input()), (error: any) => {
      assert.ok(error instanceof ProviderResponseError);
      assert.equal(error.message, `DEEPSEEK_HTTP_${status}`);
      assert.ok(!JSON.stringify(error.failure).includes(key));
      assert.match(error.failure.responseText, /REDACTED/);
      return true;
    });
    assert.equal(requests, 1);
  });
}

test('DeepSeek refuses truncated output, invalid JSON arguments and oversized bodies', async () => {
  for (const [value, expected] of [
    [{ choices: [{ finish_reason: 'length', message: { role: 'assistant' } }] }, /INCOMPLETE/],
    [
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'broken',
                  type: 'function',
                  function: { name: 'query_metrics', arguments: '{' },
                },
              ],
            },
          },
        ],
      },
      /INVALID_CALL_ARGUMENTS/,
    ],
  ] as const) {
    const provider = new DeepSeekProvider(key, 'deepseek-flash', async () =>
      json(wireReply([], value)),
    );
    await assert.rejects(provider.complete(input()), expected);
  }
  const oversized = new DeepSeekProvider(
    key,
    'deepseek-flash',
    async () => new Response('x'.repeat(1_000_001)),
  );
  await assert.rejects(oversized.complete(input()), /RESPONSE_LIMIT/);
});

test('DeepSeek probe requires the actual native echo call; free text cannot pass', async () => {
  const provider = new DeepSeekProvider(key, 'deepseek-flash', async () => json(wireReply()));
  await assert.rejects(provider.probe(new AbortController().signal), /TOOL_PROBE_FAILED/);
  assert.throws(() => new DeepSeekProvider(''), /API_KEY_REQUIRED/);
});

test('DeepSeek CLI uses only the official endpoint and refuses the Ollama raw recorder before IO', async () => {
  const options = parseEvaluationArgs(['--provider', 'deepseek']);
  assert.equal(options.model, 'deepseek-flash');
  assert.equal(options.address, DEEPSEEK_ADDRESS);
  assert.equal(parseEvaluationArgs([]).provider, 'ollama');
  assert.throws(() => parseEvaluationArgs(['--provider', 'unknown']));
  assert.throws(() =>
    parseEvaluationArgs(['--provider', 'deepseek', '--address', 'https://example.com']),
  );
  await assert.rejects(runAgentScreen(options), /SCREEN_OLLAMA_ONLY/);
});

for (const scenario of ['compare', 'quality']) {
  test(`DeepSeek ${scenario} mocked HTTP reaches the existing runtime and completion checks without leaking keys`, async () => {
    let requests = 0;
    const output = join(directory, `${scenario}.json`);
    const options = parseEvaluationArgs([
      '--provider',
      'deepseek',
      '--case',
      scenario,
      '--repeat',
      '1',
      '--max-business-requests',
      '12',
      '--max-business-ms',
      '120000',
      '--output',
      output,
    ]);
    const result = await runEvaluation(options, {
      apiKey: key,
      fetch: async (_url: unknown, init: RequestInit) => {
        requests++;
        const body = JSON.parse(init.body as string);
        if (body.tools[0].function.name === 'connection_check')
          return json(wireReply([{ name: 'connection_check', arguments: { echo: 'kinetic' } }]));
        const user = JSON.parse(body.messages.find((m: any) => m.role === 'user').content);
        const currentId = user.userSources.find((s: any) => s.kind === 'current').sourceId;
        const both = scenario === 'compare';
        if (!user.acceptedTask)
          return json(
            wireReply([
              { name: 'get_session_info', arguments: {} },
              {
                name: 'set_task_spec',
                arguments: {
                  goalTypes: { metrics: false, comparison: both, quality: !both },
                  joint: both ? 'knee' : null,
                  channels: both ? ['left', 'right'] : null,
                  basis: both ? 'filtered' : null,
                  interval: both ? { anchor: 'start', seconds: 5 } : 'sampled',
                  comparison: both
                    ? { second: { anchor: 'end', seconds: 5 }, direction: 'second_minus_first' }
                    : null,
                  metrics: both ? ['rom'] : [],
                  time: null,
                  deliveries: {
                    report: false,
                    export: null,
                    view: both
                      ? {
                          joint: 'knee',
                          channels: ['left', 'right'],
                          basis: 'filtered',
                          interval: 'comparison',
                        }
                      : null,
                  },
                  sources: [{ field: 'task', origin: 'derived', sourceId: currentId }],
                  unresolved: [],
                },
              },
            ]),
          );
        const selected = both ? ['compare_intervals', 'set_chart_view'] : ['get_quality_summary'];
        if (!user.availableEvidence.some((e: any) => e.tool === selected[0]))
          return json(
            wireReply(
              selected.map((name) => ({ name, arguments: { taskRef: user.bindings.taskRef } })),
            ),
          );
        return json(
          wireReply([
            {
              name: 'finish_analysis',
              arguments: {
                outcome: 'completed',
                messageCode: 'evidence_ready',
                citations: user.availableEvidence
                  .filter((e: any) => selected.includes(e.tool))
                  .flatMap((e: any) =>
                    e.entries.map((entry: any) => ({ evidenceId: entry.evidenceId })),
                  ),
              },
            },
          ]),
        );
      },
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result.record.runs[0]?.assessment));
    assert.equal(result.record.summary.passed, 1);
    assert.equal(result.record.provider, 'deepseek-api');
    assert.equal(result.record.evidenceKind, 'scripted-protocol-only');
    assert.equal(result.record.status, 'executed_protocol_only');
    assert.equal(result.record.connectionProbe.requests, 1);
    assert.equal(result.record.connectionProbe.response.systemFingerprint, 'test-1017-not-real');
    assert.equal(requests, result.record.summary.requests + 1);
    assert.deepEqual(result.record.config.inference.thinking, { type: 'disabled' });
    assert.ok(!('num_ctx' in result.record.config.inference));
    const audit = JSON.parse(await readFile(result.record.auditFiles[0].path, 'utf8'));
    assert.ok(
      audit.requests.every((r: any) => r.reply.response.systemFingerprint === 'test-1017-not-real'),
    );
    for (const name of await readdir(directory))
      assert.ok(!(await readFile(join(directory, name), 'utf8')).includes(key), name);
  });
}
