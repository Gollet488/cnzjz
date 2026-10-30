import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisSession } from '../src/analysis/session.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { AgentRuntime, resolveCitation } from '../src/agent/runtime.ts';
import { OllamaProvider, localOllamaURL } from '../src/agent/provider.ts';
import type { ModelCall, ModelMessage, ModelProvider, ModelReply } from '../src/agent/provider.ts';
import { demoPose } from '../src/utils/demo.ts';
import { evidenceRef, taskFixture, withTaskSpecs } from './agentFixtures.ts';
import type { TaskSpec } from '../src/agent/taskSpec.ts';

// Scripted providers below test protocol/control flow only. All pose fixtures are
// synthetic. None of these tests is evidence of real model integration.
type Request = Parameters<ModelProvider['complete']>[0];
const calls = (...items: [string, unknown][]): ModelReply => ({
  calls: items.map(([name, args]) => ({ name, arguments: args })),
});
const parameters = { threshold: 0.5, window: 5, aspect: 1, metricVersion: '2.0' as const };
function make(empty = false) {
  const session = new AnalysisSession('demo', parameters);
  if (!empty)
    for (let i = 0; i <= 400; i++)
      session.append(i >= 200 && i < 205 ? [] : demoPose(i / 20), i / 20);
  return session;
}
function feedback(request: Request, name: string): any {
  const message = request.messages.findLast((m) => m.role === 'tool' && m.toolName === name);
  assert.ok(message, `missing feedback for ${name}`);
  return JSON.parse(message.content);
}
function provider(
  steps: ((request: Request) => ModelReply | Promise<ModelReply>)[],
  spec?: (goal: string) => TaskSpec,
): ModelProvider & { requests: Request[] } {
  const requests: Request[] = [];
  return withTaskSpecs(
    {
      id: 'scripted-protocol-test',
      model: 'not-a-real-model',
      requests,
      async complete(request) {
        requests.push(structuredClone({ ...request, signal: undefined }) as Request);
        const step = steps.shift();
        assert.ok(step, 'unexpected provider call');
        return step(request);
      },
    },
    spec,
  );
}
function finish(
  request: Request,
  name: string,
  path: string,
  messageCode = 'evidence_ready',
  outcome = 'completed',
) {
  return calls([
    'finish_analysis',
    { outcome, messageCode, citations: [evidenceRef(feedback(request, name), path)] },
  ]);
}
function runtime(session: AnalysisSession, model: ModelProvider, limits = {}) {
  return new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session,
    registry: createToolRegistry(session),
    provider: model,
    limits,
  });
}
const queryArgs = (session: AnalysisSession, extra = {}) => {
  const { sessionId, revision } = session.info();
  return {
    sessionId,
    revision,
    joint: 'knee',
    channels: ['left', 'right'],
    basis: 'filtered',
    interval: [0, 5],
    ...extra,
  };
};

test('dynamic comparison loop returns actual local results and verified scalar citations', async () => {
  const session = make();
  const model = provider(
    [
      () =>
        calls(
          ['plan_analysis', { steps: ['read_session', 'compare_intervals'] }],
          ['get_session_info', {}],
        ),
      (r) => {
        assert.equal(feedback(r, 'get_session_info').result.synthetic, true);
        return calls([
          'get_quality_summary',
          {
            sessionId: session.info().sessionId,
            revision: session.info().revision,
            interval: [0, 20],
          },
        ]);
      },
      (r) => {
        assert.equal(feedback(r, 'get_quality_summary').result.missingSamples, 5);
        const p = queryArgs(session);
        const { interval: _, ...base } = p;
        return calls(['compare_intervals', { ...base, first: [0, 5], second: [15, 20] }]);
      },
      (r) => {
        assert.ok(feedback(r, 'compare_intervals').result.comparable);
        return finish(r, 'compare_intervals', '/differences/0/rom');
      },
    ],
    (goal) =>
      taskFixture(goal, {
        goalTypes: ['comparison'],
        comparison: { second: [15, 20], direction: 'second_minus_first' },
      }),
  );
  const result = await runtime(session, model).run('比较前后各 5 秒的左右膝 ROM');
  assert.equal(result.status, 'completed');
  assert.equal(result.steps.length, 2);
  const intervalROM = (start: number, end: number) => {
    const angles = session.frames
      .filter((f) => f.time >= start && f.time <= end)
      .map((f) => f.angles.knee.left)
      .filter((v): v is number => v !== null);
    return Math.max(...angles) - Math.min(...angles);
  };
  assert.equal(result.citations[0].value, intervalROM(15, 20) - intervalROM(0, 5));
  const comparison = result.calls.find((c) => c.name === 'compare_intervals')!.output;
  assert.ok(comparison.ok);
  assert.equal(result.citations[0].value, (comparison.result as any).differences[0].rom);
  assert.equal((comparison.result as any).first.evidence.sampleCount, 101);
  assert.equal((comparison.result as any).first.units.angle, 'deg');
  assert.equal(result.reference.synthetic, true);
});

test('different quality goal calls quality rather than fixed comparison sequence', async () => {
  const session = make();
  const model = provider(
    [
      () => calls(['get_session_info', {}]),
      () =>
        calls([
          'get_quality_summary',
          {
            sessionId: session.info().sessionId,
            revision: session.info().revision,
            interval: [0, 20],
          },
        ]),
      (r) => finish(r, 'get_quality_summary', '/effectiveRate'),
    ],
    (goal) => taskFixture(goal, { goalTypes: ['quality'], interval: [0, 20] }),
  );
  const result = await runtime(session, model).run('哪些区间不适合比较？');
  assert.equal(result.status, 'completed');
  assert.equal(
    result.calls.some((c) => c.name === 'compare_intervals'),
    false,
  );
  assert.equal(result.citations[0].value, 396 / 401);
});

test('multi-turn context retains intent without old results, and fetches new right-side intervals', async () => {
  const session = make();
  let turn = 0;
  const model = provider(
    [
      () => calls(['get_session_info', {}], ['query_metrics', queryArgs(session)]),
      (r) => finish(r, 'query_metrics', '/channels/0/rom'),
      (r) => {
        assert.ok(r.messages.some((m) => m.role === 'user' && m.content.includes('最初目标')));
        assert.ok(!r.messages.some((m) => m.role === 'tool'));
        assert.equal(JSON.parse(r.messages.at(-1)!.content).previousTask.spec.basis, 'filtered');
        return calls(
          ['get_session_info', {}],
          ['query_metrics', queryArgs(session, { channels: ['right'], interval: [12, 17] })],
        );
      },
      (r) => finish(r, 'query_metrics', '/channels/0/rom'),
    ],
    (goal) => taskFixture(goal, turn++ ? { channels: ['right'], interval: [12, 17] } : {}),
  );
  const agent = runtime(session, model);
  assert.equal((await agent.run('最初目标：左侧 ROM')).status, 'completed');
  const result = await agent.run('只看右侧，第二段改为 12–17 秒');
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    (result.calls.find((c) => c.name === 'query_metrics')!.arguments as any).interval,
    [12, 17],
  );
  assert.deepEqual(
    (result.calls.find((c) => c.name === 'query_metrics')!.arguments as any).channels,
    ['right'],
  );
});

test('invalid arguments feed error to model for bounded recovery, never mutate session', async () => {
  const session = make(),
    original = session.info();
  const model = provider([
    () =>
      calls(['get_session_info', {}], ['query_metrics', queryArgs(session, { interval: [-1, 5] })]),
    (r) => {
      assert.equal(feedback(r, 'query_metrics').error.code, 'SCHEMA_VALIDATION');
      return calls(['query_metrics', queryArgs(session)]);
    },
    (r) => finish(r, 'query_metrics', '/channels/0/rom'),
  ]);
  const result = await runtime(session, model).run('查询 ROM');
  assert.equal(result.status, 'completed');
  assert.equal(result.calls.filter((c) => !c.output.ok).length, 1);
  assert.deepEqual(session.info(), original);
});

test('unknown tools and repeated failures stop at recovery budget', async () => {
  const session = make();
  const model = provider(
    Array.from({ length: 4 }, () => () => calls(['fetch_url', { url: 'https://example.com' }])),
  );
  const result = await runtime(session, model).run('分析');
  assert.equal(result.status, 'limit');
  assert.equal(result.calls.length, 4);
  assert.ok(result.calls.every((c) => !c.output.ok));
});

test('no data can request information but cannot fabricate completed analysis', async () => {
  const session = make(true);
  const model = provider([
    () => calls(['get_session_info', {}]),
    () =>
      calls([
        'finish_analysis',
        { outcome: 'completed', messageCode: 'evidence_ready', citations: [] },
      ]),
    (r) => {
      assert.match(feedback(r, 'finish_analysis').error.message, /NO_DATA/);
      return calls([
        'finish_analysis',
        { outcome: 'needs_input', messageCode: 'no_samples', citations: [] },
      ]);
    },
  ]);
  const result = await runtime(session, model).run('比较 ROM');
  assert.equal(result.status, 'needs_input');
  assert.equal(result.citations.length, 0);
});

test('out of range and stale tool references return errors for correction', async () => {
  const session = make();
  const model = provider([
    () =>
      calls(
        ['get_session_info', {}],
        ['query_metrics', queryArgs(session, { interval: [30, 35] })],
      ),
    (r) => {
      assert.equal(feedback(r, 'query_metrics').error.code, 'INVALID_INTERVAL');
      return calls([
        'query_metrics',
        queryArgs(session, { revision: session.info().revision - 1 }),
      ]);
    },
    (r) => {
      assert.equal(feedback(r, 'query_metrics').error.code, 'STALE_SESSION');
      return calls(['query_metrics', queryArgs(session)]);
    },
    (r) => finish(r, 'query_metrics', '/channels/0/rom'),
  ]);
  assert.equal((await runtime(session, model).run('查询')).status, 'completed');
});

test('unverified numeric prose and forged citation path are rejected before delivery', async () => {
  const session = make();
  const model = provider([
    () => calls(['get_session_info', {}], ['query_metrics', queryArgs(session)]),
    (r) => finish(r, 'query_metrics', '/channels/0/rom', 'ROM 是 999 deg'),
    (r) => {
      assert.match(feedback(r, 'finish_analysis').error.message, /SCHEMA.*messageCode.*enum/);
      return calls([
        'finish_analysis',
        {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          citations: [{ evidenceId: 'forged-id' }],
        },
      ]);
    },
    (r) => {
      assert.match(feedback(r, 'finish_analysis').error.message, /INVALID_EVIDENCE_ID/);
      return finish(r, 'query_metrics', '/channels/0/rom');
    },
  ]);
  const result = await runtime(session, model).run('查询 ROM');
  assert.equal(result.status, 'completed');
  assert.doesNotMatch(result.message, /999/);
  assert.equal(result.citations.length, 1);
  assert.throws(() => resolveCitation({}, '/constructor'), /INVALID/);
  assert.throws(() => resolveCitation({ array: [] }, '/array'), /SCALAR/);
});

test('noncomparable intervals cannot claim completed; limitation remains in true results', async () => {
  const session = make();
  const { interval: _, ...base } = queryArgs(session);
  const model = provider(
    [
      () =>
        calls(
          ['get_session_info', {}],
          ['compare_intervals', { ...base, first: [0, 5], second: [4, 9] }],
        ),
      (r) => finish(r, 'compare_intervals', '/differences/0/rom'),
      (r) => {
        assert.match(feedback(r, 'finish_analysis').error.message, /NOT_COMPARABLE/);
        return finish(
          r,
          'compare_intervals',
          '/differences/0/rom',
          'comparison_limited',
          'limited',
        );
      },
    ],
    (goal) =>
      taskFixture(goal, {
        goalTypes: ['comparison'],
        comparison: { second: [4, 9], direction: 'second_minus_first' },
      }),
  );
  assert.equal((await runtime(session, model).run('比较重叠区间')).status, 'not_comparable');
});

test('free-text-only replies cannot masquerade as analysis', async () => {
  const model = provider(Array.from({ length: 4 }, () => () => ({ calls: [] })));
  const result = await runtime(make(), model).run('比较');
  assert.equal(result.status, 'limit');
  assert.equal(result.citations.length, 0);
});

test('metadata-only citation and mixed finish batch cannot claim completed analysis', async () => {
  const session = make();
  const model = provider([
    () => calls(['get_session_info', {}], ['query_metrics', queryArgs(session)]),
    (r) => finish(r, 'query_metrics', '/evidence/sampleCount'),
    (r) => {
      assert.match(feedback(r, 'finish_analysis').error.message, /EVIDENCE_REQUIRED/);
      const final = finish(r, 'query_metrics', '/channels/0/rom');
      return { calls: [{ name: 'get_session_info', arguments: {} }, ...final.calls] };
    },
    (r) => finish(r, 'query_metrics', '/channels/0/rom'),
  ]);
  const result = await runtime(session, model).run('分析 ROM');
  assert.equal(result.status, 'completed');
  assert.equal(result.calls.filter((c) => c.name === 'get_session_info').length, 1);
});

test('old-turn call IDs cannot be reused as current evidence', async () => {
  const session = make();
  let oldId = '';
  const model = provider([
    () => calls(['get_session_info', {}], ['query_metrics', queryArgs(session)]),
    (r) => {
      oldId = evidenceRef(feedback(r, 'query_metrics'), '/channels/0/rom').evidenceId;
      return finish(r, 'query_metrics', '/channels/0/rom');
    },
    () => calls(['get_session_info', {}]),
    () =>
      calls([
        'finish_analysis',
        {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          citations: [{ evidenceId: oldId }],
        },
      ]),
    (r) => {
      assert.match(feedback(r, 'finish_analysis').error.message, /INVALID_EVIDENCE_ID/);
      return calls(['query_metrics', queryArgs(session)]);
    },
    (r) => finish(r, 'query_metrics', '/channels/0/rom'),
  ]);
  const agent = runtime(session, model);
  await agent.run('前轮查询');
  const result = await agent.run('重新查询');
  assert.equal(result.status, 'completed');
  assert.notEqual(result.citations[0].evidenceId, oldId);
});

test('cancellation ignores late replies even when provider ignores abort signal', async () => {
  const session = make();
  let resolve!: (value: ModelReply) => void;
  const model = provider([
    () =>
      new Promise<ModelReply>((done) => {
        resolve = done;
      }),
  ]);
  const events: string[] = [];
  const agent = new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session,
    registry: createToolRegistry(session),
    provider: model,
    onChange: (run) => events.push(run.status),
  });
  const pending = agent.run('慢请求');
  agent.cancel();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  resolve(calls(['query_metrics', queryArgs(session)]));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(result.calls.length, 0);
  assert.equal(events.at(-1), 'cancelled');
});

test('timeout and bounded round/call limits stop without success', async () => {
  const never = provider([() => new Promise(() => {})]);
  assert.equal((await runtime(make(), never, { requestMs: 15 }).run('超时')).status, 'timeout');
  const repeated = provider(Array.from({ length: 2 }, () => () => calls(['get_session_info', {}])));
  assert.equal((await runtime(make(), repeated, { rounds: 2 }).run('上限')).status, 'limit');
  const batch = provider([() => calls(['get_session_info', {}], ['get_session_info', {}])]);
  assert.equal((await runtime(make(), batch, { calls: 1 }).run('调用上限')).calls.length, 0);
});

for (const mutation of ['reset', 'recalculate', 'append'] as const) {
  test(`${mutation} while model pending prevents stale execution and old context reuse`, async () => {
    const session = make();
    let resolve!: (value: ModelReply) => void;
    const model = provider([
      () =>
        new Promise<ModelReply>((done) => {
          resolve = done;
        }),
      (r) => {
        assert.ok(!r.messages.some((m) => m.role === 'tool'));
        assert.equal(
          JSON.parse(r.messages.at(-1)!.content).context.pendingUserIntents[0].goal,
          '旧目标',
        );
        return calls(['get_session_info', {}]);
      },
      () =>
        calls([
          'finish_analysis',
          { outcome: 'needs_input', messageCode: 'specify_parameters', citations: [] },
        ]),
    ]);
    const agent = runtime(session, model);
    const pending = agent.run('旧目标');
    if (mutation === 'reset') session.reset('file');
    else if (mutation === 'recalculate') session.recalculate({ ...parameters, window: 3 });
    else session.append(demoPose(21), 21);
    resolve(calls(['get_session_info', {}]));
    const result = await pending;
    assert.equal(result.status, 'stale');
    assert.equal(result.calls.length, 0);
    assert.equal((await agent.run('新目标')).status, 'needs_input');
  });
}

test('session monitor cancels an unresponsive provider after external reset', async () => {
  const session = make();
  const agent = runtime(session, provider([() => new Promise(() => {})]), { requestMs: 1000 });
  const pending = agent.run('旧会话');
  session.reset();
  assert.equal((await pending).status, 'stale');
});

test('concurrent runs are rejected and cancelled runs do not poison the next turn', async () => {
  const session = make();
  const model = provider([
    () => new Promise(() => {}),
    (r) => {
      assert.ok(!r.messages.some((m) => m.role === 'tool'));
      assert.equal(
        JSON.parse(r.messages.at(-1)!.content).context.pendingUserIntents[0].goal,
        '取消的目标',
      );
      return calls(['get_session_info', {}]);
    },
    () =>
      calls([
        'finish_analysis',
        { outcome: 'needs_input', messageCode: 'specify_parameters', citations: [] },
      ]),
  ]);
  const agent = runtime(session, model);
  const first = agent.run('取消的目标');
  await assert.rejects(agent.run('并发'), /BUSY/);
  agent.cancel();
  await first;
  assert.equal((await agent.run('新目标')).status, 'needs_input');
});

function wire(calls: ModelCall[] = [], extra = {}) {
  return new Response(
    JSON.stringify({
      done: true,
      message: {
        role: 'assistant',
        content: 'UNTRUSTED 999',
        thinking: 'private reasoning',
        tool_calls: calls.map((c) => ({ function: c })),
      },
      ...extra,
    }),
  );
}
test('Ollama adapter maps native tools/history, strips thinking and uses fixed local endpoint', async () => {
  let body: any;
  const fetcher: typeof fetch = async function (this: unknown, url, init) {
    assert.equal(this, globalThis);
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    body = JSON.parse(init!.body as string);
    return wire([{ name: 'get_session_info', arguments: {} }], {
      prompt_eval_count: 12,
      eval_count: 4,
    });
  };
  const model = new OllamaProvider('http://127.0.0.1:11434', 'local-tools', fetcher);
  const messages: ModelMessage[] = [
    { role: 'assistant', content: '', calls: [{ name: 'get_session_info', arguments: {} }] },
    { role: 'tool', toolName: 'get_session_info', content: '{"ok":true}' },
  ];
  const result = await model.complete({
    messages,
    tools: createToolRegistry(make()).definitions,
    signal: new AbortController().signal,
  });
  assert.deepEqual(body.tools[0].function.parameters, {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  });
  assert.equal(body.messages[1].tool_name, 'get_session_info');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.equal(
    model.requestBytes({ messages, tools: createToolRegistry(make()).definitions }),
    new TextEncoder().encode(JSON.stringify(body)).length,
  );
  assert.deepEqual(result.calls, [{ name: 'get_session_info', arguments: {} }]);
  assert.equal(JSON.stringify(result).includes('private reasoning'), false);
  assert.equal(JSON.stringify(result).includes('999'), false);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4 });
});

test('Ollama connection requires capability plus actual structured probe; rejects cloud relay', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () =>
    ++requests === 1
      ? new Response(JSON.stringify({ capabilities: ['tools'] }))
      : wire([{ name: 'connection_check', arguments: { echo: 'kinetic' } }]);
  const probe = await new OllamaProvider('http://localhost:11434', 'local', fetcher).probe(
    new AbortController().signal,
  );
  assert.equal(requests, 2);
  assert.equal(probe.requests, 1);
  assert.deepEqual(probe.usage, { inputTokens: undefined, outputTokens: undefined });
  for (const details of [{ capabilities: [] }, { capabilities: ['tools'], remote_host: 'cloud' }]) {
    await assert.rejects(
      new OllamaProvider(
        'http://localhost:11434',
        'local',
        async () => new Response(JSON.stringify(details)),
      ).probe(new AbortController().signal),
    );
  }
  requests = 0;
  await assert.rejects(
    new OllamaProvider('http://localhost:11434', 'local', async () =>
      ++requests === 1 ? new Response(JSON.stringify({ capabilities: ['tools'] })) : wire(),
    ).probe(new AbortController().signal),
    /探测/,
  );
});

test('Ollama adapter rejects HTTP/protocol/oversize/redirect risks and arbitrary addresses', async () => {
  for (const address of [
    'https://example.com',
    'http://127.0.0.1:11434/api',
    'http://user:secret@localhost:11434',
    'http://127.0.0.1:11434/?key=secret',
    'file:///tmp/a',
  ])
    assert.throws(() => localOllamaURL(address));
  assert.throws(() => new OllamaProvider('http://localhost:11434', 'model-cloud'));
  for (const response of [
    new Response('bad', { status: 500 }),
    new Response('{}'),
    new Response('x'.repeat(1_000_001)),
  ]) {
    const model = new OllamaProvider('http://localhost:11434', 'local', async () => response);
    await assert.rejects(
      model.complete({ messages: [], tools: [], signal: new AbortController().signal }),
    );
  }
});
