import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisSession } from '../src/analysis/session.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { demoPose } from '../src/utils/demo.ts';
import { DEMO_SIZE } from '../src/utils/dimensions.ts';
import { resolveCitation } from '../src/agent/evidenceCatalog.ts';
import {
  draftRomCard,
  emptyRomCard,
  executeRomCard,
  reviewRomCard,
} from '../src/agent/romTaskCard.ts';
import type { RomCardInput } from '../src/agent/romTaskCard.ts';
import type { ModelProvider } from '../src/agent/provider.ts';

const params = {
  threshold: 0.5,
  window: 5,
  aspect: DEMO_SIZE.width / DEMO_SIZE.height,
  metricVersion: '2.0' as const,
};
const absolute = (start: number, end: number) => ({ mode: 'absolute' as const, start, end });
function fixture() {
  const session = new AnalysisSession('demo', params);
  for (let i = 0; i < 160; i++) session.append(demoPose(i * 0.05), i * 0.05);
  for (let i = 0; i <= 216; i++) session.append(demoPose(8 + i / 16), 8 + i / 16);
  return session;
}
const input: RomCardInput = { ...emptyRomCard(), first: absolute(0, 5), second: absolute(15, 20) };

test('ROM card confirms once per version, preserves fields on modification and prepares versioned deliveries', () => {
  const session = fixture();
  const charts: unknown[] = [];
  const tools = createToolRegistry(session, {
    seekToTime: () => {
      throw new Error('Unexpected seek');
    },
    setChartView: (view) => {
      charts.push(view);
      return view;
    },
  });
  const reviewed = session.info();
  const run = (card: RomCardInput, previousRunId?: string) =>
    executeRomCard(tools, session.info(), session.frames, {
      entry: 'manual',
      confirmedAt: Date.now(),
      input: card,
      reviewed,
      previousRunId,
    }).run;
  const first = run(input);
  const right = { ...input, side: 'right' as const, second: absolute(12, 17) };
  const second = run(right, first.id);
  const third = run({ ...right, report: true, csv: true }, second.id);
  assert.deepEqual(
    [first, second, third].map((r) => r.status),
    ['completed', 'completed', 'completed'],
  );
  assert.deepEqual(charts, [
    { joint: 'knee', channels: ['left', 'right'], basis: 'filtered', interval: [0, 20] },
    { joint: 'knee', channels: ['right'], basis: 'filtered', interval: [0, 17] },
    { joint: 'knee', channels: ['right'], basis: 'filtered', interval: [0, 17] },
  ]);
  for (const r of [first, second, third]) {
    assert.deepEqual(r.reference, reviewed);
    assert.deepEqual(r.romCard?.resolved?.first, [0, 5]);
    for (const citation of r.citations) {
      assert.equal(citation.source, 'browser-local-workflow');
      const call = r.calls.find((c) => c.id === citation.callId);
      assert.ok(call?.output.ok);
      assert.equal(resolveCitation(call.output.result, citation.path), citation.value);
    }
  }
  assert.deepEqual(
    first.calls.map((c) => c.name),
    ['get_session_info', 'compare_intervals', 'set_chart_view'],
  );
  assert.deepEqual(
    second.calls.map((c) => c.name),
    first.calls.map((c) => c.name),
  );
  assert.deepEqual(
    third.calls.map((c) => c.name),
    [...first.calls.map((c) => c.name), 'prepare_report', 'prepare_export'],
  );
  const handles = third.citations.filter((c) => c.path === '/handle').map((c) => String(c.value));
  assert.deepEqual(
    handles.map((h) => tools.getArtifact(h).interval),
    [
      [0, 5],
      [0, 17],
    ],
  );
  assert.equal(tools.getArtifact(handles[1]).result.columns, 354);
  session.recalculate(params);
  for (const handle of handles) assert.throws(() => tools.getArtifact(handle), /STALE_SESSION/);
  const stale = run(right, third.id);
  assert.equal(stale.status, 'stale');
  assert.deepEqual(
    stale.calls.map((c) => c.name),
    ['get_session_info'],
  );
  assert.equal(charts.length, 3);
  session.reset('file');
  assert.throws(() => tools.getArtifact(handles[0]), /STALE_SESSION/);
});

test('ROM review reports missing, outside and empty intervals separately and resolves relative starts at nonzero PTS', () => {
  const session = new AnalysisSession('demo', params);
  for (const time of [2, 3, 4, 11, 12]) session.append(demoPose(time), time);
  const review = (card: RomCardInput) => reviewRomCard(card, session.info(), session.frames);
  assert.deepEqual(
    review({ ...input, first: { mode: 'start', seconds: 2 }, second: { mode: 'end', seconds: 1 } })
      .resolved,
    { first: [2, 4], second: [11, 12], chart: [2, 12] },
  );
  const fixed = fixture();
  const invalid = reviewRomCard(
    {
      ...input,
      first: { mode: 'absolute', start: null, end: 5 },
      second: absolute(15, 25),
      chart: absolute(7.96, 7.99),
    },
    fixed.info(),
    fixed.frames,
  );
  assert.equal(invalid.resolved, null);
  assert.match(invalid.errors.first!, /开始秒/);
  assert.match(invalid.errors.second!, /超出/);
  assert.match(invalid.errors.chart!, /没有采样帧/);
});

test('a scripted archive-shaped relative draft stays relative and never accesses the registry', async () => {
  const session = fixture();
  const snapshot = session.info();
  const raw = {
    ...input,
    first: { mode: 'start', seconds: 5 },
    second: { mode: 'end', seconds: 5 },
  };
  let requests = 0;
  const provider: ModelProvider = {
    id: 'scripted',
    model: 'archive',
    complete: async ({ tools }) => {
      requests++;
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['draft_rom_comparison'],
      );
      return { calls: [{ name: tools[0].name, arguments: raw }] };
    },
  };
  const signal = new AbortController().signal;
  const { draft, audit } = await draftRomCard(provider, '前段 0–5 秒，后段 15–20 秒', signal);
  assert.ok(draft);
  assert.deepEqual(audit.request.reply?.calls[0].arguments, raw);
  assert.equal(requests, 1);
  assert.deepEqual(session.info(), snapshot);
  assert.deepEqual(reviewRomCard(draft, snapshot, session.frames).resolved?.second, [16.5, 21.5]);
  const corrected = { ...draft, first: input.first, second: input.second };
  assert.deepEqual(reviewRomCard(corrected, snapshot, session.frames).resolved?.second, [15, 20]);
  const missing = await draftRomCard(
    {
      ...provider,
      complete: async () => ({
        calls: [{ name: 'draft_rom_comparison', arguments: { ...raw, second: { mode: 'end' } } }],
      }),
    },
    '比较两段',
    signal,
  );
  assert.equal(missing.draft, undefined);
  assert.match(missing.audit.request.error!, /second\.seconds/);
  const failed = await draftRomCard(
    {
      ...provider,
      complete: async () => {
        throw new Error('service offline');
      },
    },
    '比较两段',
    signal,
  );
  assert.equal(failed.draft, undefined);
  assert.equal(failed.audit.request.error, 'service offline');
});

test('ROM draft interruption settles even if the provider is still pending', async (t) => {
  for (const [outcome, reason, expected] of [
    ['cancel', undefined, '模型草拟已取消。'],
    ['disconnect', '模型连接已断开，草拟已取消。', '模型连接已断开，草拟已取消。'],
    [
      'session changed',
      '草拟期间采样会话已更新，草稿已失效。',
      '草拟期间采样会话已更新，草稿已失效。',
    ],
    ['timeout', undefined, '模型草拟超时。'],
  ] as const) {
    await t.test(outcome, async (t) => {
      const cancelled = new AbortController();
      const deadline = new AbortController();
      t.mock.method(AbortSignal, 'timeout', (ms: number) => {
        assert.equal(ms, 120_000);
        return deadline.signal;
      });
      const { promise, resolve } =
        Promise.withResolvers<Awaited<ReturnType<ModelProvider['complete']>>>();
      const request = draftRomCard(
        { id: 'scripted', model: 'pending', complete: () => promise },
        '比较两段',
        cancelled.signal,
      );
      (outcome === 'timeout' ? deadline : cancelled).abort(reason);
      const pending = Symbol('still pending');
      const result = await Promise.race([
        request,
        new Promise<typeof pending>((resolve) => setImmediate(() => resolve(pending))),
      ]);
      resolve({ calls: [{ name: 'draft_rom_comparison', arguments: input }] });
      assert.notEqual(result, pending, 'the draft must finish before its old reply arrives');
      assert.ok(typeof result !== 'symbol');
      assert.equal(result.draft, undefined);
      assert.equal(result.audit.request.error, expected);
      await request;
      assert.equal(result.audit.request.reply, undefined);
      assert.equal(result.audit.request.reply, undefined);
    });
  }
});

test('fixed 377-frame review cannot execute after append, recalculation or source replacement', () => {
  for (const change of ['append', 'recalculate', 'source'] as const) {
    const session = fixture();
    const reviewed = session.info();
    const card: RomCardInput = {
      ...input,
      second: { mode: 'end', seconds: 5 },
      report: true,
      csv: true,
    };
    assert.equal(reviewed.sampleCount, 377);
    assert.deepEqual(reviewRomCard(card, reviewed, session.frames).resolved?.second, [16.5, 21.5]);
    let chartApplications = 0;
    const tools = createToolRegistry(session, {
      setChartView: (view) => {
        chartApplications++;
        return view;
      },
    });
    if (change === 'append') session.append(demoPose(21.5625), 21.5625);
    if (change === 'recalculate') session.recalculate(params);
    if (change === 'source') {
      session.reset('file');
      for (let i = 0; i < 377; i++) {
        const time = i / 12.5;
        session.append(demoPose(time), time);
      }
    }
    const current = session.info();
    const run = (reference: typeof reviewed) =>
      executeRomCard(tools, current, session.frames, {
        entry: 'manual',
        confirmedAt: Date.now(),
        input: card,
        reviewed: reference,
      }).run;
    const stale = run(reviewed);
    assert.equal(stale.status, 'stale');
    assert.deepEqual(
      stale.calls.map(({ name }) => name),
      ['get_session_info'],
    );
    assert.equal(stale.romCard?.resolved, undefined);
    assert.deepEqual(stale.citations, []);
    assert.equal(chartApplications, 0);
    const fresh = run(current);
    assert.equal(fresh.status, 'completed', change);
    assert.deepEqual(fresh.romCard?.resolved?.second, [current.range![1] - 5, current.range![1]]);
    assert.deepEqual(
      fresh.calls.map(({ name }) => name),
      [
        'get_session_info',
        'compare_intervals',
        'set_chart_view',
        'prepare_report',
        'prepare_export',
      ],
    );
    assert.equal(chartApplications, 1);
  }
});
