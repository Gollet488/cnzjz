import type { AgentRun } from './runtime.ts';
import { checkedText, resolveCitation } from './runtime.ts';
import { AGENT_PROTOCOL_VERSION, checkRenderedControl } from './controlProtocol.ts';
import { AnalysisSession } from '../analysis/session.ts';
import { createToolRegistry } from '../analysis/tools.ts';
import type { ChartView, PreparedArtifact } from '../analysis/tools.ts';
import { demoPose } from '../utils/demo.ts';

export const EVAL_PARAMETERS = {
  threshold: 0.5,
  window: 5,
  aspect: 1,
  metricVersion: '2.0' as const,
};
export function evaluationSession(empty = false) {
  const session = new AnalysisSession('demo', EVAL_PARAMETERS);
  if (!empty)
    for (let i = 0; i <= 400; i++)
      session.append(i >= 200 && i < 205 ? [] : demoPose(i / 20), i / 20);
  return session;
}
const selection = { joint: 'knee', channels: ['left', 'right'], basis: 'filtered' };
export const DELIVERY_GOALS = [
  '比较 filtered 左右膝 0–5 秒与 15–20 秒的 ROM，并展示覆盖两段的图表',
  '只看右侧，第二段改成 12–17 秒',
  '准备当前右膝 filtered 0–5 秒与 12–17 秒的比较报告和 0–17 秒 CSV，保持当前最终视图',
] as const;
export const EVALUATION_VERSION = '2.2.1';
const FIXED_CASES = [
  {
    id: 'compare',
    goals: ['比较前后各 5 秒的左右膝 filtered ROM，并展示差异'],
    status: ['completed'],
    expected: [
      { name: 'compare_intervals', args: { ...selection, first: [0, 5], second: [15, 20] } },
      { name: 'set_chart_view', args: { ...selection, interval: [0, 20] } },
    ],
  },
  {
    id: 'quality',
    goals: ['哪些区间不适合比较？查询整个已采样区间的质量和缺失情况'],
    status: ['completed'],
    expected: [{ name: 'get_quality_summary', args: { interval: [0, 20] } }],
  },
  {
    id: 'multi_turn',
    goals: [
      '比较前后各 5 秒的左右膝 filtered ROM，并展示差异',
      '只看右侧，第二段改为 12–17 秒，保留前段，重新比较并展示',
    ],
    status: ['completed'],
    expected: [
      {
        name: 'compare_intervals',
        args: { ...selection, channels: ['right'], first: [0, 5], second: [12, 17] },
      },
      { name: 'set_chart_view', args: { ...selection, channels: ['right'], interval: [0, 17] } },
    ],
  },
  {
    id: 'empty',
    goals: ['比较前后各 5 秒的膝 ROM'],
    status: ['needs_input', 'limited'],
    expected: [],
  },
  {
    id: 'out_of_range',
    goals: ['仅查询右膝 filtered 的 25–30 秒，不要改区间'],
    status: ['needs_input', 'limited'],
    expected: [],
  },
  {
    id: 'tool_error',
    goals: ['查询 0–5 秒右膝 filtered ROM'],
    status: ['completed'],
    expected: [
      { name: 'query_metrics', args: { ...selection, channels: ['right'], interval: [0, 5] } },
    ],
  },
  { id: 'cancel', goals: ['比较前后各 5 秒的膝 ROM'], status: ['cancelled'], expected: [] },
  { id: 'recalculate', goals: ['查询 0–5 秒右膝 filtered ROM'], status: ['stale'], expected: [] },
  {
    id: 'report',
    goals: ['准备左右膝 filtered 报告，前段 0–5 秒、后段 12–17 秒，含事实、差异、缺失和限制'],
    status: ['completed'],
    expected: [
      { name: 'prepare_report', args: { ...selection, interval: [0, 5], comparison: [12, 17] } },
    ],
  },
  {
    id: 'export',
    goals: ['为 0–5 秒准备 CSV 导出'],
    status: ['completed'],
    expected: [{ name: 'prepare_export', args: { interval: [0, 5], format: 'csv' } }],
  },
  {
    id: 'seek',
    goals: ['定位到 12 秒'],
    status: ['completed'],
    expected: [{ name: 'seek_to_time', args: { time: 12 } }],
  },
  {
    id: 'raw_view',
    goals: ['只看右膝 raw 口径，图表设置为 12–17 秒'],
    status: ['completed'],
    expected: [
      {
        name: 'set_chart_view',
        args: { ...selection, channels: ['right'], basis: 'raw', interval: [12, 17] },
      },
    ],
  },
] as const;
export type EvaluationGroup = 'business' | 'boundary' | 'protection';
export interface TurnExpectation {
  goal: string;
  status: readonly string[];
  expected: readonly { name: string; args: Record<string, unknown> }[];
}
export interface EvaluationCase {
  id: string;
  group: EvaluationGroup;
  goals: readonly string[];
  status: readonly string[];
  expected: TurnExpectation['expected'];
  turns: readonly TurnExpectation[];
}
export const FIXED_EVALUATIONS: readonly EvaluationCase[] = [
  {
    id: 'multi_turn_delivery',
    group: 'business',
    goals: DELIVERY_GOALS,
    status: ['completed'],
    expected: [],
    turns: DELIVERY_GOALS.map((goal, index) => ({
      goal,
      status: ['completed'],
      expected:
        index === 2
          ? [
              {
                name: 'prepare_report',
                args: { ...selection, channels: ['right'], interval: [0, 5], comparison: [12, 17] },
              },
              { name: 'prepare_export', args: { interval: [0, 17], format: 'csv' } },
            ]
          : [
              {
                name: 'compare_intervals',
                args: {
                  ...selection,
                  channels: index === 0 ? ['left', 'right'] : ['right'],
                  first: [0, 5],
                  second: index === 0 ? [15, 20] : [12, 17],
                },
              },
              {
                name: 'set_chart_view',
                args: {
                  ...selection,
                  channels: index === 0 ? ['left', 'right'] : ['right'],
                  interval: index === 0 ? [0, 20] : [0, 17],
                },
              },
            ],
    })),
  },
  ...FIXED_CASES.map(
    (c): EvaluationCase => ({
      ...c,
      group: ['cancel', 'recalculate'].includes(c.id)
        ? 'protection'
        : ['empty', 'out_of_range'].includes(c.id)
          ? 'boundary'
          : 'business',
      turns: c.goals.map((goal, index) => ({
        goal,
        status: c.status,
        expected: c.id === 'multi_turn' && index === 0 ? FIXED_CASES[0].expected : c.expected,
      })),
    }),
  ),
  {
    id: 'failure_recovery',
    group: 'business',
    goals: ['查询右膝 filtered 的 0–5 秒 ROM', '重试查询右膝 filtered 的 0–5 秒 ROM'],
    status: ['completed'],
    expected: FIXED_CASES[5].expected,
    turns: [
      { goal: '查询右膝 filtered 的 0–5 秒 ROM', status: ['failed'], expected: [] },
      {
        goal: '重试查询右膝 filtered 的 0–5 秒 ROM',
        status: ['completed'],
        expected: FIXED_CASES[5].expected,
      },
    ],
  },
];
export interface EvaluationObservation {
  chart: ChartView | null;
  time: number | null;
  artifacts: Record<string, PreparedArtifact | null>;
}
export function observeEvaluation(
  run: AgentRun,
  view: { chart: ChartView | null; time: number | null },
  registry: ReturnType<typeof createToolRegistry>,
): EvaluationObservation {
  const artifacts: EvaluationObservation['artifacts'] = {};
  for (const call of run.calls) {
    if (call.output.ok && ['prepare_report', 'prepare_export'].includes(call.name)) {
      const handle = (call.output.result as any).handle;
      try {
        artifacts[handle] = registry.getArtifact(handle);
      } catch {
        artifacts[handle] = null;
      }
    }
  }
  return structuredClone({ ...view, artifacts });
}
export function totalCosts(
  runs: readonly (Pick<AgentRun, 'calls' | 'elapsedMs' | 'usage'> &
    Partial<Pick<AgentRun, 'rounds' | 'requests'>>)[],
) {
  const tokens = (key: 'inputTokens' | 'outputTokens') =>
    runs.length && runs.every((r) => r.usage[key] !== null)
      ? runs.reduce((sum, r) => sum + r.usage[key]!, 0)
      : null;
  return {
    calls: runs.reduce((sum, r) => sum + r.calls.length, 0),
    rounds:
      runs.length && runs.every((r) => r.rounds !== undefined)
        ? runs.reduce((sum, r) => sum + r.rounds!, 0)
        : null,
    requests:
      runs.length && runs.every((r) => r.requests !== undefined)
        ? runs.reduce((sum, r) => sum + r.requests!.length, 0)
        : null,
    maxRequestBytes:
      runs.length && runs.every((r) => r.requests !== undefined)
        ? Math.max(0, ...runs.flatMap((r) => r.requests!.map((request) => request.inputBytes)))
        : null,
    elapsedMs: runs.reduce((sum, r) => sum + r.elapsedMs, 0),
    reportedUsage: {
      inputTokens: runs.reduce(
        (sum, r) =>
          sum +
          (r.usage.inputTokens ??
            r.requests?.reduce((known, request) => known + (request.inputTokens ?? 0), 0) ??
            0),
        0,
      ),
      outputTokens: runs.reduce(
        (sum, r) =>
          sum +
          (r.usage.outputTokens ??
            r.requests?.reduce((known, request) => known + (request.outputTokens ?? 0), 0) ??
            0),
        0,
      ),
      inputTurns: runs.filter((r) => r.usage.inputTokens !== null).length,
      outputTurns: runs.filter((r) => r.usage.outputTokens !== null).length,
      totalTurns: runs.length,
    },
    usage: {
      inputTokens: tokens('inputTokens'),
      outputTokens: tokens('outputTokens'),
      reportedRequests: runs.reduce((sum, r) => sum + r.usage.reportedRequests, 0),
    },
  };
}
export function assessScenario(
  turns: {
    run: AgentRun;
    observation: EvaluationObservation;
    assessment?: ReturnType<typeof assessRun>;
  }[],
  scenario: EvaluationCase,
  session: AnalysisSession,
) {
  // Assess at each turn's checkpoint; older turns may legitimately predate a later revision.
  const assessments = turns.map(
    (turn, index) =>
      turn.assessment ?? assessRun(turn.run, scenario, session, turn.observation, index),
  );
  const failures = assessments.flatMap((a, i) => a.failures.map((f) => `turn:${i + 1}:${f}`));
  if (turns.length !== scenario.turns.length) failures.push('turn_count');
  return {
    passed: failures.length === 0,
    failures,
    turns: assessments,
    ...totalCosts(turns.map((t) => t.run)),
  };
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const DELIVERY_PATHS: Record<string, RegExp> = {
  compare_intervals: /^\/differences\/\d+\/(rom|meanAngle|peakAbsoluteVelocity)$/,
  query_metrics:
    /^\/channels\/\d+\/(rom|peakAbsoluteVelocity|coverage|(?:angle|velocity)\/(?:min|max|mean|populationVariance))$/,
  get_quality_summary:
    /^\/(effectiveRate|meanConfidence|missingSamples|detectedSamples|fullyReliableSamples|maxSampleGapSeconds)$/,
  set_chart_view: /^\/view\/(joint|basis|channels\/\d+|interval\/\d+)$/,
  seek_to_time: /^\/appliedTime$/,
  prepare_report: /^\/handle$/,
  prepare_export: /^\/handle$/,
};
export function assessDeliveryScope(run: AgentRun, turnIndex: number, chart: ChartView | null) {
  const failures: string[] = [];
  const spec = run.task?.spec;
  const channels = turnIndex === 0 ? ['left', 'right'] : ['right'];
  const interval = turnIndex === 0 ? [0, 20] : [0, 17];
  if (
    !spec ||
    !same(spec.goalTypes, ['comparison']) ||
    spec.joint !== 'knee' ||
    spec.basis !== 'filtered' ||
    !same(spec.channels, channels) ||
    !same(spec.interval, [0, 5]) ||
    !same(spec.metrics, ['rom']) ||
    spec.time !== null ||
    !same(spec.comparison, {
      second: turnIndex === 0 ? [15, 20] : [12, 17],
      direction: 'second_minus_first',
    }) ||
    !same(spec.deliveries.view, { ...selection, channels, interval }) ||
    spec.deliveries.report !== (turnIndex === 2) ||
    !same(spec.deliveries.export, turnIndex === 2 ? { interval: [0, 17], format: 'csv' } : null) ||
    spec.unresolved.length ||
    !same(chart, { ...selection, channels, interval })
  )
    failures.push('three_turn_scope');
  if (turnIndex < 2 && run.calls.some((c) => ['prepare_report', 'prepare_export'].includes(c.name)))
    failures.push('premature_delivery');
  return failures;
}
export function assessRun(
  run: AgentRun,
  scenario: EvaluationCase,
  session: AnalysisSession,
  observation?: EvaluationObservation,
  turnIndex = 0,
) {
  const failures: string[] = [];
  if (scenario.id === 'multi_turn_delivery')
    failures.push(...assessDeliveryScope(run, turnIndex, observation?.chart ?? null));
  const expectation = scenario.turns[turnIndex];
  if (!expectation)
    return {
      passed: false,
      failures: ['unexpected_turn'],
      calls: run.calls.length,
      elapsedMs: run.elapsedMs,
      usage: run.usage,
    };
  if (!expectation.status.includes(run.status)) failures.push(`status:${run.status}`);
  for (const expected of expectation.expected) {
    if (
      !run.calls.some(
        (c) =>
          c.name === expected.name &&
          c.output.ok &&
          Object.entries(expected.args).every(([k, v]) => same((c.arguments as any)[k], v)),
      )
    )
      failures.push(`missing_tool_or_parameters:${expected.name}`);
    const matches = (c: AgentRun['calls'][number]) =>
      c.name === expected.name &&
      c.output.ok &&
      Object.entries(expected.args).every(([k, v]) => same((c.arguments as any)[k], v));
    const last = [...run.calls].reverse().find((c) => c.name === expected.name && c.output.ok);
    if (!last || !matches(last)) failures.push(`final_delivery:${expected.name}`);
    const cited =
      last &&
      matches(last) &&
      run.citations.some(
        (ref) => ref.callId === last.id && DELIVERY_PATHS[expected.name]?.test(ref.path),
      );
    if (!cited) failures.push(`missing_delivery_evidence:${expected.name}`);
    if (expected.name === 'set_chart_view') {
      if (!observation || !same(observation.chart, expected.args))
        failures.push('final_delivery:set_chart_view');
    }
    if (expected.name === 'seek_to_time') {
      const time = expected.args.time as number;
      const sampled = session.frames.reduce(
        (best, f) => (Math.abs(f.time - time) < Math.abs(best - time) ? f.time : best),
        session.frames[0]?.time ?? NaN,
      );
      if (
        !observation ||
        observation.time !== sampled ||
        (last?.output.ok && (last.output.result as any).appliedTime !== sampled)
      )
        failures.push('final_delivery:seek_to_time');
    }
    if (['prepare_report', 'prepare_export'].includes(expected.name)) {
      const artifact = last?.output.ok
        ? observation?.artifacts[(last.output.result as any).handle]
        : null;
      try {
        if (
          !artifact ||
          !last?.output.ok ||
          !same(artifact.result, last.output.result) ||
          artifact.kind !== (expected.name === 'prepare_report' ? 'report' : 'csv') ||
          !same(artifact.interval, expected.args.interval)
        )
          throw new Error('artifact');
        session.assertCurrent(artifact.reference);
      } catch {
        failures.push(`final_delivery:${expected.name}`);
      }
    }
  }
  // Re-execute reads independently, so the evaluator catches mutated values,
  // units, sample counts and stale references, not just a claimed completion.
  const oracle = createToolRegistry(session, {
    setChartView: (view) => view,
    seekToTime: (time) => ({
      appliedTime: session.frames.reduce(
        (best, f) => (Math.abs(f.time - time) < Math.abs(best - time) ? f.time : best),
        session.frames[0]?.time ?? NaN,
      ),
    }),
  });
  if (!['stale', 'cancelled'].includes(run.status)) {
    try {
      session.assertCurrent(run.reference);
    } catch {
      failures.push('stale_run');
    }
    for (const call of run.calls.filter((c) => c.output.ok)) {
      if (
        [
          'get_session_info',
          'get_quality_summary',
          'query_metrics',
          'compare_intervals',
          'set_chart_view',
          'seek_to_time',
        ].includes(call.name)
      ) {
        if (!same(oracle.execute(call.name, call.arguments), call.output))
          failures.push(`tool_value_or_units:${call.name}`);
      }
      if (['prepare_report', 'prepare_export'].includes(call.name)) {
        const value = call.output.ok ? (call.output.result as any) : null;
        try {
          oracle.validateEvidence(value.evidence);
          const fresh = oracle.execute(call.name, call.arguments);
          if (
            !fresh.ok ||
            !same({ ...(fresh.result as any), handle: null }, { ...value, handle: null })
          )
            throw new Error('artifact_contents');
          if (call.name === 'prepare_report') {
            const args = call.arguments as any;
            const facts = oracle.execute('query_metrics', {
              sessionId: args.sessionId,
              revision: args.revision,
              joint: args.joint,
              channels: args.channels,
              basis: args.basis,
              interval: args.interval,
            });
            if (!facts.ok || !same(facts.result, value.facts)) throw new Error('report_facts');
            if (args.comparison) {
              const comparison = oracle.execute('compare_intervals', {
                sessionId: args.sessionId,
                revision: args.revision,
                joint: args.joint,
                channels: args.channels,
                basis: args.basis,
                first: args.interval,
                second: args.comparison,
              });
              if (!comparison.ok || !same(comparison.result, value.comparison))
                throw new Error('report_comparison');
            }
          } else if (value.rows !== value.evidence.sampleCount || value.downloadStarted !== false)
            throw new Error('export_metadata');
        } catch {
          failures.push(`artifact_evidence:${call.name}`);
        }
      }
    }
    for (const citation of run.citations) {
      const call = run.calls.find((c) => c.id === citation.callId);
      try {
        if (
          !call?.output.ok ||
          !same(resolveCitation(call.output.result, citation.path), citation.value)
        )
          throw new Error('value');
      } catch {
        failures.push('citation_value');
      }
    }
  }
  if (['completed', 'limited', 'needs_input', 'partial', 'not_comparable'].includes(run.status)) {
    try {
      if (run.protocolVersion === AGENT_PROTOCOL_VERSION)
        checkRenderedControl(run.message, run.steps);
      else {
        checkedText(run.message, 600);
        run.steps.forEach((s) => checkedText(s, 120));
      }
    } catch {
      failures.push('prohibited_prose');
    }
    if (run.status === 'completed' && !run.citations.length) failures.push('missing_citations');
  }
  if (
    scenario.id === 'out_of_range' &&
    run.calls.some(
      (c) =>
        ['query_metrics', 'compare_intervals', 'prepare_report', 'prepare_export'].includes(
          c.name,
        ) && c.output.ok,
    )
  )
    failures.push('silently_changed_range');
  if (['stale', 'cancelled'].includes(run.status) && run.citations.length)
    failures.push('late_citations');
  if (
    ['empty', 'out_of_range', 'cancel', 'recalculate'].includes(scenario.id) &&
    (run.calls.some(
      (c) =>
        c.output.ok &&
        ['set_chart_view', 'seek_to_time', 'prepare_report', 'prepare_export'].includes(c.name),
    ) ||
      observation?.chart != null ||
      observation?.time != null ||
      Object.keys(observation?.artifacts ?? {}).length)
  )
    failures.push('unexpected_delivery');
  return {
    passed: !failures.length,
    failures: [...new Set(failures)],
    calls: run.calls.length,
    elapsedMs: run.elapsedMs,
    usage: run.usage,
  };
}
