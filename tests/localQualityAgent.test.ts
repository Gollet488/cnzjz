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
function fixture() {
  const session = new AnalysisSession('demo', {
    threshold: 0.5,
    window: 5,
    aspect: 1,
    metricVersion: '2.0',
  });
  for (let i = 0; i <= 100; i++) {
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
