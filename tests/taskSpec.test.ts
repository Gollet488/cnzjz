import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { evaluationSession } from '../src/agent/evaluation.ts';
import type { ModelProvider } from '../src/agent/provider.ts';
import type { TaskSpec } from '../src/agent/taskSpec.ts';
import {
  validateTaskSpec,
  missingTaskFields,
  validateTaskAnalysis,
  declaresTaskMissingField,
} from '../src/agent/taskSpec.ts';
import type { ChartView } from '../src/analysis/tools.ts';
import { evidenceRef, taskFixture, taskForActions } from './agentFixtures.ts';

const comparisonSpec = {
  goalTypes: ['comparison'],
  joint: 'knee',
  channels: ['left', 'right'],
  basis: 'filtered',
  interval: [0, 5],
  comparison: { second: [15, 20], direction: 'second_minus_first' },
  metrics: ['rom'],
  time: null,
  deliveries: {
    view: { joint: 'knee', channels: ['left', 'right'], basis: 'filtered', interval: [0, 20] },
    report: false,
    export: null,
  },
  sources: [],
  unresolved: [],
};

test('structured unresolved only describes missing required fields, without mutating declarations', () => {
  const goal = '查询质量、统计或交付';
  for (const path of [
    'joint',
    'comparison.second',
    'deliveries.report',
    'deliveries.export.interval',
    'interval',
  ]) {
    const spec = taskFixture(goal, {
      goalTypes: ['quality'],
      joint: null,
      channels: null,
      basis: null,
      comparison: null,
      metrics: [],
      interval: [0, 20],
      unresolved: [path],
    });
    const before = structuredClone(spec);
    assert.throws(() => validateTaskAnalysis(spec), /TASK_SPEC_UNRESOLVED_CONFLICT/);
    assert.deepEqual(spec, before);
  }
  const missing = taskFixture(goal, { basis: null, unresolved: ['basis', '需要用户说明采样条件'] });
  assert.doesNotThrow(() => validateTaskAnalysis(missing));
  assert.deepEqual(missing.unresolved, ['basis', '需要用户说明采样条件']);
  const unresolvedChild = taskFixture(goal, {
    goalTypes: ['comparison'],
    comparison: null,
    unresolved: ['comparison.second'],
  });
  assert.doesNotThrow(() => validateTaskAnalysis(unresolvedChild));
  assert.equal(declaresTaskMissingField(unresolvedChild, 'comparison'), true);
  unresolvedChild.unresolved = ['comparison.任意自由文本'];
  assert.equal(declaresTaskMissingField(unresolvedChild, 'comparison'), false);
});

test('review R1: quality alone cannot complete a comparison and view goal', async () => {
  const session = evaluationSession();
  const goal = '比较前后各 5 秒的左右膝 ROM，并展示差异';
  const spec = {
    ...comparisonSpec,
    sources: Object.keys(comparisonSpec)
      .filter((k) => !['sources', 'unresolved'].includes(k))
      .map((field) => ({ field, origin: 'explicit', text: goal, fromRunId: null })),
  };
  let step = 0;
  const run = await new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session,
    registry: createToolRegistry(session),
    provider: {
      id: 'scripted-r1',
      model: 'not-real',
      async complete(request) {
        const call = (name: string, args: unknown) => ({ calls: [{ name, arguments: args }] });
        if (step++ === 0)
          return {
            calls: [
              { name: 'get_session_info', arguments: {} },
              { name: 'set_task_spec', arguments: spec },
            ],
          };
        if (step === 2)
          return call('get_quality_summary', {
            sessionId: session.info().sessionId,
            revision: session.info().revision,
            interval: [0, 20],
          });
        const quality = request.messages
          .filter((m) => m.toolName === 'get_quality_summary')
          .map((m) => JSON.parse(m.content))
          .at(-1);
        return call('finish_analysis', {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          citations: [evidenceRef(quality, '/effectiveRate')],
        });
      },
    },
  }).run(goal);
  assert.notEqual(run.status, 'completed', 'R1: quality is not comparison or final view evidence');
  assert.ok(run.task, 'the submitted comparison specification must be accepted');
  assert.deepEqual(run.completion?.missing, ['comparison', 'view']);
  assert.ok(run.calls.some((c) => c.name === 'finish_analysis' && !c.output.ok));
});

type Action = { name: string; args: Record<string, unknown> };
const paths: Record<string, string> = {
  query_metrics: '/channels/0/rom',
  compare_intervals: '/differences/0/rom',
  get_quality_summary: '/effectiveRate',
  set_chart_view: '/view/basis',
  seek_to_time: '/appliedTime',
  prepare_report: '/handle',
  prepare_export: '/handle',
};
function bench() {
  const session = evaluationSession();
  const state: { chart: ChartView | null; time: number | null } = { chart: null, time: null };
  const registry = createToolRegistry(session, {
    readWorkspace: () => structuredClone(state),
    seekToTime(time) {
      state.time = session.frames.reduce(
        (best, f) => (Math.abs(f.time - time) < Math.abs(best - time) ? f.time : best),
        session.frames[0].time,
      );
      return { appliedTime: state.time };
    },
    setChartView(view) {
      state.chart = structuredClone(view);
      return view;
    },
  });
  return { session, state, registry };
}
async function executeCase(
  goal: string,
  spec: TaskSpec,
  actions: Action[],
  options: {
    outcome?: string;
    fallback?: string;
    paths?: Record<string, string>;
    beforeFinish?: (w: ReturnType<typeof bench>) => void;
    omitSpec?: boolean;
  } = {},
) {
  const w = bench();
  let step = 0;
  const provider: ModelProvider = {
    id: 'vendor-neutral-script',
    model: 'protocol-only',
    async complete(request) {
      const call = (name: string, args: unknown) => ({ calls: [{ name, arguments: args }] });
      if (step++ === 0)
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            ...(options.omitSpec ? [] : [{ name: 'set_task_spec', arguments: spec }]),
          ],
        };
      if (step === 2 && actions.length)
        return {
          calls: actions.map((a) => ({
            name: a.name,
            arguments: {
              sessionId: w.session.info().sessionId,
              revision: w.session.info().revision,
              ...a.args,
            },
          })),
        };
      if (step <= 3) options.beforeFinish?.(w);
      const messages = request.messages
        .filter((m) => m.role === 'tool')
        .map((m) => JSON.parse(m.content));
      const rejected = messages.some((m) => m.tool === 'finish_analysis' && !m.ok);
      return call('finish_analysis', {
        outcome: rejected ? (options.fallback ?? 'failed') : (options.outcome ?? 'completed'),
        messageCode: 'evidence_ready',
        citations: actions.flatMap((a) => {
          const result = messages.findLast((m) => m.tool === a.name && m.ok);
          return result ? [evidenceRef(result, options.paths?.[a.name] ?? paths[a.name])] : [];
        }),
      });
    },
  };
  const run = await new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session: w.session,
    registry: w.registry,
    provider,
  }).run(goal);
  return { ...w, run };
}

// These goals and parameters are independent of the fixed evaluation cases.
const shoulder = { joint: 'shoulder', channels: ['right'], basis: 'raw' };
const compare = {
  name: 'compare_intervals',
  args: { ...shoulder, first: [1, 4], second: [11, 14] },
};
const view = { name: 'set_chart_view', args: { ...shoulder, interval: [1, 14] } };
for (const goal of [
  '把开头一至四秒与十一至十四秒的右肩原始活动范围作对照，并画出来',
  '请呈现右肩 raw 在 1–4 和 11–14 秒的 ROM 差值曲线',
]) {
  test(`paraphrased comparison completes with independent shoulder intervals: ${goal}`, async () => {
    const spec = taskForActions(goal, [compare, view]);
    // View before statistics is valid: the model chooses the order.
    const { run } = await executeCase(goal, spec, [view, compare]);
    assert.equal(run.status, 'completed', JSON.stringify(run.calls));
    assert.equal(run.completion?.state, 'ready');
    assert.equal(run.task?.validation, 'structure_and_provenance_only');
  });
}
for (const [label, args] of [
  ['joint', { joint: 'elbow' }],
  ['side', { channels: ['left'] }],
  ['basis', { basis: 'filtered' }],
  ['interval', { first: [2, 5] }],
  ['direction', { first: [11, 14], second: [1, 4] }],
] as const) {
  test(`matching quality/view cannot mask wrong comparison ${label}`, async () => {
    const goal = '对照右肩 raw 的 1–4 秒和 11–14 秒 ROM 并显示';
    const spec = taskForActions(goal, [compare, view]);
    const { run } = await executeCase(
      goal,
      spec,
      [
        view,
        { name: compare.name, args: { ...compare.args, ...args } },
        { name: 'get_quality_summary', args: { interval: [1, 14] } },
      ],
      { fallback: 'partial' },
    );
    assert.equal(run.status, 'partial');
    assert.deepEqual(run.completion?.missing, ['comparison']);
    assert.deepEqual(run.completion?.satisfied, ['view']);
  });
}
test('a view reference and comparison metadata cannot substitute for comparison statistics', async () => {
  const goal = '比较右肩指定区间 raw ROM 并展示';
  const spec = taskForActions(goal, [compare, view]);
  const { run } = await executeCase(goal, spec, [compare, view], {
    paths: { compare_intervals: '/first/evidence/sampleCount' },
    fallback: 'partial',
  });
  assert.equal(run.status, 'partial');
  assert.deepEqual(run.completion?.missing, ['comparison']);
});
test('quality cannot substitute for requested ROM even when the metric call succeeded', async () => {
  const goal = '查询右肩原始 ROM';
  const action = { name: 'query_metrics', args: { ...shoulder, interval: [1, 4] } };
  const { run } = await executeCase(goal, taskForActions(goal, [action]), [action], {
    paths: { query_metrics: '/channels/0/coverage' },
  });
  assert.notEqual(run.status, 'completed');
  assert.deepEqual(run.completion?.missing, ['metrics']);
});
test('missing numeric statistics cannot complete a metric or report goal', async () => {
  for (const name of ['query_metrics', 'prepare_report']) {
    const goal = '只处理右肩 raw 的单帧区间，ROM 保留缺失';
    const action = {
      name,
      args: {
        ...shoulder,
        interval: [2, 2],
        ...(name === 'prepare_report' ? { comparison: null } : {}),
      },
    };
    const { run } = await executeCase(goal, taskForActions(goal, [action]), [action]);
    assert.notEqual(run.status, 'completed');
    assert.deepEqual(run.completion?.missing, [name === 'query_metrics' ? 'metrics' : 'report']);
  }
});

for (const field of ['joint', 'channels', 'basis', 'interval', 'comparison', 'metrics'] as const) {
  test(`missing ${field} stays missing and requires clarification despite successful tools`, async () => {
    const goal = '比较这两段，其他参数尚未明确';
    const spec = taskForActions(goal, [compare, view]);
    (spec as any)[field] = field === 'metrics' ? [] : null;
    const { run } = await executeCase(goal, spec, [compare, view], { fallback: 'needs_input' });
    assert.equal(run.status, 'needs_input');
    assert.deepEqual(run.task?.spec[field], spec[field]);
    assert.ok(run.completion?.missing.includes(field));
  });
}
test('unknown intent and explicit ambiguity remain clarification requirements', async () => {
  const spec = taskFixture('按之前的意思处理', { goalTypes: [], unresolved: ['不清楚所指目标'] });
  assert.deepEqual(missingTaskFields(validateTaskSpec(spec, '按之前的意思处理')), [
    '不清楚所指目标',
    'goalTypes',
  ]);
  const action = { name: 'get_quality_summary', args: { interval: [0, 20] } };
  const { run } = await executeCase('按之前的意思处理', spec, [action], {
    fallback: 'needs_input',
  });
  assert.equal(run.status, 'needs_input');
});

const independent: { goal: string; action: Action }[] = [
  { goal: '跳到七点零三秒附近的已采样帧', action: { name: 'seek_to_time', args: { time: 7.03 } } },
  {
    goal: '显示左肘 filtered 的 2–6 秒曲线',
    action: {
      name: 'set_chart_view',
      args: { joint: 'elbow', channels: ['left'], basis: 'filtered', interval: [2, 6] },
    },
  },
  {
    goal: '给右肩 raw 的 1–4 秒生成报告',
    action: { name: 'prepare_report', args: { ...shoulder, interval: [1, 4], comparison: null } },
  },
  {
    goal: '把 3–8 秒准备为 CSV',
    action: { name: 'prepare_export', args: { interval: [3, 8], format: 'csv' } },
  },
  {
    goal: '只查 6–9 秒的缺失和质量',
    action: { name: 'get_quality_summary', args: { interval: [6, 9] } },
  },
  {
    goal: '只统计脊柱中线的 filtered ROM，范围 2–6 秒',
    action: {
      name: 'query_metrics',
      args: { joint: 'spine', channels: ['midline'], basis: 'filtered', interval: [2, 6] },
    },
  },
];
for (const { goal, action } of independent)
  test(`independent ${action.name} needs only its own delivery`, async () => {
    const { run } = await executeCase(goal, taskForActions(goal, [action]), [action]);
    assert.equal(run.status, 'completed', JSON.stringify(run.calls));
    assert.deepEqual(
      run.calls.filter((c) => Object.keys(paths).includes(c.name)).map((c) => c.name),
      [action.name],
    );
  });
test('a report with matching comparison facts can deliver comparison without a redundant compare call', async () => {
  const goal = '将右肩 raw 两段对照写进报告';
  const action = {
    name: 'prepare_report',
    args: { ...shoulder, interval: [1, 4], comparison: [11, 14] },
  };
  const spec = taskForActions(goal, [action]);
  spec.goalTypes.push('comparison');
  const { run } = await executeCase(goal, spec, [action]);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.completion?.satisfied, ['comparison', 'report']);
});
test('report-only delivery does not invent a requested statistic', async () => {
  const { goal, action } = independent[2];
  const spec = taskForActions(goal, [action]);
  spec.metrics = [];
  const { run } = await executeCase(goal, spec, [action]);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.task?.spec.metrics, []);
});
test('provider JSON member order and equivalent channel order do not alter delivery matching', async () => {
  const goal = '显示左右肩 raw 的指定区间';
  const action = { name: view.name, args: { ...view.args, channels: ['left', 'right'] } };
  const spec = taskForActions(goal, [action]);
  spec.deliveries.view = {
    interval: [1, 14],
    basis: 'raw',
    channels: ['right', 'left'],
    joint: 'shoulder',
  };
  const { run } = await executeCase(goal, spec, [action]);
  assert.equal(run.status, 'completed');
});

test('last actual chart state and last successful application must both match', async () => {
  const goal = '显示右肩原始曲线';
  const spec = taskForActions(goal, [view]);
  for (const external of [false, true]) {
    const wrong = { name: view.name, args: { ...view.args, joint: 'hip' } };
    const { run } = await executeCase(goal, spec, external ? [view] : [view, wrong], {
      beforeFinish: external
        ? (w) => {
            w.state.chart!.basis = 'filtered';
          }
        : undefined,
    });
    assert.notEqual(run.status, 'completed');
    assert.deepEqual(run.completion?.missing, ['view']);
  }
});
test('actual seek drift and absent workspace observation block delivery', async () => {
  const { goal, action } = independent[0];
  const { run } = await executeCase(goal, taskForActions(goal, [action]), [action], {
    beforeFinish: (w) => {
      w.state.time = 4;
    },
  });
  assert.notEqual(run.status, 'completed');
  const { run: absent } = await executeCase(goal, taskForActions(goal, [action]), [action], {
    beforeFinish: (w) => {
      w.registry.readWorkspace = () => {
        throw new Error('unavailable');
      };
    },
  });
  assert.notEqual(absent.status, 'completed');
  assert.ok(absent.completion?.limitations.includes('WORKSPACE_OBSERVATION_UNAVAILABLE'));
});
test('expired report/export handles cannot complete original delivery', async () => {
  for (const { goal, action } of independent.slice(2, 4)) {
    const { run } = await executeCase(goal, taskForActions(goal, [action]), [action], {
      beforeFinish: (w) => {
        const info = w.session.info();
        for (let i = 0; i < 12; i++)
          w.registry.execute('prepare_export', {
            sessionId: info.sessionId,
            revision: info.revision,
            interval: [0, 1],
            format: 'csv',
          });
      },
    });
    assert.notEqual(run.status, 'completed');
    assert.ok(
      run.completion?.missing.includes(action.name === 'prepare_report' ? 'report' : 'export'),
    );
  }
});
test('noncomparable matching evidence is distinct from partial results and execution failure', async () => {
  const goal = '比较右肩原始口径的重叠区间';
  const action = { name: compare.name, args: { ...compare.args, second: [3, 6] } };
  const { run } = await executeCase(goal, taskForActions(goal, [action]), [action], {
    fallback: 'not_comparable',
  });
  assert.equal(run.status, 'not_comparable');
  assert.ok(run.completion?.limitations.length);
});
test('completed without a declared task and partial without matching evidence are rejected', async () => {
  const { goal, action } = independent[4];
  const { run } = await executeCase(goal, taskForActions(goal, [action]), [action], {
    omitSpec: true,
  });
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.completion?.missing, ['TASK_SPEC_REQUIRED']);
  const result = await executeCase(goal, taskForActions(goal, [action]), [], {
    outcome: 'partial',
  });
  assert.equal(result.run.status, 'failed');
  assert.ok(
    result.run.calls.some(
      (c) => !c.output.ok && c.output.error.message.includes('PARTIAL_EVIDENCE_REQUIRED'),
    ),
  );
});
test('invalid channels, source claims and altered inherited fields are rejected structurally', () => {
  const goal = '请沿用之前参数';
  const spec = taskFixture(goal);
  const previous = {
    runId: 'previous-run',
    goal,
    spec,
    validation: 'structure_and_provenance_only' as const,
  };
  const inherited = structuredClone(spec);
  inherited.sources = spec.sources.map((s) => ({
    ...s,
    origin: 'inherited',
    fromRunId: previous.runId,
  }));
  assert.deepEqual(validateTaskSpec(inherited, '再做一次', previous), inherited);
  inherited.basis = 'raw';
  assert.throws(
    () => validateTaskSpec(inherited, '再做一次', previous),
    /TASK_SPEC_INHERITANCE:basis/,
  );
  assert.throws(() => validateTaskSpec({ ...spec, joint: 'spine' }, goal), /TASK_SPEC_CHANNEL/);
  assert.throws(
    () => validateTaskSpec({ ...spec, sources: [] }, goal),
    /TASK_SPEC_SOURCE_REQUIRED/,
  );
  spec.sources[0].text = '伪造用户原文';
  assert.throws(() => validateTaskSpec(spec, goal), /TASK_SPEC_SOURCE_TEXT/);
});
test('mixed explicit report and inherited view parameters retain separate provenance', () => {
  const goal = '显示右肩 raw 指定区间';
  const spec = taskForActions(goal, [view]);
  const previous = {
    runId: 'prior-view',
    goal,
    spec,
    validation: 'structure_and_provenance_only' as const,
  };
  const nextGoal = '只改左侧并生成报告，其余沿用';
  const next = structuredClone(spec);
  next.channels = ['left'];
  next.deliveries.view!.channels = ['left'];
  next.deliveries.report = true;
  next.sources = next.sources
    .filter((s) => s.field !== 'deliveries')
    .map((s) => ({ ...s, text: nextGoal, origin: 'explicit' }));
  next.sources.push(
    ...['joint', 'basis', 'interval'].map((field) => ({
      field: `deliveries.view.${field}`,
      origin: 'inherited' as const,
      text: goal,
      fromRunId: previous.runId,
    })),
    { field: 'deliveries.view.channels', origin: 'explicit', text: '只改左侧', fromRunId: null },
    { field: 'deliveries.report', origin: 'explicit', text: '生成报告', fromRunId: null },
  );
  assert.deepEqual(validateTaskSpec(next, nextGoal, previous), next);
  next.deliveries.view!.basis = 'filtered';
  assert.throws(
    () => validateTaskSpec(next, nextGoal, previous),
    /TASK_SPEC_INHERITANCE:deliveries.view.basis/,
  );
});

test('completion feedback lets the model supply a missing view and then complete', async () => {
  const w = bench(),
    goal = '比较右肩 raw 指定两段 ROM，并展示';
  let step = 0;
  const run = await new AgentRuntime({
    modelProtocol: 'legacy-v2',
    ...w,
    provider: {
      id: 'dynamic-recovery',
      model: 'not-real',
      async complete(request) {
        const call = (name: string, args: unknown) => ({ calls: [{ name, arguments: args }] });
        const ref = { sessionId: w.session.info().sessionId, revision: w.session.info().revision };
        if (step++ === 0)
          return {
            calls: [
              { name: 'get_session_info', arguments: {} },
              { name: 'set_task_spec', arguments: taskForActions(goal, [compare, view]) },
            ],
          };
        if (step === 2) return call(compare.name, { ...ref, ...compare.args });
        const messages = request.messages
          .filter((m) => m.role === 'tool')
          .map((m) => JSON.parse(m.content));
        if (step === 4) {
          const rejected = messages.at(-1);
          assert.deepEqual(rejected.completion.missing, ['view']);
          assert.deepEqual(rejected.completion.satisfied, ['comparison']);
          return call(view.name, { ...ref, ...view.args });
        }
        return call('finish_analysis', {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          citations: messages
            .filter((m) => m.ok && [compare.name, view.name].includes(m.tool))
            .map((m) => evidenceRef(m, paths[m.tool])),
        });
      },
    },
  }).run(goal);
  assert.equal(run.status, 'completed');
  assert.equal(run.calls.filter((c) => c.name === 'finish_analysis' && !c.output.ok).length, 1);
});
test('accepted requirements cannot be downgraded after completion rejection', async () => {
  const w = bench(),
    goal = '比较右肩 raw 两段 ROM 并展示';
  let step = 0;
  const spec = taskForActions(goal, [compare, view]);
  const run = await new AgentRuntime({
    modelProtocol: 'legacy-v2',
    ...w,
    provider: {
      id: 'no-downgrade',
      model: 'not-real',
      async complete() {
        const call = (name: string, args: unknown) => ({ calls: [{ name, arguments: args }] });
        if (step++ === 0)
          return {
            calls: [
              { name: 'get_session_info', arguments: {} },
              { name: 'set_task_spec', arguments: spec },
            ],
          };
        if (step === 2)
          return call('finish_analysis', {
            outcome: 'completed',
            messageCode: 'evidence_ready',
            citations: [],
          });
        if (step === 3)
          return call(
            'set_task_spec',
            taskForActions(goal, [{ name: 'get_quality_summary', args: { interval: [0, 20] } }]),
          );
        return call('finish_analysis', {
          outcome: 'failed',
          messageCode: 'evidence_ready',
          citations: [],
        });
      },
    },
  }).run(goal);
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.task?.spec, spec);
  assert.ok(
    run.calls.some((c) => !c.output.ok && c.output.error.message.includes('TASK_SPEC_LOCKED')),
  );
});
test('partial task intent survives revision changes with traceable inheritance and fresh evidence', async () => {
  const w = bench();
  const goals = [
    '比较右肩 raw 在 1–4 与 11–14 秒的 ROM 并展示',
    '只看左侧，其余沿用，重新比较并展示',
  ];
  let turn = -1,
    step = 0;
  let currentSignal: AbortSignal | undefined;
  const provider: ModelProvider = {
    id: 'traceable-multi-turn',
    model: 'not-real',
    async complete(request) {
      if (request.signal !== currentSignal) {
        currentSignal = request.signal;
        turn++;
        step = 0;
      }
      const goal = goals[turn];
      const call = (name: string, args: unknown) => ({ calls: [{ name, arguments: args }] });
      const ref = { sessionId: w.session.info().sessionId, revision: w.session.info().revision };
      if (step++ === 0) {
        const spec = taskForActions(goal, [compare, view]);
        if (turn) {
          const user = JSON.parse(request.messages.at(-1)!.content);
          assert.ok(
            !request.messages.some((m) => m.role === 'tool'),
            'old revision evidence is absent',
          );
          assert.equal(user.previousTask.goal, goals[0]);
          spec.channels = ['left'];
          spec.deliveries.view!.channels = ['left'];
          spec.sources = spec.sources.map((s) =>
            ['goalTypes', 'joint', 'basis', 'interval', 'comparison', 'metrics'].includes(s.field)
              ? {
                  ...s,
                  origin: 'inherited',
                  text: user.previousTask.spec.sources.find((p: any) => p.field === s.field).text,
                  fromRunId: user.previousTask.runId,
                }
              : { ...s, origin: 'explicit' },
          );
        }
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            { name: 'set_task_spec', arguments: spec },
          ],
        };
      }
      if (step === 2)
        return {
          calls: [compare, ...(turn ? [view] : [])].map((a) => ({
            name: a.name,
            arguments: { ...ref, ...a.args, channels: turn ? ['left'] : ['right'] },
          })),
        };
      const messages = request.messages
        .filter((m) => m.role === 'tool')
        .map((m) => JSON.parse(m.content));
      return call('finish_analysis', {
        outcome: turn ? 'completed' : 'partial',
        messageCode: 'evidence_ready',
        citations: messages
          .filter((m) => m.ok && [compare.name, view.name].includes(m.tool))
          .map((m) => evidenceRef(m, paths[m.tool])),
      });
    },
  };
  const runtime = new AgentRuntime({ modelProtocol: 'legacy-v2', ...w, provider });
  const first = await runtime.run(goals[0]);
  assert.equal(first.status, 'partial');
  w.session.recalculate({ ...w.session.info().parameters, window: 3 });
  runtime.invalidate();
  const second = await runtime.run(goals[1]);
  assert.equal(second.status, 'completed', JSON.stringify(second.calls));
  assert.equal(second.task?.spec.sources.find((s) => s.field === 'joint')?.fromRunId, first.id);
  assert.equal(second.task?.spec.sources.find((s) => s.field === 'channels')?.origin, 'explicit');
  assert.notEqual(first.reference.revision, second.reference.revision);
  assert.ok(second.citations.every((c) => !first.citations.some((p) => p.callId === c.callId)));
});
