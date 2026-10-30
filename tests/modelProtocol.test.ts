// Controlled providers and synthetic pose only; never real model success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../src/agent/runtime.ts';
import type { ModelProvider, ModelReply } from '../src/agent/provider.ts';
import type { RunAudit } from '../src/agent/audit.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { evaluationSession } from '../src/agent/evaluation.ts';
import {
  ModelProtocolAdapter,
  MODEL_PROTOCOL_VERSION,
  modelGoalTypes,
  compactModelFeedback,
} from '../src/agent/modelProtocol.ts';
import { taskFixture, taskForActions, evidenceRef } from './agentFixtures.ts';
import type { TaskSpec } from '../src/agent/taskSpec.ts';
import { AnalysisSession } from '../src/analysis/session.ts';
import { demoPose } from '../src/utils/demo.ts';

type Request = Parameters<ModelProvider['complete']>[0];
const user = (r: Request) => JSON.parse(r.messages.find((m) => m.role === 'user')!.content);
const feedback = (r: Request, name: string) =>
  JSON.parse(r.messages.findLast((m) => m.toolName === name)!.content);
const call = (name: string, args: unknown): ModelReply => ({ calls: [{ name, arguments: args }] });
const currentId = (r: Request) =>
  user(r).userSources.find((s: any) => s.kind === 'current').sourceId;
function specCall(r: Request, spec = taskFixture(user(r).goal)) {
  return {
    ...spec,
    goalTypes: modelGoalTypes(spec.goalTypes),
    sources: spec.sources.map(({ field, origin }) => ({ field, origin, sourceId: currentId(r) })),
  };
}
function start(r: Request, spec?: TaskSpec): ModelReply {
  return {
    calls: [
      { name: 'get_session_info', arguments: {} },
      { name: 'set_task_spec', arguments: specCall(r, spec) },
    ],
  };
}
function wholeTask(r: Request, spec: TaskSpec) {
  return {
    ...spec,
    goalTypes: modelGoalTypes(spec.goalTypes),
    sources: [{ field: 'task', origin: 'derived', sourceId: currentId(r) }],
  };
}
function finish(r: Request, tool = 'query_metrics', path = '/channels/0/rom') {
  return call('finish_analysis', {
    outcome: 'completed',
    messageCode: 'evidence_ready',
    citations: [evidenceRef(feedback(r, tool), path)],
  });
}
function harness(complete: ModelProvider['complete'], session = evaluationSession()) {
  const audits: RunAudit[] = [];
  const workspace: any = { chart: null, time: null };
  const registry = createToolRegistry(session, {
    setChartView: (chart) => (workspace.chart = structuredClone(chart)),
    readWorkspace: () => workspace,
    seekToTime: (time) => ({ appliedTime: (workspace.time = time) }),
  });
  const runtime = new AgentRuntime({
    session,
    registry,
    provider: { id: 'h2-scripted', model: 'no-real-model', complete },
    onAudit: (a) => {
      audits.push(a);
    },
    onReady: () => {
      registry.readWorkspace();
    },
  });
  return { runtime, session, registry, audits, workspace };
}

test('v3.10 missing sources feedback and repeated protocol questions stay unlocked until model redeclaration', async () => {
  let step = 0;
  const h = harness(async (r) => {
    step++;
    if (step <= 4) {
      if (step > 1) {
        const rejected = feedback(r, 'set_task_spec');
        assert.equal(user(r).acceptedTask, null);
        assert.ok(r.tools.some((t) => t.name === 'set_task_spec'));
        if (step === 2) {
          assert.equal(rejected.error.issue.kind, 'missing_field');
          assert.equal(rejected.error.issue.path, '$.sources');
          assert.match(rejected.error.message, /SCHEMA \$\.sources: missing field/);
          assert.match(rejected.error.issue.suggestion, /不是用户缺参/);
          assert.doesNotMatch(rejected.error.message, /request clarification/);
        } else {
          assert.match(rejected.error.message, /TASK_SPEC_UNRESOLVED_PROTOCOL.*sources/);
          assert.equal(rejected.rejection.attempts, step - 2);
          assert.equal(rejected.rejection.callIds.length, step - 2);
          assert.deepEqual(rejected.scopeReview.unresolved, ['sources']);
        }
      }
      const spec: any = wholeTask(
        r,
        taskFixture(user(r).goal, {
          goalTypes: ['quality'],
          joint: null,
          channels: null,
          basis: null,
          metrics: [],
          unresolved: step === 2 || step === 3 ? ['sources'] : [],
        }),
      );
      spec.interval = 'sampled';
      if (step === 1) delete spec.sources;
      return {
        calls: [
          ...(step === 1 ? [{ name: 'get_session_info', arguments: {} }] : []),
          { name: 'set_task_spec', arguments: spec },
        ],
      };
    }
    if (step === 5) return call('get_quality_summary', { taskRef: user(r).bindings.taskRef });
    return call('finish_analysis', {
      outcome: 'completed',
      messageCode: 'evidence_ready',
      citations: user(r)
        .availableEvidence.find((e: any) => e.tool === 'get_quality_summary')
        .entries.map((e: any) => ({ evidenceId: e.evidenceId })),
    });
  });
  const run = await h.runtime.run('查询全部已采样质量、缺失与不可比较限制');
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 3);
  assert.deepEqual(run.task!.spec.unresolved, []);
  assert.deepEqual(run.task!.spec.goalTypes, ['quality']);
  assert.deepEqual(run.task!.spec.interval, [0, 20]);
  assert.equal(run.citations.length, 6);
  assert.deepEqual((h.audits[0]!.run.calls[2]!.modelArguments as any).unresolved, ['sources']);
  assert.deepEqual((h.audits[0]!.run.calls[3]!.modelArguments as any).unresolved, ['sources']);
});

for (const question of [
  'sources[0].sourceId',
  '$.sources',
  'taskRef',
  'sessionId',
  'revision',
  'evidenceId',
  'bindings.taskRef',
  'unresolved',
]) {
  test(`v3.10 internal path cannot lock a task as user missing data: ${question}`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0) return start(r, taskFixture(user(r).goal, { unresolved: [question] }));
      assert.equal(user(r).acceptedTask, null);
      assert.match(feedback(r, 'set_task_spec').error.message, /TASK_SPEC_UNRESOLVED_PROTOCOL/);
      return call('finish_analysis', {
        outcome: 'failed',
        messageCode: 'execution_failed',
        citations: [],
      });
    });
    const run = await h.runtime.run('查询 filtered 左右膝 0–5 秒 ROM');
    assert.equal(run.task, undefined);
    assert.equal(run.status, 'failed');
    assert.deepEqual((run.calls[1]!.modelArguments as any).unresolved, [question]);
  });
}

test('v3.10 free text business question containing protocol words remains explicit', async () => {
  const question = '需要用户说明 sources 数据代表哪次运动？';
  let step = 0;
  const h = harness(async (r) => {
    if (step++ === 0) return start(r, taskFixture(user(r).goal, { unresolved: [question] }));
    return call('finish_analysis', {
      outcome: 'needs_input',
      messageCode: 'specify_parameters',
      citations: [],
    });
  });
  const run = await h.runtime.run('查询 filtered 左右膝 0–5 秒 ROM，并确认运动来源');
  assert.equal(run.status, 'needs_input', run.message);
  assert.deepEqual(run.task!.spec.unresolved, [question]);
});

test('v3.10 missing and wrong task bindings retain schema details and permit corrected execution', async () => {
  let step = 0;
  const h = harness(async (r) => {
    step++;
    if (step === 1) return start(r);
    if (step === 2) return call('query_metrics', {});
    if (step <= 4) {
      const rejected = feedback(r, 'query_metrics');
      assert.equal(rejected.error.issue.path, '$.taskRef');
      assert.equal(rejected.error.issue.kind, step === 3 ? 'missing_field' : 'enum');
      assert.match(rejected.error.issue.suggestion, /taskRef 从 bindings 读取/);
      assert.doesNotMatch(rejected.error.message, /request clarification/);
      assert.ok(user(r).acceptedTask);
      return call('query_metrics', {
        taskRef: step === 3 ? 'invalid-current-binding' : user(r).bindings.taskRef,
      });
    }
    return finish(r);
  });
  const run = await h.runtime.run('查询 filtered 左右膝 0–5 秒 ROM');
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 2);
});

for (const [selection, error] of [
  [{ metrics: false, quality: true }, /goalTypes.comparison.*missing/],
  [{ metrics: 'false', comparison: false, quality: true }, /goalTypes.metrics/],
  [['quality'], /goalTypes/],
  [{ metrics: false, comparison: false, quality: true, view: true }, /goalTypes.view/],
] as const) {
  test(`v3.9 malformed explicit analysis choice is an internal rejection, not user missing data: ${JSON.stringify(selection)}`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      step++;
      if (step <= 2) {
        if (step === 2) {
          assert.equal(user(r).acceptedTask, null);
          assert.match(feedback(r, 'set_task_spec').error.message, error);
          assert.doesNotMatch(feedback(r, 'set_task_spec').error.message, /TASK_SPEC_INCOMPLETE/);
        }
        const spec: any = wholeTask(
          r,
          taskFixture(user(r).goal, {
            goalTypes: ['quality'],
            joint: null,
            channels: null,
            basis: null,
            metrics: [],
          }),
        );
        spec.interval = 'sampled';
        if (step === 1) spec.goalTypes = selection;
        return {
          calls: [
            ...(step === 1 ? [{ name: 'get_session_info', arguments: {} }] : []),
            { name: 'set_task_spec', arguments: spec },
          ],
        };
      }
      assert.deepEqual(user(r).acceptedTask.goalTypes, modelGoalTypes(['quality']));
      if (step === 3) return call('get_quality_summary', { taskRef: user(r).bindings.taskRef });
      return call('finish_analysis', {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: user(r)
          .availableEvidence.find((e: any) => e.tool === 'get_quality_summary')
          .entries.map((e: any) => ({ evidenceId: e.evidenceId })),
      });
    });
    const run = await h.runtime.run('查询全部已采样质量和缺失及比较限制');
    assert.equal(run.status, 'completed', run.message);
    assert.deepEqual(run.task!.spec.goalTypes, ['quality']);
    assert.deepEqual(run.task!.spec.interval, [0, 20]);
    assert.deepEqual(run.task!.spec.deliveries, { view: null, report: false, export: null });
    assert.equal(run.citations.length, 6);
    assert.deepEqual(
      run.calls[1]!.modelArguments && (run.calls[1]!.modelArguments as any).goalTypes,
      selection,
    );
  });
}

test('v3.9 goal patch rejects legacy arrays and permits explicit all-false independent delivery', async () => {
  let signal: AbortSignal,
    turn = 0,
    step = 0;
  const h = harness(async (r) => {
    if (signal !== r.signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    step++;
    if (turn === 1) {
      if (step === 1) return start(r);
      if (step === 2) return call('query_metrics', { taskRef: user(r).bindings.taskRef });
      return finish(r);
    }
    assert.deepEqual(user(r).previousTask.spec.goalTypes, modelGoalTypes(['metrics']));
    if (step <= 2) {
      if (step === 2) {
        assert.equal(user(r).acceptedTask, null);
        assert.match(feedback(r, 'set_task_patch').error.message, /expected object/);
      }
      return {
        calls: [
          ...(step === 1 ? [{ name: 'get_session_info', arguments: {} }] : []),
          {
            name: 'set_task_patch',
            arguments: {
              changes: [
                ['goalTypes', step === 1 ? [] : modelGoalTypes([])],
                ['deliveries.export', { interval: [0, 5], format: 'csv' }],
              ].map(([field, value]) => ({
                field,
                value,
                origin: 'explicit',
                sourceId: currentId(r),
              })),
            },
          },
        ],
      };
    }
    assert.deepEqual(user(r).acceptedTask.goalTypes, modelGoalTypes([]));
    if (step === 3) return call('prepare_export', { taskRef: user(r).bindings.taskRef });
    return finish(r, 'prepare_export', '/handle');
  });
  assert.equal((await h.runtime.run('查询 filtered 左右膝 0–5 秒 ROM')).status, 'completed');
  const run = await h.runtime.run('删除独立统计要求，只准备 0–5 秒 CSV');
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.task!.spec.goalTypes, []);
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 1);
});

test('v3.6 repeated rejection keeps scope errors visible and permits model correction without source repair', async () => {
  let step = 0;
  const h = harness(async (r) => {
    step++;
    if (step <= 3) {
      const spec: any = specCall(
        r,
        taskFixture(user(r).goal, {
          goalTypes: ['comparison'],
          comparison: { second: [15, 20], direction: 'second_minus_first' },
          deliveries: {
            view: {
              joint: 'knee',
              channels: ['left', 'right'],
              basis: 'filtered',
              interval: [0, 10],
            },
            report: false,
            export: null,
          },
        }),
      );
      spec.interval = { anchor: 'start', seconds: 5 };
      spec.comparison.second = { anchor: 'end', seconds: 5 };
      if (step < 3) spec.sources.push(structuredClone(spec.sources[0]));
      if (step > 1) {
        assert.equal(user(r).acceptedTask, null);
        const f = feedback(r, 'set_task_spec');
        assert.equal(f.rejection.attempts, step - 1);
        assert.equal(r.messages.filter((m) => m.toolName === 'set_task_spec').length, 1);
        assert.match(f.error.message, /SOURCE_DUPLICATE/);
        assert.deepEqual(f.scopeReview, {
          sampled: [0, 20],
          interval: [0, 5],
          second: [15, 20],
          view: [0, 10],
          coversSampled: false,
          coversComparison: false,
          unresolved: [],
        });
      }
      if (step === 3) {
        spec.sources = [{ field: 'task', origin: 'derived', sourceId: currentId(r) }];
        spec.deliveries.view.interval = 'comparison';
      }
      return {
        calls: [
          ...(step === 1 ? [{ name: 'get_session_info', arguments: {} }] : []),
          { name: 'set_task_spec', arguments: spec },
        ],
      };
    }
    if (step === 4)
      return {
        calls: ['compare_intervals', 'set_chart_view'].map((name) => ({
          name,
          arguments: { taskRef: user(r).bindings.taskRef },
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
  });
  const run = await h.runtime.run('比较 filtered 左右膝开头和结尾各五秒 ROM，展示两段图表');
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 2);
  assert.deepEqual(h.workspace.chart.interval, [0, 20]);
  assert.equal((run.calls[1]!.modelArguments as any).sources.length, 10);
  assert.equal(h.audits[0]!.run.calls.filter((c) => !c.output.ok).length, 2);
  // Changed arguments OR changed errors must remain separate feedback classes.
  const rejected = structuredClone(run.calls[1]!);
  rejected.id = 'different-error';
  if (!rejected.output.ok) rejected.output.error.message = 'different validation failure';
  const projected = compactModelFeedback({ ...run, calls: [...run.calls.slice(0, 3), rejected] });
  assert.equal(projected.filter((m) => m.toolName === 'set_task_spec').length, 2);
});

for (const [first, second] of [
  [
    [4, 6],
    [12, 14],
  ],
  [
    [12, 14],
    [4, 6],
  ],
] as const) {
  test(`v3.6 explicit comparison view is the declared envelope, not all sampled ${first}`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0) {
        const spec: any = wholeTask(
          r,
          taskFixture(user(r).goal, {
            goalTypes: ['comparison'],
            interval: [...first],
            comparison: { second: [...second], direction: 'second_minus_first' },
          }),
        );
        spec.deliveries.view = {
          joint: 'knee',
          channels: ['left', 'right'],
          basis: 'filtered',
          interval: 'comparison',
        };
        assert.deepEqual(user(r).rangeOptions.sampled, { selection: 'sampled', interval: [0, 20] });
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            { name: 'set_task_spec', arguments: spec },
          ],
        };
      }
      assert.deepEqual(user(r).acceptedTask.deliveries.view.interval, [4, 14]);
      assert.deepEqual(user(r).acceptedTask.interval, first);
      assert.deepEqual(user(r).acceptedTask.comparison.second, second);
      return call('finish_analysis', {
        outcome: 'failed',
        messageCode: 'execution_failed',
        citations: [],
      });
    });
    const run = await h.runtime.run('只展示这两段包络');
    assert.deepEqual(run.task!.spec.deliveries.view!.interval, [4, 14]);
  });
}

for (const attack of ['no_second', 'wrong_field', 'explicit_source', 'reversed'] as const) {
  test(`v3.6 comparison selector ${attack} is rejected without implicit statistical choices`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0) {
        const spec: any = wholeTask(
          r,
          taskFixture(user(r).goal, {
            comparison: { second: [15, 20], direction: 'second_minus_first' },
          }),
        );
        spec.deliveries.view = {
          joint: 'knee',
          channels: ['left', 'right'],
          basis: 'filtered',
          interval: 'comparison',
        };
        if (attack === 'no_second') spec.comparison = null;
        if (attack === 'wrong_field') spec.interval = 'comparison';
        if (attack === 'explicit_source') spec.sources[0].origin = 'explicit';
        if (attack === 'reversed') spec.comparison.second = [20, 15];
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            { name: 'set_task_spec', arguments: spec },
          ],
        };
      }
      assert.equal(user(r).acceptedTask, null);
      assert.equal(feedback(r, 'set_task_spec').ok, false);
      return call('finish_analysis', {
        outcome: 'failed',
        messageCode: 'execution_failed',
        citations: [],
      });
    });
    const run = await h.runtime.run('测试选择边界');
    assert.equal(run.task, undefined);
    assert.equal(run.calls.at(-1)!.output.ok, true);
  });
}

for (const removeFirst of [false, true]) {
  test(`v3.6 comparison view patch uses simultaneous changes and respects explicit null ${removeFirst}`, async () => {
    let signal: AbortSignal,
      turn = 0,
      step = 0;
    const h = harness(async (r) => {
      if (signal !== r.signal) {
        signal = r.signal;
        turn++;
        step = 0;
      }
      if (step++ === 0) {
        if (turn === 1)
          return start(
            r,
            taskFixture(user(r).goal, {
              goalTypes: ['comparison'],
              comparison: { second: [15, 20], direction: 'second_minus_first' },
              deliveries: {
                view: {
                  joint: 'knee',
                  channels: ['left', 'right'],
                  basis: 'filtered',
                  interval: [0, 20],
                },
                report: false,
                export: null,
              },
            }),
          );
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            {
              name: 'set_task_patch',
              arguments: {
                changes: [
                  {
                    field: 'deliveries.view.interval',
                    value: 'comparison',
                    origin: 'derived',
                    sourceId: currentId(r),
                  },
                  {
                    field: 'comparison.second',
                    value: [12, 17],
                    origin: 'derived',
                    sourceId: currentId(r),
                  },
                  ...(removeFirst
                    ? [
                        {
                          field: 'interval',
                          value: null,
                          origin: 'derived',
                          sourceId: currentId(r),
                        },
                      ]
                    : []),
                ],
              },
            },
          ],
        };
      }
      if (turn === 2) {
        if (removeFirst) {
          assert.equal(user(r).acceptedTask, null);
          assert.match(feedback(r, 'set_task_patch').error.message, /COMPARISON_SCOPE_REQUIRED/);
        } else {
          assert.deepEqual(user(r).acceptedTask.interval, [0, 5]);
          assert.deepEqual(user(r).acceptedTask.comparison.second, [12, 17]);
          assert.deepEqual(user(r).acceptedTask.deliveries.view.interval, [0, 17]);
        }
      }
      return call('finish_analysis', {
        outcome: 'failed',
        messageCode: 'execution_failed',
        citations: [],
      });
    });
    await h.runtime.run('比较 filtered 左右膝两段 ROM 并展示');
    const run = await h.runtime.run('后段改 12–17 秒，视图覆盖两段');
    assert.equal(run.calls.at(-1)!.output.ok, true);
    assert.equal(!!run.task, !removeFirst);
  });
}

for (const [offset, duration] of [
  [0, 5],
  [7, 3],
] as const) {
  test(`v3.5 explicit sampled anchors use frozen range at ${offset}, duration ${duration}`, async () => {
    const session = new AnalysisSession('demo', evaluationSession().info().parameters);
    for (let i = 0; i <= 400; i++) session.append(demoPose(i / 20), offset + i / 20);
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0) {
        const spec: any = wholeTask(
          r,
          taskFixture(user(r).goal, {
            goalTypes: ['comparison'],
            comparison: { second: [15, 20], direction: 'second_minus_first' },
            deliveries: {
              view: {
                joint: 'knee',
                channels: ['left', 'right'],
                basis: 'filtered',
                interval: [0, 20],
              },
              report: false,
              export: null,
            },
          }),
        );
        spec.interval = { anchor: 'start', seconds: duration };
        spec.comparison.second = { anchor: 'end', seconds: duration };
        spec.deliveries.view.interval = 'sampled';
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            { name: 'set_task_spec', arguments: spec },
          ],
        };
      }
      if (step === 2)
        return {
          calls: ['set_chart_view', 'compare_intervals'].map((name) => ({
            name,
            arguments: { taskRef: user(r).bindings.taskRef },
          })),
        };
      assert.deepEqual(user(r).acceptedTask.interval, [offset, offset + duration]);
      assert.deepEqual(user(r).acceptedTask.comparison.second, [
        offset + 20 - duration,
        offset + 20,
      ]);
      assert.deepEqual(user(r).completion.missing, ['comparison', 'view']);
      return call('finish_analysis', {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: [
          evidenceRef(feedback(r, 'compare_intervals'), '/differences/0/rom'),
          evidenceRef(feedback(r, 'set_chart_view'), '/view/basis'),
        ],
      });
    }, session);
    const run = await h.runtime.run('展示 filtered 左右膝采样开头和结尾的 ROM 比较');
    assert.equal(run.status, 'completed', run.message);
    assert.deepEqual(h.workspace.chart.interval, [offset, offset + 20]);
    assert.equal(
      run.calls.find((c) => c.name === 'set_task_spec')!.modelArguments &&
        (run.calls.find((c) => c.name === 'set_task_spec')!.modelArguments as any).comparison.second
          .anchor,
      'end',
    );
  });
}

for (const attack of ['too_long', 'explicit_source', 'unknown_anchor', 'narrow_view'] as const) {
  test(`v3.5 sampled interval ${attack} is rejected without clipping or source repair`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0) {
        const spec: any = wholeTask(r, taskFixture(user(r).goal));
        spec.interval = {
          anchor: attack === 'unknown_anchor' ? 'middle' : 'end',
          seconds: attack === 'too_long' ? 21 : 5,
        };
        if (attack === 'explicit_source') spec.sources[0].origin = 'explicit';
        if (attack === 'narrow_view') {
          spec.goalTypes = modelGoalTypes(['comparison']);
          spec.interval = { anchor: 'start', seconds: 5 };
          spec.comparison = {
            second: { anchor: 'end', seconds: 5 },
            direction: 'second_minus_first',
          };
          spec.deliveries.view = {
            joint: 'knee',
            channels: ['left', 'right'],
            basis: 'filtered',
            interval: [0, 5],
          };
        }
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            { name: 'set_task_spec', arguments: spec },
          ],
        };
      }
      assert.equal(user(r).acceptedTask, null);
      assert.match(
        feedback(r, 'set_task_spec').error.message,
        attack === 'too_long'
          ? /OUT_OF_RANGE/
          : attack === 'explicit_source'
            ? /SOURCE_REQUIRED/
            : attack === 'unknown_anchor'
              ? /invalid enum|no matching type/
              : /COMPARISON_VIEW_INTERVAL/,
      );
      return call('finish_analysis', {
        outcome: 'failed',
        messageCode: 'execution_failed',
        citations: [],
      });
    });
    const run = await h.runtime.run('测试显式区间边界');
    assert.equal(run.status, 'failed', run.message);
    assert.equal(run.calls.at(-1)!.output.ok, true);
    assert.equal(run.task, undefined);
    assert.ok(
      !run.calls.some((c) =>
        ['query_metrics', 'compare_intervals', 'set_chart_view'].includes(c.name),
      ),
    );
  });
}

test('v3.5 incomplete added statistics remain unlocked; model can choose quality without invented parameters', async () => {
  let step = 0;
  const h = harness(async (r) => {
    if (step++ < 2) {
      const spec: any = wholeTask(
        r,
        taskFixture(user(r).goal, {
          goalTypes: step === 1 ? ['quality', 'metrics'] : ['quality'],
          joint: null,
          channels: null,
          basis: null,
          metrics: step === 1 ? ['minAngle', 'maxAngle', 'angleVariance'] : [],
        }),
      );
      spec.interval = 'sampled';
      assert.deepEqual(user(r).rangeOptions.sampled, { selection: 'sampled', interval: [0, 20] });
      if (step === 2) {
        assert.match(feedback(r, 'set_task_spec').error.message, /TASK_SPEC_INCOMPLETE.*joint/);
        assert.equal(user(r).acceptedTask, null);
        assert.ok(r.tools.some((t) => t.name === 'set_task_spec'));
      }
      return {
        calls: [
          ...(step === 1 ? [{ name: 'get_session_info', arguments: {} }] : []),
          { name: 'set_task_spec', arguments: spec },
        ],
      };
    }
    if (step === 3) return call('get_quality_summary', { taskRef: user(r).bindings.taskRef });
    return finish(r, 'get_quality_summary', '/missingSamples');
  });
  const run = await h.runtime.run('查询全部采样质量、缺失及不可比较限制');
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.task!.spec.goalTypes, ['quality']);
  assert.deepEqual(run.task!.spec.interval, [0, 20]);
  assert.deepEqual(run.task!.spec.metrics, []);
});

test('v3.5 truly missing declared fields still allow clarification without defaults', async () => {
  let step = 0;
  const h = harness(async (r) => {
    if (step++ === 0)
      return start(r, taskFixture(user(r).goal, { basis: null, unresolved: ['basis'] }));
    assert.equal(user(r).acceptedTask.basis, null);
    return call('finish_analysis', {
      outcome: 'needs_input',
      messageCode: 'specify_parameters',
      citations: [],
    });
  });
  const run = await h.runtime.run('查询左右膝 0–5 秒 ROM，尚未选择口径');
  assert.equal(run.status, 'needs_input');
  assert.deepEqual(run.task!.spec.unresolved, ['basis']);
});

test('v3.8 repeated irrelevant unresolved rejection permits an explicit quality redeclaration and finish', async () => {
  let step = 0;
  const h = harness(async (r) => {
    step++;
    if (step <= 3) {
      if (step > 1) {
        const rejected = feedback(r, 'set_task_spec');
        assert.match(rejected.error.message, /TASK_SPEC_UNRESOLVED_CONFLICT.*comparison.second/);
        assert.equal(rejected.rejection.attempts, step - 1);
        assert.equal(rejected.rejection.callIds.length, step - 1);
        assert.equal(user(r).acceptedTask, null);
        assert.deepEqual(rejected.scopeReview.unresolved, ['comparison.second']);
      }
      const spec: any = wholeTask(
        r,
        taskFixture(user(r).goal, {
          goalTypes: ['quality'],
          joint: null,
          channels: null,
          basis: null,
          comparison: null,
          metrics: step < 3 ? ['coverage'] : [],
          unresolved: step < 3 ? ['comparison.second'] : [],
        }),
      );
      spec.interval = 'sampled';
      return {
        calls: [
          ...(step === 1 ? [{ name: 'get_session_info', arguments: {} }] : []),
          { name: 'set_task_spec', arguments: spec },
        ],
      };
    }
    if (step === 4) return call('get_quality_summary', { taskRef: user(r).bindings.taskRef });
    assert.deepEqual(user(r).acceptedTask.unresolved, []);
    return call('finish_analysis', {
      outcome: 'completed',
      messageCode: 'evidence_ready',
      citations: user(r)
        .availableEvidence.find((e: any) => e.tool === 'get_quality_summary')
        .entries.map((e: any) => ({ evidenceId: e.evidenceId })),
    });
  });
  const run = await h.runtime.run('查询全部已采样质量、缺失与不可比较限制');
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 2);
  assert.equal(h.audits[0]!.run.calls.filter((c) => !c.output.ok).length, 2);
  assert.deepEqual((run.calls[1]!.modelArguments as any).unresolved, ['comparison.second']);
  assert.deepEqual(run.task!.spec.interval, [0, 20]);
  assert.equal(run.citations.length, 6);
  assert.ok(
    !run.calls.some((c) =>
      ['prepare_report', 'prepare_export', 'compare_intervals'].includes(c.name),
    ),
  );
});

for (const question of ['comparison.second', '口径尚未确定，需用户选择']) {
  test(`v3.8 real structured or free text missing requirement remains explicit: ${question}`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0)
        return start(
          r,
          taskFixture(user(r).goal, {
            goalTypes: ['quality', 'comparison'],
            comparison:
              question === 'comparison.second'
                ? null
                : { second: [15, 20], direction: 'second_minus_first' },
            basis: question === 'comparison.second' ? 'filtered' : null,
            unresolved: question === 'comparison.second' ? [question] : ['basis', question],
          }),
        );
      return call('finish_analysis', {
        outcome: 'needs_input',
        messageCode: 'specify_parameters',
        citations: [],
      });
    });
    const run = await h.runtime.run('查询质量并比较两段左右膝 ROM，参数需要确认');
    assert.equal(run.status, 'needs_input', run.message);
    assert.ok(run.task!.spec.unresolved.includes(question));
    assert.ok(run.calls.every((c) => c.output.ok));
  });
}

test('v3.8 patch does not erase inherited unresolved when the model removes its analysis requirement', async () => {
  let signal: AbortSignal,
    turn = 0,
    step = 0;
  const h = harness(async (r) => {
    if (signal !== r.signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    step++;
    if (turn === 1) {
      if (step === 1)
        return start(r, taskFixture(user(r).goal, { basis: null, unresolved: ['basis'] }));
      return call('finish_analysis', {
        outcome: 'needs_input',
        messageCode: 'specify_parameters',
        citations: [],
      });
    }
    if (step === 1)
      return call('set_task_patch', {
        changes: [
          ['goalTypes', modelGoalTypes(['quality'])],
          ['joint', null],
          ['channels', null],
          ['metrics', []],
        ].map(([field, value]) => ({ field, value, origin: 'explicit', sourceId: currentId(r) })),
      });
    if (step === 2) {
      assert.equal(user(r).acceptedTask, null);
      assert.match(
        feedback(r, 'set_task_patch').error.message,
        /TASK_SPEC_UNRESOLVED_CONFLICT.*basis/,
      );
      const spec: any = wholeTask(
        r,
        taskFixture(user(r).goal, {
          goalTypes: ['quality'],
          joint: null,
          channels: null,
          basis: null,
          metrics: [],
          unresolved: [],
        }),
      );
      spec.interval = 'sampled';
      return call('set_task_spec', spec);
    }
    if (step === 3)
      return {
        calls: [
          { name: 'get_session_info', arguments: {} },
          { name: 'get_quality_summary', arguments: { taskRef: user(r).bindings.taskRef } },
        ],
      };
    return finish(r, 'get_quality_summary', '/missingSamples');
  });
  await h.runtime.run('查询左右膝 ROM，尚未选择口径');
  const run = await h.runtime.run('改成仅查询全部采样质量，不做关节统计');
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 1);
  assert.deepEqual(run.task!.spec.unresolved, []);
});

test('v3.7 contradictory quality comparison stays unlocked despite unresolved and repeated rejection', async () => {
  let step = 0;
  const h = harness(async (r) => {
    step++;
    if (step <= 3) {
      if (step > 1) {
        assert.equal(user(r).acceptedTask, null);
        const rejected = feedback(r, 'set_task_spec');
        assert.match(rejected.error.message, /TASK_SPEC_ANALYSIS_CONFLICT/);
        assert.equal(rejected.rejection.attempts, step - 1);
        assert.deepEqual(rejected.scopeReview.unresolved, [
          'joint',
          'channels',
          'basis',
          'metrics',
        ]);
        assert.ok(!r.tools.some((t) => t.name === 'compare_intervals'));
      }
      const spec: any = wholeTask(
        r,
        taskFixture(user(r).goal, {
          goalTypes: ['quality'],
          joint: null,
          channels: null,
          basis: null,
          metrics: [],
          comparison: step < 3 ? { second: [15, 20], direction: 'second_minus_first' } : null,
          unresolved: step < 3 ? ['joint', 'channels', 'basis', 'metrics'] : [],
        }),
      );
      spec.interval = 'sampled';
      return {
        calls: [
          ...(step === 1 ? [{ name: 'get_session_info', arguments: {} }] : []),
          { name: 'set_task_spec', arguments: spec },
        ],
      };
    }
    if (step === 4) {
      assert.deepEqual(user(r).acceptedTask.interval, [0, 20]);
      assert.equal(user(r).acceptedTask.comparison, null);
      return call('get_quality_summary', { taskRef: user(r).bindings.taskRef });
    }
    return finish(r, 'get_quality_summary', '/missingSamples');
  });
  const run = await h.runtime.run('查询全部已采样的质量、缺失与限制');
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 2);
  assert.equal(h.audits[0]!.run.calls.filter((c) => !c.output.ok).length, 2);
  const quality = run.calls.find((c) => c.name === 'get_quality_summary')!.output;
  assert.ok(quality.ok);
  assert.equal((quality.result as any).evidence.sampleCount, 401);
  assert.deepEqual(run.task!.spec.unresolved, []);
  assert.equal(run.citations.length, 1);
  assert.ok(!run.calls.some((c) => ['compare_intervals', 'prepare_export'].includes(c.name)));
});

for (const report of [false, true]) {
  test(`v3.7 explicit mixed comparison or comparison report retains both intervals: report=${report}`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0)
        return start(
          r,
          taskFixture(user(r).goal, {
            goalTypes: report ? ['quality'] : ['quality', 'comparison'],
            comparison: { second: [15, 20], direction: 'second_minus_first' },
            deliveries: { view: null, report, export: null },
          }),
        );
      assert.deepEqual(user(r).acceptedTask.interval, [0, 5]);
      assert.deepEqual(user(r).acceptedTask.comparison.second, [15, 20]);
      assert.equal(user(r).acceptedTask.deliveries.report, report);
      return call('finish_analysis', {
        outcome: 'failed',
        messageCode: 'execution_failed',
        citations: [],
      });
    });
    const run = await h.runtime.run(
      report ? '查询质量并准备两段比较报告' : '查询质量并比较两段 ROM',
    );
    assert.ok(run.task);
    assert.ok(run.calls.every((c) => c.output.ok));
  });
}

test('v3.7 comparison analysis with genuinely missing basis remains eligible for clarification', async () => {
  let step = 0;
  const h = harness(async (r) => {
    if (step++ === 0)
      return start(
        r,
        taskFixture(user(r).goal, {
          goalTypes: ['quality', 'comparison'],
          comparison: { second: [15, 20], direction: 'second_minus_first' },
          basis: null,
          unresolved: ['basis'],
        }),
      );
    assert.equal(user(r).acceptedTask.basis, null);
    return call('finish_analysis', {
      outcome: 'needs_input',
      messageCode: 'specify_parameters',
      citations: [],
    });
  });
  const run = await h.runtime.run('查询质量并比较两段左右膝 ROM，尚未选择口径');
  assert.equal(run.status, 'needs_input');
  assert.deepEqual(run.task!.spec.goalTypes, ['comparison', 'quality']);
  assert.deepEqual(run.task!.spec.unresolved, ['basis']);
});

test('v3.7 patch cannot leave an undeclared comparison after removing its report', async () => {
  let signal: AbortSignal,
    turn = 0,
    step = 0;
  const h = harness(async (r) => {
    if (signal !== r.signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    step++;
    if (turn === 1) {
      if (step === 1)
        return start(
          r,
          taskFixture(user(r).goal, {
            goalTypes: ['quality'],
            comparison: { second: [15, 20], direction: 'second_minus_first' },
            deliveries: { view: null, report: true, export: null },
          }),
        );
      return call('finish_analysis', {
        outcome: 'failed',
        messageCode: 'execution_failed',
        citations: [],
      });
    }
    if (step <= 2) {
      if (step === 2) {
        assert.equal(user(r).acceptedTask, null);
        assert.match(feedback(r, 'set_task_patch').error.message, /TASK_SPEC_ANALYSIS_CONFLICT/);
      }
      return call('set_task_patch', {
        changes: [
          { field: 'deliveries.report', value: false, origin: 'explicit', sourceId: currentId(r) },
          ...(step === 2
            ? [{ field: 'comparison', value: null, origin: 'explicit', sourceId: currentId(r) }]
            : []),
        ],
      });
    }
    assert.equal(user(r).acceptedTask.comparison, null);
    if (step === 3) return call('get_session_info', {});
    return call('finish_analysis', {
      outcome: 'failed',
      messageCode: 'execution_failed',
      citations: [],
    });
  });
  await h.runtime.run('查询质量并准备前后两段比较报告');
  const run = await h.runtime.run('取消报告和两段比较，保留质量');
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 1);
  assert.equal(run.task!.spec.comparison, null);
  assert.equal(run.task!.spec.deliveries.report, false);
  assert.deepEqual(run.task!.spec.goalTypes, ['quality']);
});

test('v3.5 alternating inspected pages stay visible and missing session remains explicit', async () => {
  let step = 0,
    compareId: string;
  const h = harness(async (r) => {
    if (step++ === 0)
      return call(
        'set_task_spec',
        wholeTask(
          r,
          taskFixture(user(r).goal, {
            goalTypes: ['comparison'],
            comparison: { second: [15, 20], direction: 'second_minus_first' },
          }),
        ),
      );
    if (step === 2) return call('compare_intervals', { taskRef: user(r).bindings.taskRef });
    compareId = feedback(r, 'compare_intervals').callId;
    if (step <= 5) {
      if (step === 5) {
        assert.deepEqual(
          user(r).inspectedPages.map((p: any) => p.path),
          ['/first/evidence', '/second/evidence'],
        );
        assert.deepEqual(user(r).prerequisites.finish_analysis, ['get_session_info']);
      }
      return call('inspect_result', {
        callId: compareId,
        path: step === 4 ? '/second/evidence' : '/first/evidence',
        start: 0,
        limit: 1,
      });
    }
    assert.equal(user(r).inspectedPages.length, 2);
    assert.deepEqual(user(r).completion.missing, ['comparison']);
    if (step === 6) {
      assert.equal(feedback(r, 'inspect_result').result.duplicate, true);
      return call('get_session_info', {});
    }
    return finish(r, 'compare_intervals', '/differences/0/rom');
  });
  const run = await h.runtime.run('比较 filtered 左右膝两段 ROM');
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.citations.length, 1);
});

test('v3.5 mixed quality and metrics explicitly requested remain separate goals and citations', async () => {
  let step = 0;
  const h = harness(async (r) => {
    if (step++ === 0)
      return start(r, taskFixture(user(r).goal, { goalTypes: ['quality', 'metrics'] }));
    if (step === 2)
      return {
        calls: ['get_quality_summary', 'query_metrics'].map((name) => ({
          name,
          arguments: { taskRef: user(r).bindings.taskRef },
        })),
      };
    return call('finish_analysis', {
      outcome: 'completed',
      messageCode: 'evidence_ready',
      citations: [
        evidenceRef(feedback(r, 'get_quality_summary'), '/missingSamples'),
        evidenceRef(feedback(r, 'query_metrics'), '/channels/0/rom'),
      ],
    });
  });
  const run = await h.runtime.run('查询 0–5 秒质量和 filtered 左右膝 ROM');
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.task!.spec.goalTypes, ['metrics', 'quality']);
});

test('v3.5 relative patch resolves only model-selected changed fields and retains absolute intent', async () => {
  let signal: AbortSignal,
    turn = 0,
    step = 0;
  const h = harness(async (r) => {
    if (signal !== r.signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    if (step++ === 0) {
      if (turn === 1) return start(r);
      return {
        calls: [
          { name: 'get_session_info', arguments: {} },
          {
            name: 'set_task_patch',
            arguments: {
              changes: [
                {
                  field: 'interval',
                  value: { anchor: 'end', seconds: 3 },
                  origin: 'derived',
                  sourceId: currentId(r),
                },
              ],
            },
          },
        ],
      };
    }
    if (step === 2) return call('query_metrics', { taskRef: user(r).bindings.taskRef });
    return finish(r);
  });
  assert.equal((await h.runtime.run('查询 filtered 左右膝 0–5 秒 ROM')).status, 'completed');
  const run = await h.runtime.run('区间改成全部采样最后三秒');
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.task!.spec.interval, [17, 20]);
  assert.deepEqual(run.task!.spec.channels, ['left', 'right']);
  assert.equal(run.task!.spec.basis, 'filtered');
  assert.equal(run.task!.spec.sources.find((s) => s.field === 'interval')!.origin, 'derived');
});

for (const name of [
  'seek_to_time',
  'set_chart_view',
  'prepare_report',
  'prepare_export',
] as const) {
  test(`v3.4 independent ${name} has one explicit declaration and requires delivery evidence`, async () => {
    const args = {
      seek_to_time: { time: 12 },
      set_chart_view: { joint: 'knee', channels: ['right'], basis: 'filtered', interval: [0, 5] },
      prepare_report: {
        joint: 'knee',
        channels: ['right'],
        basis: 'filtered',
        interval: [0, 5],
        comparison: null,
      },
      prepare_export: { interval: [0, 5], format: 'csv' },
    }[name];
    const path = {
      seek_to_time: '/appliedTime',
      set_chart_view: '/view/basis',
      prepare_report: '/handle',
      prepare_export: '/handle',
    }[name];
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0) return start(r, taskForActions(user(r).goal, [{ name, args }]));
      assert.deepEqual(user(r).acceptedTask.goalTypes, modelGoalTypes([]));
      if (step === 2)
        return call('finish_analysis', {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          citations: [],
        });
      if (step === 3) {
        assert.match(feedback(r, 'finish_analysis').error.message, /EVIDENCE_REQUIRED/);
        return call(name, { taskRef: user(r).bindings.taskRef });
      }
      return finish(r, name, path);
    });
    const run = await h.runtime.run(`仅执行 ${name}`);
    assert.equal(run.status, 'completed', run.message);
    assert.deepEqual(run.task!.spec.goalTypes, []);
    assert.equal(run.completion!.state, 'ready');
  });
}

test('v3.4 quality cannot declare phantom seek in first spec', async () => {
  let step = 0;
  const h = harness(async (r) => {
    if (step++ === 0) {
      const spec: any = specCall(r);
      spec.goalTypes = { ...modelGoalTypes(['quality']), seek: true };
      return call('set_task_spec', spec);
    }
    assert.match(feedback(r, 'set_task_spec').error.message, /goalTypes.seek.*unknown field/);
    assert.equal(user(r).acceptedTask, null);
    return call('get_session_info', {});
  });
  const run = await h.runtime.run('查询质量');
  assert.equal(run.task, undefined);
  assert.ok(!run.calls.some((c) => c.name === 'seek_to_time'));
});

for (const [joint, first, second, goal] of [
  ['knee', [0, 5], [15, 20], '比较 filtered 左右膝最初五秒和最后五秒 ROM，展示两段'],
  [
    'elbow',
    [2, 7],
    [12, 17],
    '我想看看左右肘在 2 到 7 秒以及 12 到 17 秒 filtered 活动范围差多少，并显示曲线',
  ],
  ['hip', [1, 5], [10, 14], '用 filtered 对照左右髋 1–5 和 10–14 秒 ROM，画出来'],
  ['wrist', [3, 6], [9, 12], '展示 filtered 双腕 3–6 / 9–12 秒 ROM 对比'],
] as const) {
  test(`v3 controlled choice: ${joint}, distinct intervals and paraphrase retain independent evidence/view checks`, async () => {
    let step = 0;
    const actions = [
      {
        name: 'compare_intervals',
        args: { joint, channels: ['left', 'right'], basis: 'filtered', first, second },
      },
      {
        name: 'set_chart_view',
        args: {
          joint,
          channels: ['left', 'right'],
          basis: 'filtered',
          interval: [first[0], second[1]],
        },
      },
    ];
    const h = harness(async (r) => {
      if (step++ === 0) {
        assert.ok(!r.tools.some((t) => t.name === 'compare_intervals'));
        return start(r, taskForActions(goal, actions));
      }
      if (step === 2) {
        assert.ok(!r.tools.some((t) => t.name === 'set_task_spec'));
        for (const name of ['compare_intervals', 'set_chart_view']) {
          const schema = r.tools.find((t) => t.name === name)!.inputSchema;
          assert.deepEqual(schema.required, ['taskRef']);
          assert.deepEqual(Object.keys(schema.properties!), ['taskRef']);
          assert.deepEqual(schema.properties!.taskRef.enum, [user(r).bindings.taskRef]);
          assert.equal(schema.additionalProperties, false);
        }
        // Reverse tool order is a model/provider decision, not a runtime plan.
        return {
          calls: [...actions]
            .reverse()
            .map((a) => ({ name: a.name, arguments: { taskRef: user(r).bindings.taskRef } })),
        };
      }
      return call('finish_analysis', {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: [
          evidenceRef(feedback(r, actions[0]!.name), '/differences/0/rom'),
          evidenceRef(feedback(r, actions[1]!.name), '/view/basis'),
        ],
      });
    });
    const run = await h.runtime.run(goal);
    assert.equal(run.status, 'completed', run.message);
    assert.deepEqual(h.workspace.chart, actions[1]!.args);
    assert.equal(run.modelProtocolVersion, MODEL_PROTOCOL_VERSION);
    assert.match(run.protocolFingerprint!, /^[a-f0-9]{64}$/);
    assert.equal(run.timing!.application, 'ready');
    assert.equal(run.timing!.audit, 'saved');
    assert.ok(run.calls.every((c) => c.modelArguments !== undefined));
    assert.ok(run.task!.spec.sources.every((s) => s.text === goal && s.fromRunId === null));
    assert.equal(
      run.calls.find((c) => c.name === 'compare_intervals')!.arguments &&
        (run.calls.find((c) => c.name === 'compare_intervals')!.arguments as any).sessionId,
      run.reference.sessionId,
    );
    for (const [i, request] of h.audits[0]!.requests.entries()) {
      assert.deepEqual(
        request.tools!.map((t) => t.name),
        run.requests![i]!.offeredTools,
      );
      assert.equal(
        createHash('sha256').update(JSON.stringify(request.tools)).digest('hex'),
        run.requests![i]!.toolFingerprint,
      );
    }
    const c = run.calls.find((c) => c.name === 'compare_intervals')!;
    assert.ok(c.output.ok && (c.output.result as any).first.evidence.parameters);
  });
}

for (const failure of ['none', 'after_spec', 'before_spec'] as const) {
  test(`v3 ${failure}: partial modification and mixed sources retain fields and fresh references`, async () => {
    let turn = 0,
      step = 0;
    let signal: AbortSignal;
    const initial = '查询 filtered 左右膝 0–5 秒 ROM';
    const h = harness(async (r) => {
      if (r.signal !== signal) {
        signal = r.signal;
        turn++;
        step = 0;
      }
      if (turn === 1 && (failure === 'before_spec' || (failure === 'after_spec' && step > 0)))
        throw new Error('controlled failure');
      if (step++ === 0) {
        if (turn === 1) return start(r);
        if (failure === 'before_spec') {
          const spec: any = specCall(r, taskFixture(initial, { channels: ['right'] }));
          const pending = user(r).userSources.find((s: any) => s.kind === 'pending');
          assert.equal(pending.text, initial);
          spec.sources = spec.sources.map((s: any) =>
            s.field === 'channels' ? s : { ...s, origin: 'inherited', sourceId: pending.sourceId },
          );
          return {
            calls: [
              { name: 'get_session_info', arguments: {} },
              { name: 'set_task_spec', arguments: spec },
            ],
          };
        }
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            {
              name: 'set_task_patch',
              arguments: {
                changes: [
                  {
                    field: 'channels',
                    value: ['right'],
                    origin: 'explicit',
                    sourceId: currentId(r),
                  },
                ],
              },
            },
          ],
        };
      }
      if (step === 2) return call('query_metrics', { taskRef: user(r).bindings.taskRef });
      return finish(r);
    });
    const first = await h.runtime.run(initial);
    assert.equal(first.status, failure === 'none' ? 'completed' : 'failed');
    const second = await h.runtime.run('仅改成右侧，其余照旧');
    assert.equal(second.status, 'completed', JSON.stringify(second.calls));
    assert.deepEqual(second.task!.spec.channels, ['right']);
    assert.deepEqual(second.task!.spec.interval, [0, 5]);
    assert.equal(second.task!.spec.sources.find((s) => s.field === 'joint')!.fromRunId, first.id);
    assert.equal(second.task!.spec.sources.find((s) => s.field === 'channels')!.text, second.goal);
    assert.ok(second.citations.every((c) => c.callId.startsWith(second.id.slice(0, 8))));
  });
}

test('v3 pending modification over an accepted task is recovered through its local source ID', async () => {
  let turn = 0,
    step = 0;
  let signal: AbortSignal;
  const h = harness(async (r) => {
    if (r.signal !== signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    if (turn === 2) throw new Error('offline before patch');
    if (step++ === 0) {
      if (turn === 1) return start(r);
      const pending = user(r).userSources.find((s: any) => s.kind === 'pending');
      return {
        calls: [
          { name: 'get_session_info', arguments: {} },
          {
            name: 'set_task_patch',
            arguments: {
              changes: [
                {
                  field: 'channels',
                  value: ['right'],
                  origin: 'explicit',
                  sourceId: pending.sourceId,
                },
              ],
            },
          },
        ],
      };
    }
    return step === 2 ? call('query_metrics', { taskRef: user(r).bindings.taskRef }) : finish(r);
  });
  await h.runtime.run('查 filtered 左右膝 0–5 秒 ROM');
  const failed = await h.runtime.run('改成右侧');
  const recovered = await h.runtime.run('重试刚才的修改');
  assert.equal(recovered.status, 'completed', JSON.stringify(recovered.calls));
  assert.equal(
    recovered.task!.spec.sources.find((s) => s.field === 'channels')!.fromRunId,
    failed.id,
  );
});

for (const attack of ['fake_id', 'metadata', 'wrong_origin', 'old_text', 'wrong_field'] as const) {
  test(`v3 rejects user provenance attack: ${attack}`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0) {
        const spec: any = specCall(r);
        if (attack === 'fake_id') spec.sources[0].sourceId = 'forged';
        if (attack === 'metadata') spec.sources[0].sourceId = user(r).currentSession.sessionId;
        if (attack === 'wrong_origin') spec.sources[0].origin = 'inherited';
        if (attack === 'old_text')
          spec.sources[0] = {
            field: 'joint',
            origin: 'explicit',
            text: user(r).goal,
            fromRunId: null,
          };
        if (attack === 'wrong_field') spec.sources[0].field = 'sessionId';
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            { name: 'set_task_spec', arguments: spec },
          ],
        };
      }
      assert.equal(feedback(r, 'set_task_spec').ok, false);
      return call('finish_analysis', {
        outcome: 'needs_input',
        messageCode: 'specify_parameters',
        citations: [],
      });
    });
    const run = await h.runtime.run('查 filtered 左右膝 0–5 秒 ROM');
    assert.equal(run.task, undefined);
    assert.equal(run.status, 'needs_input');
  });
}

for (const key of ['sessionId', 'revision', 'channels', 'first', 'taskRef'] as const) {
  test(`v3 conflicting or forged ${key} is rejected and original parameters are never overwritten`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0)
        return start(
          r,
          taskFixture(user(r).goal, {
            goalTypes: ['comparison'],
            comparison: { second: [15, 20], direction: 'second_minus_first' },
          }),
        );
      if (step === 2)
        return call('compare_intervals', {
          taskRef: user(r).bindings.taskRef,
          [key]: {
            sessionId: 'wrong',
            revision: 0,
            channels: ['right'],
            first: [1, 4],
            taskRef: 'forged',
          }[key],
        });
      if (step === 3) {
        assert.equal(feedback(r, 'compare_intervals').ok, false);
        return call('compare_intervals', { taskRef: user(r).bindings.taskRef });
      }
      return finish(r, 'compare_intervals', '/differences/0/rom');
    });
    const run = await h.runtime.run('对比 filtered 左右膝前后五秒 ROM');
    assert.equal(run.status, 'completed', run.message);
    assert.equal(run.calls.filter((c) => c.name === 'compare_intervals' && c.output.ok).length, 1);
    assert.ok(run.calls.find((c) => c.name === 'compare_intervals' && !c.output.ok));
  });
}

test('v3 omitted metadata and catalog can be queried and paginated from full audit facts', async () => {
  let step = 0,
    queryId: string;
  const h = harness(async (r) => {
    if (step++ === 0) return start(r);
    if (step === 2) return call('query_metrics', { taskRef: user(r).bindings.taskRef });
    if (step === 3) {
      const data = feedback(r, 'query_metrics');
      queryId = data.callId;
      assert.ok(data.result.evidence.omitted.includes('parameters'));
      assert.ok(data.result.units.angle === 'deg' && data.result.evidence.sampleCount > 0);
      assert.ok(
        data.evidenceCatalog.entries.length < 10 && data.evidenceCatalog.omittedEntries > 0,
      );
      return call('inspect_result', {
        callId: queryId,
        path: '/evidence/parameters',
        start: 0,
        limit: 8,
      });
    }
    if (step === 4) {
      assert.equal(feedback(r, 'inspect_result').result.value.metricVersion, '2.0');
      return call('inspect_result', {
        callId: queryId,
        path: '/evidenceCatalog',
        start: 0,
        limit: 2,
      });
    }
    assert.equal(feedback(r, 'inspect_result').result.items.length, 2);
    assert.ok(feedback(r, 'inspect_result').result.omittedItems > 0);
    return finish(r);
  });
  const run = await h.runtime.run('查 filtered 左右膝 0–5 秒 ROM');
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.calls.filter((c) => c.name === 'inspect_result' && c.output.ok).length, 2);
  const query = run.calls.find((c) => c.name === 'query_metrics')!;
  assert.deepEqual(query.output, h.registry.execute('query_metrics', query.arguments));
  assert.equal(
    run.citations[0]!.value,
    query.output.ok && (query.output.result as any).channels[0].rom,
  );
});

test('v3 tools are constrained by frozen request state; no-data exposes only useful controls', async () => {
  let step = 0;
  const h = harness(
    async (r) => {
      if (step++ === 0) {
        assert.deepEqual(
          r.tools.map((t) => t.name),
          ['get_session_info', 'plan_analysis'],
        );
        return call('query_metrics', {});
      }
      if (step === 2) {
        assert.match(feedback(r, 'query_metrics').error.message, /TOOL_NOT_OFFERED/);
        return call('get_session_info', {});
      }
      return call('finish_analysis', {
        outcome: 'needs_input',
        messageCode: 'no_samples',
        citations: [],
      });
    },
    new AnalysisSession('demo', evaluationSession().info().parameters),
  );
  const run = await h.runtime.run('查询数据');
  assert.equal(run.status, 'needs_input');
  assert.equal(run.calls[0]!.output.ok, false);
});

test('v3 a forged citation cannot complete; valid final view and actual artifact availability still gate delivery', async () => {
  let step = 0;
  const goal = '展示右膝 raw 0–5 秒并准备 CSV';
  const actions = [
    {
      name: 'set_chart_view',
      args: { joint: 'knee', channels: ['right'], basis: 'raw', interval: [0, 5] },
    },
    { name: 'prepare_export', args: { interval: [0, 5], format: 'csv' } },
  ];
  const h = harness(async (r) => {
    if (step++ === 0) return start(r, taskForActions(goal, actions));
    if (step === 2)
      return {
        calls: actions.map((a) => ({
          name: a.name,
          arguments: { taskRef: user(r).bindings.taskRef },
        })),
      };
    if (step === 3)
      return call('finish_analysis', {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: [{ evidenceId: 'forged' }],
      });
    if (step === 4) {
      assert.match(feedback(r, 'finish_analysis').error.message, /INVALID_EVIDENCE_ID/);
      h.workspace.chart = { ...h.workspace.chart, basis: 'filtered' };
      return call('finish_analysis', {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: actions.map((a, i) =>
          evidenceRef(feedback(r, a.name), i ? '/handle' : '/view/basis'),
        ),
      });
    }
    assert.match(feedback(r, 'finish_analysis').error.message, /EVIDENCE_REQUIRED/);
    return call('finish_analysis', {
      outcome: 'partial',
      messageCode: 'partial_delivery',
      citations: [evidenceRef(feedback(r, 'prepare_export'), '/handle')],
    });
  });
  const run = await h.runtime.run(goal);
  assert.equal(run.status, 'partial', run.message);
  assert.ok(run.completion!.missing.includes('view'));
  const exported = run.calls.find((c) => c.name === 'prepare_export')!;
  assert.ok(exported.output.ok && h.registry.getArtifact((exported.output.result as any).handle));
});

test('v3 late response, source IDs and task references cannot rebind after revision or clear', async () => {
  let ready!: () => void, resolve!: (reply: ModelReply) => void;
  const pending = new Promise<void>((r) => {
    ready = r;
  });
  let captured: Request;
  const h = harness(async (r) => {
    captured = r;
    ready();
    return new Promise<ModelReply>((done) => {
      resolve = done;
    });
  });
  const work = h.runtime.run('查 filtered 左右膝 0–5 秒 ROM');
  await pending;
  h.session.recalculate({ ...h.session.info().parameters, window: 3 });
  h.runtime.clear();
  resolve(start(captured!));
  const run = await work;
  assert.equal(run.status, 'stale');
  assert.equal(run.calls.length, 0);
  await delay(5);
  assert.equal(h.runtime.taskContext.previousTask, null);
  const adapter = new ModelProtocolAdapter(run.id, run.reference, run.goal);
  assert.throws(
    () =>
      adapter.expand(
        { name: 'get_session_info', arguments: {} },
        { ...run, reference: h.session.info() },
        [],
      ),
    /STALE_PROTOCOL_BINDING/,
  );
});

test('v3 accepted old intent and stale pending intent are not offered as new-source user provenance', async () => {
  let turn = 0,
    step = 0;
  let signal: AbortSignal;
  const h = harness(async (r) => {
    if (signal !== r.signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    if (turn === 2) {
      assert.equal(user(r).context.referenceChanged, true);
      assert.ok(!r.tools.some((t) => t.name === 'set_task_patch'));
      assert.ok(user(r).userSources.every((s: any) => s.kind === 'current'));
      return call('get_session_info', {});
    }
    if (step++ === 0) return start(r);
    return step === 2 ? call('query_metrics', { taskRef: user(r).bindings.taskRef }) : finish(r);
  });
  const first = await h.runtime.run('查 filtered 左右膝 0–5 秒 ROM');
  assert.equal(first.status, 'completed');
  h.session.recalculate({ ...h.session.info().parameters, window: 3 });
  const second = await h.runtime.run('继续刚才的');
  assert.equal(second.task, undefined);
  assert.equal(second.status, 'limit');
});

test('v3 provenance keeps local retention/deletion protection; task ID alone never changes intent', async () => {
  let turn = 0,
    step = 0;
  let signal: AbortSignal;
  const h = harness(async (r) => {
    if (signal !== r.signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    if (step++ === 0) {
      if (turn === 1) return start(r);
      const spec: any = specCall(r, taskFixture(user(r).goal, { metrics: [], goalTypes: [] }));
      spec.sources = spec.sources.filter(
        (s: any) => s.field !== 'metrics' && s.field !== 'goalTypes',
      );
      return {
        calls: [
          { name: 'get_session_info', arguments: {} },
          { name: 'set_task_spec', arguments: spec },
        ],
      };
    }
    if (turn === 2) {
      assert.match(feedback(r, 'set_task_spec').error.message, /TASK_CHANGE_SOURCE_REQUIRED/);
      return call('finish_analysis', {
        outcome: 'needs_input',
        messageCode: 'specify_parameters',
        citations: [],
      });
    }
    return step === 2 ? call('query_metrics', { taskRef: user(r).bindings.taskRef }) : finish(r);
  });
  await h.runtime.run('查 filtered 左右膝 0–5 秒 ROM');
  const second = await h.runtime.run('只改右侧');
  assert.equal(second.task, undefined);
  assert.equal(second.status, 'needs_input');
});

for (const reuse of ['source', 'task', 'citation'] as const) {
  test(`v3 actual previous-turn ${reuse} ID is refused even on the same session`, async () => {
    let turn = 0,
      step = 0;
    let signal: AbortSignal;
    let oldSource: string, oldTask: string, oldCitation: string;
    const h = harness(async (r) => {
      if (signal !== r.signal) {
        signal = r.signal;
        turn++;
        step = 0;
      }
      if (step++ === 0) {
        if (turn === 1) {
          oldSource = currentId(r);
          return start(r);
        }
        const spec: any = specCall(r);
        if (reuse === 'source') spec.sources[0].sourceId = oldSource;
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            { name: 'set_task_spec', arguments: spec },
          ],
        };
      }
      if (turn === 2 && reuse === 'source') {
        assert.match(
          feedback(r, 'set_task_spec').error.message,
          /SCHEMA \$\.sources\[0\]\.sourceId: invalid enum/,
        );
        assert.ok(
          !r.tools
            .find((t) => t.name === 'set_task_spec')!
            .inputSchema.properties!.sources.items!.properties!.sourceId.enum!.includes(oldSource),
        );
        return call('finish_analysis', {
          outcome: 'needs_input',
          messageCode: 'specify_parameters',
          citations: [],
        });
      }
      if (step === 2) {
        if (turn === 1) oldTask = user(r).bindings.taskRef;
        return call('query_metrics', {
          taskRef: turn === 2 && reuse === 'task' ? oldTask : user(r).bindings.taskRef,
        });
      }
      if (turn === 1) {
        oldCitation = evidenceRef(feedback(r, 'query_metrics'), '/channels/0/rom').evidenceId;
        return finish(r);
      }
      if (reuse === 'task') {
        assert.match(
          feedback(r, 'query_metrics').error.message,
          /SCHEMA \$\.taskRef: invalid enum/,
        );
        return call('finish_analysis', {
          outcome: 'failed',
          messageCode: 'execution_failed',
          citations: [],
        });
      }
      if (step === 3)
        return call('finish_analysis', {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          citations: [{ evidenceId: oldCitation }],
        });
      assert.match(feedback(r, 'finish_analysis').error.message, /INVALID_EVIDENCE_ID/);
      return finish(r);
    });
    assert.equal((await h.runtime.run('查询 filtered 左右膝 0–5 秒 ROM')).status, 'completed');
    const second = await h.runtime.run('重新查询 filtered 左右膝 0–5 秒 ROM');
    assert.equal(
      second.status,
      reuse === 'source' ? 'needs_input' : reuse === 'task' ? 'failed' : 'completed',
      second.message,
    );
    assert.ok(second.calls.some((c) => !c.output.ok));
  });
}

test('v3 explicit user deletion is accepted locally and an unavailable artifact cannot be delivered', async () => {
  let turn = 0,
    step = 0;
  let signal: AbortSignal;
  const h = harness(async (r) => {
    if (signal !== r.signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    if (step++ === 0) {
      if (turn === 1) return start(r);
      const changes = [
        ['goalTypes', modelGoalTypes([])],
        ['joint', null],
        ['channels', null],
        ['basis', null],
        ['metrics', []],
        ['deliveries.export', { interval: [0, 5], format: 'csv' }],
      ].map(([field, value]) => ({ field, value, origin: 'explicit', sourceId: currentId(r) }));
      return {
        calls: [
          { name: 'get_session_info', arguments: {} },
          { name: 'set_task_patch', arguments: { changes } },
        ],
      };
    }
    if (step === 2)
      return call(turn === 1 ? 'query_metrics' : 'prepare_export', {
        taskRef: user(r).bindings.taskRef,
      });
    if (turn === 1) return finish(r);
    if (step === 3) {
      h.registry.getArtifact = () => {
        throw new Error('injected unavailable handle');
      };
      return finish(r, 'prepare_export', '/handle');
    }
    assert.match(feedback(r, 'finish_analysis').error.message, /EVIDENCE_REQUIRED/);
    return call('finish_analysis', {
      outcome: 'failed',
      messageCode: 'execution_failed',
      citations: [],
    });
  });
  await h.runtime.run('查询 filtered 左右膝 0–5 秒 ROM');
  const run = await h.runtime.run('不再查询指标，只准备 0–5 秒 CSV');
  assert.equal(run.status, 'failed', run.message);
  assert.deepEqual(run.task!.spec.goalTypes, []);
  assert.deepEqual(run.task!.spec.metrics, []);
  assert.ok(run.completion!.missing.includes('export'));
});

test('v3.2 duplicate business arguments are rejected and retain exact model arguments in feedback', async () => {
  let step = 0;
  const explicit = {
    joint: 'knee',
    channels: ['left', 'right'],
    basis: 'filtered',
    interval: [0, 5],
  };
  const h = harness(async (r) => {
    if (step++ === 0) return start(r);
    if (step === 2) return call('query_metrics', { taskRef: user(r).bindings.taskRef });
    if (step === 3) return call('query_metrics', explicit);
    if (step === 4) {
      assert.match(feedback(r, 'query_metrics').error.message, /missing field taskRef/);
      assert.deepEqual(
        r.messages.findLast((m) => m.calls?.[0]?.name === 'query_metrics')!.calls![0]!.arguments,
        explicit,
      );
      return call('query_metrics', { taskRef: user(r).bindings.taskRef });
    }
    assert.deepEqual(
      r.messages.findLast((m) => m.calls?.[0]?.name === 'query_metrics')!.calls![0]!.arguments,
      { taskRef: user(r).bindings.taskRef },
    );
    return finish(r);
  });
  assert.equal((await h.runtime.run('查询 filtered 左右膝 0–5 秒 ROM')).status, 'completed');
});

test('v3 overlapping intervals retain real not-comparable reasons and cannot complete', async () => {
  let step = 0;
  const h = harness(async (r) => {
    if (step++ === 0)
      return start(
        r,
        taskFixture(user(r).goal, {
          goalTypes: ['comparison'],
          comparison: { second: [4, 9], direction: 'second_minus_first' },
        }),
      );
    if (step === 2) return call('compare_intervals', { taskRef: user(r).bindings.taskRef });
    if (step === 3) {
      assert.equal(feedback(r, 'compare_intervals').result.comparable, false);
      assert.ok(feedback(r, 'compare_intervals').result.reasons.length > 0);
      return finish(r, 'compare_intervals', '/differences/0/rom');
    }
    assert.match(feedback(r, 'finish_analysis').error.message, /NOT_COMPARABLE/);
    return call('finish_analysis', {
      outcome: 'not_comparable',
      messageCode: 'comparison_limited',
      citations: [evidenceRef(feedback(r, 'compare_intervals'), '/differences/0/rom')],
    });
  });
  const run = await h.runtime.run('比较 filtered 左右膝 0–5 和 4–9 秒 ROM');
  assert.equal(run.status, 'not_comparable', run.message);
});

test('v3.3 one declared task source expands without changing comparison parameters or evidence', async () => {
  let step = 0;
  const view = {
    joint: 'knee' as const,
    channels: ['left', 'right'] as const,
    basis: 'filtered' as const,
    interval: [0, 20],
  };
  const h = harness(async (r) => {
    if (step++ === 0) {
      const spec = taskFixture(user(r).goal, {
        goalTypes: ['comparison'],
        comparison: { second: [15, 20], direction: 'second_minus_first' },
        deliveries: {
          view: { ...view, channels: [...view.channels], interval: [0, 20] },
          report: false,
          export: null,
        },
      });
      return {
        calls: [
          { name: 'get_session_info', arguments: {} },
          { name: 'set_task_spec', arguments: wholeTask(r, spec) },
        ],
      };
    }
    if (step === 2)
      return {
        calls: ['compare_intervals', 'set_chart_view'].map((name) => ({
          name,
          arguments: { taskRef: user(r).bindings.taskRef },
        })),
      };
    const index = user(r).availableEvidence;
    for (const tool of ['compare_intervals', 'set_chart_view']) {
      const entry = index.find((c: any) => c.tool === tool);
      assert.equal(entry.callId, feedback(r, tool).callId);
      assert.deepEqual(entry.entries, feedback(r, tool).evidenceCatalog.entries);
    }
    if (step === 3)
      return call('finish_analysis', {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: [evidenceRef(feedback(r, 'set_chart_view'), '/view/basis')],
      });
    assert.match(feedback(r, 'finish_analysis').error.message, /comparison/);
    return call('finish_analysis', {
      outcome: 'completed',
      messageCode: 'evidence_ready',
      citations: [
        evidenceRef(feedback(r, 'compare_intervals'), '/differences/0/rom'),
        evidenceRef(feedback(r, 'set_chart_view'), '/view/basis'),
      ],
    });
  });
  const run = await h.runtime.run('比较前后各5秒左右膝 filtered ROM，并展示图表');
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(h.workspace.chart, view);
  assert.equal(run.task!.spec.sources.length, 9);
  assert.ok(
    run.task!.spec.sources.every(
      (s) => s.text === run.goal && s.origin === 'derived' && s.fromRunId === null,
    ),
  );
  const declaration = run.calls.find((c) => c.name === 'set_task_spec')!;
  assert.equal((declaration.modelArguments as any).sources.length, 1);
  assert.equal((declaration.arguments as any).deliveries.report, false);
  const comparison = run.calls.find((c) => c.name === 'compare_intervals')!;
  assert.deepEqual(
    comparison.output,
    h.registry.execute('compare_intervals', comparison.arguments),
  );
  assert.equal(run.reference.revision, h.session.info().revision);
});

for (const defect of ['derived', 'task_overlap', 'view_overlap', 'missing_false'] as const) {
  test(`source coverage rejects ${defect} and accepts model redeclaration without changing intent`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      step++;
      if (step <= 2) {
        const spec: any = wholeTask(
          r,
          taskFixture(user(r).goal, {
            goalTypes: ['comparison'],
            comparison: { second: [15, 20], direction: 'second_minus_first' },
            deliveries: {
              report: false,
              export: null,
              view: {
                joint: 'knee',
                channels: ['left', 'right'],
                basis: 'filtered',
                interval: [0, 20],
              },
            },
          }),
        );
        spec.deliveries.view.interval = 'comparison';
        if (step === 1) {
          if (defect === 'derived') spec.sources[0].origin = 'explicit';
          if (defect === 'task_overlap')
            spec.sources.push({ ...spec.sources[0], field: 'deliveries.view.interval' });
          if (defect === 'view_overlap')
            spec.sources = ['deliveries.view', 'deliveries.view.interval'].map((field) => ({
              ...spec.sources[0],
              field,
            }));
          if (defect === 'missing_false')
            spec.sources = [
              'goalTypes',
              'joint',
              'channels',
              'interval',
              'comparison',
              'metrics',
              'deliveries.view',
            ].map((field) => ({
              ...spec.sources[0],
              field,
            }));
        } else {
          const rejected = feedback(r, 'set_task_spec');
          assert.equal(user(r).acceptedTask, null);
          assert.equal(h.workspace.chart, null);
          assert.match(
            rejected.error.message,
            defect === 'derived'
              ? /RELATIVE_INTERVAL_SOURCE_REQUIRED:deliveries.view.interval:derived/
              : defect === 'missing_false'
                ? /TASK_SPEC_SOURCE_REQUIRED/
                : /TASK_SPEC_SOURCE_OVERLAP/,
          );
          if (defect === 'missing_false') {
            assert.deepEqual(rejected.error.missingSources, ['basis', 'deliveries.report']);
            assert.deepEqual(rejected.scopeReview.unresolved, []);
          }
        }
        return {
          calls: [
            ...(step === 1 ? [{ name: 'get_session_info', arguments: {} }] : []),
            { name: 'set_task_spec', arguments: spec },
          ],
        };
      }
      if (step === 3)
        return {
          calls: ['compare_intervals', 'set_chart_view'].map((name) => ({
            name,
            arguments: { taskRef: user(r).bindings.taskRef },
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
    });
    const run = await h.runtime.run('比较 filtered 左右膝 0–5 秒与 15–20 秒 ROM 并展示图表');
    assert.equal(run.status, 'completed', run.message);
    assert.equal(run.calls.filter((c) => !c.output.ok).length, 1);
    assert.equal(
      (run.calls.find((c) => c.name === 'set_task_spec' && c.output.ok)!.modelArguments as any)
        .sources.length,
      1,
    );
    assert.deepEqual(run.task!.spec.interval, [0, 5]);
    assert.deepEqual(run.task!.spec.comparison!.second, [15, 20]);
    assert.deepEqual(run.task!.spec.deliveries.view!.interval, [0, 20]);
    assert.equal(run.task!.spec.deliveries.report, false);
    assert.equal(run.task!.spec.deliveries.export, null);
    assert.deepEqual(run.task!.spec.unresolved, []);
    assert.ok(run.task!.spec.sources.every((s) => s.origin === 'derived' && s.text === run.goal));
  });
}

for (const attack of ['overlap', 'narrow_view', 'forged', 'inherited'] as const) {
  test(`v3.3 whole-task source retains provenance and coverage rejection: ${attack}`, async () => {
    let step = 0;
    const h = harness(async (r) => {
      if (step++ === 0) {
        const spec: any = wholeTask(
          r,
          taskFixture(user(r).goal, {
            goalTypes: ['comparison'],
            comparison: { second: [15, 20], direction: 'second_minus_first' },
            deliveries: {
              report: false,
              export: null,
              view: {
                joint: 'knee',
                channels: ['left', 'right'],
                basis: 'filtered',
                interval: attack === 'narrow_view' ? [0, 5] : [0, 20],
              },
            },
          }),
        );
        if (attack === 'overlap') spec.sources.push({ ...spec.sources[0], field: 'deliveries' });
        if (attack === 'forged') spec.sources[0].sourceId = 'forged';
        if (attack === 'inherited') spec.sources[0].origin = 'inherited';
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            { name: 'set_task_spec', arguments: spec },
          ],
        };
      }
      assert.equal(feedback(r, 'set_task_spec').ok, false);
      assert.match(
        feedback(r, 'set_task_spec').error.message,
        attack === 'overlap'
          ? /SOURCE_OVERLAP/
          : attack === 'narrow_view'
            ? /COMPARISON_VIEW_INTERVAL/
            : /invalid enum/,
      );
      return call('finish_analysis', {
        outcome: 'needs_input',
        messageCode: 'specify_parameters',
        citations: [],
      });
    });
    const run = await h.runtime.run('比较 filtered 左右膝两段 ROM 并展示');
    assert.equal(run.status, 'needs_input');
    assert.equal(run.task, undefined);
    assert.equal(h.workspace.chart, null);
  });
}

test('v3.3 quality feedback exposes real paths and progressively discovers deep facts', async () => {
  let step = 0;
  let qualityId: string;
  const h = harness(async (r) => {
    if (step++ === 0)
      return {
        calls: [
          { name: 'get_session_info', arguments: {} },
          {
            name: 'set_task_spec',
            arguments: wholeTask(
              r,
              taskFixture(user(r).goal, {
                goalTypes: ['quality'],
                joint: null,
                channels: null,
                basis: null,
                interval: [0, 20],
                metrics: [],
              }),
            ),
          },
        ],
      };
    if (step === 2) return call('get_quality_summary', { taskRef: user(r).bindings.taskRef });
    if (step === 3) {
      qualityId = feedback(r, 'get_quality_summary').callId;
      const schema = r.tools.find((t) => t.name === 'inspect_result')!.inputSchema;
      assert.ok(schema.properties!.callId.enum!.includes(qualityId));
      assert.ok(schema.properties!.path.enum!.includes('/lowConfidenceIntervals'));
      assert.ok(!schema.properties!.path.enum!.includes('/evidence/lowConfidenceIntervals'));
      return call('inspect_result', {
        callId: qualityId,
        path: '/evidence/lowConfidenceIntervals',
        start: 0,
        limit: 1,
      });
    }
    if (step === 4) {
      assert.match(feedback(r, 'inspect_result').error.message, /invalid enum/);
      return call('inspect_result', {
        callId: qualityId,
        path: '/evidence/parameters',
        start: 0,
        limit: 1,
      });
    }
    if (step === 5) {
      assert.equal(feedback(r, 'inspect_result').result.value.metricVersion, '2.0');
      assert.ok(
        r.tools
          .find((t) => t.name === 'inspect_result')!
          .inputSchema.properties!.path.enum!.includes('/evidence/parameters/metricVersion'),
      );
      return call('inspect_result', {
        callId: qualityId,
        path: '/evidence/parameters/metricVersion',
        start: 0,
        limit: 1,
      });
    }
    assert.equal(feedback(r, 'inspect_result').result.value, '2.0');
    return finish(r, 'get_quality_summary', '/missingSamples');
  });
  const run = await h.runtime.run('查询全部已采样区间质量与缺失');
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.task!.spec.metrics, []);
  assert.deepEqual(run.task!.spec.interval, [0, 20]);
});
