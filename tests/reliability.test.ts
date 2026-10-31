// Deterministic reductions of stage E real-model failures, never model scores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskSpec, taskSpecSchema } from '../src/agent/taskSpec.ts';
import { validate } from '../src/analysis/schema.ts';
import { applyTaskPatch } from '../src/agent/taskContext.ts';
import { taskFixture } from './agentFixtures.ts';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { OllamaProvider } from '../src/agent/provider.ts';
import { evaluationSession } from '../src/agent/evaluation.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';

test('E source text: computed coordinates cannot replace a verbatim user source', () => {
  const goal = '比较左肘 filtered 最初三秒和最后三秒的 ROM';
  const spec = taskFixture(goal, {
    joint: 'elbow',
    channels: ['left'],
    interval: [2, 5],
  });
  const source = spec.sources.find((s) => s.field === 'interval')!;
  source.text = '[2, 5]';
  assert.throws(
    () => validateTaskSpec(spec, goal),
    (error: Error) => {
      assert.match(error.message, /TASK_SPEC_SOURCE_TEXT:interval/);
      assert.match(error.message, /原文.*逐字/);
      return true;
    },
  );
  source.text = '最初三秒';
  assert.deepEqual(validateTaskSpec(spec, goal), spec);
  source.text = '最初 三秒';
  assert.throws(() => validateTaskSpec(spec, goal), /TASK_SPEC_SOURCE_TEXT/);
});

test('E inheritance: a session range is not an accepted previous task', () => {
  const goal = '查询整个已采样区间的质量';
  const spec = taskFixture(goal, {
    goalTypes: ['quality'],
    joint: null,
    channels: null,
    basis: null,
    interval: [2, 12],
    metrics: [],
  });
  const source = spec.sources.find((s) => s.field === 'interval')!;
  source.origin = 'inherited';
  assert.throws(
    () => validateTaskSpec(spec, goal),
    (error: Error) => {
      assert.match(error.message, /TASK_SPEC_INHERITANCE:interval/);
      assert.match(error.message, /previousTask.*pendingUserIntents/);
      return true;
    },
  );
  source.origin = 'derived';
  source.text = '整个已采样区间';
  assert.deepEqual(validateTaskSpec(spec, goal), spec);
});

test('E context: failed unaccepted specification cannot be patched into existence', () => {
  const goal = '第二段改为九至十二秒';
  const patch = {
    changes: [
      {
        field: 'comparison.second',
        value: [9, 12],
        text: goal,
        origin: 'explicit',
        fromRunId: null,
      },
    ],
  };
  assert.throws(() => applyTaskPatch(patch, goal), /TASK_CONTEXT_REQUIRED/);
});

test('E advertised source fields reject metadata and invented goal fields before provenance validation', () => {
  const goal = '查询整个已采样区间的质量';
  const spec = taskFixture(goal);
  for (const field of ['goal', 'sessionId', 'revision', 'unresolved']) {
    spec.sources = [{ field, origin: 'explicit', text: goal, fromRunId: null }];
    assert.throws(() => validate(taskSpecSchema, spec), /\$\.sources\[0\]\.field/);
  }
  const valid = taskFixture(goal);
  assert.doesNotThrow(() => validate(taskSpecSchema, valid));
});

test('E HTTP failure remains failed with unknown cost and recoverable original intent', async () => {
  const session = evaluationSession();
  const goal = '比较左肘 filtered 两段 ROM';
  const runtime = new AgentRuntime({
    session,
    registry: createToolRegistry(session),
    provider: new OllamaProvider(
      'http://127.0.0.1:11434',
      'transport-test-only',
      async () => new Response(JSON.stringify({ error: 'synthetic HTTP 500' }), { status: 500 }),
    ),
  });
  const first = await runtime.run(goal);
  assert.equal(first.status, 'failed');
  assert.equal(first.calls.length, 0);
  assert.equal(first.usage.inputTokens, null);
  assert.equal(first.requests?.[0]?.status, 'failed');
  const second = await runtime.run('只改右侧');
  assert.equal(second.context?.previousTask, null);
  assert.ok(second.context?.pendingUserIntents.some((intent) => intent.goal === goal));
  assert.equal(second.status, 'failed');
});
