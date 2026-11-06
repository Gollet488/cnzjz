import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolRegistry } from '../src/analysis/tools.ts';
import type { ChartView } from '../src/analysis/tools.ts';
import { evaluationSession } from '../src/agent/evaluation.ts';
import {
  bindRomIntent,
  parseRomIntent,
  ROM_INTENT_TOOL,
  verifyRomIntent,
} from '../src/agent/romIntent.ts';
import { AgentRuntime } from '../src/agent/runtime.ts';
import type { RunAudit } from '../src/agent/audit.ts';
import type { ModelProvider } from '../src/agent/provider.ts';

const first = '比较 filtered 左右膝 0–5 秒与绝对 15–20 秒的 ROM，并展示覆盖两段的图表';
const second = '只看右膝，第二段改成 12–17 秒';
const third = '保持比较参数，增加报告和 0–17 秒 CSV';
const call = (args: unknown) => ({ name: ROM_INTENT_TOOL.name, arguments: args });

test('absolute windows and the derived chart are bound separately from CSV', () => {
  const session = evaluationSession();
  const goal = first.replace('覆盖两段', '0–19.5 秒').replace('15–20', '15–19');
  const bound = bindRomIntent(parseRomIntent(goal)!, goal, session.info(), session.frames);
  const { proposed, input } = bound.review;
  assert.deepEqual(proposed.interval, [0, 5]);
  assert.deepEqual(proposed.comparison?.second, [15, 19]);
  assert.deepEqual(proposed.deliveries.view?.interval, [0, 19.5]);
  assert.equal(
    proposed.sources.find((s) => s.field === 'deliveries.view.interval')?.origin,
    'explicit',
  );
  const previous = {
    input,
    task: {
      runId: 'previous',
      goal,
      spec: proposed,
      validation: 'structure_and_provenance_only' as const,
    },
  };
  const revised = bindRomIntent(
    parseRomIntent(second, input)!,
    second,
    session.info(),
    session.frames,
    previous,
  );
  assert.deepEqual(revised.review.proposed.deliveries.view?.interval, [0, 19.5]);
  assert.deepEqual(revised.review.proposed.comparison?.second, [12, 17]);
  const delivered = bindRomIntent(
    parseRomIntent(third, input)!,
    third,
    session.info(),
    session.frames,
    previous,
  );
  assert.deepEqual(delivered.review.proposed.deliveries.export?.interval, [0, 17]);
  assert.deepEqual(delivered.review.proposed.deliveries.view?.interval, [0, 19.5]);
  const conflict =
    '准备当前右膝 filtered 0–5 秒与 12–17 秒的比较报告和 0–17 秒 CSV，保持当前最终视图';
  assert.throws(
    () =>
      bindRomIntent(
        parseRomIntent(conflict, input)!,
        conflict,
        session.info(),
        session.frames,
        previous,
      ),
    /ROM_INTENT_CONFLICT/,
  );
});

test('real anchors resolve against the sampled range while ambiguous prose stays unbound', () => {
  const session = evaluationSession();
  const goal = first.replace('0–5 秒', '采样开头 3 秒').replace('绝对 15–20 秒', '采样末尾 4 秒');
  const bound = bindRomIntent(parseRomIntent(goal)!, goal, session.info(), session.frames);
  assert.deepEqual(bound.review.input.second, { mode: 'end', seconds: 4 });
  assert.deepEqual(bound.review.proposed.interval, [0, 3]);
  assert.deepEqual(bound.review.proposed.comparison?.second, [16, 20]);
  assert.equal(
    bound.review.proposed.sources.find((s) => s.field === 'comparison.second')?.origin,
    'derived',
  );
  assert.equal(parseRomIntent(first.replace('15–20 秒', '约 15–20 秒')), undefined);
  assert.equal(parseRomIntent(first + '，或者用末尾 5 秒'), undefined);
  assert.equal(parseRomIntent(first.replace('filtered ', '')), undefined);
  assert.equal(parseRomIntent('只看右膝，改为 12–17 秒', bound.review.input), undefined);
  assert.throws(
    () => verifyRomIntent([call({ intent: 'deliver' })], bound, session.info()),
    /ROM_INTENT_CONFLICT/,
  );
  assert.throws(
    () =>
      verifyRomIntent(
        [call({ intent: 'compare', second: { anchor: 'end', seconds: 5 } })],
        bound,
        session.info(),
      ),
    /unknown field/,
  );
  assert.throws(
    () =>
      verifyRomIntent([call({ intent: 'compare', sourceId: 'previous' })], bound, session.info()),
    /unknown field/,
  );
  assert.throws(
    () =>
      verifyRomIntent([call({ intent: 'compare' })], bound, {
        ...session.info(),
        revision: bound.review.reference.revision + 1,
      }),
    /STALE_SESSION/,
  );
});

test('a structured intent precedes confirmation and one local execution per turn', async () => {
  const session = evaluationSession();
  const audits: RunAudit[] = [];
  let requests = 0;
  let reviews = 0;
  let chartWrites = 0;
  let chart: ChartView | null = null;
  const provider: ModelProvider = {
    id: 'ollama-local',
    model: 'offline-fixture',
    async complete(request) {
      assert.deepEqual(
        request.tools.map(({ name }) => name),
        [ROM_INTENT_TOOL.name],
      );
      return { calls: [call({ intent: ['compare', 'revise', 'deliver'][requests++] })] };
    },
  };
  const runtime = new AgentRuntime({
    provider,
    session,
    registry: createToolRegistry(session, {
      setChartView: (view) => {
        chartWrites++;
        return (chart = view);
      },
      readWorkspace: () => ({ chart, time: null }),
    }),
    reviewRom: async (review) => {
      assert.equal(requests, reviews + 1);
      assert.equal(chartWrites, reviews++);
      return { input: review.input, reviewed: review.reference, confirmedAt: Date.now() };
    },
    onAudit: (audit) => {
      audits.push(audit);
    },
  });
  for (const [index, goal] of [first, second, third].entries()) {
    const run = await runtime.run(goal);
    assert.equal(run.status, 'completed', run.message);
    assert.equal(run.rounds, 1);
    assert.equal(run.calls[0].name, ROM_INTENT_TOOL.name);
    assert(
      run.calls
        .slice(1)
        .every((entry) => entry.source === 'local-executor' && !entry.modelArguments),
    );
    const spec = run.task!.spec;
    assert.deepEqual(spec.interval, [0, 5]);
    assert.deepEqual(spec.comparison?.second, index ? [12, 17] : [15, 20]);
    assert.deepEqual(spec.deliveries.view?.interval, index ? [0, 17] : [0, 20]);
    assert.deepEqual(spec.channels, index ? ['right'] : ['left', 'right']);
    assert.equal(spec.basis, 'filtered');
    assert.equal(spec.joint, 'knee');
    assert.equal(spec.deliveries.report, index === 2);
    assert.deepEqual(spec.deliveries.export?.interval, index === 2 ? [0, 17] : undefined);
    assert.equal(
      spec.sources.find((s) => s.field === 'deliveries.view.interval')?.origin,
      index === 2 ? 'inherited' : 'derived',
    );
  }
  assert.equal(requests, 3);
  assert.equal(reviews, 3);
  assert.equal(chartWrites, 3);
  assert(audits.every((audit) => audit.requests.length === 1));
  session.append([], 20.1);
  assert.equal((await runtime.run(second)).status, 'stale');
  assert.equal(requests, 3);
  assert.equal(chartWrites, 3);
});

test('a session change during review prevents acceptance and chart writes', async () => {
  const session = evaluationSession();
  const runtime = new AgentRuntime({
    session,
    provider: {
      id: 'ollama-local',
      model: 'offline-fixture',
      complete: async () => ({ calls: [call({ intent: 'compare' })] }),
    },
    registry: createToolRegistry(session, { setChartView: () => assert.fail('stale chart write') }),
    reviewRom: async (review) => {
      session.append([], 20.1);
      return { input: review.input, reviewed: review.reference, confirmedAt: Date.now() };
    },
  });
  const run = await runtime.run(first);
  assert.equal(run.status, 'stale');
  assert.equal(run.task, undefined);
  assert.deepEqual(run.calls, []);
});
