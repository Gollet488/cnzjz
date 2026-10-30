// Controlled/extracted protocol regression only; never model business evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime.ts';
import type { AgentRun } from '../src/agent/runtime.ts';
import type { ModelProvider } from '../src/agent/provider.ts';
import { OllamaProvider } from '../src/agent/provider.ts';
import {
  ModelProtocolAdapter,
  modelGoalTypes,
  inspectionGuide,
  compactModelFeedback,
} from '../src/agent/modelProtocol.ts';
import { validateTaskSpec, TaskSpecSourceError } from '../src/agent/taskSpec.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { evaluationSession } from '../src/agent/evaluation.ts';
import { taskFixture, evidenceRef } from './agentFixtures.ts';
import type { TaskSpec } from '../src/agent/taskSpec.ts';

type Request = Parameters<ModelProvider['complete']>[0];
const context = (r: Request) => JSON.parse(r.messages.find((m) => m.role === 'user')!.content);
const feedback = (r: Request, name: string) =>
  JSON.parse(r.messages.findLast((m) => m.toolName === name)!.content);
const call = (name: string, args: unknown) => ({ calls: [{ name, arguments: args }] });
const finish = { outcome: 'needs_input', messageCode: 'specify_parameters', citations: [] };
test('export exposes every determinable missing source at once and preserves input', () => {
  const goal = '准备 filtered 左右膝 0–5 秒报告和 CSV';
  const original = taskFixture(goal, {
    goalTypes: ['report', 'export'],
    deliveries: { view: null, report: true, export: { interval: [0, 5], format: 'csv' } },
  });
  original.sources = original.sources.filter(
    (source) => !['goalTypes', 'interval', 'deliveries'].includes(source.field),
  );
  original.sources.push({
    field: 'deliveries.export',
    origin: 'explicit',
    text: goal,
    fromRunId: null,
  });
  const snapshot = structuredClone(original);
  assert.throws(
    () => validateTaskSpec(original, goal),
    (e: any) => {
      assert.ok(e instanceof TaskSpecSourceError);
      assert.deepEqual(e.missingSources, ['goalTypes', 'interval', 'deliveries.report']);
      return true;
    },
  );
  assert.deepEqual(original, snapshot);
  const corrected = structuredClone(original);
  for (const field of ['goalTypes', 'interval', 'deliveries.report'])
    corrected.sources.push({ field, origin: 'explicit', text: goal, fromRunId: null });
  assert.deepEqual(validateTaskSpec(corrected, goal), corrected);
  corrected.sources[0].text = 'invented';
  assert.throws(() => validateTaskSpec(corrected, goal), /TASK_SPEC_SOURCE_TEXT/);
});

test('J1 no automatic session read or finish: prerequisite visible, unoffered finish rejected, model recovers', async () => {
  const session = evaluationSession();
  let step = 0;
  const runtime = new AgentRuntime({
    session,
    registry: createToolRegistry(session),
    provider: {
      id: 'J1-controlled',
      model: 'none',
      async complete(r) {
        if (step++ === 0) {
          assert.deepEqual(context(r).prerequisites.finish_analysis, ['get_session_info']);
          assert.ok(!r.tools.some((t) => t.name === 'finish_analysis'));
          return call('finish_analysis', finish);
        }
        if (step === 2) {
          assert.match(feedback(r, 'finish_analysis').error.message, /READ_SESSION_FIRST/);
          return call('get_session_info', {});
        }
        assert.deepEqual(context(r).prerequisites.finish_analysis, []);
        assert.ok(r.tools.some((t) => t.name === 'finish_analysis'));
        return call('finish_analysis', finish);
      },
    },
  });
  const run = await runtime.run('缺少侧别时请求补充');
  assert.equal(run.status, 'needs_input');
  assert.deepEqual(
    run.calls.map((c) => [c.name, c.output.ok]),
    [
      ['finish_analysis', false],
      ['get_session_info', true],
      ['finish_analysis', true],
    ],
  );
});

test('J1 all source paths survive real runtime feedback; only model supplies corrected sources', async () => {
  const session = evaluationSession();
  let step = 0;
  const runtime = new AgentRuntime({
    session,
    registry: createToolRegistry(session),
    provider: {
      id: 'J1-controlled',
      model: 'none',
      async complete(r) {
        const u = context(r);
        const spec = taskFixture(u.goal);
        spec.sources = [];
        const sourceId = u.userSources[0].sourceId;
        if (step++ === 0)
          return call('set_task_spec', { ...spec, goalTypes: modelGoalTypes(spec.goalTypes) });
        if (step === 2) {
          assert.deepEqual(feedback(r, 'set_task_spec').error.missingSources, [
            'goalTypes',
            'joint',
            'channels',
            'basis',
            'interval',
            'metrics',
            'deliveries.report',
          ]);
          spec.sources = Object.keys(spec)
            .filter((field) => !['sources', 'unresolved'].includes(field))
            .map((field) => ({ field, origin: 'explicit', sourceId })) as any;
          return {
            calls: [
              { name: 'get_session_info', arguments: {} },
              {
                name: 'set_task_spec',
                arguments: { ...spec, goalTypes: modelGoalTypes(spec.goalTypes) },
              },
            ],
          };
        }
        if (step === 3) return call('query_metrics', { taskRef: u.bindings.taskRef });
        return call('finish_analysis', {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          citations: [evidenceRef(feedback(r, 'query_metrics'), '/channels/0/rom')],
        });
      },
    },
  });
  const run = await runtime.run('查左右膝 filtered 0–5 秒 ROM');
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 1);
});

test('inspect valid paths, limits, task directory and duplicate marker preserve original evidence IDs', async () => {
  const session = evaluationSession();
  let step = 0;
  const runtime = new AgentRuntime({
    session,
    registry: createToolRegistry(session),
    provider: {
      id: 'controlled-inspection',
      model: 'none',
      async complete(r) {
        const u = context(r);
        if (step++ === 0) {
          const spec = taskFixture(u.goal, {
            goalTypes: ['comparison'],
            channels: ['right'],
            comparison: { second: [12, 17], direction: 'second_minus_first' },
          });
          return {
            calls: [
              { name: 'get_session_info', arguments: {} },
              {
                name: 'set_task_spec',
                arguments: {
                  ...spec,
                  goalTypes: modelGoalTypes(spec.goalTypes),
                  sources: spec.sources.map(({ field, origin }) => ({
                    field,
                    origin,
                    sourceId: u.userSources[0].sourceId,
                  })),
                },
              },
            ],
          };
        }
        if (step === 2) return call('compare_intervals', { taskRef: u.bindings.taskRef });
        if (step === 3)
          return call('inspect_result', {
            callId: feedback(r, 'compare_intervals').callId,
            path: '/first/channels',
            start: 0,
            limit: 32,
          });
        return call('finish_analysis', {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          citations: [evidenceRef(feedback(r, 'compare_intervals'), '/differences/0/rom')],
        });
      },
    },
  });
  const run = await runtime.run('比较右膝 filtered 在 0–5 和 12–17 秒的 ROM');
  assert.equal(run.status, 'completed', run.message);
  const record = run.calls.find((c) => c.name === 'compare_intervals')!;
  const adapter = new ModelProtocolAdapter(run.id, run.reference, run.goal);
  const original = structuredClone(record);
  const help = adapter.inspectionHelp({ callId: record.id, path: '/bad' }, run);
  assert.ok('paths' in help && help.paths.some((p) => p.path === '/first/channels'));
  const selected = inspectionGuide(record, run, '/first/channels');
  assert.deepEqual(selected.paths[0], {
    path: '/first/channels',
    type: 'array',
    length: 1,
    startMax: 0,
  });
  assert.equal(selected.limitMax, 32);
  for (const path of ['/absent', '/__proto__', '/first/~2'])
    assert.throws(
      () => adapter.inspect({ callId: record.id, path, start: 0, limit: 1 }, run),
      /INVALID_FACT_PATH/,
    );
  assert.throws(
    () => adapter.inspect({ callId: record.id, path: '/first/channels', start: 1, limit: 1 }, run),
    /FACT_PAGE_OUT_OF_RANGE/,
  );
  assert.throws(
    () => adapter.inspect({ callId: record.id, path: '/first', start: 1, limit: 1 }, run),
    /FACT_NOT_ARRAY/,
  );
  const result = adapter.inspect(
    { callId: record.id, path: '/first/channels', start: 0, limit: 32 },
    run,
  );
  assert.equal(result.duplicate, true);
  assert.equal(result.newFacts, false);
  const task = adapter.inspect(
    { callId: record.id, path: '/taskEvidenceCatalog', start: 0, limit: 32 },
    run,
  );
  assert.ok('items' in task && task.items.length > 0 && task.items.length <= 16);
  assert.ok(
    'items' in task &&
      task.items.every((e: any) =>
        original.evidenceCatalog!.entries.some((o) => o.evidenceId === e.evidenceId),
      ),
  );
  assert.deepEqual(record, original);
});

test('J1 runtime inspect errors carry bounds and paths; inspect itself creates no citable measurements', async () => {
  const session = evaluationSession();
  let step = 0;
  let queryId = '';
  const runtime = new AgentRuntime({
    session,
    registry: createToolRegistry(session),
    provider: {
      id: 'J1-controlled',
      model: 'none',
      async complete(r) {
        const u = context(r);
        if (step++ === 0)
          return {
            calls: [
              { name: 'get_session_info', arguments: {} },
              {
                name: 'set_task_spec',
                arguments: {
                  ...taskFixture(u.goal),
                  goalTypes: modelGoalTypes(['metrics']),
                  sources: taskFixture(u.goal).sources.map(({ field, origin }) => ({
                    field,
                    origin,
                    sourceId: u.userSources[0].sourceId,
                  })),
                },
              },
            ],
          };
        if (step === 2) return call('query_metrics', { taskRef: u.bindings.taskRef });
        if (step === 3) {
          const f = feedback(r, 'query_metrics');
          queryId = f.callId;
          assert.ok(f.inspection.paths.some((p: any) => p.path === '/channels'));
          return call('inspect_result', {
            callId: queryId,
            path: '/channels',
            start: 0,
            limit: 100,
          });
        }
        if (step === 4) {
          const f = feedback(r, 'inspect_result');
          assert.equal(f.error.inspection.limitMax, 32);
          assert.equal(f.error.issue.kind, 'bounds');
          assert.equal(f.error.issue.path, '$.limit');
          return call('inspect_result', {
            callId: queryId,
            path: '/channels',
            start: 99,
            limit: 1,
          });
        }
        if (step === 5) {
          const f = feedback(r, 'inspect_result');
          assert.match(f.error.message, /FACT_PAGE_OUT_OF_RANGE/);
          assert.equal(f.error.inspection.paths[0].length, 2);
          return call('inspect_result', {
            callId: queryId,
            path: '/taskEvidenceCatalog',
            start: 0,
            limit: 16,
          });
        }
        return call('finish_analysis', {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          citations: [evidenceRef(feedback(r, 'query_metrics'), '/channels/0/rom')],
        });
      },
    },
  });
  const run = await runtime.run('左右膝 filtered 的 0–5 秒 ROM');
  assert.equal(run.status, 'completed', run.message);
  assert.ok(run.calls.filter((c) => c.name === 'inspect_result').every((c) => !c.evidenceCatalog));
  assert.ok(JSON.stringify(compactModelFeedback(run)).length < 32000);
});

test('J1 inspection discovery is bounded and explicitly incomplete; unlisted valid children remain readable', () => {
  const reference = evaluationSession().info();
  const result = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`field${i}`, Array.from({ length: 40 }, (_, j) => j)]),
  );
  const record = {
    id: 'large',
    name: 'query_metrics',
    arguments: {},
    output: { ok: true as const, tool: 'query_metrics', result },
  };
  const run = { id: 'bounded', reference, goal: 'bounded', calls: [record] } as unknown as AgentRun;
  const adapter = new ModelProtocolAdapter(run.id, reference, run.goal);
  const guide = inspectionGuide(record, run);
  assert.equal(guide.paths.length, 24);
  assert.equal(guide.truncated, true);
  assert.ok(JSON.stringify(guide).length < 4000);
  assert.equal(
    (adapter.inspect({ callId: 'large', path: '/field99/39', start: 0, limit: 1 }, run) as any)
      .value,
    39,
  );
});

for (const content of ['', '已完成，请查看结果']) {
  test(`J1 empty tool_calls/prose remains a model failure and consumes only existing recovery budget: ${content || 'empty'}`, async () => {
    const session = evaluationSession();
    let requests = 0;
    const provider = new OllamaProvider('http://127.0.0.1:11434', 'offline-fixture', (async () => {
      requests++;
      return Response.json({ done: true, message: { role: 'assistant', content, tool_calls: [] } });
    }) as typeof fetch);
    const run = await new AgentRuntime({
      session,
      registry: createToolRegistry(session),
      provider,
    }).run('请交付结果');
    assert.equal(run.status, 'limit');
    assert.equal(requests, 4);
    assert.equal(run.calls.length, 0);
    assert.equal(run.usage.inputTokens, null);
    assert.equal(run.usage.outputTokens, null);
  });
}

for (const [joint, first, second, goal] of [
  ['hip', [10, 14], [1, 5], '原始右髋先看十到十四秒，再对照一到五秒，后减前并画图'],
  ['wrist', [9, 12], [3, 6], 'raw 右腕 9–12 与 3–6 的 ROM 对照，图表包住两窗'],
] as const) {
  test(`J1 controlled ${joint}: reversed time windows and view-before-comparison preserve numeric direction`, async () => {
    const session = evaluationSession();
    let chart: unknown = null;
    const registry = createToolRegistry(session, {
      setChartView: (v) => (chart = v),
      readWorkspace: () => ({ chart, time: null }),
    } as any);
    let step = 0;
    const view = {
      joint,
      channels: ['right'],
      basis: 'raw',
      interval: [Math.min(first[0], second[0]), Math.max(first[1], second[1])],
    } as const;
    const runtime = new AgentRuntime({
      session,
      registry,
      provider: {
        id: 'J1-controlled',
        model: 'none',
        async complete(r) {
          const u = context(r);
          if (step++ === 0) {
            const spec = taskFixture(goal, {
              joint,
              channels: ['right'],
              basis: 'raw',
              interval: [...first],
              comparison: { second: [...second], direction: 'second_minus_first' },
              goalTypes: ['comparison'],
              deliveries: { view: structuredClone(view) as any, report: false, export: null },
            });
            return {
              calls: [
                { name: 'get_session_info', arguments: {} },
                {
                  name: 'set_task_spec',
                  arguments: {
                    ...spec,
                    goalTypes: modelGoalTypes(spec.goalTypes),
                    sources: spec.sources.map(({ field, origin }) => ({
                      field,
                      origin,
                      sourceId: u.userSources[0].sourceId,
                    })),
                  },
                },
              ],
            };
          }
          if (step === 2)
            return {
              calls: ['set_chart_view', 'compare_intervals'].map((name) => ({
                name,
                arguments: { taskRef: u.bindings.taskRef },
              })),
            };
          return call('finish_analysis', {
            outcome: 'completed',
            messageCode: 'evidence_ready',
            citations: [
              evidenceRef(feedback(r, 'compare_intervals'), '/differences/0/rom'),
              evidenceRef(feedback(r, 'set_chart_view'), '/view/basis'),
            ],
          });
        },
      },
    });
    const run = await runtime.run(goal);
    assert.equal(run.status, 'completed', run.message);
    assert.deepEqual(chart, view);
    const compared = run.calls.find((c) => c.name === 'compare_intervals')!.output;
    assert.ok(compared.ok);
    const result = compared.result as any;
    assert.deepEqual(result.first.evidence.interval, first);
    assert.deepEqual(result.second.evidence.interval, second);
    assert.equal(
      result.differences[0].rom,
      result.second.channels[0].rom - result.first.channels[0].rom,
    );
  });
}

test('J1 repeated single-field runtime patches retain every other field and requery fresh evidence', async () => {
  const session = evaluationSession();
  const goals = [
    '左右肘 filtered 2–7 秒的 ROM',
    '只右侧',
    '统计区间改为 8–13 秒',
    '改看 raw',
    '加上平均角',
  ];
  const changes = [
    ['channels', ['right']],
    ['interval', [8, 13]],
    ['basis', 'raw'],
    ['metrics', ['rom', 'meanAngle']],
  ] as const;
  let turn = -1,
    step = 0,
    signal: AbortSignal;
  const runtime = new AgentRuntime({
    session,
    registry: createToolRegistry(session),
    provider: {
      id: 'J1-controlled',
      model: 'none',
      async complete(r) {
        if (signal !== r.signal) {
          signal = r.signal;
          turn++;
          step = 0;
        }
        const u = context(r);
        if (step++ === 0) {
          const sourceId = u.userSources[0].sourceId;
          const spec = taskFixture(goals[0]!, { joint: 'elbow', interval: [2, 7] });
          const declaration =
            turn === 0
              ? {
                  name: 'set_task_spec',
                  arguments: {
                    ...spec,
                    goalTypes: modelGoalTypes(spec.goalTypes),
                    sources: spec.sources.map(({ field, origin }) => ({ field, origin, sourceId })),
                  },
                }
              : {
                  name: 'set_task_patch',
                  arguments: {
                    changes: [
                      {
                        field: changes[turn - 1]![0],
                        value: changes[turn - 1]![1],
                        origin: 'explicit',
                        sourceId,
                      },
                    ],
                  },
                };
          return { calls: [{ name: 'get_session_info', arguments: {} }, declaration] };
        }
        if (step === 2) return call('query_metrics', { taskRef: u.bindings.taskRef });
        return call('finish_analysis', {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          citations: [evidenceRef(feedback(r, 'query_metrics'), '/channels/0/rom')],
        });
      },
    },
  });
  let previous: TaskSpec | undefined;
  const oldEvidence = new Set<string>();
  for (const [index, goal] of goals.entries()) {
    const run = await runtime.run(goal);
    assert.equal(run.status, 'completed', run.message);
    if (previous) {
      const expected = structuredClone(previous) as any;
      expected[changes[index - 1]![0]] = structuredClone(changes[index - 1]![1]);
      assert.deepEqual({ ...run.task!.spec, sources: [] }, { ...expected, sources: [] });
      const patch = run.calls.find((c) => c.name === 'set_task_patch')!;
      assert.equal((patch.modelArguments as any).changes.length, 1);
    }
    assert.ok(run.citations.every((c) => !oldEvidence.has(c.evidenceId!)));
    for (const record of run.calls)
      for (const entry of record.evidenceCatalog?.entries ?? []) oldEvidence.add(entry.evidenceId);
    previous = run.task!.spec;
  }
});
