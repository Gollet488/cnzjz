import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  array,
  enumeration,
  nullable,
  number,
  object,
  SchemaError,
  validate,
} from '../src/analysis/schema.ts';
import type { Schema } from '../src/analysis/schema.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { evaluationSession, assessRun, FIXED_EVALUATIONS } from '../src/agent/evaluation.ts';
import { AgentRuntime, resolveCitation } from '../src/agent/runtime.ts';
import type { AgentRun } from '../src/agent/runtime.ts';
import type { ModelProvider, ModelReply } from '../src/agent/provider.ts';
import { OllamaProvider } from '../src/agent/provider.ts';
import {
  AGENT_PROTOCOL_VERSION,
  MESSAGE_TEXT,
  PLAN_TEXT,
  checkRenderedControl,
} from '../src/agent/controlProtocol.ts';
import {
  EVIDENCE_CATALOG_VERSION,
  MAX_CATALOG_ENTRIES,
  RunEvidenceDirectory,
  modelCatalog,
} from '../src/agent/evidenceCatalog.ts';
import { evidenceRef, taskForActions } from './agentFixtures.ts';
import { AnalysisSession } from '../src/analysis/session.ts';
import { demoPose } from '../src/utils/demo.ts';

type Request = Parameters<ModelProvider['complete']>[0];
const reply = (name: string, args: unknown): ModelReply => ({ calls: [{ name, arguments: args }] });
const messages = (r: Request) =>
  r.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
const last = (r: Request, tool: string) => messages(r).findLast((m) => m.tool === tool);
const action = { name: 'get_quality_summary', args: { interval: [0, 20] } };

function harness(
  steps: ((r: Request) => ModelReply | Promise<ModelReply>)[],
  session = evaluationSession(),
) {
  const registry = createToolRegistry(session);
  const goal = '查询当前区间的质量';
  const runtime = new AgentRuntime({
    modelProtocol: 'legacy-v2',
    session,
    registry,
    limits: { recoveries: 12, rounds: 20 },
    provider: {
      id: 'stage-c-scripted-protocol',
      model: 'no-real-model',
      async complete(r) {
        const next = steps.shift();
        assert.ok(next, 'unexpected model request');
        return next(r);
      },
    },
  });
  const start = () => ({
    calls: [
      { name: 'get_session_info', arguments: {} },
      { name: 'set_task_spec', arguments: taskForActions(goal, [action]) },
      {
        name: action.name,
        arguments: {
          sessionId: session.info().sessionId,
          revision: session.info().revision,
          ...action.args,
        },
      },
    ],
  });
  const finish = (r: Request) =>
    reply('finish_analysis', {
      outcome: 'completed',
      messageCode: 'evidence_ready',
      citations: [evidenceRef(last(r, action.name), '/effectiveRate')],
    });
  return { session, registry, runtime, goal, start, finish };
}

test('R5 v2: common local Chinese including 一 no longer blocks a normal finish', async () => {
  const h = harness([
    () => h.start(),
    (r) => {
      assert.equal(
        JSON.parse(r.messages.findLast((m) => m.role === 'user')!.content).protocolVersion,
        AGENT_PROTOCOL_VERSION,
      );
      return reply('plan_analysis', { steps: ['read_session', 'present_evidence'] });
    },
    (r) => h.finish(r),
  ]);
  const run = await h.runtime.run(h.goal);
  assert.equal(run.status, 'completed');
  assert.equal(run.protocolVersion, AGENT_PROTOCOL_VERSION);
  assert.match(run.message, /一并/);
  assert.match(run.steps[1], /一并/);
  assert.equal(run.message, MESSAGE_TEXT.evidence_ready);
  assert.equal(run.steps[1], PLAN_TEXT.present_evidence);
  checkRenderedControl(run.message, run.steps);
  checkRenderedControl(run.message, [PLAN_TEXT.compare_intervals]);
  assert.match(PLAN_TEXT.compare_intervals, /进一步分析/);
  assert.equal(
    assessRun(run, FIXED_EVALUATIONS.find((c) => c.id === 'quality')!, h.session).passed,
    true,
  );
  const quality = run.calls.find((c) => c.name === action.name)!;
  assert.ok(quality.output.ok);
  assert.equal(run.citations[0].value, (quality.output.result as any).effectiveRate);
  assert.ok(run.citations[0].evidenceId);
  assert.equal(run.citations[0].callId, quality.id);
  assert.equal(run.citations[0].path, '/effectiveRate');
});

test('v2: every successful call has an auditable bounded catalog and model entries have no pointer', async () => {
  const h = harness([
    () => h.start(),
    (r) => {
      for (const m of messages(r)) {
        assert.equal(m.protocolVersion, AGENT_PROTOCOL_VERSION);
        assert.equal(m.evidenceCatalog.version, EVIDENCE_CATALOG_VERSION);
        assert.ok(m.evidenceCatalog.entries.length <= MAX_CATALOG_ENTRIES);
        for (const e of m.evidenceCatalog.entries) {
          assert.equal(Object.hasOwn(e, 'path'), false);
          assert.ok(e.value === null || ['string', 'number', 'boolean'].includes(typeof e.value));
        }
      }
      return h.finish(r);
    },
  ]);
  const run = await h.runtime.run(h.goal);
  assert.equal(run.status, 'completed');
  for (const call of run.calls) {
    assert.ok(call.output.ok);
    assert.ok(call.evidenceCatalog);
    if (call.name === 'set_task_spec')
      assert.deepEqual(
        call.evidenceCatalog.entries.map((e) => e.path),
        ['/accepted'],
      );
    for (const entry of call.evidenceCatalog.entries)
      assert.deepEqual(resolveCitation(call.output.result, entry.path), entry.value);
  }
});

test('v2 rejects legacy parameters, arbitrary prose/numbers, absent IDs, forged IDs and model-copied values, then recovers', async () => {
  const invalid: [unknown, string][] = [
    [{ outcome: 'completed', message: '先核对一下，结果一致。', citations: [] }, 'missing_field'],
    [{ outcome: 'completed', messageCode: 'ROM为999度', citations: [] }, 'enum'],
    [{ outcome: 'completed', messageCode: 'evidence_ready', citations: [{}] }, 'missing_field'],
    [
      {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: [{ callId: 'old-call', path: '/effectiveRate' }],
      },
      'missing_field',
    ],
    [
      {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: [{ evidenceId: { value: 999 } }],
      },
      'type',
    ],
    [
      {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: [{ evidenceId: 'forged' }],
      },
      'INVALID_EVIDENCE_ID',
    ],
  ];
  const steps: ((r: Request) => ModelReply)[] = [() => h.start()];
  invalid.forEach(([args], i) => {
    steps.push((r) => {
      if (i) {
        const error = last(r, 'finish_analysis').error;
        assert.match(error.issue?.kind ?? error.message, new RegExp(invalid[i - 1][1]));
      }
      return reply('finish_analysis', args);
    });
  });
  steps.push((r) => {
    assert.match(last(r, 'finish_analysis').error.message, /INVALID_EVIDENCE_ID/);
    const good = h.finish(r);
    (good.calls[0].arguments as any).citations[0].value = 999;
    return good;
  });
  steps.push((r) => {
    const issue = last(r, 'finish_analysis').error.issue;
    assert.equal(issue.kind, 'unknown_field');
    assert.equal(issue.path, '$.citations[0].value');
    return reply('plan_analysis', { steps: ['先核对一下，结果一致。'] });
  });
  steps.push((r) => {
    assert.equal(last(r, 'plan_analysis').error.issue.path, '$.steps[0]');
    return h.finish(r);
  });
  const h = harness(steps);
  const run = await h.runtime.run(h.goal);
  assert.equal(run.status, 'completed');
  assert.doesNotMatch(run.message, /999/);
  assert.equal(run.calls.filter((c) => !c.output.ok).length, 8);
});

test('long local quality output stays complete in audit while feedback and catalog visibly omit tails', async () => {
  const session = new AnalysisSession('demo', {
    threshold: 0.5,
    window: 5,
    aspect: 1,
    metricVersion: '2.0',
  });
  for (let i = 0; i <= 400; i++) session.append(i % 2 ? demoPose(i / 20) : [], i / 20);
  const h = harness(
    [
      () => h.start(),
      (r) => {
        const q = last(r, action.name);
        assert.equal(q.result.lowConfidenceIntervals.items.length, 8);
        assert.equal(q.result.lowConfidenceIntervals.omittedItems, 92);
        assert.equal(q.result.omittedIntervals, 101);
        assert.equal(q.evidenceCatalog.truncated, true);
        assert.ok(
          !q.evidenceCatalog.entries.some((e: any) =>
            e.label.startsWith('lowConfidenceIntervals.8.'),
          ),
        );
        evidenceRef(q, '/maxSampleGapSeconds');
        return h.finish(r);
      },
    ],
    session,
  );
  const run = await h.runtime.run(h.goal);
  assert.equal(run.status, 'completed');
  const record = run.calls.find((c) => c.name === action.name)!;
  assert.ok(record.output.ok);
  assert.equal((record.output.result as any).lowConfidenceIntervals.length, 100);
  assert.equal(record.evidenceCatalog!.truncated, true);
});

test('catalog truncation preserves full result; no objects, inherited properties, NaN or Infinity become citations', () => {
  const result = Object.assign(Object.create({ inherited: 12 }), {
    nested: { value: 1 },
    array: Array.from({ length: 100 }, (_, i) => ({ value: i })),
    absent: undefined,
    nan: NaN,
    infinite: Infinity,
    longText: 'x'.repeat(513),
    empty: null,
    many: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`key${i}`, i])),
  });
  const directory = new RunEvidenceDirectory('run', { sessionId: 'session', revision: 4 });
  const catalog = directory.add('call', result);
  assert.equal(catalog.entries.length, MAX_CATALOG_ENTRIES);
  assert.equal(catalog.truncated, true);
  assert.equal(result.array.length, 100);
  assert.ok(
    !catalog.entries.some((e) =>
      ['inherited', 'nested', 'array', 'nan', 'infinite', 'absent', 'longText'].includes(e.label),
    ),
  );
  assert.ok(catalog.entries.some((e) => e.label === 'nested.value'));
  assert.ok(catalog.entries.some((e) => e.label === 'empty' && e.value === null));
  assert.ok(!modelCatalog(catalog).entries.some((e) => Object.hasOwn(e, 'path')));
  for (const pointer of [
    '/inherited',
    '/nested',
    '/array',
    '/absent',
    '/nan',
    '/infinite',
    '/constructor',
    '/nested/~bad',
  ])
    assert.throws(() => resolveCitation(result, pointer), /INVALID|SCALAR|FINITE/);
  const escaped = directory.add('escaped', { 'a/b': { '~': 3 } });
  assert.equal(resolveCitation({ 'a/b': { '~': 3 } }, escaped.entries[0].path), 3);
  const run = {
    id: 'run',
    reference: { sessionId: 'session', revision: 4 },
    calls: [{ id: 'call', output: { ok: true, result } }],
  } as AgentRun;
  const entry = catalog.entries.find((e) => e.label === 'nested.value')!;
  assert.equal(directory.resolve(entry.evidenceId, run).value, 1);
  result.nested.value = 9;
  assert.throws(() => directory.resolve(entry.evidenceId, run), /EVIDENCE_VALUE_CHANGED/);
  result.nested.value = 1;
  run.reference.revision++;
  assert.throws(() => directory.resolve(entry.evidenceId, run), /INVALID_EVIDENCE_ID/);
  run.reference.revision--;
  run.calls[0].output = { ok: false, tool: 'fake', error: { code: 'error', message: 'failed' } };
  assert.throws(() => directory.resolve(entry.evidenceId, run), /INVALID_CITATION_CALL/);
  run.calls[0].output = { ok: true, tool: 'fake', result: { nested: [] } };
  assert.throws(() => directory.resolve(entry.evidenceId, run), /INVALID_CITATION_PATH/);
  run.calls[0].output = { ok: true, tool: 'fake', result: { nested: { value: [] } } };
  assert.throws(() => directory.resolve(entry.evidenceId, run), /SCALAR/);
});

const nestedSchema = object({
  view: nullable(object({ basis: enumeration('raw', 'filtered'), interval: array(number, 2, 2) })),
});
for (const [value, kind, path, expected] of [
  [{}, 'missing_field', '$.view', 'object | null'],
  [{ view: { interval: [0, 1] } }, 'missing_field', '$.view.basis', 'enum ["raw","filtered"]'],
  [
    { view: { basis: 'guessed', interval: [0, 1] } },
    'enum',
    '$.view.basis',
    'enum ["raw","filtered"]',
  ],
  [{ view: { basis: 'raw', interval: [0, '1'] } }, 'type', '$.view.interval[1]', 'number'],
  [{ view: { basis: 'raw', interval: [0] } }, 'bounds', '$.view.interval', 'array'],
  [
    { view: { basis: 'raw', interval: [0, 1], side: 'right' } },
    'unknown_field',
    '$.view.side',
    'object',
  ],
] as const) {
  test(`schema diagnostics v2: ${kind} at ${path}`, () => {
    assert.throws(
      () => validate(nestedSchema, value),
      (error) => {
        assert.ok(error instanceof SchemaError);
        assert.equal(error.issue.version, '2.0.0');
        assert.equal(error.issue.kind, kind);
        assert.equal(error.issue.path, path);
        assert.equal(error.issue.expected, expected);
        assert.match(error.issue.suggestion, /guess|coercion|unknown/);
        if (kind === 'missing_field') assert.match(error.message, /missing field/);
        return true;
      },
    );
  });
}

test('tool errors name missing business/version fields; no side, basis, interval or version is injected', async () => {
  const h = harness([
    () => h.start(),
    (r) => {
      const schema = r.tools.find((t) => t.name === 'query_metrics')!.inputSchema;
      assert.ok(schema.required!.includes('sessionId'));
      assert.ok(schema.required!.includes('revision'));
      return reply('query_metrics', {
        sessionId: h.session.info().sessionId,
        revision: h.session.info().revision,
        joint: 'knee',
        channels: ['right'],
        interval: [1, 4],
      });
    },
    (r) => {
      const error = last(r, 'query_metrics').error;
      assert.equal(error.code, 'SCHEMA_VALIDATION');
      assert.equal(error.issue.path, '$.basis');
      assert.equal(error.issue.kind, 'missing_field');
      assert.equal(error.issue.expected, 'enum ["raw","filtered"]');
      assert.match(error.message, /missing field basis/);
      return h.finish(r);
    },
  ]);
  const run = await h.runtime.run(h.goal);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.calls.find((c) => c.name === 'query_metrics')!.arguments, {
    sessionId: h.session.info().sessionId,
    revision: h.session.info().revision,
    joint: 'knee',
    channels: ['right'],
    interval: [1, 4],
  });
  const failed = h.registry.execute('get_quality_summary', { interval: [0, 20] });
  assert.ok(!failed.ok);
  assert.equal(failed.error.issue?.path, '$.sessionId');
});

test('new session revision cannot revive old arguments or catalog IDs; no automatic rebinding', async () => {
  let oldId = '';
  let oldArgs: any;
  const h = harness([
    () => {
      oldArgs = h.start().calls[2].arguments;
      return h.start();
    },
    (r) => {
      oldId = evidenceRef(last(r, action.name), '/effectiveRate').evidenceId;
      return h.finish(r);
    },
    () => h.start(),
    () => reply(action.name, oldArgs),
    (r) => {
      assert.equal(last(r, action.name).error.code, 'STALE_SESSION');
      assert.equal(Object.hasOwn(last(r, action.name), 'evidenceCatalog'), false);
      return reply('finish_analysis', {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: [{ evidenceId: oldId }],
      });
    },
    (r) => {
      assert.match(last(r, 'finish_analysis').error.message, /INVALID_EVIDENCE_ID/);
      // The rejected old arguments never replace the prior current successful result.
      const current = messages(r).findLast((m) => m.tool === action.name && m.ok);
      return reply('finish_analysis', {
        outcome: 'completed',
        messageCode: 'evidence_ready',
        citations: [evidenceRef(current, '/effectiveRate')],
      });
    },
  ]);
  assert.equal((await h.runtime.run(h.goal)).status, 'completed');
  h.session.recalculate({ ...h.session.info().parameters, window: 3 });
  const second = await h.runtime.run(h.goal);
  assert.equal(second.status, 'completed');
  assert.notEqual(second.citations[0].evidenceId, oldId);
  assert.deepEqual(
    second.calls.find((c) => !c.output.ok && c.name === action.name)!.arguments,
    oldArgs,
  );
});

test('Ollama v2 wire uses native enum/required tool schemas and returns catalogs through tool content unchanged', async () => {
  let body: any;
  const catalog = {
    version: EVIDENCE_CATALOG_VERSION,
    entries: [{ evidenceId: 'known', label: 'effectiveRate', value: 0.75 }],
    truncated: false,
  };
  const provider = new OllamaProvider('http://localhost:11434', 'protocol', async (_url, init) => {
    body = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({
        done: true,
        message: {
          role: 'assistant',
          content: 'ROM 999',
          tool_calls: [
            {
              function: {
                name: 'finish_analysis',
                arguments: {
                  outcome: 'completed',
                  messageCode: 'evidence_ready',
                  citations: [{ evidenceId: 'known' }],
                },
              },
            },
          ],
        },
      }),
    );
  });
  const h = harness([
    () => h.start(),
    async (r) => {
      const result = await provider.complete({
        ...r,
        messages: [
          {
            role: 'tool',
            toolName: action.name,
            content: JSON.stringify({ ok: true, evidenceCatalog: catalog }),
          },
        ],
      });
      assert.equal(body.messages[0].tool_name, action.name);
      assert.deepEqual(JSON.parse(body.messages[0].content).evidenceCatalog, catalog);
      const control = body.tools.find((t: any) => t.function.name === 'finish_analysis').function
        .parameters as Schema;
      assert.deepEqual(control.required, ['outcome', 'messageCode', 'citations']);
      assert.ok(control.properties!.messageCode.enum!.includes('evidence_ready'));
      assert.deepEqual(control.properties!.citations.items!.required, ['evidenceId']);
      assert.ok(!control.properties!.message);
      assert.equal(JSON.stringify(result).includes('999'), false);
      return h.finish(r);
    },
  ]);
  assert.equal((await h.runtime.run(h.goal)).status, 'completed');
});
