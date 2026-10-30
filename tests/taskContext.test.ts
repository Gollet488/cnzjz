import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime.ts';
import type { AgentRun } from '../src/agent/runtime.ts';
import type { ModelProvider, ModelReply } from '../src/agent/provider.ts';
import type { RunAudit } from '../src/agent/audit.ts';
import { evaluationSession, totalCosts } from '../src/agent/evaluation.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { applyTaskPatch, CONTEXT_LIMITS, jsonBytes } from '../src/agent/taskContext.ts';
import type { TaskPatch } from '../src/agent/taskContext.ts';
import type { TaskSpec, TaskUnderstanding } from '../src/agent/taskSpec.ts';
import { demoPose } from '../src/utils/demo.ts';
import { evidenceRef, taskFixture } from './agentFixtures.ts';

// All providers here are scripted protocol tests with synthetic pose samples.
// Token counts, when present, are deliberately injected accounting fixtures.
type Request = Parameters<ModelProvider['complete']>[0];
const call = (name: string, args: unknown): ModelReply => ({ calls: [{ name, arguments: args }] });
const user = (r: Request) => JSON.parse(r.messages.find((m) => m.role === 'user')!.content);
const result = (r: Request, name: string) =>
  JSON.parse(r.messages.findLast((m) => m.toolName === name)!.content);
const initialGoal = '比较左右膝 filtered 在 0–5 与 15–20 秒的 ROM';
const followGoal = '只看右侧，第二段改为 12–17 秒';
const spec = () =>
  taskFixture(initialGoal, {
    goalTypes: ['comparison'],
    comparison: { second: [15, 20], direction: 'second_minus_first' },
  });
const patch: TaskPatch = {
  changes: [
    { field: 'channels', value: ['right'], text: '只看右侧', origin: 'explicit', fromRunId: null },
    {
      field: 'comparison.second',
      value: [12, 17],
      text: '第二段改为 12–17 秒',
      origin: 'explicit',
      fromRunId: null,
    },
  ],
};
function harness(complete: ModelProvider['complete']) {
  const session = evaluationSession();
  const registry = createToolRegistry(session);
  const audits: RunAudit[] = [];
  const runtime = new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session,
    registry,
    provider: { id: 'stage-d-scripted-protocol', model: 'no-real-model', complete },
    onAudit: (audit) => {
      audits.push(audit);
    },
  });
  return { session, registry, audits, runtime };
}
function compare(r: Request) {
  const task: TaskUnderstanding = result(
    r,
    r.messages.some((m) => m.toolName === 'set_task_patch') ? 'set_task_patch' : 'set_task_spec',
  ).result.task;
  return call('compare_intervals', {
    sessionId: user(r).currentSession.sessionId,
    revision: user(r).currentSession.revision,
    joint: task.spec.joint,
    channels: task.spec.channels,
    basis: task.spec.basis,
    first: task.spec.interval,
    second: task.spec.comparison!.second,
  });
}
function finish(r: Request, tool = 'compare_intervals', path = '/differences/0/rom') {
  return call('finish_analysis', {
    outcome: 'completed',
    messageCode: 'evidence_ready',
    citations: [evidenceRef(result(r, tool), path)],
  });
}
function start(task: TaskSpec) {
  return {
    calls: [
      { name: 'get_session_info', arguments: {} },
      { name: 'set_task_spec', arguments: task },
    ],
  };
}

for (const firstOutcome of ['completed', 'failed', 'limit'] as const) {
  test(`${firstOutcome} then partial user modification retains every omitted parameter and uses fresh evidence`, async () => {
    let turn = 0,
      step = 0;
    let signal: AbortSignal | undefined;
    const h = harness(async (r) => {
      if (r.signal !== signal) {
        signal = r.signal;
        turn++;
        step = 0;
      }
      if (step++ === 0) {
        if (turn === 1) return start(spec());
        assert.equal(r.messages.length, 2, 'no prior conversation/tool messages');
        assert.equal(user(r).previousTask.spec.joint, 'knee');
        assert.equal(user(r).context.recentFeedback.status, firstOutcome);
        assert.ok(!JSON.stringify(r.messages).includes(h.audits[0].run.calls.at(-1)!.id));
        return {
          calls: [
            { name: 'get_session_info', arguments: {} },
            { name: 'set_task_patch', arguments: patch },
          ],
        };
      }
      if (turn === 1 && firstOutcome === 'failed') throw new Error('injected provider failure');
      if (turn === 1 && firstOutcome === 'limit') return { calls: [] };
      return step === 2 ? compare(r) : finish(r);
    });
    const first = await h.runtime.run(initialGoal);
    assert.equal(first.status, firstOutcome);
    const second = await h.runtime.run(followGoal);
    assert.equal(second.status, 'completed', second.message);
    assert.deepEqual(second.task!.spec.interval, [0, 5]);
    assert.deepEqual(second.task!.spec.comparison, {
      second: [12, 17],
      direction: 'second_minus_first',
    });
    assert.deepEqual(second.task!.spec.channels, ['right']);
    assert.equal(second.task!.spec.joint, 'knee');
    assert.equal(second.task!.spec.basis, 'filtered');
    assert.deepEqual(second.task!.spec.metrics, ['rom']);
    assert.equal(second.task!.spec.sources.find((s) => s.field === 'joint')!.fromRunId, first.id);
    assert.equal(second.task!.spec.sources.find((s) => s.field === 'channels')!.text, '只看右侧');
    assert.ok(second.citations.every((c) => c.callId.startsWith(second.id.slice(0, 8))));
    assert.equal(h.audits.length, 2);
    assert.equal(h.audits[0].run.status, firstOutcome);
    assert.ok(h.audits[0].requests.length >= 2);
  });
}

test('failure before any spec retains raw intent and permits traceable recovery from that user text', async () => {
  let index = 0;
  const h = harness(async (r) => {
    if (index++ === 0) throw new Error('offline');
    if (index === 2) {
      const u = user(r);
      assert.equal(u.previousTask, null);
      assert.equal(u.context.pendingUserIntents[0].goal, initialGoal);
      const declared = spec();
      declared.sources = declared.sources.map((s) => ({
        ...s,
        origin: 'inherited',
        fromRunId: u.context.pendingUserIntents[0].runId,
      }));
      return start(declared);
    }
    return index === 3 ? compare(r) : finish(r);
  });
  const failed = await h.runtime.run(initialGoal);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.task, undefined);
  const recovered = await h.runtime.run('重试刚才的比较');
  assert.equal(recovered.status, 'completed', JSON.stringify(recovered.calls));
  assert.ok(recovered.task!.spec.sources.every((s) => s.fromRunId === failed.id));
  assert.deepEqual(h.runtime.taskContext.pendingUserIntents, []);
});

test('a follow-up that fails before acceptance remains pending over an older successful task', async () => {
  let turn = 0,
    step = 0;
  let signal: AbortSignal | undefined;
  const h = harness(async (r) => {
    if (r.signal !== signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    if (turn === 2) throw new Error('offline before follow-up spec');
    if (step++ === 0) {
      if (turn === 1) return start(spec());
      const pending = user(r).context.pendingUserIntents[0];
      assert.equal(pending.goal, followGoal);
      return {
        calls: [
          { name: 'get_session_info', arguments: {} },
          {
            name: 'set_task_patch',
            arguments: {
              changes: patch.changes.map((c) => ({ ...c, fromRunId: pending.runId })),
            },
          },
        ],
      };
    }
    return step === 2 ? compare(r) : finish(r);
  });
  assert.equal((await h.runtime.run(initialGoal)).status, 'completed');
  const failed = await h.runtime.run(followGoal);
  assert.equal(failed.status, 'failed');
  const recovered = await h.runtime.run('重试这次修改');
  assert.equal(recovered.status, 'completed', JSON.stringify(recovered.calls));
  assert.deepEqual(recovered.task!.spec.interval, [0, 5]);
  assert.deepEqual(recovered.task!.spec.comparison!.second, [12, 17]);
  assert.equal(
    recovered.task!.spec.sources.find((s) => s.field === 'channels')!.fromRunId,
    failed.id,
  );
});

test('revision invalidation keeps intent, replaces numbers and rejects prior run catalog IDs', async () => {
  let turn = 0,
    step = 0,
    oldId = '';
  let signal: AbortSignal | undefined;
  const h = harness(async (r) => {
    if (r.signal !== signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    if (step++ === 0) {
      if (turn === 1) return start(spec());
      assert.ok(user(r).context.referenceChanged);
      assert.equal(r.messages.length, 2);
      assert.ok(!JSON.stringify(r.messages).includes(oldId));
      return {
        calls: [
          { name: 'get_session_info', arguments: {} },
          { name: 'set_task_patch', arguments: { changes: [] } },
        ],
      };
    }
    if (step === 2) return compare(r);
    if (turn === 1)
      oldId = evidenceRef(result(r, 'compare_intervals'), '/differences/0/rom').evidenceId;
    if (turn === 2 && step === 3)
      return call('finish_analysis', {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: [{ evidenceId: oldId }],
      });
    if (turn === 2) assert.match(result(r, 'finish_analysis').error.message, /INVALID_EVIDENCE_ID/);
    return finish(r);
  });
  const first = await h.runtime.run(initialGoal);
  assert.equal(first.status, 'completed');
  h.session.recalculate({ ...h.session.info().parameters, window: 9 });
  h.runtime.invalidate();
  const second = await h.runtime.run('参数沿用，重新取数');
  assert.equal(second.status, 'completed');
  assert.notEqual(second.reference.revision, first.reference.revision);
  assert.equal(second.citations.length, 1);
  assert.notEqual(second.citations[0].evidenceId, oldId);
  assert.notEqual(second.citations[0].value, first.citations[0].value);
});

test('new source with unavailable old intervals asks for clarification and refuses clipped query/view/export', async () => {
  let turn = 0,
    step = 0;
  let signal: AbortSignal | undefined;
  const h = harness(async (r) => {
    if (r.signal !== signal) {
      signal = r.signal;
      turn++;
      step = 0;
    }
    if (step++ === 0) {
      if (turn === 1) return start(spec());
      assert.deepEqual(user(r).context.unavailableFields, ['comparison.second']);
      return {
        calls: [
          { name: 'get_session_info', arguments: {} },
          { name: 'set_task_patch', arguments: { changes: [] } },
        ],
      };
    }
    if (turn === 1) return step === 2 ? compare(r) : finish(r);
    if (step === 2) {
      const ref = { sessionId: h.session.info().sessionId, revision: h.session.info().revision };
      return {
        calls: [
          {
            name: 'query_metrics',
            arguments: {
              ...ref,
              joint: 'knee',
              basis: 'filtered',
              channels: ['right'],
              interval: [0, 5],
            },
          },
          {
            name: 'set_chart_view',
            arguments: {
              ...ref,
              joint: 'knee',
              basis: 'filtered',
              channels: ['right'],
              interval: [0, 5],
            },
          },
          { name: 'prepare_export', arguments: { ...ref, interval: [0, 5], format: 'csv' } },
        ],
      };
    }
    assert.ok(
      r.messages
        .filter((m) => ['set_chart_view', 'prepare_export'].includes(m.toolName!))
        .every((m) => {
          const feedback = JSON.parse(m.content);
          return (
            !feedback.ok &&
            !feedback.evidenceCatalog &&
            /INTENT_RANGE_UNAVAILABLE/.test(feedback.error.message)
          );
        }),
    );
    return call('finish_analysis', {
      outcome: 'needs_input',
      messageCode: 'range_unavailable',
      citations: [],
    });
  });
  assert.equal((await h.runtime.run(initialGoal)).status, 'completed');
  const oldSession = h.session.info().sessionId;
  h.session.reset('file');
  for (let i = 0; i <= 120; i++) h.session.append(demoPose(i / 20), i / 20);
  const run = await h.runtime.run('换来源后按原参数比较');
  assert.equal(run.status, 'needs_input', JSON.stringify(run.calls));
  assert.notEqual(run.reference.sessionId, oldSession);
  assert.deepEqual(run.task!.spec.comparison!.second, [15, 20]);
  assert.equal(
    run.calls.filter(
      (c) => ['query_metrics', 'set_chart_view', 'prepare_export'].includes(c.name) && c.output.ok,
    ).length,
    0,
  );
});

test('patches preserve unspecified values, refuse overlaps/forged provenance and cannot erase missing requirements', () => {
  const previous: TaskUnderstanding = {
    runId: 'prior',
    goal: initialGoal,
    spec: spec(),
    validation: 'structure_and_provenance_only',
  };
  const changed = applyTaskPatch(patch, followGoal, previous);
  assert.deepEqual(changed.interval, previous.spec.interval);
  assert.equal(changed.basis, previous.spec.basis);
  assert.deepEqual(changed.comparison!.second, [12, 17]);
  assert.throws(
    () => applyTaskPatch({ changes: [...patch.changes, patch.changes[0]] }, followGoal, previous),
    /OVERLAP/,
  );
  assert.throws(
    () =>
      applyTaskPatch(
        { changes: [{ ...patch.changes[0], fromRunId: 'forged' }] },
        followGoal,
        previous,
      ),
    /SOURCE_TEXT/,
  );
  assert.throws(() => applyTaskPatch(patch, followGoal), /CONTEXT_REQUIRED/);
  previous.spec.unresolved = ['joint', 'interval'];
  assert.deepEqual(applyTaskPatch(patch, followGoal, previous).unresolved, ['joint', 'interval']);
});

test('full spec cannot silently erase a previous requirement without a user source', async () => {
  let index = 0;
  const h = harness(async () => {
    if (index++ === 0) return start(spec());
    if (index === 2) throw new Error('offline');
    const dropped = spec();
    dropped.interval = null;
    dropped.sources = dropped.sources
      .filter((s) => s.field !== 'interval')
      .map((s) => ({ ...s, text: '只看右侧' }));
    return call('set_task_spec', dropped);
  });
  await h.runtime.run(initialGoal);
  const run = await h.runtime.run('只看右侧');
  assert.equal(run.task, undefined);
  assert.ok(
    run.calls.every(
      (c) => !c.output.ok && /TASK_CHANGE_SOURCE_REQUIRED:interval/.test(c.output.error.message),
    ),
  );
  assert.deepEqual(h.runtime.taskContext.previousTask!.spec.interval, [0, 5]);
});

test('clear during an unresponsive request cannot resurrect context, costs or handles; audit survives', async () => {
  let index = 0;
  let resolve!: (r: ModelReply) => void;
  const h = harness(async (r) => {
    if (index++ === 0) return start(spec());
    if (index === 2)
      return new Promise((done) => {
        resolve = done;
      });
    assert.equal(user(r).previousTask, null);
    assert.deepEqual(user(r).context.pendingUserIntents, []);
    return index === 3
      ? start(taskFixture('新的完整目标'))
      : call('finish_analysis', {
          outcome: 'needs_input',
          messageCode: 'specify_parameters',
          citations: [],
        });
  });
  const pending = h.runtime.run(initialGoal);
  while (!resolve) await new Promise((done) => setTimeout(done, 1));
  h.runtime.clear();
  const cancelled = await pending;
  assert.equal(cancelled.status, 'stale');
  assert.equal(cancelled.conversationCosts!.turns, 1);
  assert.equal(cancelled.conversationCosts!.requests, 2);
  resolve(call('prepare_export', {}));
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(h.runtime.taskContext.previousTask, null);
  assert.equal(h.runtime.taskContext.turns, 0);
  assert.equal(h.audits[0].run.status, 'stale');
  assert.equal(h.audits[0].run.calls.length, 2);
  const restarted = await h.runtime.run('新的完整目标');
  assert.equal(restarted.status, 'needs_input');
  assert.notEqual(cancelled.conversationId, restarted.conversationId);
  assert.equal(restarted.conversationCosts!.turns, 1);
});

test('separate runtime sessions never share intent or pending failed goals', async () => {
  const first = harness(async () => {
    throw new Error('offline');
  });
  await first.runtime.run(initialGoal);
  const second = harness(async (r) => {
    assert.equal(user(r).previousTask, null);
    assert.deepEqual(user(r).context.pendingUserIntents, []);
    throw new Error('offline');
  });
  await second.runtime.run(followGoal);
  assert.equal(first.runtime.taskContext.pendingUserIntents[0].goal, initialGoal);
  assert.equal(second.runtime.taskContext.pendingUserIntents[0].goal, followGoal);
});

test('long conversations have bounded requests, an explicit turn cap, and no silent loss of parameters', async () => {
  let seen = 0;
  const h = harness(async (r) => {
    if (r.messages.length === 2) {
      seen++;
      if (seen > 1) {
        assert.equal(user(r).previousTask.spec.basis, 'filtered');
        assert.deepEqual(user(r).previousTask.spec.comparison.second, [15, 20]);
        assert.equal(user(r).context.previousTask, undefined, 'no duplicated prior task');
      }
      return seen === 1
        ? start(spec())
        : {
            calls: [
              { name: 'get_session_info', arguments: {} },
              { name: 'set_task_patch', arguments: { changes: [] } },
            ],
          };
    }
    return call('finish_analysis', {
      outcome: 'needs_input',
      messageCode: 'specify_parameters',
      citations: [],
    });
  });
  const runs: AgentRun[] = [];
  for (let i = 0; i < CONTEXT_LIMITS.turns; i++)
    runs.push(await h.runtime.run(i ? '沿用参数重试' : initialGoal));
  assert.ok(runs.every((r) => r.status === 'needs_input'));
  assert.equal(h.audits.length, CONTEXT_LIMITS.turns);
  assert.ok(
    runs.every((r) =>
      r.requests!.every((request) => request.inputBytes <= CONTEXT_LIMITS.requestBytes),
    ),
  );
  assert.ok(jsonBytes(h.runtime.taskContext) <= CONTEXT_LIMITS.intentBytes);
  assert.equal(runs.at(-1)!.conversationCosts!.turns, CONTEXT_LIMITS.turns);
  assert.equal(runs.at(-1)!.conversationCosts!.rounds, CONTEXT_LIMITS.turns * 2);
  assert.equal(totalCosts(runs).rounds, CONTEXT_LIMITS.turns * 2);
  await assert.rejects(h.runtime.run('继续'), /TASK_CONTEXT_LIMIT/);
  assert.equal(h.audits.length, CONTEXT_LIMITS.turns, 'no extra request or audit on refusal');
  assert.deepEqual(h.runtime.taskContext.previousTask!.spec.interval, [0, 5]);
});

test('unparsed failures stop at a separate pending-intent cap without discarding user text', async () => {
  const h = harness(async () => {
    throw new Error('offline');
  });
  for (let i = 0; i < CONTEXT_LIMITS.pendingGoals; i++) await h.runtime.run(`明确用户要求 ${i}`);
  await assert.rejects(h.runtime.run('不得静默挤掉旧要求'), /TASK_CONTEXT_LIMIT/);
  assert.equal(h.runtime.taskContext.pendingUserIntents.length, CONTEXT_LIMITS.pendingGoals);
  assert.equal(h.runtime.taskContext.pendingUserIntents[0].goal, '明确用户要求 0');
});

test('oversized current feedback stops before another request; full rejected arguments remain auditable', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return call('query_metrics', { unexpected: 'x'.repeat(CONTEXT_LIMITS.requestBytes) });
  });
  const run = await h.runtime.run('保持有界');
  assert.equal(run.status, 'limit');
  assert.match(run.message, /CONTEXT_LIMIT/);
  assert.equal(calls, 1);
  assert.equal(run.requests!.length, 1);
  assert.equal(
    (h.audits[0].run.calls[0].arguments as any).unexpected.length,
    CONTEXT_LIMITS.requestBytes,
  );
  assert.equal(h.runtime.taskContext.pendingUserIntents[0].goal, '保持有界');
});

test('per-request bytes, all-session tokens, response rounds and elapsed time have distinct accounting', async () => {
  let index = 0;
  const h = harness(async () => {
    index++;
    if (index === 1) return { ...start(spec()), usage: { inputTokens: 10, outputTokens: 2 } };
    if (index === 2)
      return {
        ...call('finish_analysis', {
          outcome: 'needs_input',
          messageCode: 'specify_parameters',
          citations: [],
        }),
        usage: { outputTokens: 3 },
      };
    throw new Error('provider failed without usage');
  });
  const first = await h.runtime.run(initialGoal);
  const second = await h.runtime.run('重试');
  assert.deepEqual(first.usage, { inputTokens: null, outputTokens: 5, reportedRequests: 2 });
  assert.equal(second.conversationCosts!.turns, 2);
  assert.equal(second.conversationCosts!.requests, 3);
  assert.equal(second.conversationCosts!.rounds, 2);
  assert.equal(second.conversationCosts!.inputTokens, null);
  assert.equal(second.conversationCosts!.outputTokens, null);
  assert.deepEqual(second.conversationCosts!.reportedUsage, {
    inputTokens: 10,
    outputTokens: 5,
    inputRequests: 1,
    outputRequests: 2,
  });
  assert.equal(second.conversationCosts!.elapsedMs, first.elapsedMs + second.elapsedMs);
  assert.equal(second.requests![0].status, 'failed');
  assert.equal(second.requests![0].wireBytes, null);
  assert.ok(first.requests!.every((r) => r.inputBytes > r.messageBytes));
  assert.equal(totalCosts([first, second]).reportedUsage.inputTokens, 10);
  assert.equal(totalCosts([first, second]).reportedUsage.outputTokens, 5);
});

test('audit sink failure is visible and does not convert a completed analysis to an unverified result', async () => {
  const h = harness(async () => {
    throw new Error('unused');
  });
  let step = 0;
  const runtime = new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session: h.session,
    registry: h.registry,
    provider: {
      id: 'scripted',
      model: 'not-real',
      async complete(r) {
        return step++ === 0 ? start(spec()) : step === 2 ? compare(r) : finish(r);
      },
    },
    onAudit: () => {
      throw new Error('quota');
    },
  });
  const run = await runtime.run(initialGoal);
  assert.equal(run.status, 'completed');
  assert.equal(run.auditStatus, 'failed');
  assert.equal(run.citations.length, 1);
});

test('recent errors have no evidence catalog and do not replace the last successful measured facts', async () => {
  let step = 0;
  const h = harness(async (r) => {
    if (step++ === 0) return start(spec());
    if (step === 2) return compare(r);
    if (step === 3 || step === 4) return call('compare_intervals', { wrong: step });
    const feedback = r.messages
      .filter((m) => m.toolName === 'compare_intervals')
      .map((m) => JSON.parse(m.content));
    assert.equal(feedback.length, 3);
    assert.ok(feedback.filter((f) => !f.ok).every((f) => !f.evidenceCatalog && !f.result));
    return call('finish_analysis', {
      outcome: 'completed',
      messageCode: 'evidence_ready',
      citations: [
        evidenceRef(
          feedback.find((f) => f.ok),
          '/differences/0/rom',
        ),
      ],
    });
  });
  const run = await h.runtime.run(initialGoal);
  assert.equal(run.status, 'completed');
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 2);
  const audit = h.audits[0];
  assert.equal(audit.requests.length, run.requests!.length);
  for (const [i, request] of audit.requests.entries()) {
    assert.equal(
      jsonBytes({ messages: request.messages, tools: audit.tools }),
      run.requests![i].inputBytes,
    );
    assert.ok(request.reply);
  }
});

test('stale accepted intent is kept while its pending tools and old artifact handles are unusable', async () => {
  let step = 0;
  let waiting!: () => void;
  const entered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const h = harness(async () => {
    if (step++ === 0) return start(spec());
    waiting();
    return new Promise(() => {});
  });
  const ref = h.session.info();
  const prepared = h.registry.execute('prepare_export', {
    sessionId: ref.sessionId,
    revision: ref.revision,
    interval: [0, 5],
    format: 'csv',
  });
  assert.ok(prepared.ok);
  const handle = (prepared.result as any).handle;
  const pending = h.runtime.run(initialGoal);
  await entered;
  h.session.recalculate({ ...ref.parameters, window: 3 });
  h.runtime.invalidate();
  const run = await pending;
  assert.equal(run.status, 'stale');
  assert.equal(h.runtime.taskContext.previousTask!.runId, run.id);
  assert.deepEqual(h.runtime.taskContext.previousTask!.spec.interval, [0, 5]);
  assert.throws(() => h.registry.getArtifact(handle), /STALE/);
  assert.equal(run.citations.length, 0);
  assert.equal(h.audits[0].requests.at(-1)!.error, 'stale');
});

test('accepting another task never silently drops an unacknowledged pending user modification', async () => {
  let step = 0;
  const h = harness(async () => {
    if (step++ === 0) throw new Error('offline before parsing user intent');
    if (step === 2) return start(taskFixture('当前只查右膝 ROM'));
    return call('finish_analysis', {
      outcome: 'needs_input',
      messageCode: 'specify_parameters',
      citations: [],
    });
  });
  const failed = await h.runtime.run(initialGoal);
  await h.runtime.run('当前只查右膝 ROM');
  assert.deepEqual(h.runtime.taskContext.pendingUserIntents, [
    {
      runId: failed.id,
      goal: initialGoal,
      reference: { sessionId: failed.reference.sessionId, revision: failed.reference.revision },
    },
  ]);
});
