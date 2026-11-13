// Synthetic protocol regressions only; real-model acceptance is recorded separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisSession } from '../src/analysis/session.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { AgentRuntime, resolveCitation } from '../src/agent/runtime.ts';
import type { AgentRun, CallRecord, Citation } from '../src/agent/runtime.ts';
import type { ModelProvider } from '../src/agent/provider.ts';
import { checkCompletion } from '../src/agent/completion.ts';
import { assessRun, observeEvaluation } from '../src/agent/evaluation.ts';
import type { EvaluationCase } from '../src/agent/evaluation.ts';
import { missingTaskFields, validateTaskAnalysis } from '../src/agent/taskSpec.ts';
import { compactModelFeedback, modelGoalTypes, taskCatalog } from '../src/agent/modelProtocol.ts';
import { MAX_CATALOG_ENTRIES, RunEvidenceDirectory } from '../src/agent/evidenceCatalog.ts';
import { demoPose } from '../src/utils/demo.ts';
import { taskFixture } from './agentFixtures.ts';

const goal = '检查 filtered 左右肘 0–5 秒的有效样本、覆盖和连续缺失';
function fixture(duration = 5) {
  const session = new AnalysisSession('demo', {
    threshold: 0.5,
    window: 5,
    aspect: 1,
    metricVersion: '2.1',
  });
  for (let i = 0; i <= duration * 20; i++) {
    const points = demoPose(i / 20);
    // Different sides, local visibility gaps, plus full no-detection samples.
    if (i % 5 === 1) points[13]!.visibility = 0.1;
    if (i >= 40 && i <= 70) points[14]!.visibility = 0.1;
    session.append(i === 80 ? [] : points, i / 20);
  }
  const spec = taskFixture(goal, { goalTypes: ['quality'], joint: 'elbow', metrics: [] });
  return { session, spec, registry: createToolRegistry(session) };
}
function qualityCall(
  h: ReturnType<typeof fixture>,
  selection: unknown,
  id = 'quality',
): CallRecord {
  const args = {
    sessionId: h.session.info().sessionId,
    revision: h.session.info().revision,
    interval: [0, 5],
    ...(selection ? { selection } : {}),
  };
  const output = h.registry.execute('get_quality_summary', args);
  assert.equal(output.ok, true, JSON.stringify(output));
  return { id, name: 'get_quality_summary', arguments: args, output };
}
function runWith(h: ReturnType<typeof fixture>, calls: CallRecord[]): AgentRun {
  return {
    id: 'local-quality-run',
    reference: h.session.info(),
    task: { runId: 'local-quality-run', goal, spec: h.spec },
    calls,
  } as AgentRun;
}
function cite(call: CallRecord, path: string): Citation {
  assert.equal(call.output.ok, true);
  return { callId: call.id, path, value: resolveCitation((call.output as any).result, path) };
}

test('local quality declarations require the complete selection, global quality stays parameter-free', () => {
  const { spec } = fixture();
  for (const field of ['joint', 'channels', 'basis'] as const) {
    const partial = { ...spec, [field]: null };
    assert.deepEqual(missingTaskFields(partial), [field]);
    assert.doesNotThrow(() => validateTaskAnalysis(partial));
  }
  const global = { ...spec, joint: null, channels: null, basis: null };
  assert.deepEqual(missingTaskFields(global), []);
  assert.doesNotThrow(() => validateTaskAnalysis(global));
});

test('a constrained quality task preserves a labelled absolute interval before binding tools', async () => {
  const h = fixture();
  const absoluteGoal = '请查询绝对区间 [1.01, 4.01] 秒内 raw 右膝角度的样本质量。';
  const declaration = {
    actions: ['quality'],
    joint: 'knee',
    basis: 'raw',
    channels: ['right'],
    metrics: [],
    second: null,
    view: null,
  };
  let specAttempts = 0;
  const provider: ModelProvider = {
    id: 'scripted-local-quality',
    model: 'no-real-model',
    toolMode: 'constrained',
    async complete(request) {
      const user = JSON.parse(request.messages.find((m) => m.role === 'user')!.content);
      const offered = request.tools.map((tool) => tool.name);
      if (offered.includes('get_session_info'))
        return { calls: [{ name: 'get_session_info', arguments: {} }] };
      if (offered.includes('set_task_spec')) {
        const intervals = ['sampled', [1.01, 1.01], [1.01, 4.01]];
        return {
          calls: [
            {
              name: 'set_task_spec',
              arguments: { ...declaration, interval: intervals[specAttempts++] },
            },
          ],
        };
      }
      if (offered.includes('get_quality_summary'))
        return {
          calls: [{ name: 'get_quality_summary', arguments: { taskRef: user.bindings.taskRef } }],
        };
      const entries = user.availableEvidence.find(
        (e: any) => e.tool === 'get_quality_summary',
      ).entries;
      return {
        calls: [
          {
            name: 'finish_analysis',
            arguments: {
              outcome: 'completed',
              messageCode: 'evidence_ready',
              evidence: {
                get_quality_summary: [
                  entries.find((e: any) => e.label === 'selection.channels.0.coverage').evidenceId,
                ],
              },
            },
          },
        ],
      };
    },
  };
  const runtime = new AgentRuntime({ session: h.session, registry: h.registry, provider });
  const run = await runtime.run(absoluteGoal);
  assert.equal(run.status, 'completed', run.message);
  assert.equal(specAttempts, 3);
  assert.match((run.calls[1]!.output as any).error.message, /\$\.interval/);
  assert.match((run.calls[2]!.output as any).error.message, /TASK_SPEC_QUALITY_INTERVAL/);
  const quality = run.calls.filter((call) => call.name === 'get_quality_summary');
  assert.equal(quality.length, 1);
  assert.deepEqual((quality[0]!.arguments as any).interval, [1.01, 4.01]);
});

const historicalQualityGoals = [
  '请检查 35.01–40.01 秒 raw 右膝角度的样本质量。给出实际采样范围、有效样本数、无效样本数和帧覆盖率，说明分母与限制，并引用有效数、无效数和覆盖率。',
  '请查询 raw 右膝角度在第 35.01 秒到第 40.01 秒的样本质量（绝对区间 [35.01, 40.01]）。请引用有效样本数、无效样本数和帧覆盖率。',
];
const rightKneeQuality = {
  actions: ['quality'],
  joint: 'knee',
  basis: 'raw',
  channels: ['right'],
  metrics: [],
  second: null,
  view: null,
};
const qualityLabels = ['validSamples', 'invalidSamples', 'coverage'];

function scriptedQuality(declare: (tool: string, user: any) => object): ModelProvider {
  return {
    id: 'scripted-local-quality',
    model: 'no-real-model',
    toolMode: 'constrained',
    async complete(request) {
      const user = JSON.parse(request.messages.find((m) => m.role === 'user')!.content);
      const offered = request.tools.map((tool) => tool.name);
      const call = (name: string, args: object) => ({ calls: [{ name, arguments: args }] });
      if (offered.includes('get_session_info')) return call('get_session_info', {});
      const declaration =
        offered.find((name) => name === 'set_task_patch') ??
        offered.find((name) => name === 'set_task_spec');
      if (declaration) return call(declaration, declare(declaration, user));
      if (offered.includes('get_quality_summary'))
        return call('get_quality_summary', { taskRef: user.bindings.taskRef });
      const entries = user.availableEvidence.find(
        (item: any) => item.tool === 'get_quality_summary',
      )?.entries;
      return call(
        'finish_analysis',
        entries
          ? {
              outcome: 'completed',
              messageCode: 'evidence_ready',
              evidence: {
                get_quality_summary: qualityLabels.map(
                  (label) =>
                    entries.find((entry: any) => entry.label === `selection.channels.0.${label}`)
                      .evidenceId,
                ),
              },
            }
          : { outcome: 'needs_input', messageCode: 'specify_parameters', evidence: {} },
      );
    },
  };
}

for (const [index, query] of [
  ...historicalQualityGoals,
  '想了解从 35.01 秒至 40.01 秒右膝 raw 角度的样本质量，请列出有效帧和覆盖率。',
].entries()) {
  test(`quality range replay ${index + 1} rejects substituted bounds before computing`, async () => {
    const h = fixture(67);
    const intervals = ['sampled', [35.01, 35.01], [35.01, 40.01]];
    let attempts = 0;
    const provider = scriptedQuality(() => ({
      ...rightKneeQuality,
      ...(index < 2 && attempts === 0
        ? {
            metrics: index === 1 ? ['coverage'] : [],
            second: 'sampled',
            view: 'sampled',
          }
        : {}),
      interval: intervals[attempts++],
    }));
    const run = await new AgentRuntime({ session: h.session, registry: h.registry, provider }).run(
      query,
    );
    const quality = run.calls.filter((call) => call.name === 'get_quality_summary');
    const declarations = run.calls.filter((call) => call.name === 'set_task_spec');
    const result = quality[0]?.output.ok ? (quality[0].output.result as any) : undefined;
    assert.deepEqual(
      {
        accepted: declarations.map((call) => call.output.ok),
        status: run.status,
        bound: run.task?.spec.interval,
        queried: (quality[0]?.arguments as any)?.interval,
        evidenceRange: result?.evidence.interval,
        sampledRange: result?.evidence.sampledRange,
        sampleCount: result?.evidence.sampleCount,
      },
      {
        accepted: [false, false, true],
        status: 'completed',
        bound: [35.01, 40.01],
        queried: [35.01, 40.01],
        evidenceRange: [35.01, 40.01],
        sampledRange: [35.05, 40],
        sampleCount: 100,
      },
    );
    assert.deepEqual(
      run.calls.map((call) => call.name),
      [
        'get_session_info',
        'set_task_spec',
        'set_task_spec',
        'set_task_spec',
        'get_quality_summary',
        'finish_analysis',
      ],
    );
    assert.deepEqual(quality[0]!.arguments, {
      sessionId: h.session.info().sessionId,
      revision: h.session.info().revision,
      interval: [35.01, 40.01],
      selection: { joint: 'knee', channels: ['right'], basis: 'raw' },
    });
    assert.equal(run.completion?.state, 'ready');
    assert.deepEqual(
      run.citations.map(({ callId, path, value }) => ({ callId, path, value })),
      qualityLabels.map((label) => ({
        callId: quality[0]!.id,
        path: `/selection/channels/0/${label}`,
        value: result.selection.channels[0][label],
      })),
    );
  });
}

for (const [name, query, missing] of [
  [
    'conflicting ranges',
    '请检查 raw 右膝在 35.01–40.01 秒或 36.01–41.01 秒的样本质量。',
    ['interval'],
  ],
  ['missing selection', '请检查 35.01–40.01 秒膝关节的样本质量。', ['channels', 'basis']],
] as const) {
  test(`quality range ${name} needs clarification without querying samples`, async () => {
    const h = fixture(67);
    let attempts = 0;
    const provider = scriptedQuality(() => {
      attempts++;
      if (name === 'conflicting ranges')
        return {
          ...rightKneeQuality,
          interval: attempts === 1 ? [35.01, 40.01] : null,
          unresolved: attempts === 1 ? [] : missing,
        };
      return {
        ...rightKneeQuality,
        interval: [35.01, 40.01],
        channels: null,
        basis: null,
        unresolved: missing,
      };
    });
    const run = await new AgentRuntime({ session: h.session, registry: h.registry, provider }).run(
      query,
    );
    assert.equal(run.status, 'needs_input', run.message);
    assert.equal(run.completion?.state, 'needs_input');
    assert.deepEqual(run.completion?.missing, missing);
    assert.deepEqual(
      run.task?.spec.interval,
      name === 'conflicting ranges' ? null : [35.01, 40.01],
    );
    assert.deepEqual(
      run.calls.map((call) => [call.name, call.output.ok]),
      [
        ['get_session_info', true],
        ...(name === 'conflicting ranges' ? [['set_task_spec', false]] : []),
        ['set_task_spec', true],
        ['finish_analysis', true],
      ],
    );
    assert.deepEqual(run.citations, []);
  });
}

test('quality scope retains full and relative selections and the unchanged fields in follow-ups', async () => {
  const h = fixture(67);
  let absoluteAttempts = 0;
  const provider = scriptedQuality((tool, user) => {
    if (tool === 'set_task_spec') return { ...rightKneeQuality, interval: 'sampled' };
    if (user.goal.includes('末尾')) return { changes: { first: { anchor: 'end', seconds: 5 } } };
    if (user.goal.includes('35.01'))
      return { changes: { first: absoluteAttempts++ === 0 ? 'sampled' : [35.01, 40.01] } };
    return { changes: { channels: ['left'] } };
  });
  const runtime = new AgentRuntime({ session: h.session, registry: h.registry, provider });
  for (const [query, interval, channel, declarations] of [
    ['请检查全片 raw 右膝样本质量。', [0, 67], 'right', [true]],
    ['区间改成采样末尾 5 秒，其他照旧。', [62, 67], 'right', [true]],
    ['区间改成 35.01-40.01 秒，其他照旧。', [35.01, 40.01], 'right', [false, true]],
    ['只改左侧，区间和口径照旧。', [35.01, 40.01], 'left', [true]],
  ] as const) {
    const run = await runtime.run(query);
    assert.equal(run.status, 'completed', run.message);
    assert.equal(run.completion?.state, 'ready');
    assert.deepEqual(
      run.calls
        .filter((call) => ['set_task_spec', 'set_task_patch'].includes(call.name))
        .map((call) => call.output.ok),
      declarations,
    );
    const quality = run.calls.filter((call) => call.name === 'get_quality_summary');
    assert.equal(quality.length, 1);
    assert.deepEqual(quality[0]!.arguments, {
      sessionId: h.session.info().sessionId,
      revision: h.session.info().revision,
      interval,
      selection: { joint: 'knee', channels: [channel], basis: 'raw' },
    });
    assert.ok(quality[0]!.output.ok);
    assert.deepEqual((quality[0]!.output.result as any).evidence.interval, interval);
    assert.equal(run.citations.length, qualityLabels.length);
    assert.ok(run.citations.every(({ callId }) => callId === quality[0]!.id));
  }
});

test('local quality completion requires both selected sides and basis; global evidence cannot substitute', () => {
  const h = fixture();
  const selection = { joint: 'elbow', channels: ['left', 'right'], basis: 'filtered' };
  const local = qualityCall(h, selection);
  const global = qualityCall(h, null, 'global');
  const run = runWith(h, [local, global]);
  assert.deepEqual(checkCompletion(run, [cite(global, '/effectiveRate')], h.registry).missing, [
    'quality',
  ]);
  const left = cite(local, '/selection/channels/0/validSamples');
  const right = cite(local, '/selection/channels/1/invalidSamples');
  assert.deepEqual(checkCompletion(run, [left], h.registry).missing, ['quality']);
  assert.equal(checkCompletion(run, [left, right], h.registry).state, 'ready');
  for (const wrong of [
    { ...selection, basis: 'raw' },
    { ...selection, joint: 'knee' },
    { ...selection, channels: ['left'] },
  ]) {
    const mismatch = qualityCall(h, wrong, 'wrong');
    const refs = (mismatch.output as any).result.selection.channels.map((_: any, i: number) =>
      cite(mismatch, `/selection/channels/${i}/validSamples`),
    );
    assert.deepEqual(checkCompletion(runWith(h, [mismatch]), refs, h.registry).missing, [
      'quality',
    ]);
  }
});

test('bounded quality catalogs preserve both-side samples and long-gap source endpoints', () => {
  const h = fixture();
  const record = qualityCall(h, { joint: 'elbow', channels: ['left', 'right'], basis: 'filtered' });
  const run = runWith(h, [record]);
  const directory = new RunEvidenceDirectory(run.id, run.reference);
  record.evidenceCatalog = directory.add(record.id, (record.output as any).result);
  assert.ok(record.evidenceCatalog.entries.length <= MAX_CATALOG_ENTRIES);
  const catalog = taskCatalog(record, run);
  assert.ok(catalog.entries.length <= 16);
  for (const side of [0, 1])
    for (const field of [
      'validSamples',
      'coverage',
      'invalidSamples',
      'longestMissingInterval.interval.0',
      'longestMissingInterval.interval.1',
      'longestMissingInterval.samples',
    ]) {
      const label = `selection.channels.${side}.${field}`;
      const entry = catalog.entries.find((e) => e.label === label);
      assert.ok(entry, label);
      const resolved = directory.resolve(entry.evidenceId, run);
      assert.equal(resolved.value, resolveCitation((record.output as any).result, resolved.path));
    }
  const projected = compactModelFeedback(run).find((m) => m.role === 'tool')!;
  const feedback = JSON.parse(projected.content);
  assert.equal(feedback.result.selection.joint, 'elbow');
  assert.equal(feedback.result.selection.channels.length, 2);
  assert.equal(feedback.result.selection.channels[1].invalidSamples, 32);
  assert.ok(Buffer.byteLength(projected.content) < 16000);
  h.session.recalculate({ ...h.session.info().parameters, window: 3 });
  assert.throws(() => h.registry.validateEvidence((record.output as any).result.evidence), /STALE/);
  assert.throws(
    () =>
      directory.resolve(catalog.entries[0]!.evidenceId, { ...run, reference: h.session.info() }),
    /INVALID_EVIDENCE_ID/,
  );
});

test('model task binding uses the accepted local selection without extra metrics or guessed parameters', async () => {
  const h = fixture();
  let step = 0;
  const provider: ModelProvider = {
    id: 'scripted-local-quality',
    model: 'not-a-real-model',
    async complete(request) {
      const user = JSON.parse(request.messages.find((m) => m.role === 'user')!.content);
      if (step++ === 0)
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            {
              name: 'set_task_spec',
              arguments: {
                ...h.spec,
                goalTypes: modelGoalTypes(h.spec.goalTypes),
                sources: [
                  { field: 'task', origin: 'explicit', sourceId: user.userSources[0].sourceId },
                ],
              },
            },
          ],
        };
      if (step === 2)
        return {
          calls: [{ name: 'get_quality_summary', arguments: { taskRef: user.bindings.taskRef } }],
        };
      const entries = user.availableEvidence.find(
        (e: any) => e.tool === 'get_quality_summary',
      ).entries;
      return {
        calls: [
          {
            name: 'finish_analysis',
            arguments: {
              outcome: 'completed',
              messageCode: 'evidence_ready',
              citations: [0, 1].map((i) => ({
                evidenceId: entries.find((e: any) => e.label === `selection.channels.${i}.coverage`)
                  .evidenceId,
              })),
            },
          },
        ],
      };
    },
  };
  const run = await new AgentRuntime({ session: h.session, registry: h.registry, provider }).run(
    goal,
  );
  assert.equal(run.status, 'completed', run.message);
  const call = run.calls.find((c) => c.name === 'get_quality_summary')!;
  assert.deepEqual((call.arguments as any).selection, {
    joint: 'elbow',
    channels: ['left', 'right'],
    basis: 'filtered',
  });
  assert.deepEqual(run.task!.spec.metrics, []);
  assert.equal(
    run.calls.some((c) => c.name === 'query_metrics'),
    false,
  );
  assert.equal(run.citations.length, 2);
});

test('a report cannot register stale comparison-quality evidence under a current outer version', async () => {
  const h = fixture();
  const args = {
    sessionId: h.session.info().sessionId,
    revision: h.session.info().revision,
    joint: 'elbow',
    channels: ['left', 'right'],
    basis: 'filtered',
    interval: [0, 1],
    comparison: [4, 5],
  };
  const registry = {
    ...h.registry,
    execute(name: string, input: unknown) {
      const output = h.registry.execute(name, input);
      if (name === 'prepare_report' && output.ok) {
        const result = structuredClone(output.result) as any;
        assert.ok(result.comparisonQuality);
        result.comparisonQuality.evidence.revision--;
        return { ...output, result };
      }
      return output;
    },
  };
  let step = 0;
  const run = await new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session: h.session,
    registry,
    provider: {
      id: 'scripted-stale-local-quality',
      model: 'not-a-real-model',
      async complete() {
        if (step++ === 0)
          return {
            calls: [
              { name: 'get_session_info', arguments: {} },
              {
                name: 'set_task_spec',
                arguments: taskFixture(goal, {
                  goalTypes: ['report'],
                  joint: 'elbow',
                  interval: [0, 1],
                  comparison: { second: [4, 5], direction: 'second_minus_first' },
                  metrics: [],
                  deliveries: { view: null, report: true, export: null },
                }),
              },
            ],
          };
        if (step === 2) return { calls: [{ name: 'prepare_report', arguments: args }] };
        return {
          calls: [
            {
              name: 'finish_analysis',
              arguments: { outcome: 'failed', messageCode: 'execution_failed', citations: [] },
            },
          ],
        };
      },
    },
  }).run(goal);
  const report = run.calls.find((c) => c.name === 'prepare_report')!;
  assert.equal(report.output.ok, false);
  assert.match((report.output as any).error.message, /STALE_SESSION/);
  assert.equal(report.evidenceCatalog, undefined);
  assert.equal(run.status, 'failed');
});

test('two-interval bounded catalogs retain each side source-time extrema', () => {
  const h = fixture();
  const output = h.registry.execute('compare_intervals', {
    sessionId: h.session.info().sessionId,
    revision: h.session.info().revision,
    joint: 'elbow',
    channels: ['left', 'right'],
    basis: 'filtered',
    first: [0, 1],
    second: [3, 4],
  });
  assert.equal(output.ok, true);
  const record: CallRecord = { id: 'compare', name: 'compare_intervals', arguments: {}, output };
  const run = runWith(h, [record]);
  run.task!.spec.metrics = ['rom'];
  const directory = new RunEvidenceDirectory(run.id, run.reference);
  record.evidenceCatalog = directory.add(record.id, (output as any).result);
  assert.ok(record.evidenceCatalog.entries.length <= MAX_CATALOG_ENTRIES);
  const catalog = taskCatalog(record, run);
  assert.ok(catalog.entries.length <= 24);
  for (const part of ['first', 'second'])
    for (const side of [0, 1])
      for (const event of ['minimum', 'maximum']) {
        const label = `${part}.channels.${side}.events.${event}.time`;
        const entry = catalog.entries.find((e) => e.label === label);
        assert.ok(entry, label);
        const citation = directory.resolve(entry.evidenceId, run);
        assert.equal(citation.value, resolveCitation((output as any).result, citation.path));
      }
});

test('a restricted comparison report satisfies delivery while the comparison stays unfulfilled', async () => {
  const h = fixture();
  for (let i = 101; i <= 200; i++) h.session.append(demoPose(i / 20), i / 20);
  const view = {
    joint: 'elbow' as const,
    channels: ['left', 'right'] as const,
    basis: 'filtered' as const,
    interval: [1.5, 8],
  };
  const spec = taskFixture(goal, {
    goalTypes: ['comparison', 'quality'],
    joint: 'elbow',
    interval: [1.5, 3.5],
    comparison: { second: [6, 8], direction: 'second_minus_first' },
    deliveries: {
      view: { ...view, channels: [...view.channels], interval: [1.5, 8] },
      report: true,
      export: { interval: [1.5, 8], format: 'csv' },
    },
  });
  const workspace = { chart: null as any, time: null };
  const registry = createToolRegistry(h.session, {
    readWorkspace: () => workspace,
    setChartView: (value) => (workspace.chart = structuredClone(value)),
    seekToTime: (time) => ({ appliedTime: time }),
  });
  let step = 0;
  const run = await new AgentRuntime({
    session: h.session,
    registry,
    provider: {
      id: 'scripted-limited-report',
      model: 'not-a-real-model',
      async complete(request) {
        const user = JSON.parse(request.messages.find((m) => m.role === 'user')!.content);
        if (step++ === 0)
          return {
            calls: [
              { name: 'get_session_info', arguments: {} },
              {
                name: 'set_task_spec',
                arguments: {
                  ...spec,
                  goalTypes: modelGoalTypes(spec.goalTypes),
                  sources: [
                    { field: 'task', origin: 'explicit', sourceId: user.userSources[0].sourceId },
                  ],
                },
              },
            ],
          };
        if (step === 2)
          return {
            calls: [
              'compare_intervals',
              'get_quality_summary',
              'set_chart_view',
              'prepare_report',
              'prepare_export',
            ].map((name) => ({ name, arguments: { taskRef: user.bindings.taskRef } })),
          };
        const ref = (tool: string, label: string) => {
          const entry = user.availableEvidence
            .find((e: any) => e.tool === tool)
            .entries.find((e: any) => e.label === label);
          assert.ok(entry, `${tool}:${label}`);
          return { evidenceId: entry.evidenceId };
        };
        return {
          calls: [
            {
              name: 'finish_analysis',
              arguments: {
                outcome: step === 3 ? 'completed' : 'limited',
                messageCode: step === 3 ? 'evidence_ready' : 'comparison_limited',
                citations: [
                  ref('compare_intervals', 'comparable'),
                  ref('compare_intervals', 'first.channels.0.events.minimum.time'),
                  ref('get_quality_summary', 'selection.channels.0.coverage'),
                  ref('get_quality_summary', 'selection.channels.1.coverage'),
                  ref('set_chart_view', 'view.basis'),
                  ref('prepare_report', 'handle'),
                  ref('prepare_export', 'handle'),
                ],
              },
            },
          ],
        };
      },
    },
  }).run(goal);
  assert.equal(run.status, 'not_comparable', run.message);
  assert.equal(run.completion!.state, 'not_comparable');
  assert.deepEqual(run.completion!.missing, ['comparison']);
  assert.deepEqual(run.completion!.satisfied, ['quality', 'view', 'report', 'export']);
  assert.ok(run.completion!.limitations.some((line) => line.includes('80%')));
  const refused = run.calls.find((c) => c.name === 'finish_analysis' && !c.output.ok)!;
  assert.match((refused.output as any).error.message, /NOT_COMPARABLE/);
  const report = run.calls.find((c) => c.name === 'prepare_report')!;
  assert.equal((report.output as any).result.comparison.comparable, false);
  assert.ok(registry.getArtifact((report.output as any).result.handle));
  const comparison = run.calls.find((c) => c.name === 'compare_intervals')!;
  const scenario = {
    id: 'restricted-local-report',
    group: 'business',
    turns: [
      {
        goal,
        status: ['not_comparable'],
        expected: [{ name: comparison.name, args: comparison.arguments }],
      },
    ],
  } as EvaluationCase;
  const observation = observeEvaluation(run, workspace, registry);
  const assessment = assessRun(run, scenario, h.session, observation);
  assert.equal(assessment.passed, true, assessment.failures.join(','));
  const falseCompletion = assessRun(
    { ...run, status: 'completed' },
    { ...scenario, turns: [{ ...scenario.turns[0]!, status: ['completed'] }] },
    h.session,
    observation,
  );
  assert.ok(falseCompletion.failures.includes('missing_delivery_evidence:compare_intervals'));
});
