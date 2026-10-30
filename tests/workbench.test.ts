import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  parseEvaluationArgs,
  runEvaluation as evaluateProtocol,
} from '../scripts/evaluate-agent.mjs';
import { createToolRegistry } from '../src/analysis/tools.ts';
import type { ChartView } from '../src/analysis/tools.ts';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { AGENT_PROTOCOL_VERSION } from '../src/agent/controlProtocol.ts';
import type { AgentRun } from '../src/agent/runtime.ts';
import type { ModelProvider } from '../src/agent/provider.ts';
import {
  FIXED_EVALUATIONS,
  assessRun,
  assessScenario,
  observeEvaluation,
  totalCosts,
  EVALUATION_VERSION,
  evaluationSession,
  EVAL_PARAMETERS,
  type EvaluationCase,
} from '../src/agent/evaluation.ts';
import { csvHeader } from '../src/utils/csv.ts';
import { evidenceRef, taskFixture, taskForActions, withTaskSpecs } from './agentFixtures.ts';
// Freeze historical scripted v2 fixtures; v3 has independent protocol coverage.
const runEvaluation = (options: any, dependencies: any = {}) =>
  evaluateProtocol(options, { ...dependencies, modelProtocol: 'legacy-v2' });
const select = { joint: 'knee', channels: ['left', 'right'], basis: 'filtered' };
const evaluationCase = (id: string) => {
  const scenario = FIXED_EVALUATIONS.find((candidate) => candidate.id === id);
  assert.ok(scenario, `Missing evaluation case: ${id}`);
  return scenario;
};
function evaluationTask(scenario: EvaluationCase, goal: string) {
  const index = scenario.goals.indexOf(goal);
  assert.ok(index >= 0);
  if (scenario.id !== 'multi_turn_delivery')
    return taskForActions(goal, scenario.turns[index].expected);
  // The three-turn acceptance requires one comparison intent with explicit
  // delivery flags, including the retained view on the final report/export turn.
  const channels = index === 0 ? ['left', 'right'] : ['right'];
  return taskFixture(goal, {
    goalTypes: ['comparison'],
    channels: channels as ('left' | 'right')[],
    comparison: { second: index === 0 ? [15, 20] : [12, 17], direction: 'second_minus_first' },
    deliveries: {
      view: { ...select, channels, interval: index === 0 ? [0, 20] : [0, 17] } as ChartView,
      report: index === 2,
      export: index === 2 ? { interval: [0, 17], format: 'csv' } : null,
    },
  });
}
function evaluationActions(scenario: EvaluationCase, index: number) {
  const actions = [...scenario.turns[index].expected];
  if (scenario.id === 'multi_turn_delivery' && index === 2)
    actions.push({
      name: 'set_chart_view',
      args: { ...select, channels: ['right'], interval: [0, 17] },
    });
  return actions;
}
const ref = (session: ReturnType<typeof evaluationSession>) => ({
  sessionId: session.info().sessionId,
  revision: session.info().revision,
});

// Formal versions of review R2/R3. These drive the real runtime and local tools.
async function auditTurns(failFirst = false, wrongFinalView = false) {
  const w = workbench();
  const scenario = evaluationCase(failFirst ? 'multi_turn' : 'compare');
  let step = 0;
  let failures = failFirst ? 2 : 0;
  const actions = [...scenario.expected];
  if (wrongFinalView)
    actions.push({
      name: 'set_chart_view',
      args: {
        joint: 'elbow',
        channels: ['right'],
        basis: 'raw',
        interval: [12, 17],
      },
    } as any);
  const agent = new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session: w.session,
    registry: w.registry,
    limits: { recoveries: 1 },
    provider: withTaskSpecs(
      {
        id: 'regression-protocol',
        model: 'not-real',
        async complete(request) {
          if (failures-- > 0) return { calls: [] };
          if (step++ === 0) return { calls: [{ name: 'get_session_info', arguments: {} }] };
          const action = actions[step - 2];
          if (action)
            return {
              calls: [{ name: action.name, arguments: { ...ref(w.session), ...action.args } }],
            };
          const messages = request.messages
            .filter((m) => m.role === 'tool')
            .map((m) => JSON.parse(m.content));
          return {
            calls: [
              {
                name: 'finish_analysis',
                arguments: {
                  outcome: 'completed',
                  messageCode: 'evidence_ready',
                  citations: messages
                    .filter((m) => m.ok && ['compare_intervals', 'set_chart_view'].includes(m.tool))
                    .map((m) =>
                      evidenceRef(
                        m,
                        m.tool === 'set_chart_view' ? '/view/basis' : '/differences/0/rom',
                      ),
                    ),
                },
              },
            ],
          };
        },
      },
      (goal) => taskForActions(goal, scenario.turns.find((t) => t.goal === goal)!.expected),
    ),
  });
  const runs: AgentRun[] = [];
  if (failFirst) runs.push(await agent.run(scenario.goals[0]));
  runs.push(await agent.run(scenario.goals.at(-1)!));
  return { w, scenario, runs };
}

test('review R2: correct intermediate call cannot mask the wrong final applied view', async () => {
  const { w, scenario, runs } = await auditTurns(false, true);
  assert.notEqual(runs[0].status, 'completed');
  const result = assessRun(runs[0], scenario, w.session, {
    chart: w.view!,
    time: w.time,
    artifacts: {},
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('final_delivery:set_chart_view'));
});

test('review R3: failed first turn cannot pass a multi-turn case; costs include both turns', async () => {
  const { w, scenario, runs } = await auditTurns(true);
  assert.equal(runs[0].status, 'limit');
  assert.equal(runs[1].status, 'completed');
  runs[0].elapsedMs = 11;
  runs[1].elapsedMs = 19;
  runs[0].usage = { inputTokens: 10, outputTokens: 2, reportedRequests: 1 };
  runs[1].usage = { inputTokens: 20, outputTokens: 3, reportedRequests: 1 };
  const result = assessScenario(
    runs.map((run) => ({ run, observation: { chart: w.view!, time: w.time, artifacts: {} } })),
    scenario,
    w.session,
  );
  assert.equal(result.passed, false);
  assert.equal(result.turns[0].passed, false);
  assert.equal(result.turns[1].passed, true);
  assert.equal(result.elapsedMs, 30);
  assert.equal(result.calls, runs[0].calls.length + runs[1].calls.length);
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 5, reportedRequests: 2 });
});

test('delivery evidence must cite the final matching result and relevant fact rather than metadata', async () => {
  const { w, scenario, runs } = await auditTurns();
  const run = runs[0];
  const observation = { chart: w.view!, time: w.time, artifacts: {} };
  assert.equal(assessRun(run, scenario, w.session, observation).passed, true);
  const citation = run.citations.find((c) => c.path === '/differences/0/rom')!;
  const comparison = run.calls.find((c) => c.id === citation.callId)!;
  citation.path = '/first/evidence/sampleCount';
  citation.value = (comparison.output as any).result.first.evidence.sampleCount;
  assert.ok(
    assessRun(run, scenario, w.session, observation).failures.includes(
      'missing_delivery_evidence:compare_intervals',
    ),
  );
  citation.path = '/differences/0/rom';
  citation.value = (comparison.output as any).result.differences[0].rom;
  const view = run.calls.find((c) => c.name === 'set_chart_view')!;
  run.calls.push({ ...structuredClone(view), id: 'new-final-view' });
  assert.ok(
    assessRun(run, scenario, w.session, observation).failures.includes(
      'missing_delivery_evidence:set_chart_view',
    ),
  );
});
function workbench(session = evaluationSession()) {
  let time: number | null = null;
  let view: ChartView | undefined;
  let applications = 0;
  const registry = createToolRegistry(session, {
    readWorkspace() {
      return { chart: view ?? null, time };
    },
    seekToTime(value) {
      time = session.frames.reduce(
        (best, f) => (Math.abs(f.time - value) < Math.abs(best - value) ? f.time : best),
        session.frames[0].time,
      );
      return { appliedTime: time };
    },
    setChartView(value) {
      view = value;
      applications++;
      return structuredClone(value);
    },
  });
  return {
    session,
    registry,
    get time() {
      return time;
    },
    get view() {
      return view;
    },
    get applications() {
      return applications;
    },
  };
}
function success(result: ReturnType<ReturnType<typeof createToolRegistry>['execute']>): any {
  assert.ok(result.ok, JSON.stringify(result));
  return result.result;
}

test('view ports execute every request, validate before mutation, and return actual sampled time', () => {
  const w = workbench(),
    reference = ref(w.session);
  const request = { ...reference, ...select, channels: ['right'], interval: [12, 17] };
  success(w.registry.execute('set_chart_view', request));
  success(w.registry.execute('set_chart_view', { ...request, interval: [0, 5] }));
  success(w.registry.execute('set_chart_view', request));
  assert.equal(w.applications, 3); // A cached write would silently leave the wrong view.
  assert.deepEqual(w.view?.interval, [12, 17]);
  assert.deepEqual(w.view?.channels, ['right']);
  assert.equal(
    success(w.registry.execute('seek_to_time', { ...reference, time: 12.012 })).appliedTime,
    12,
  );
  assert.equal(w.time, 12);
  assert.equal(w.registry.execute('set_chart_view', { ...request, interval: [12, 22] }).ok, false);
  assert.equal(w.applications, 3);
  assert.equal(createToolRegistry(w.session).execute('set_chart_view', request).ok, false);
  assert.equal(w.registry.execute('seek_to_time', { ...reference, time: -1 }).ok, false);
});

test('report and export use real aggregates, retain limitations, isolate copies and reject stale/evicted handles', () => {
  const w = workbench(),
    reference = ref(w.session);
  const args = { ...reference, ...select, interval: [0, 5], comparison: [12, 17] };
  const report = success(w.registry.execute('prepare_report', args));
  assert.deepEqual(
    report.facts,
    success(w.registry.execute('query_metrics', { ...reference, ...select, interval: [0, 5] })),
  );
  assert.equal(
    report.comparison.differences[0].rom,
    report.comparison.second.channels[0].rom - report.comparison.first.channels[0].rom,
  );
  assert.equal(report.facts.units.angle, 'deg');
  assert.equal(report.facts.channels[0].angle.sampleCount, 101);
  assert.ok(report.limitations.length);
  assert.ok(report.missing.length);
  const exported = success(
    w.registry.execute('prepare_export', { ...reference, interval: [0, 5], format: 'csv' }),
  );
  assert.equal(exported.rows, 101);
  assert.equal(exported.columns, csvHeader().length);
  assert.equal(exported.downloadStarted, false);
  report.facts.channels[0].rom = -999;
  assert.notEqual(w.registry.getArtifact(report.handle).result.facts.channels[0].rom, -999);
  const missing = success(
    w.registry.execute('prepare_report', { ...args, interval: [10, 10.2], comparison: null }),
  );
  assert.equal(missing.facts.channels[0].rom, null);
  assert.equal(missing.quality.missingSamples, 5);
  for (let i = 0; i < 12; i++)
    success(
      w.registry.execute('prepare_export', { ...reference, interval: [0, 5], format: 'csv' }),
    );
  assert.throws(() => w.registry.getArtifact(exported.handle), /UNKNOWN_ARTIFACT/);
  const current = success(w.registry.execute('prepare_report', args));
  w.session.recalculate({ ...EVAL_PARAMETERS, window: 3 });
  assert.throws(() => w.registry.getArtifact(current.handle), /STALE_SESSION/);
  assert.equal(w.registry.execute('prepare_report', args).ok, false);
});

// These are explicitly scripted protocol evaluations. They exercise production
// runtime, tools, evidence and assessment; they do not evaluate model reasoning.
for (const scenario of FIXED_EVALUATIONS) {
  test(`fixed protocol evaluation: ${scenario.id}`, async () => {
    const w = workbench(evaluationSession(scenario.id === 'empty'));
    let step = 0;
    let goalIndex = 0;
    const provider: ModelProvider = withTaskSpecs(
      {
        id: 'scripted-protocol-only',
        model: 'not-real',
        async complete(request) {
          if (scenario.id === 'failure_recovery' && goalIndex === 0)
            throw new Error('EVAL_INJECTED_FAILURE');
          const call = (name: string, args: unknown) => ({ calls: [{ name, arguments: args }] });
          if (scenario.id === 'cancel') {
            agent.cancel();
            return call('get_session_info', {});
          }
          if (scenario.id === 'recalculate') {
            w.session.recalculate({ ...EVAL_PARAMETERS, window: 3 });
            return call('get_session_info', {});
          }
          if (step++ === 0) {
            if (goalIndex && scenario.id === 'multi_turn')
              assert.ok(
                request.messages.some((m) => m.role === 'user' && m.content.includes('比较前后')),
              );
            return {
              calls: [
                {
                  name: 'plan_analysis',
                  arguments: { steps: ['read_session'] },
                },
                { name: 'get_session_info', arguments: {} },
              ],
            };
          }
          const expected = evaluationActions(scenario, goalIndex);
          if (scenario.id === 'tool_error' && step === 2)
            return call('query_metrics', {
              ...ref(w.session),
              ...select,
              channels: ['midline'],
              interval: [0, 5],
            });
          const offset = scenario.id === 'tool_error' ? 1 : 0;
          const action = expected[step - 2 - offset];
          if (action) return call(action.name, { ...ref(w.session), ...action.args });
          const messages = request.messages
            .filter((m) => m.role === 'tool')
            .map((m) => ({ name: m.toolName, data: JSON.parse(m.content) }));
          const paths: Record<string, string> = {
            compare_intervals: '/differences/0/rom',
            query_metrics: '/channels/0/rom',
            get_quality_summary: '/effectiveRate',
            set_chart_view: '/view/basis',
            seek_to_time: '/appliedTime',
            prepare_report: '/handle',
            prepare_export: '/handle',
          };
          return call('finish_analysis', {
            outcome: scenario.turns[goalIndex].status[0],
            messageCode: 'evidence_ready',
            citations: expected.flatMap((e) => {
              const last = messages.findLast((m) => m.data.ok && m.name === e.name);
              return last ? [evidenceRef(last.data, paths[last.name!])] : [];
            }),
          });
        },
      },
      (goal) => evaluationTask(scenario, goal),
    );
    const agent = new AgentRuntime({
      modelProtocol: 'legacy-v2',
      session: w.session,
      registry: w.registry,
      provider,
    });
    const turns = [];
    for (const goal of scenario.goals) {
      step = 0;
      const run = await agent.run(goal);
      const observation = observeEvaluation(
        run,
        { chart: w.view ?? null, time: w.time },
        w.registry,
      );
      const assessment = assessRun(run, scenario, w.session, observation, goalIndex);
      turns.push({ run, observation, assessment });
      goalIndex++;
    }
    const assessment = assessScenario(turns, scenario, w.session);
    assert.deepEqual(assessment.failures, [], JSON.stringify(turns));
    if (scenario.id === 'tool_error') assert.ok(turns[0].run.calls.some((c) => !c.output.ok));
  });
}

test('evaluator catches tool numerics, citation values and prohibited conclusions', async () => {
  const w = workbench();
  let step = 0;
  const agent = new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session: w.session,
    registry: w.registry,
    provider: withTaskSpecs(
      {
        id: 'scripted',
        model: 'not-real',
        async complete(request) {
          if (step++ === 0) return { calls: [{ name: 'get_session_info', arguments: {} }] };
          if (step === 2)
            return {
              calls: [
                {
                  name: 'get_quality_summary',
                  arguments: { ...ref(w.session), interval: [0, 20] },
                },
              ],
            };
          const result = JSON.parse(request.messages.at(-1)!.content);
          return {
            calls: [
              {
                name: 'finish_analysis',
                arguments: {
                  outcome: 'completed',
                  messageCode: 'evidence_ready',
                  citations: [evidenceRef(result, '/effectiveRate')],
                },
              },
            ],
          };
        },
      },
      (goal) =>
        taskForActions(goal, [{ name: 'get_quality_summary', args: { interval: [0, 20] } }]),
    ),
  });
  const run = await agent.run('查询质量');
  const scenario = evaluationCase('quality');
  assert.equal(assessRun(run, scenario, w.session).passed, true);
  const forged = structuredClone(run);
  const call = forged.calls.find((c) => c.name === 'get_quality_summary')!;
  if (call.output.ok) (call.output.result as any).effectiveRate = 999;
  forged.citations[0].value = -1;
  forged.message = '动作评分100分，正确';
  assert.deepEqual(
    assessRun(forged, scenario, w.session).failures.sort(),
    ['citation_value', 'prohibited_prose', 'tool_value_or_units:get_quality_summary'].sort(),
  );
});

test('evaluation independently rejects tampered metric units and sample counts', () => {
  const w = workbench(),
    args = { ...ref(w.session), ...select, interval: [0, 5] };
  const metric = success(w.registry.execute('query_metrics', args));
  const run = {
    id: 'unit-check',
    goal: '检查单位',
    reference: w.session.info(),
    provider: 'scripted',
    model: 'not-real',
    status: 'completed',
    phase: '',
    steps: [],
    calls: [
      {
        id: 'metric',
        name: 'query_metrics',
        arguments: args,
        output: { ok: true, tool: 'query_metrics', result: metric },
      },
    ],
    citations: [{ callId: 'metric', path: '/channels/0/rom', value: metric.channels[0].rom }],
    message: '请查看证据。',
    rounds: 1,
    startedAt: 0,
    elapsedMs: 1,
    usage: { inputTokens: null, outputTokens: null, reportedRequests: 0 },
  } as AgentRun;
  // Scenario requires right-only, so check the independent value failure directly.
  metric.units.angle = 'radian';
  metric.channels[0].angle.sampleCount = 999;
  assert.ok(
    assessRun(run, evaluationCase('tool_error'), w.session).failures.includes(
      'tool_value_or_units:query_metrics',
    ),
  );
});

test('recalculation retains user goals only and never reuses old numeric evidence', async () => {
  const w = workbench();
  let index = 0;
  const agent = new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session: w.session,
    registry: w.registry,
    provider: {
      id: 'scripted',
      model: 'not-real',
      async complete(request) {
        if (index++ === 2) {
          assert.equal(
            JSON.parse(request.messages.at(-1)!.content).context.pendingUserIntents[0].goal,
            '只看右侧',
          );
          assert.ok(!request.messages.some((m) => m.role === 'tool'));
          assert.ok(request.messages.some((m) => m.content.includes('只看右侧')));
        }
        return index % 2
          ? { calls: [{ name: 'get_session_info', arguments: {} }] }
          : {
              calls: [
                {
                  name: 'finish_analysis',
                  arguments: {
                    outcome: 'needs_input',
                    messageCode: 'evidence_ready',
                    citations: [],
                  },
                },
              ],
            };
      },
    },
  });
  assert.equal((await agent.run('只看右侧')).status, 'needs_input');
  w.session.recalculate({ ...EVAL_PARAMETERS, window: 3 });
  agent.invalidate();
  assert.equal((await agent.run('重新取数')).status, 'needs_input');
});

test('last applied seek, missing observation, expired artifact and stale run are rejected', async () => {
  for (const id of ['seek', 'report', 'export', 'raw_view']) {
    const w = workbench();
    const scenario = FIXED_EVALUATIONS.find((c) => c.id === id)!;
    const expected = scenario.expected[0];
    const args = { ...ref(w.session), ...expected.args };
    const output = w.registry.execute(expected.name, args);
    assert.ok(output.ok);
    const paths: Record<string, string> = {
      seek: '/appliedTime',
      report: '/handle',
      export: '/handle',
      raw_view: '/view/basis',
    };
    const value = id === 'seek' ? 12 : id === 'raw_view' ? 'raw' : (output.result as any).handle;
    const run = {
      id: 'delivery',
      goal: scenario.goals[0],
      reference: w.session.info(),
      provider: 'scripted',
      model: 'not-real',
      status: 'completed',
      phase: '',
      steps: [],
      calls: [{ id: 'delivery', name: expected.name, arguments: args, output }],
      citations: [{ callId: 'delivery', path: paths[id], value }],
      message: '请查看证据。',
      rounds: 1,
      startedAt: 0,
      elapsedMs: 1,
      usage: { inputTokens: 5, outputTokens: 2, reportedRequests: 1 },
    } as AgentRun;
    const observed = observeEvaluation(run, { chart: w.view ?? null, time: w.time }, w.registry);
    assert.equal(assessRun(run, scenario, w.session, observed).passed, true, id);
    assert.equal(assessRun(run, scenario, w.session).passed, false, `${id}: missing observation`);
    const tampered = structuredClone(observed);
    if (id === 'seek') tampered.time = 8;
    else if (id === 'raw_view') tampered.chart!.joint = 'elbow';
    else tampered.artifacts[String(value)] = null;
    assert.equal(assessRun(run, scenario, w.session, tampered).passed, false, id);
    if (id === 'seek') {
      const wrongArgs = { ...ref(w.session), time: 8 };
      run.calls.push({
        id: 'wrong-seek',
        name: expected.name,
        arguments: wrongArgs,
        output: w.registry.execute(expected.name, wrongArgs),
      });
      assert.ok(
        assessRun(run, scenario, w.session, observed).failures.includes(
          'final_delivery:seek_to_time',
        ),
      );
    }
    w.session.recalculate({ ...EVAL_PARAMETERS, window: 3 });
    assert.ok(assessRun(run, scenario, w.session, observed).failures.includes('stale_run'));
  }
});

test('multi-turn assessment requires every expected turn and preserves unknown token totals', async () => {
  const { w, scenario, runs } = await auditTurns(true);
  const observation = { chart: w.view!, time: w.time, artifacts: {} };
  assert.ok(
    assessScenario([{ run: runs[1], observation }], scenario, w.session).failures.includes(
      'turn_count',
    ),
  );
  assert.ok(assessScenario([], scenario, w.session).failures.includes('turn_count'));
  runs[0].usage = { inputTokens: null, outputTokens: 3, reportedRequests: 1 };
  runs[1].usage = { inputTokens: 5, outputTokens: 2, reportedRequests: 1 };
  assert.deepEqual(totalCosts(runs).usage, {
    inputTokens: null,
    outputTokens: 5,
    reportedRequests: 2,
  });
  assert.deepEqual(totalCosts(runs).reportedUsage, {
    inputTokens: 5,
    outputTokens: 5,
    inputTurns: 1,
    outputTurns: 2,
    totalTurns: 2,
  });
});

const temporaryDirectories: string[] = [];
after(async () => {
  const root = resolve('.qa');
  for (const directory of temporaryDirectories) {
    const child = relative(root, resolve(directory));
    if (!child.startsWith('..') && !isAbsolute(child) && child.startsWith('stage-a-protocol-'))
      await rm(directory, { recursive: true });
    else throw new Error(`Refusing cleanup outside this test's directories: ${directory}`);
  }
});
async function outputPath(name = 'evaluation.json') {
  await mkdir(resolve('.qa'), { recursive: true });
  const directory = await mkdtemp(resolve('.qa/stage-a-protocol-'));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

// Deterministic provider for the script orchestration contract, never model quality.
function protocolProvider(failBusiness = false) {
  const paths: Record<string, string> = {
    compare_intervals: '/differences/0/rom',
    query_metrics: '/channels/0/rom',
    get_quality_summary: '/effectiveRate',
    set_chart_view: '/view/basis',
    seek_to_time: '/appliedTime',
    prepare_report: '/handle',
    prepare_export: '/handle',
  };
  return withTaskSpecs(
    {
      id: 'scripted-protocol-only',
      model: 'not-real',
      probes: 0,
      async probe() {
        this.probes++;
      },
      async complete(request: any) {
        const userIndex = request.messages.findLastIndex((m: any) => m.role === 'user');
        const user = JSON.parse(request.messages[userIndex].content);
        const scenario = FIXED_EVALUATIONS.find((c) => c.goals.includes(user.goal))!;
        const turn = scenario.turns.find((t) => t.goal === user.goal)!;
        const messages = request.messages
          .slice(userIndex + 1)
          .filter((m: any) => m.role === 'tool')
          .map((m: any) => JSON.parse(m.content));
        const call = (name: string, args: unknown) => ({
          calls: [{ name, arguments: args }],
          usage: { inputTokens: 5, outputTokens: 2 },
        });
        if (!messages.length) return call('get_session_info', {});
        const expected = evaluationActions(scenario, scenario.turns.indexOf(turn));
        const action = expected.find((e) => !messages.some((m: any) => m.ok && m.tool === e.name));
        if (action && !failBusiness)
          return call(action.name, {
            sessionId: user.currentSession.sessionId,
            revision: user.currentSession.revision,
            ...action.args,
          });
        return call('finish_analysis', {
          outcome: failBusiness && scenario.group === 'business' ? 'needs_input' : turn.status[0],
          messageCode: 'evidence_ready',
          citations: expected.flatMap((e) => {
            const message = messages.findLast((m: any) => m.ok && m.tool === e.name);
            return message ? [evidenceRef(message, paths[e.name])] : [];
          }),
        });
      },
      async summarizeOnce() {
        throw new Error('Unrelated fixed snapshot generation must be skipped in screen and matrix');
      },
    },
    (goal) => evaluationTask(FIXED_EVALUATIONS.find((c) => c.goals.includes(goal))!, goal),
  );
}

test('evaluation script validates filters, CLI exit codes, skip output and refuses historical overwrite', async () => {
  const selected = parseEvaluationArgs([
    '--case',
    'compare,multi_turn',
    '--case',
    'quality,compare',
    '--repeat',
    '1',
  ]);
  assert.deepEqual(selected.caseIds, ['compare', 'multi_turn', 'quality']);
  for (const args of [
    ['--case', 'unknown'],
    ['--case', ''],
    ['--case', 'quality,'],
    ['--repeat', '0'],
    ['--repeat', '1.5'],
    ['--repeat', '6'],
    ['--unknown'],
    ['--max-business-requests', '0'],
    ['--max-business-ms', 'NaN'],
  ])
    assert.throws(() => parseEvaluationArgs(args));
  const output = await outputPath();
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['scripts/evaluate-agent.mjs', ...args], { encoding: 'utf8' });
  assert.equal(cli('--help').status, 0);
  assert.equal(cli('--case', 'unknown', '--skip-real').status, 1);
  assert.equal(
    cli('--case', 'quality', '--repeat', '1', '--skip-real', '--output', output).status,
    0,
  );
  const original = await readFile(output, 'utf8');
  const record = JSON.parse(original);
  assert.equal(record.evaluationVersion, EVALUATION_VERSION);
  assert.equal(record.agentProtocolVersion, AGENT_PROTOCOL_VERSION);
  assert.equal(record.config.agentProtocolVersion, AGENT_PROTOCOL_VERSION);
  assert.equal(record.status, 'skipped_model_unavailable');
  assert.equal(record.summary.executed, 0);
  assert.equal(record.summary.successRate, null);
  assert.equal(record.summary.groups.business.planned, 1);
  assert.equal(record.summary.groups.protection.planned, 0);
  assert.match(record.fingerprints.config, /^[a-f0-9]{64}$/);
  assert.match(record.fingerprints.code, /^[a-f0-9]{64}$/);
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  assert.equal(record.fingerprints.config, digest(JSON.stringify(record.config)));
  assert.equal(record.fingerprints.code, digest(JSON.stringify(record.fingerprints.files)));
  const source = record.fingerprints.files.find((f: any) => f.path === 'src/agent/evaluation.ts');
  assert.equal(source.sha256, digest(await readFile(resolve(source.path))));
  assert.equal(cli('--skip-real', '--output', output).status, 1);
  assert.equal(await readFile(output, 'utf8'), original);
  const secondOutput = await outputPath();
  assert.equal(
    cli('--case', 'quality', '--repeat', '1', '--skip-real', '--output', secondOutput).status,
    0,
  );
  assert.deepEqual(
    JSON.parse(await readFile(secondOutput, 'utf8')).fingerprints,
    record.fingerprints,
  );
  const missingModel = await outputPath();
  assert.equal(cli('--case', 'quality', '--output', missingModel).status, 1);
  assert.equal(JSON.parse(await readFile(missingModel, 'utf8')).status, 'failed');
});

test('script protocol preserves all fixed cases, groups, per-turn observations and summed costs', async () => {
  const provider = protocolProvider();
  const options = parseEvaluationArgs([
    '--model',
    'not-real',
    '--repeat',
    '1',
    '--output',
    await outputPath(),
  ]);
  const { record, exitCode } = await runEvaluation(options, { provider });
  assert.equal(exitCode, 0, JSON.stringify({ error: record.error, summary: record.summary }));
  assert.equal(provider.probes, 1);
  assert.equal(record.connectionProbe.status, 'passed');
  assert.equal(record.connectionProbe.scope, 'connection_only_excluded_from_business');
  assert.ok(record.connectionProbe.elapsedMs >= 0);
  assert.equal(
    record.config.systemPrompt.sha256,
    createHash('sha256').update(record.config.systemPrompt.content).digest('hex'),
  );
  assert.equal(record.evidenceKind, 'scripted-protocol-only');
  const allTurns = record.runs.flatMap((row: any) => row.turns);
  assert.equal(record.auditFiles.length, allTurns.length);
  const auditFile = record.auditFiles.find((file: any) => file.runId === allTurns[0].run.id);
  const contents = await readFile(auditFile.path, 'utf8');
  assert.equal(createHash('sha256').update(contents).digest('hex'), auditFile.sha256);
  const audit = JSON.parse(contents);
  assert.deepEqual(audit.run.calls, allTurns[0].run.calls);
  assert.equal(audit.requests.length, allTurns[0].run.requests.length);
  assert.ok(audit.tools.some((tool: any) => tool.name === 'set_task_patch'));
  assert.equal(record.summary.executed, 14);
  assert.deepEqual(
    Object.values(record.summary.groups).map((g: any) => [g.executed, g.passed]),
    [
      [10, 10],
      [2, 2],
      [2, 2],
    ],
  );
  const multi = record.runs.find((r: any) => r.caseId === 'multi_turn');
  assert.equal(multi.turns.length, 2);
  assert.deepEqual(
    multi.turns.map((t: any) => t.observation.chart.interval),
    [
      [0, 20],
      [0, 17],
    ],
  );
  assert.deepEqual(multi.assessment.usage, totalCosts(multi.turns.map((t: any) => t.run)).usage);
  assert.equal(
    multi.assessment.rounds,
    multi.turns.reduce((sum: number, turn: any) => sum + turn.run.rounds, 0),
  );
  assert.equal(
    multi.assessment.elapsedMs,
    multi.turns.reduce((sum: number, t: any) => sum + t.run.elapsedMs, 0),
  );
  assert.equal(
    record.summary.calls,
    record.runs
      .flatMap((r: any) => r.turns)
      .reduce((sum: number, t: any) => sum + t.run.calls.length, 0),
  );
  assert.equal(record.baseline, null);
  assert.equal(record.baselinePolicy.status, 'skipped');
  assert.equal(record.baselinePolicy.requests, 0);
  const failure = await runEvaluation(
    { ...options, caseIds: ['quality', 'empty', 'cancel'], output: await outputPath() },
    { provider: protocolProvider(true) },
  );
  assert.equal(failure.exitCode, 1);
  assert.deepEqual(
    Object.values(failure.record.summary.groups).map((g: any) => [g.executed, g.passed]),
    [
      [1, 0],
      [1, 1],
      [1, 1],
    ],
  );
  assert.equal(failure.record.summary.successRate, 2 / 3);
});

test('checkpoint persists the first turn before cancellation and retains immutable partial evidence', async () => {
  const output = await outputPath();
  const controller = new AbortController();
  let partial: any;
  const result = await runEvaluation(
    parseEvaluationArgs([
      '--case',
      'multi_turn',
      '--repeat',
      '1',
      '--model',
      'not-real',
      '--output',
      output,
    ]),
    {
      provider: protocolProvider(),
      controller,
      async onCheckpoint(record: any) {
        if (record.checkpoint.reason === 'turn_completed') {
          partial = JSON.parse(await readFile(record.checkpoint.path, 'utf8'));
          assert.equal(JSON.parse(await readFile(output, 'utf8')).runs[0].turns.length, 1);
          controller.abort('protocol_test_stop');
        }
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.record.status, 'cancelled', result.record.error ?? '');
  assert.equal(partial.runs[0].turns.length, 1);
  assert.equal(partial.summary.executed, 0);
  assert.equal(partial.summary.incomplete, 1);
  assert.equal(partial.summary.successRate, null);
  assert.equal(result.record.runs[0].assessment, null);
  assert.deepEqual(JSON.parse(await readFile(partial.checkpoint.path, 'utf8')), partial);
  assert.equal(result.record.summary.calls, partial.runs[0].turns[0].run.calls.length);
});

test('evaluation request budget retains partial multi-turn evidence without sending an extra request', async () => {
  const provider = protocolProvider();
  let sent = 0;
  const complete = provider.complete.bind(provider);
  provider.complete = async (request: any) => {
    sent++;
    return complete(request);
  };
  const { record, exitCode } = await runEvaluation(
    parseEvaluationArgs([
      '--case',
      'multi_turn',
      '--repeat',
      '1',
      '--model',
      'not-real',
      '--max-business-requests',
      '1',
      '--max-business-ms',
      '600000',
      '--output',
      await outputPath(),
    ]),
    { provider },
  );
  assert.equal(exitCode, 1);
  assert.equal(sent, 1);
  assert.equal(record.businessBudget.requests, 1);
  assert.equal(record.businessBudget.stoppedBy, 'business_request_budget');
  assert.equal(record.summary.requests, 1);
  assert.equal(record.runs[0].turns.length, 1);
  assert.equal(record.runs[0].assessment, null);
  assert.equal(record.baseline, null);
  assert.equal(record.auditFiles.length, 1);
});

test('evaluation wall budget aborts an in-flight request and retains its unknown token cost', async () => {
  const provider = protocolProvider();
  provider.complete = async ({ signal }: any) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('budget_abort')), { once: true });
    });
  const { record, exitCode } = await runEvaluation(
    parseEvaluationArgs([
      '--case',
      'quality',
      '--repeat',
      '1',
      '--model',
      'not-real',
      '--max-business-ms',
      '25',
      '--output',
      await outputPath(),
    ]),
    { provider },
  );
  assert.equal(exitCode, 1);
  assert.equal(record.businessBudget.stoppedBy, 'business_time_budget');
  assert.equal(record.summary.requests, 1);
  assert.equal(record.summary.usage.inputTokens, null);
  assert.equal(record.runs[0].turns[0].run.requests[0].status, 'failed');
  assert.equal(record.auditFiles.length, 1);
});

test('unexpected interruption preserves completed turns and exits with failure', async () => {
  const output = await outputPath();
  let interrupted = false;
  const { record, exitCode } = await runEvaluation(
    parseEvaluationArgs([
      '--case',
      'multi_turn',
      '--repeat',
      '1',
      '--model',
      'not-real',
      '--output',
      output,
    ]),
    {
      provider: protocolProvider(),
      onCheckpoint(snapshot: any) {
        if (!interrupted && snapshot.checkpoint.reason === 'turn_completed') {
          interrupted = true;
          throw new Error('protocol_test_interruption');
        }
      },
    },
  );
  assert.equal(exitCode, 1);
  assert.equal(record.status, 'failed');
  assert.equal(record.error, 'protocol_test_interruption');
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(saved.runs[0].turns.length, 1);
  assert.equal(saved.summary.incomplete, 1);
  assert.equal(saved.summary.passed, 0);
  assert.equal(saved.summary.successRate, null);
});
