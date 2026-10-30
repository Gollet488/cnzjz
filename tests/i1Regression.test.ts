// Offline historical replay and controlled protocol checks. No real generation.
import { modelGoalTypes } from '../src/agent/modelProtocol.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRuntime } from '../src/agent/runtime.ts';
import type { AgentRun } from '../src/agent/runtime.ts';
import type { ModelProvider } from '../src/agent/provider.ts';
import type { RunAudit } from '../src/agent/audit.ts';
import { OllamaProvider } from '../src/agent/providers/ollama.ts';
import { evaluationSession } from '../src/agent/evaluation.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { validateTaskSpec, missingTaskFields } from '../src/agent/taskSpec.ts';
import type { TaskSpec, TaskUnderstanding } from '../src/agent/taskSpec.ts';
import { applyTaskPatch } from '../src/agent/taskContext.ts';
import { ModelProtocolAdapter, compactModelFeedback } from '../src/agent/modelProtocol.ts';
import { RunEvidenceDirectory } from '../src/agent/evidenceCatalog.ts';
import { taskFixture, evidenceRef } from './agentFixtures.ts';

const historical = JSON.parse(
  await readFile(new URL('./fixtures/i1-historical-failures.json', import.meta.url), 'utf8'),
);
async function saveReplay(name: string, value: unknown) {
  if (process.env.I1_EVIDENCE_DIR)
    await writeFile(
      join(process.env.I1_EVIDENCE_DIR, `${name}.json`),
      JSON.stringify(
        {
          kind: 'controlled/offline replay, not real model acceptance',
          value,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
}
const previous = (spec: TaskSpec, goal: string): TaskUnderstanding => ({
  runId: 'previous',
  goal,
  spec,
  validation: 'structure_and_provenance_only',
});
function comparison(goal: string, joint: TaskSpec['joint'] = 'knee'): TaskSpec {
  return taskFixture(goal, {
    joint,
    goalTypes: ['comparison'],
    comparison: { second: [15, 20], direction: 'second_minus_first' },
    deliveries: {
      view: { joint: joint!, channels: ['left', 'right'], basis: 'filtered', interval: [0, 20] },
      report: false,
      export: null,
    },
  });
}

test('I1 H3 accepted first-only comparison view is refused without altering the declaration', () => {
  const { spec, goal } = historical.compare;
  const before = structuredClone(spec);
  assert.throws(() => validateTaskSpec(spec, goal), /TASK_SPEC_COMPARISON_VIEW_INTERVAL/);
  assert.deepEqual(spec, before);
  // Defense for old/imported tasks at the completion boundary as well.
  assert.ok(missingTaskFields(spec).includes('deliveries.view.interval:comparison_coverage'));
});

for (const [joint, first, second, goal] of [
  ['elbow', [2, 7], [12, 17], '将两段肘关节 ROM 和对应曲线放在一起'],
  ['hip', [10, 14], [1, 5], '髋部按第二段减第一段比较，时间顺序相反'],
  ['wrist', [3, 6], [9, 12], '双腕两个观察窗口的对照'],
] as const) {
  test(`I1 ${joint}: comparison coverage uses both endpoints without keyword routing`, () => {
    const spec = comparison(goal, joint);
    spec.interval = [...first];
    spec.comparison!.second = [...second];
    spec.deliveries.view!.interval = [...first];
    assert.throws(() => validateTaskSpec(spec, goal), /TASK_SPEC_COMPARISON_VIEW_INTERVAL/);
    spec.deliveries.view!.interval = [Math.min(first[0], second[0]), Math.max(first[1], second[1])];
    assert.deepEqual(validateTaskSpec(spec, goal), spec);
    spec.deliveries.view!.interval = [0, 20];
    assert.deepEqual(validateTaskSpec(spec, goal), spec, 'a wider explicitly chosen view is valid');
    spec.deliveries.view = null;
    spec.goalTypes = ['comparison'];
    assert.deepEqual(validateTaskSpec(spec, goal), spec, 'comparison alone does not invent a view');
  });
}

test('I1 multi-turn context retains the source-to-field map after mixed-source patches', () => {
  const initial = '比较左右肘 filtered 0–5 / 15–20 ROM 并展示';
  const goal = '仅右侧，后一个窗口调整到 12–17';
  const spec = applyTaskPatch(
    {
      changes: [
        ['channels', ['right']],
        ['comparison.second', [12, 17]],
        ['deliveries.view.channels', ['right']],
        ['deliveries.view.interval', [0, 17]],
      ].map(([field, value]) => ({
        field,
        value,
        origin: 'explicit',
        text: goal,
        fromRunId: null,
      })),
    },
    goal,
    previous(comparison(initial, 'elbow'), initial),
  );
  assert.deepEqual(spec.interval, [0, 5]);
  assert.equal(spec.basis, 'filtered');
  assert.equal(spec.joint, 'elbow');
  assert.ok(spec.goalTypes.includes('comparison'));
  const session = evaluationSession().info();
  const adapter = new ModelProtocolAdapter('next', session, '继续准备报告', previous(spec, goal));
  const run = {
    id: 'next',
    reference: session,
    goal: '继续准备报告',
    calls: [],
  } as unknown as AgentRun;
  const context = adapter.context(run);
  const sources = context.previousTask!.spec.sources!;
  assert.equal(sources.length, spec.sources.length);
  for (const source of sources) {
    const bound = adapter.userSources.find((s) => s.sourceId === (source as any).sourceId)!;
    assert.equal(bound.kind, 'previous');
    assert.equal(bound.text, spec.sources.find((s) => s.field === source.field)!.text);
  }
  const offered = adapter.tools(run, [
    { name: 'set_task_spec', description: '', inputSchema: {}, outputSchema: {} },
  ]);
  const expanded = adapter.expand(
    { name: 'set_task_spec', arguments: context.previousTask!.spec },
    run,
    offered,
  );
  assert.deepEqual(
    validateTaskSpec(expanded, run.goal, previous(spec, goal)).comparison!.second,
    [12, 17],
  );
});

test('I1 single-field changes retain every unrelated analysis/delivery field over repeated turns', () => {
  let prior = previous(comparison('原始比较与图表'), '原始比较与图表');
  for (const [field, value, goal] of [
    ['deliveries.report', true, '也生成报告'],
    ['deliveries.export', { interval: [0, 17], format: 'csv' }, 'CSV 只取 0 到 17 秒'],
    ['metrics', ['rom', 'meanAngle'], '再看平均角'],
    ['comparison.second', [12, 17], '第二段缩为 12 到 17 秒'],
    ['deliveries.view.interval', [0, 17], '最后图表范围设成 0 到 17'],
  ] as const) {
    const next = applyTaskPatch(
      { changes: [{ field, value, origin: 'explicit', text: goal, fromRunId: null }] },
      goal,
      prior,
    );
    const expected = structuredClone(prior.spec) as any;
    const keys = field.split('.');
    const leaf = keys.pop()!;
    keys.reduce((v, k) => v[k], expected)[leaf] = structuredClone(value);
    assert.deepEqual({ ...next, sources: [] }, { ...expected, sources: [] });
    prior = previous(next, goal);
  }
  assert.deepEqual(prior.spec.interval, [0, 5]);
  assert.deepEqual(prior.spec.comparison!.second, [12, 17]);
  assert.deepEqual(prior.spec.deliveries.export!.interval, [0, 17]);
});

test('I1 report and CSV/view task bindings stay independent; H5 wrong first interval remains a model error', () => {
  const session = evaluationSession().info();
  const goal = '比较报告并导出覆盖区间';
  const spec = comparison(goal);
  spec.comparison!.second = [12, 17];
  spec.deliveries = {
    ...spec.deliveries,
    report: true,
    export: { interval: [0, 17], format: 'csv' },
  };
  spec.deliveries.view!.interval = [0, 17];
  const run = {
    id: 'bound',
    reference: session,
    goal,
    calls: [],
    task: { ...previous(spec, goal), runId: 'bound' },
  } as unknown as AgentRun;
  const adapter = new ModelProtocolAdapter(run.id, session, goal);
  const registry = createToolRegistry(evaluationSession());
  const offered = adapter.tools(run, registry.definitions);
  for (const [name, expected] of [
    ['prepare_report', { interval: [0, 5], comparison: [12, 17] }],
    ['prepare_export', { interval: [0, 17], format: 'csv' }],
    ['set_chart_view', { interval: [0, 17] }],
  ] as const) {
    const args = adapter.expand(
      { name, arguments: { taskRef: adapter.taskRef } },
      run,
      offered,
    ) as any;
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(args[key], value);
  }
  assert.throws(
    () =>
      adapter.expand(
        { name: 'prepare_report', arguments: { taskRef: adapter.taskRef, interval: [0, 17] } },
        run,
        offered,
      ),
    /SCHEMA \$\.interval: unknown field/,
  );
  // A well-formed model declaration with the wrong semantic first interval is
  // still not something a local validator can reinterpret from user prose.
  assert.deepEqual(
    validateTaskSpec(historical.report.spec, historical.report.goal).interval,
    [0, 17],
  );
});

test('I1 artifact feedback distinguishes its handle value from the citable evidence ID', () => {
  const reference = evaluationSession().info();
  const directory = new RunEvidenceDirectory('artifact-run', reference);
  const result = {
    handle: historical.compare.handleCall.output.result.handle,
    evidence: { sessionId: reference.sessionId, revision: reference.revision },
  };
  const record = {
    id: 'report-call',
    name: 'prepare_report',
    arguments: {},
    output: { ok: true as const, tool: 'prepare_report', result },
    evidenceCatalog: directory.add('report-call', result),
  };
  const run = { id: 'artifact-run', reference, calls: [record] } as unknown as AgentRun;
  const feedback = JSON.parse(compactModelFeedback(run)[1]!.content);
  const entry = feedback.evidenceCatalog.entries[0];
  assert.equal(entry.kind, 'artifact_handle');
  assert.match(entry.evidenceId, /^evidence:/);
  assert.notEqual(entry.value, entry.evidenceId);
  assert.throws(() => directory.resolve(result.handle, run), /INVALID_EVIDENCE_ID/);
  assert.equal(directory.resolve(entry.evidenceId, run).value, result.handle);
  assert.throws(
    () => directory.resolve(entry.evidenceId, { ...run, id: 'other-run' }),
    /INVALID_EVIDENCE_ID/,
  );
  assert.throws(
    () =>
      directory.resolve(entry.evidenceId, {
        ...run,
        reference: { ...reference, revision: reference.revision + 1 },
      }),
    /INVALID_EVIDENCE_ID/,
  );
});

test('I1 frozen H3 HTTP 500 retains service error, raw body and unknown usage in the audit', async () => {
  const audits: RunAudit[] = [];
  let requests = 0;
  const provider = new OllamaProvider('http://127.0.0.1:11434', 'offline-fixture', (async () => {
    requests++;
    return new Response(historical.http.body, { status: historical.http.status });
  }) as typeof fetch);
  const session = evaluationSession();
  const run = await new AgentRuntime({
    session,
    registry: createToolRegistry(session),
    provider,
    onAudit: (a) => {
      audits.push(a);
    },
  }).run('读取质量');
  assert.equal(run.status, 'failed');
  assert.equal(requests, 1, 'no implicit retry or guessed tool arguments');
  assert.equal(run.calls.length, 0);
  assert.equal(run.usage.inputTokens, null);
  assert.equal(run.usage.outputTokens, null);
  assert.match(audits[0]!.requests[0]!.error!, /unexpected end of JSON input/);
  assert.equal((audits[0]!.requests[0] as any).providerFailure.responseText, historical.http.body);
  assert.equal((audits[0]!.requests[0] as any).providerFailure.httpStatus, 500);
  await saveReplay('http-500-replay', audits[0]);
});

test('I1 incomplete tool JSON is retained and never repaired into executable arguments', async () => {
  const responseText =
    '{"done":true,"message":{"role":"assistant","tool_calls":[{"function":{"name":"set_task_spec","arguments":';
  const audits: RunAudit[] = [];
  const session = evaluationSession();
  const provider = new OllamaProvider(
    'http://127.0.0.1:11434',
    'offline-fixture',
    (async () => new Response(responseText)) as typeof fetch,
  );
  const run = await new AgentRuntime({
    session,
    registry: createToolRegistry(session),
    provider,
    onAudit: (a) => {
      audits.push(a);
    },
  }).run('不能猜测参数');
  assert.equal(run.status, 'failed');
  assert.equal(run.requests!.length, 1);
  assert.equal(run.calls.length, 0);
  assert.equal(run.usage.outputTokens, null);
  assert.equal((audits[0]!.requests[0] as any).providerFailure.responseText, responseText);
  await saveReplay('incomplete-json-replay', audits[0]);
});

for (const joint of ['knee', 'elbow'] as const) {
  test(`I1 controlled ${joint}: all three turns deliver independent intervals and fresh evidence in chosen tool order`, async () => {
    const session = evaluationSession();
    const workspace: any = { chart: null, time: null };
    const registry = createToolRegistry(session, {
      setChartView: (v) => (workspace.chart = structuredClone(v)),
      readWorkspace: () => workspace,
    });
    let turn = 0,
      step = 0;
    let signal: AbortSignal;
    const user = (r: Parameters<ModelProvider['complete']>[0]) =>
      JSON.parse(r.messages.find((m) => m.role === 'user')!.content);
    const feedback = (r: Parameters<ModelProvider['complete']>[0], name: string) =>
      JSON.parse(r.messages.findLast((m) => m.toolName === name)!.content);
    const provider: ModelProvider = {
      id: 'controlled-I1',
      model: 'no-real-model',
      async complete(r) {
        if (r.signal !== signal) {
          signal = r.signal;
          turn++;
          step = 0;
        }
        const context = user(r);
        const sourceId = context.userSources.find((s: any) => s.kind === 'current').sourceId;
        if (step++ === 0) {
          assert.equal(r.messages.length, 2, 'no historic numbers, handles or evidence IDs');
          const declaration =
            turn === 1
              ? {
                  name: 'set_task_spec',
                  arguments: {
                    ...comparison(context.goal, joint),
                    goalTypes: modelGoalTypes(['comparison']),
                    sources: comparison(context.goal, joint).sources.map(({ field, origin }) => ({
                      field,
                      origin,
                      sourceId,
                    })),
                  },
                }
              : {
                  name: 'set_task_patch',
                  arguments: {
                    changes: (turn === 2
                      ? [
                          ['channels', ['right']],
                          ['comparison.second', [12, 17]],
                          ['deliveries.view.channels', ['right']],
                          ['deliveries.view.interval', [0, 17]],
                        ]
                      : [
                          ['deliveries.report', true],
                          ['deliveries.export', { interval: [0, 17], format: 'csv' }],
                        ]
                    ).map(([field, value]) => ({ field, value, origin: 'explicit', sourceId })),
                  },
                };
          return { calls: [{ name: 'get_session_info', arguments: {} }, declaration] };
        }
        if (step === 2) {
          // Deliberately choose a different order and let the report satisfy
          // comparison on turn 3. The product must not force a tool pipeline.
          const names =
            turn === 1
              ? ['set_chart_view', 'compare_intervals']
              : turn === 2
                ? ['compare_intervals', 'set_chart_view']
                : ['prepare_export', 'set_chart_view', 'prepare_report'];
          return {
            calls: names.map((name) => ({
              name,
              arguments: { taskRef: context.bindings.taskRef },
            })),
          };
        }
        return {
          calls: [
            {
              name: 'finish_analysis',
              arguments: {
                outcome: 'completed',
                messageCode: 'evidence_ready',
                citations:
                  turn === 3
                    ? [
                        evidenceRef(feedback(r, 'prepare_report'), '/handle'),
                        evidenceRef(feedback(r, 'prepare_export'), '/handle'),
                        evidenceRef(feedback(r, 'set_chart_view'), '/view/basis'),
                      ]
                    : [
                        evidenceRef(feedback(r, 'compare_intervals'), '/differences/0/rom'),
                        evidenceRef(feedback(r, 'set_chart_view'), '/view/basis'),
                      ],
              },
            },
          ],
        };
      },
    };
    const audits: RunAudit[] = [];
    const runtime = new AgentRuntime({
      session,
      registry,
      provider,
      onAudit: (a) => {
        audits.push(a);
      },
    });
    const runs: AgentRun[] = [];
    for (const goal of [
      `比较 filtered 左右 ${joint} 的 0–5 / 15–20 ROM，并展示两段`,
      '只看右侧，第二段改成 12–17 秒',
      '准备当前比较报告，并准备 0–17 秒 CSV，保留当前图表',
    ])
      runs.push(await runtime.run(goal));
    assert.deepEqual(
      runs.map((r) => r.status),
      ['completed', 'completed', 'completed'],
      JSON.stringify(
        runs.map((r) => ({
          status: r.status,
          message: r.message,
          errors: r.calls.filter((c) => !c.output.ok),
        })),
      ),
    );
    assert.deepEqual(runs[0]!.task!.spec.deliveries.view!.interval, [0, 20]);
    for (const run of runs.slice(1)) {
      assert.equal(run.task!.spec.joint, joint);
      assert.equal(run.task!.spec.basis, 'filtered');
      assert.deepEqual(run.task!.spec.channels, ['right']);
      assert.deepEqual(run.task!.spec.interval, [0, 5]);
      assert.deepEqual(run.task!.spec.comparison!.second, [12, 17]);
      assert.deepEqual(run.task!.spec.deliveries.view!.interval, [0, 17]);
    }
    const final = runs[2]!;
    const report: any = final.calls.find((c) => c.name === 'prepare_report')!.output;
    const csv: any = final.calls.find((c) => c.name === 'prepare_export')!.output;
    assert.deepEqual(report.result.facts.evidence.interval, [0, 5]);
    assert.deepEqual(report.result.comparison.second.evidence.interval, [12, 17]);
    assert.deepEqual(csv.result.evidence.interval, [0, 17]);
    assert.equal(report.result.facts.units.angle, 'deg');
    assert.ok(report.result.facts.evidence.sampleCount > 0);
    assert.equal(
      report.result.comparison.differences[0].rom,
      report.result.comparison.second.channels[0].rom -
        report.result.comparison.first.channels[0].rom,
    );
    assert.equal(registry.getArtifact(report.result.handle).kind, 'report');
    assert.equal(registry.getArtifact(csv.result.handle).kind, 'csv');
    assert.deepEqual(workspace.chart, final.task!.spec.deliveries.view);
    const old = new Set(
      runs[0]!.calls.flatMap((c) => c.evidenceCatalog?.entries.map((e) => e.evidenceId) ?? []),
    );
    assert.ok(final.citations.every((c) => !old.has(c.evidenceId!)));
    assert.equal(final.conversationCosts!.requests, 9);
    assert.equal(
      final.conversationCosts!.inputTokens,
      null,
      'unknown controlled usage is not zero',
    );
    assert.equal(audits.length, 3);
    await saveReplay(`controlled-three-turn-${joint}`, { runs, audits });
  });
}

test('I1 H5 partial null-export patch still fails rather than filling missing CSV parameters', () => {
  const goal = historical.partialPatch.goal;
  const prior = previous(comparison('已有比较'), '已有比较');
  const changes = historical.partialPatch.call.modelArguments.changes.map((c: any) => ({
    field: c.field,
    value: c.value,
    origin: c.origin,
    text: goal,
    fromRunId: null,
  }));
  assert.throws(() => applyTaskPatch({ changes }, goal, prior), /format/);
  assert.equal(prior.spec.deliveries.export, null);
  assert.deepEqual(prior.spec.comparison!.second, [15, 20]);
});

test('I1 incomplete argument objects consume only the existing recovery allowance and retain all known request costs', async () => {
  const session = evaluationSession();
  const audits: RunAudit[] = [];
  let count = 0;
  const provider = new OllamaProvider('http://127.0.0.1:11434', 'offline-fixture', (async () => {
    count++;
    return Response.json({
      done: true,
      message: {
        role: 'assistant',
        tool_calls: [
          { function: { name: 'set_task_spec', arguments: { goalTypes: ['comparison'] } } },
        ],
      },
      prompt_eval_count: 11,
      eval_count: 7,
    });
  }) as typeof fetch);
  const run = await new AgentRuntime({
    session,
    registry: createToolRegistry(session),
    provider,
    onAudit: (a) => {
      audits.push(a);
    },
  }).run('不猜缺失的关节与区间');
  assert.equal(run.status, 'limit');
  assert.equal(count, 4, 'original recovery budget is 3');
  assert.equal(run.task, undefined);
  assert.ok(run.calls.every((c) => !c.output.ok && !c.evidenceCatalog));
  assert.deepEqual(run.usage, { inputTokens: 44, outputTokens: 28, reportedRequests: 4 });
  assert.equal(audits[0]!.requests.length, 4);
  assert.ok(
    audits[0]!.requests.every(
      (r) =>
        r.reply!.calls[0]!.arguments &&
        Object.keys(r.reply!.calls[0]!.arguments as object).length === 1,
    ),
  );
  await saveReplay('finite-recovery-replay', audits[0]);
});
