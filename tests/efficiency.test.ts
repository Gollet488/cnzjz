import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import {
  FIXED_EVALUATIONS,
  evaluationSession,
  observeEvaluation,
} from '../src/agent/evaluation.ts';
import {
  assessEfficiencySample,
  assessLocalMeasurements,
  verifyEfficiency,
  AGENT_LIMITS,
  LOCAL_LIMITS,
} from '../src/agent/efficiency.ts';
import { taskForActions, withTaskSpecs, evidenceRef } from './agentFixtures.ts';

const temporaryDirectories: string[] = [];
const scratchRoot = resolve('.qa');
const controlledEvidence: any[] = [];
const capture = (name: string, input: any, result: any) =>
  controlledEvidence.push(structuredClone({ name, input, result }));
after(async () => {
  for (const directory of temporaryDirectories) {
    const child = relative(scratchRoot, resolve(directory));
    assert.ok(!child.startsWith('..') && !isAbsolute(child) && child.startsWith('h1-efficiency-'));
    await rm(directory, { recursive: true });
  }
  if (process.env.H1_EVIDENCE_DIRECTORY)
    await writeFile(
      join(resolve(process.env.H1_EVIDENCE_DIRECTORY), 'controlled-cases.json'),
      JSON.stringify(
        { kind: 'controlled-scripted-only-not-real-performance', cases: controlledEvidence },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
});

async function sample(
  id = 'compare',
  options: {
    failFirst?: boolean;
    auditFail?: boolean;
    readyFail?: boolean;
    delayed?: boolean;
  } = {},
) {
  const multi = FIXED_EVALUATIONS.find((s) => s.id === 'multi_turn')!;
  const report = FIXED_EVALUATIONS.find((s) => s.id === 'report')!;
  const third = {
    ...report.turns[0],
    goal: '准备右膝 filtered 0–5 秒与 12–17 秒比较报告，准备 0–17 秒 CSV，并展示 0–17 秒右膝 filtered 图表',
    expected: [
      ...report.expected.map((e) => ({ ...e, args: { ...e.args, channels: ['right'] } })),
      { name: 'prepare_export', args: { interval: [0, 17], format: 'csv' } },
      {
        name: 'set_chart_view',
        args: { joint: 'knee', channels: ['right'], basis: 'filtered', interval: [0, 17] },
      },
    ],
  };
  const scenario =
    id === 'page'
      ? { ...multi, turns: [...multi.turns, third] }
      : FIXED_EVALUATIONS.find((s) => s.id === id)!;
  const session = evaluationSession();
  const view: any = { chart: null, time: null };
  const registry = createToolRegistry(session, {
    setChartView: (chart) => (view.chart = structuredClone(chart)),
    readWorkspace: () => view,
    seekToTime: (time) => ({ appliedTime: (view.time = time) }),
  });
  const paths: any = {
    compare_intervals: '/differences/0/rom',
    set_chart_view: '/view/basis',
    prepare_export: '/handle',
    prepare_report: '/handle',
    get_quality_summary: '/effectiveRate',
    query_metrics: '/channels/0/rom',
  };
  let index = 0;
  const runtime = new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session,
    registry,
    onReady: async () => {
      if (options.delayed) await delay(20);
      if (options.readyFail) throw Error('paint');
    },
    onAudit: async () => {
      if (options.delayed) await delay(25);
      if (options.auditFail) throw Error('disk');
    },
    provider: withTaskSpecs(
      {
        id: 'controlled',
        model: 'not-real',
        requestBytes: () => 30000,
        async complete(request) {
          if (options.delayed) await delay(5);
          if (options.failFirst && index === 0) throw Error('first turn failed');
          const user = JSON.parse(request.messages.find((m) => m.role === 'user')!.content);
          const expected = scenario.turns[index].expected;
          const results = request.messages
            .filter((m) => m.role === 'tool')
            .map((m) => JSON.parse(m.content));
          const action = !results.length
            ? { name: 'get_session_info', args: {} }
            : expected.find((e) => !results.some((r) => r.ok && r.tool === e.name));
          return {
            usage: { inputTokens: 100, outputTokens: 10 },
            calls: action
              ? [
                  {
                    name: action.name,
                    arguments:
                      action.name === 'get_session_info'
                        ? {}
                        : {
                            sessionId: user.currentSession.sessionId,
                            revision: user.currentSession.revision,
                            ...action.args,
                          },
                  },
                ]
              : [
                  {
                    name: 'finish_analysis',
                    arguments: {
                      outcome: 'completed',
                      messageCode: 'evidence_ready',
                      citations: expected.map((e) =>
                        evidenceRef(
                          results.findLast((r) => r.ok && r.tool === e.name),
                          paths[e.name],
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
  const turns: any[] = [];
  for (const turn of scenario.turns) {
    const run = await runtime.run(turn.goal);
    turns.push({ run, observation: observeEvaluation(run, view, registry) });
    index++;
  }
  return { caseId: id, repeat: 1, turns };
}

test('real runtime timing includes model, local tools, application and primary audit; missing sinks stay unknown', async () => {
  const entry = await sample('compare', { delayed: true });
  const run = entry.turns[0].run;
  assert.equal(assessEfficiencySample(entry).status, 'passed');
  capture('complete-runtime-timing', entry, assessEfficiencySample(entry));
  assert.ok(run.timing.applicationMs >= 18);
  assert.ok(run.timing.auditMs >= 23);
  assert.ok(run.timing.wallMs >= run.elapsedMs + 40);
  assert.equal(run.timing.wallMs, run.timing.computeMs);
  assert.ok(run.calls.every((c: any) => c.elapsedMs >= 0));
  const empty = new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session: evaluationSession(),
    registry: createToolRegistry(evaluationSession()),
    provider: {
      id: 'test',
      model: 'none',
      async complete() {
        throw Error('offline');
      },
    },
  });
  const failed = await empty.run('查询');
  assert.equal(failed.timing!.application, 'unmeasured');
  assert.equal(failed.timing!.audit, 'unmeasured');
  for (const opts of [{ auditFail: true }, { readyFail: true }])
    assert.equal(assessEfficiencySample(await sample('compare', opts)).status, 'failed');
});

test('inclusive Agent budgets use actual wire bytes and every request token, with known partial costs retained', async () => {
  const entry = await sample('quality');
  const run = entry.turns[0].run;
  const limit = AGENT_LIMITS.single;
  run.timing.wallMs = run.timing.computeMs = limit.wallMs;
  for (const request of run.requests) {
    request.wireBytes = limit.wireBytes;
    request.inputTokens = 0;
    request.outputTokens = 0;
  }
  run.requests[0].inputTokens = limit.inputTokens;
  run.requests[0].outputTokens = limit.outputTokens;
  assert.equal(assessEfficiencySample(entry).status, 'passed');
  for (const [field, value] of [
    ['wireBytes', limit.wireBytes + 1],
    ['inputTokens', limit.inputTokens + 1],
    ['outputTokens', limit.outputTokens + 1],
  ] as const) {
    const modified = structuredClone(entry);
    modified.turns[0].run.requests[0][field] = value;
    assert.equal(assessEfficiencySample(modified).status, 'failed', field);
    capture(`over-limit:${field}`, modified, assessEfficiencySample(modified));
  }
  const slow = structuredClone(entry);
  slow.turns[0].run.timing.wallMs++;
  slow.turns[0].run.timing.computeMs++;
  assert.equal(assessEfficiencySample(slow).status, 'failed');
  for (const field of ['wireBytes', 'inputTokens', 'outputTokens']) {
    const modified = structuredClone(entry);
    modified.turns[0].run.requests[0][field] = null;
    assert.equal(assessEfficiencySample(modified).status, 'unmeasured', field);
    capture(`unknown:${field}`, modified, assessEfficiencySample(modified));
  }
  const partial = structuredClone(entry);
  partial.turns[0].run.requests[0].inputTokens = null;
  const result = assessEfficiencySample(partial);
  assert.equal(result.costs.inputTokens, null);
  assert.equal(result.costs.reportedInputRequests, run.requests.length - 1);
  const many = structuredClone(entry);
  many.turns[0].run.requests.push(
    ...Array.from({ length: 5 }, () => ({
      ...run.requests[0],
      inputTokens: null,
      outputTokens: null,
    })),
  );
  assert.equal(assessEfficiencySample(many).status, 'failed');
});

test('missing final observations/timing never pass; wrong final view or artifact fails independent replay', async () => {
  for (const id of ['compare', 'report', 'export', 'raw_view']) {
    const entry = await sample(id);
    assert.equal(assessEfficiencySample(entry).status, 'passed', id);
    const missing = structuredClone(entry);
    delete missing.turns[0].observation;
    assert.equal(assessEfficiencySample(missing).status, 'unmeasured');
    const untimed = structuredClone(entry);
    delete untimed.turns[0].run.timing;
    assert.equal(assessEfficiencySample(untimed).status, 'unmeasured');
    if (id === 'compare' || id === 'raw_view') entry.turns[0].observation.chart.joint = 'elbow';
    else entry.turns[0].observation.artifacts = {};
    assert.equal(assessEfficiencySample(entry).status, 'failed', id);
    capture(`wrong-final:${id}`, entry, assessEfficiencySample(entry));
  }
});

test('first-turn failure cannot be hidden by successful correction; all costs and missing turns count', async () => {
  const entry = await sample('multi_turn', { failFirst: true });
  const result = assessEfficiencySample(entry);
  assert.equal(entry.turns[0].run.status, 'failed');
  assert.equal(entry.turns[1].run.status, 'completed');
  assert.equal(result.status, 'failed');
  capture('first-turn-failed-correction-completed', entry, result);
  assert.equal(result.costs.failedRequests, 1);
  assert.equal(
    result.costs.requests,
    entry.turns.reduce((n, t) => n + t.run.requests.length, 0),
  );
  assert.equal(result.costs.inputTokens, null);
  assert.equal(
    result.costs.wallMs,
    entry.turns.reduce((n, t) => n + t.run.timing.wallMs, 0),
  );
  entry.turns.shift();
  assert.notEqual(assessEfficiencySample(entry).status, 'passed');
});

function localFixture() {
  const measurements: any = {};
  for (const [id, [limit, count]] of Object.entries(LOCAL_LIMITS)) {
    measurements[id] = {
      context: {
        environmentFingerprint: 'controlled',
        configFingerprint: 'controlled',
        materialFingerprint: 'controlled',
        frames: 18000,
        synthetic: true,
        columns: 354,
        invalidationVerified: true,
        forcedGC: true,
        sampledPeak: true,
        rssRecorded: true,
        freshPagePerRun: true,
        nonJSHeapRecorded: true,
        foreground: true,
        productionPage: true,
        nativeDialogWaitSeparate: true,
        performanceObserver: true,
        width: 1280,
        height: 720,
        durationSeconds: id === 'cameraFPS' ? 60 : 60,
        model: 'Lite',
        actualInferenceFrames: true,
        fps: 30,
        realInput: true,
        allPTSChecked: true,
        thermalState: 'cold',
        sourceFramesRecorded: true,
        uiFPSSeparate: true,
        processedFrames: 1800,
        expectedFrames: 1800,
        fullRange: true,
        hashIncluded: true,
        destination:
          id === 'csvNodeMs'
            ? 'node-file'
            : id === 'csvBrowserStreamMs'
              ? 'browser-file-stream'
              : 'blob',
      },
      samples: Array.from({ length: count }, (_, i) => ({
        id: String(i),
        value: limit,
        correct: true,
        evidence: 'controlled-boundary',
        fullFileVerified: true,
        sha256: 'controlled',
        coldRegistry: true,
      })),
    };
  }
  return measurements;
}

test('local thresholds, minimum samples, p95 and unknown memory are executable without running benchmarks', () => {
  const measurements = localFixture();
  assert.deepEqual(
    assessLocalMeasurements(measurements).filter((r) => r.status !== 'passed'),
    [],
  );
  for (const [id, [limit, , aggregation]] of Object.entries(LOCAL_LIMITS)) {
    const copy = structuredClone(measurements);
    copy[id].samples.forEach((s: any) => {
      s.value = aggregation === 'median-min' ? limit - 1 : limit + 1;
    });
    assert.equal(assessLocalMeasurements(copy).find((r) => r.id === id)!.status, 'failed', id);
  }
  measurements.csvNodeMs.samples.pop();
  measurements.browserBlobHeapBytes.samples[0].value = null;
  assert.equal(
    assessLocalMeasurements(measurements).find((r) => r.id === 'csvNodeMs')!.status,
    'unmeasured',
  );
  capture(
    'local-insufficient-and-unknown-memory',
    measurements,
    assessLocalMeasurements(measurements),
  );
  assert.equal(
    assessLocalMeasurements(measurements).find((r) => r.id === 'browserBlobHeapBytes')!.status,
    'unmeasured',
  );
  measurements.queryCachedMs.samples.slice(0, 5).forEach((s: any) => {
    s.value = 500;
  });
  assert.equal(
    assessLocalMeasurements(measurements).find((r) => r.id === 'queryCachedMs')!.value,
    5,
  );
  measurements.queryCachedMs.samples[5].value = 500;
  assert.equal(
    assessLocalMeasurements(measurements).find((r) => r.id === 'queryCachedMs')!.status,
    'failed',
  );
});

test('failed, timeout, cancelled and limited runs never become zero-cost passes', async () => {
  const row = await sample();
  for (const status of ['failed', 'timeout', 'cancelled', 'limit']) {
    const failed = structuredClone(row);
    failed.turns[0].run.status = status;
    failed.turns[0].run.elapsedMs = 0;
    const record = { status: 'executed_real_model', evidenceKind: 'real-model', runs: [failed] };
    assert.equal(verifyEfficiency(record).status, 'failed', status);
  }
});

test('aggregation rejects missing repetitions and unknown model/conditions; three samples have no p95', async () => {
  const row = await sample();
  const record = {
    evaluationVersion: '2.2.1',
    evidenceKind: 'real-model',
    status: 'executed_real_model',
    runs: [row],
  };
  const report = verifyEfficiency(record);
  assert.equal(report.status, 'unmeasured');
  assert.ok(report.checks.some((c) => c.id === 'samples:compare' && c.status === 'unmeasured'));
  assert.equal(report.groups![0].p95Ms, null);
  assert.equal(verifyEfficiency({ efficiencyScopes: [] }).status, 'failed');
});

test('page gate counts three independent complete sessions, rejects wrong deliveries and enforces the entire scene budget', async () => {
  const sessions: any[] = [];
  for (let i = 0; i < 3; i++) {
    const entry = await sample('page');
    sessions.push({
      id: String(i),
      kind: 'real-model-page-demonstration',
      completed: true,
      reportCorrect: true,
      csvCorrect: true,
      turns: entry.turns.map((t, index) => ({
        ...t,
        nodeConsistent: true,
        businessCorrect: true,
        finalView: `膝 filtered ${index ? '右侧 0–17 s' : '左侧 / 右侧 0–20 s'}`,
      })),
      pageOracle: {
        passed: true,
        independentReplay: true,
        allNecessaryTurns: true,
        finalView: true,
        report: true,
        csv: true,
        evidence: [
          'controlled-session.csv',
          'controlled-1.json',
          'controlled-2.json',
          'controlled-3.json',
          'controlled-report.json',
          'controlled-prepared.csv',
        ],
      },
    });
  }
  const record: any = {
    efficiencyScopes: ['page'],
    sessions,
    measurementConditions: {
      thermalState: 'warm',
      cpu: 'controlled',
      node: 'v24.22.1',
      platform: 'win32',
      pnpm: '11.25.0',
      powerMode: 'controlled',
      modelResidency: 'controlled',
      backgroundLoad: 'controlled',
      serviceVersion: 'controlled',
      modelFingerprint: 'controlled',
    },
    fingerprints: { code: 'controlled', config: 'controlled', material: 'controlled' },
  };
  assert.equal(verifyEfficiency(record).status, 'passed');
  for (const mutate of [
    (r: any) => {
      r.sessions[0].turns[2].finalView = '膝 filtered 左侧 0–17 s';
    },
    (r: any) => {
      r.sessions[0].turns[2].run.calls.find(
        (c: any) => c.name === 'prepare_export',
      ).arguments.interval = [0, 5];
    },
    (r: any) => {
      r.sessions[0].turns[0].run.timing.wallMs = 90001;
      r.sessions[0].turns[0].run.timing.computeMs = 90001;
    },
    (r: any) => {
      r.sessions[0].turns[0].run.requests[0].wireBytes = 48 * 1024 + 1;
    },
  ]) {
    const copy = structuredClone(record);
    mutate(copy);
    assert.equal(verifyEfficiency(copy).status, 'failed');
  }
  const unknown = structuredClone(record);
  unknown.sessions[0].turns[0].run.requests[0].inputTokens = null;
  assert.equal(verifyEfficiency(unknown).status, 'unmeasured');
  const short = structuredClone(record);
  short.sessions.pop();
  assert.equal(verifyEfficiency(short).status, 'unmeasured');
});

test('CLI is offline and read-only, missing input/failure/unmeasured all return nonzero', async () => {
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, 'h1-efficiency-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'missing.json');
  await writeFile(path, JSON.stringify({ efficiencyScopes: ['local'] }));
  const before = await readFile(path);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['scripts/verify-efficiency.mjs', ...args], { encoding: 'utf8' });
  assert.equal(run().status, 1);
  const result = run('--', path);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'unmeasured');
  assert.deepEqual(await readFile(path), before);
  const failed = join(directory, 'failed.json');
  await writeFile(failed, JSON.stringify({ status: 'failed', runs: [] }));
  assert.equal(run(failed).status, 1);
  const passed = join(directory, 'controlled-local.json');
  await writeFile(
    passed,
    JSON.stringify({ efficiencyScopes: ['local'], efficiencyMeasurements: localFixture() }),
  );
  assert.equal(
    run(passed).status,
    0,
    'complete controlled scoped fixture exercises success exit; not a measured benchmark',
  );
});
