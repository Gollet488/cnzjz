import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkedProxyOrigin,
  frozenHumanMaterials,
  humanScenarios,
  humanSubmissionEvidence,
  parseEvaluationArgs,
  runEvaluation,
} from '../scripts/evaluate-agent.mjs';
import { AgentRuntime, MAX_FINAL_CITATIONS } from '../src/agent/runtime.ts';
import { assessRun, observeEvaluation } from '../src/agent/evaluation.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import type { ChartView } from '../src/analysis/tools.ts';

const replay = [
  '--human-input-index',
  '.qa/core-work/20261030-input-closure-1793357317372/input-index.json',
];

test('human proxy refuses alternate hosts, credentials, paths and redirect targets', () => {
  for (const origin of [
    'http://localhost:5173',
    'http://127.0.0.2:5173',
    'http://[::1]:5173',
    'https://127.0.0.1:5173',
    'http://user:password@127.0.0.1:5173',
    'http://127.0.0.1:5173/',
    'http://127.0.0.1:5173/__deepseek/complete',
    'http://127.0.0.1:5173?url=https://example.com',
    'http://127.0.0.1:5173#https://example.com',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
  ])
    assert.throws(() => checkedProxyOrigin(origin), origin);
  assert.equal(checkedProxyOrigin('http://127.0.0.1:5186'), 'http://127.0.0.1:5186');
});

test('human CLI cannot change the configured provider, model, fixed tasks or hard budget', () => {
  for (const change of [
    ['--provider', 'ollama'],
    ['--model', 'other-model'],
    ['--case', 'compare'],
    ['--repeat', '2'],
    ['--address', 'https://api.deepseek.com'],
    ['--max-business-requests', '25'],
    ['--max-business-ms', '240001'],
  ])
    assert.throws(
      () => parseEvaluationArgs([...replay, '--local-only', ...change]),
      change.join(' '),
    );
});

test('local-only keeps a truthful credential-free configuration without a proxy', () => {
  const local = parseEvaluationArgs([...replay, '--local-only']);
  assert.equal(local.localOnly, true);
  assert.equal(local.proxyOrigin, null);
  assert.equal(local.address, null);
  assert.equal(local.provider, 'deepseek');
  assert.equal(local.model, 'deepseek-flash');
  assert.equal(local.repetitions, 1);
  assert.deepEqual(local.caseIds, ['human-720', 'human-1080']);
  assert.deepEqual(local.budget, { requests: 24, ms: 240000 });
  assert.throws(() => parseEvaluationArgs(['--local-only']));
  assert.throws(() => parseEvaluationArgs(replay));
});

test('human real configuration names the exact loopback transport and permits smaller budgets', () => {
  const real = parseEvaluationArgs([
    ...replay,
    '--proxy-origin',
    'http://127.0.0.1:5186',
    '--max-business-requests',
    '12',
    '--max-business-ms',
    '120000',
  ]);
  assert.equal(real.address, 'http://127.0.0.1:5186');
  assert.equal(real.proxyOrigin, real.address);
  assert.equal(real.localOnly, false);
  assert.deepEqual(real.budget, { requests: 12, ms: 120000 });
});

const frozenAvailable = existsSync('.qa/core-work/20261104-data-baseline/baseline.json');
const frozen = () => frozenHumanMaterials(replay[1]);

test(
  'human --case human-1080 enters only the selected business case with a mocked loopback transport',
  { skip: !frozenAvailable },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'human-evaluation-'));
    t.after(async () => {
      await Promise.all((await readdir(directory)).map((file) => unlink(join(directory, file))));
      await rmdir(directory);
    });
    const origin = 'http://127.0.0.1:5186';
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      requests.push(url);
      if (url === `${origin}/__deepseek/probe`)
        return Response.json({ requests: 1, usage: { inputTokens: 0, outputTokens: 0 } });
      assert.equal(url, `${origin}/__deepseek/complete`);
      return Response.json({ error: 'DEEPSEEK_PROXY_REQUEST_FAILED' }, { status: 502 });
    });
    const options = parseEvaluationArgs([
      ...replay,
      '--case',
      'human-1080',
      '--proxy-origin',
      origin,
      '--max-business-requests',
      '1',
      '--output',
      join(directory, 'entry.json'),
    ]);
    const { record, exitCode } = await runEvaluation(options);
    assert.equal(exitCode, 1);
    assert.equal(record.plannedCases, 1);
    assert.deepEqual(
      record.config.cases.map((item) => item.id),
      ['human-1080'],
    );
    assert.deepEqual(
      record.humanMaterials.map((item) => item.id),
      ['human-1080'],
    );
    assert.deepEqual(
      record.runs.map((item) => item.caseId),
      ['human-1080'],
    );
    assert.equal(record.requestAccounting.businessRequests, 1);
    assert.deepEqual(requests, [`${origin}/__deepseek/probe`, `${origin}/__deepseek/complete`]);
  },
);

async function runFrozen(
  id: string,
  omissions: string[][] = [],
  firstAttemptExtras: Record<string, string[]> = {},
) {
  const scenario = humanScenarios().find((s) => s.id === id)!;
  const { session, sidecar } = (await frozen()).get(id);
  const submission = humanSubmissionEvidence(scenario, sidecar);
  const turn = scenario.turns[0];
  const [compare, , chart, , csv] = turn.expected;
  const workspace = { chart: null as ChartView | null, time: null };
  const registry = createToolRegistry(session, {
    readWorkspace: () => workspace,
    setChartView: (view) => (workspace.chart = view),
    seekToTime: (time) => ({ appliedTime: time }),
  });
  const attempts: { labels: string[]; minimumReplacements: number }[] = [];
  let step = 0;
  const runtime = new AgentRuntime({
    session,
    registry,
    submissionEvidence: submission.gaps,
    provider: {
      id: 'scripted-frozen-evidence',
      model: 'offline',
      async complete({ messages, tools }) {
        const user = JSON.parse(messages.find((m) => m.role === 'user')!.content);
        if (step++ === 0)
          return {
            calls: [
              { name: 'get_session_info', arguments: {} },
              {
                name: 'set_task_spec',
                arguments: {
                  goalTypes: { comparison: true, quality: true, metrics: false },
                  joint: compare.args.joint,
                  channels: compare.args.channels,
                  basis: compare.args.basis,
                  interval: compare.args.first,
                  comparison: { second: compare.args.second, direction: 'second_minus_first' },
                  metrics: ['rom'],
                  time: null,
                  deliveries: { view: chart.args, report: true, export: csv.args },
                  sources: [
                    { field: 'task', origin: 'explicit', sourceId: user.userSources[0].sourceId },
                  ],
                  unresolved: [],
                },
              },
            ],
          };
        if (step === 2)
          return {
            calls: turn.expected.map(({ name }) => ({
              name,
              arguments: { taskRef: user.bindings.taskRef },
            })),
          };
        const finish = tools.find((t) => t.name === 'finish_analysis')!;
        assert.equal(finish.inputSchema.properties?.citations?.maxItems, MAX_FINAL_CITATIONS);
        const evidence = Object.fromEntries(
          user.availableEvidence.map(({ tool, entries }: any) => [tool, entries]),
        );
        const qualityPaths = [
          'selection.channels.0.validSamples',
          'selection.channels.1.validSamples',
        ];
        const comparePaths = [];
        if (id === 'human-720') {
          qualityPaths.push(
            'selection.channels.1.coverage',
            ...['interval.0', 'interval.1', 'samples'].map(
              (field) => `selection.channels.1.longestMissingInterval.${field}`,
            ),
          );
          comparePaths.push(
            'comparable',
            ...[0, 1].map((side) => `first.channels.${side}.events.minimum.time`),
          );
        } else {
          comparePaths.push(
            'first.units.angle',
            'second.units.angle',
            'first.evidence.limitations.0',
          );
          for (const side of [0, 1]) {
            comparePaths.push(
              `second.channels.${side}.angle.sampleCount`,
              `differences.${side}.rom`,
            );
            for (const part of ['first', 'second'])
              for (const event of ['minimum', 'maximum'])
                comparePaths.push(`${part}.channels.${side}.events.${event}.time`);
          }
        }
        const previousOmissions = omissions[step - 3] ?? [];
        const submitted = Object.entries({
          get_quality_summary: qualityPaths,
          compare_intervals: comparePaths,
          set_chart_view: ['view.basis'],
          prepare_report: ['handle'],
          prepare_export: ['handle'],
        }).flatMap(([tool, paths]) =>
          [
            ...paths.filter((label) => !previousOmissions.includes(label)),
            ...(step === 3 ? (firstAttemptExtras[tool] ?? []) : []),
          ].map((label) => {
            const entry = evidence[tool].find((e: any) => e.label === label);
            assert.ok(entry, `missing compact entry: ${tool}/${label}`);
            return { evidenceId: entry.evidenceId };
          }),
        );
        if (step > 3) {
          const rejection = messages.findLast(
            (m) => m.role === 'tool' && m.toolName === 'finish_analysis',
          )!;
          const { ok, error } = JSON.parse(rejection.content);
          assert.equal(ok, false);
          assert.match(error.message, /SUBMISSION_EVIDENCE_REQUIRED/);
          assert.ok(error.submissionGaps.every((gap: any) => gap.reason === 'missing_citation'));
          attempts.push({
            labels: error.submissionGaps.flatMap((gap: any) => gap.labels),
            minimumReplacements: error.submissionBudget.minimumReplacements,
          });
        }
        return {
          calls: [
            {
              name: 'finish_analysis',
              arguments: {
                outcome: turn.status[0],
                messageCode: id === 'human-720' ? 'comparison_limited' : 'evidence_ready',
                citations: submitted,
              },
            },
          ],
        };
      },
    },
  });
  const run = await runtime.run(turn.goal);
  assert.equal(run.status, turn.status[0], run.message);
  assert.equal(run.citations.length, submission.requiredCitations);
  assert.deepEqual(submission.gaps(run, run.citations), []);
  const observation = observeEvaluation(run, workspace, registry);
  const assessment = assessRun(run, scenario, session, observation);
  assert.equal(assessment.passed, true, assessment.failures.join('\n'));
  return { run, submission, attempts, observation };
}

test(
  'frozen 720 rejects the missing 127 count and chart separately and accepts a corrected restricted delivery',
  { skip: !frozenAvailable },
  async () => {
    const count = 'selection.channels.1.longestMissingInterval.samples';
    const { run, attempts } = await runFrozen('human-720', [[count], ['view.basis']]);
    assert.deepEqual(attempts, [
      { labels: [count], minimumReplacements: 0 },
      { labels: ['view.basis'], minimumReplacements: 0 },
    ]);
    assert.equal(run.citations.length, 12);
    assert.equal(
      run.citations.find((c) => c.path.endsWith('/longestMissingInterval/samples'))?.value,
      127,
    );
    assert.deepEqual(run.completion?.missing, ['comparison']);
    assert.deepEqual(run.completion?.satisfied, ['quality', 'view', 'report', 'export']);
    assert.equal(run.requests?.length, 5);
  },
);

test(
  'frozen 1080 fills the citation budget with both sides and intervals, degree units, ROM deltas, extrema and projection',
  { skip: !frozenAvailable },
  async () => {
    const missing = [
      ...[0, 1].flatMap((side) =>
        ['minimum', 'maximum'].map((event) => `second.channels.${side}.events.${event}.time`),
      ),
      'view.basis',
      'handle',
      'handle',
    ];
    const { run, submission, attempts } = await runFrozen('human-1080', [missing], {
      get_quality_summary: [0, 1].flatMap((side) =>
        ['coverage', 'validIntervals.0.interval.1'].map(
          (field) => `selection.channels.${side}.${field}`,
        ),
      ),
      compare_intervals: [
        'comparable',
        'first.channels.0.angle.sampleCount',
        'first.channels.1.angle.sampleCount',
      ],
    });
    assert.deepEqual(attempts, [{ labels: missing, minimumReplacements: 7 }]);
    assert.equal(run.requests?.length, 4);
    assert.equal(submission.requiredCitations, 20);
    assert.equal(run.completion?.state, 'ready');
    for (const citation of run.citations) {
      const gaps = submission.gaps(
        run,
        run.citations.filter((c) => c !== citation),
      );
      assert.equal(gaps.length, 1, citation.path);
      assert.equal(gaps[0].reason, 'missing_citation');
      assert.ok(gaps[0].labels.includes(citation.path.slice(1).replaceAll('/', '.')));
    }
    const values = (pattern: RegExp) =>
      run.citations.filter((c) => pattern.test(c.path)).map((c) => c.value);
    assert.deepEqual(values(/(?:validSamples|sampleCount)$/), [151, 151, 151, 151]);
    assert.deepEqual(values(/\/units\/angle$/), ['deg', 'deg']);
    assert.deepEqual(values(/^\/differences\/\d+\/rom$/), [-43.64149215510655, -53.39578031586359]);
    assert.equal(values(/\/events\/(minimum|maximum)\/time$/).length, 8);
    assert.match(String(values(/\/evidence\/limitations\/0$/)[0]), /2D 几何投影/);
  },
);
