import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisSession } from '../src/analysis/session.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { angleValue } from '../src/utils/poseMath.ts';
import { csvHeader } from '../src/utils/csv.ts';
import type { Landmark } from '../src/types.ts';

// Constructed geometry exercises contracts, not human measurement accuracy.
const parameters = { threshold: 0.5, window: 1, aspect: 1, metricVersion: '2.1' as const };
const point = (x: number, y: number, visibility = 1): Landmark => ({ x, y, z: 0, visibility });
function pose(degrees = 90) {
  const p = Array.from({ length: 33 }, (_, i) => point(i / 50, (i % 4) / 5));
  p[23] = point(1, 0);
  p[25] = point(0, 0);
  p[27] = point(Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180));
  p[24] = point(2, 0);
  p[26] = point(1, 0);
  p[28] = point(1 + Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180));
  return p;
}
const selection = { joint: 'knee', channels: ['left', 'right'], basis: 'raw' };
function input(s: AnalysisSession, args: Record<string, unknown> = {}) {
  return { sessionId: s.info().sessionId, revision: s.info().revision, ...args };
}
function result(s: AnalysisSession, name: string, args: Record<string, unknown>): any {
  const output = createToolRegistry(s).execute(name, input(s, args));
  assert.ok(output.ok, JSON.stringify(output));
  return output.result;
}

test('local quality separates bilateral angular availability, detection and unrelated confidence', () => {
  const s = new AnalysisSession('file', parameters);
  const a = pose();
  a[0].visibility = 0.1; // Global 33-point reliability fails; knees remain available.
  s.append(a, 0);
  const b = pose();
  b[28].visibility = 0.1;
  s.append(b, 0.03);
  s.append([], 0.06);
  s.append(pose(), 0.09);
  const q = result(s, 'get_quality_summary', { interval: [0, 0.09], selection });
  assert.equal(q.evidence.sampleCount, 4);
  assert.equal(q.fullyReliableSamples, 1);
  assert.equal(q.selection.joint, 'knee');
  assert.equal(q.selection.basis, 'raw');
  const [left, right] = q.selection.channels;
  assert.deepEqual([left.validSamples, left.invalidSamples, left.coverage], [3, 1, 0.75]);
  assert.deepEqual([right.validSamples, right.invalidSamples, right.coverage], [2, 2, 0.5]);
  assert.deepEqual([left.notDetectedSamples, left.unusableSamples], [1, 0]);
  assert.deepEqual([right.notDetectedSamples, right.unusableSamples], [1, 1]);
  assert.deepEqual(right.longestMissingInterval, { interval: [0.03, 0.06], samples: 2 });
  assert.deepEqual(left.longestMissingInterval, { interval: [0.06, 0.06], samples: 1 });
  const metrics = result(s, 'query_metrics', { interval: [0, 0.09], ...selection });
  assert.deepEqual(
    q.selection.channels.map((c: any) => c.validSamples),
    metrics.channels.map((c: any) => c.angle.sampleCount),
  );
  assert.deepEqual(result(s, 'get_quality_summary', { interval: [0, 0.09] }).selection, null);
  assert.equal(csvHeader().length, 354);
});

test('filtered angles cannot fill a collapsed projection or occlusion in a raw frame', () => {
  const s = new AnalysisSession('file', { ...parameters, window: 2 });
  s.append(pose(30), 1);
  const degenerate = pose(90);
  degenerate[23] = { ...degenerate[25], x: degenerate[25].x + 0.004 };
  s.append(degenerate, 1.03);
  const occluded = pose(80);
  occluded[27].visibility = 0.1;
  s.append(occluded, 1.06);
  s.append([], 1.09);
  s.append(pose(60), 1.12);
  for (const basis of ['raw', 'filtered'] as const) {
    const q = result(s, 'get_quality_summary', {
      interval: [1, 1.12],
      selection: { ...selection, basis },
    });
    const expected = s.frames.filter(
      (f) => angleValue(basis === 'raw' ? f.rawAngles : f.angles, 'knee', 'left') !== null,
    ).length;
    assert.equal(q.selection.channels[0].validSamples, expected);
    assert.equal(q.evidence.basis, basis);
    assert.equal(q.selection.channels[0].notDetectedSamples, 1);
    assert.equal(
      angleValue(basis === 'raw' ? s.frames[2].rawAngles : s.frames[2].angles, 'knee', 'left'),
      null,
    );
    assert.equal(
      angleValue(basis === 'raw' ? s.frames[3].rawAngles : s.frames[3].angles, 'knee', 'left'),
      null,
    );
  }
  assert.equal(s.frames[1].rawAngles.knee.left, null);
  assert.equal(s.frames[1].angles.knee.left, null);
  assert.notEqual(s.frames[1].angles.knee.right, null);
  assert.equal(s.frames[1].rawPoints[23].x, 0.004);
  assert.equal(s.frames[4].velocity.knee.left, null);
});

test('single-frame intervals retain exact source time, zero span and null derivative', () => {
  const s = new AnalysisSession('file', parameters);
  s.append(pose(60), 1.234567);
  const args = { interval: [1.234567, 1.234567], ...selection };
  const q = result(s, 'get_quality_summary', { interval: args.interval, selection });
  assert.deepEqual(q.selection.channels[0].validIntervals, [
    { interval: args.interval, samples: 1 },
  ]);
  assert.equal(q.timing.medianSampleGapSeconds, null);
  assert.deepEqual(q.timing.gapIntervals, []);
  assert.equal(q.maxSampleGapSeconds, null);
  const m = result(s, 'query_metrics', args);
  assert.equal(m.channels[0].rom, null);
  assert.equal(m.channels[0].velocity.sampleCount, 0);
  assert.equal(m.channels[0].events.minimum.time, 1.234567);
  assert.deepEqual(m.channels[0].events.minimum, m.channels[0].events.maximum);
});

test('irregular timestamps split valid and missing runs without inventing unsampled frames', () => {
  const s = new AnalysisSession('file', parameters);
  for (const t of [0, 0.03, 0.06, 1, 1.03]) s.append(pose(), t);
  const q = result(s, 'get_quality_summary', { interval: [0, 1.03], selection });
  assert.ok(Math.abs(q.timing.medianSampleGapSeconds - 0.03) < 1e-10);
  assert.deepEqual(q.timing.gapIntervals, [
    { interval: [0.06, 1], seconds: 0.94, limitSeconds: 0.1 },
  ]);
  assert.equal(q.timing.gapCount, 1);
  assert.equal(q.selection.channels[0].validSamples, 5);
  assert.equal(q.selection.channels[0].missingIntervalCount, 0);
  assert.deepEqual(q.selection.channels[0].validIntervals, [
    { interval: [0, 0.06], samples: 3 },
    { interval: [1, 1.03], samples: 2 },
  ]);
  const missing = new AnalysisSession('file', parameters);
  for (const t of [0, 0.03, 0.06, 1, 1.03]) missing.append([], t);
  const mq = result(missing, 'get_quality_summary', { interval: [0, 1.03], selection });
  assert.equal(mq.selection.channels[0].missingIntervalCount, 2);
  assert.equal(mq.selection.channels[0].notDetectedSamples, 5);
  assert.equal(mq.lowConfidenceIntervals.length, 2);
});

test('comparison and report retain per-interval facts without deltas for a timing break', () => {
  const s = new AnalysisSession('file', parameters);
  for (const t of [0, 0.03, 0.06, 1, 1.03, 2, 2.03, 2.06, 3, 3.03]) s.append(pose(), t);
  const compared = result(s, 'compare_intervals', {
    ...selection,
    first: [0, 1.03],
    second: [2, 3.03],
  });
  assert.equal(compared.first.channels[0].coverage, 1);
  assert.equal(compared.second.channels[0].coverage, 1);
  assert.equal(compared.comparable, false);
  assert.ok(compared.reasons.some((r: string) => r.includes('采样中断')));
  assert.equal(typeof compared.first.channels[0].rom, 'number');
  assert.deepEqual(compared.differences[0], {
    channel: 'left',
    rom: null,
    meanAngle: null,
    peakAbsoluteVelocity: null,
  });
  const report = result(s, 'prepare_report', {
    ...selection,
    interval: [0, 1.03],
    comparison: [2, 3.03],
  });
  assert.deepEqual(report.trends, ['所选区间不可比较；各段统计仅供独立核对。']);
});

test('a source-time gap resets velocity and smoothing and is visible in a narrow query or comparison edge', () => {
  const s = new AnalysisSession('file', { ...parameters, window: 5 });
  [0, 0.03, 0.06, 0.09, 1, 1.03, 1.06].forEach((time, i) => s.append(pose(i < 4 ? 30 : 90), time));
  const frame = s.frames[4];
  assert.equal(frame.angles.knee.left, 90);
  assert.equal(frame.velocity.knee.left, null);
  assert.equal(frame.rawVelocity.knee.left, null);
  assert.deepEqual(frame.windowInterval, [1, 1]);
  assert.equal(frame.variance.raw.value, null);
  const q = result(s, 'get_quality_summary', { interval: [0.09, 1], selection });
  assert.equal(q.timing.gapCount, 1); // A single interval cannot hide the known break.
  const m = result(s, 'query_metrics', { ...selection, interval: [0.09, 1] });
  assert.equal(m.channels[0].velocity.sampleCount, 0);
  const c = result(s, 'compare_intervals', {
    ...selection,
    first: [0, 0.06],
    second: [0.97, 1.03],
  });
  assert.equal(c.second.channels[0].coverage, 1);
  assert.equal(c.comparable, false);
  assert.match(c.reasons.join('；'), /采样中断/);
  const before = structuredClone(s.frames);
  s.recalculate(s.info().parameters);
  assert.deepEqual(s.frames, before);
});

test('bounded intervals preserve late long missing runs and exact omitted counts', () => {
  const s = new AnalysisSession('file', parameters);
  for (let i = 0; i < 40; i++) s.append(i % 2 || i >= 30 ? [] : pose(), i / 50);
  const q = result(s, 'get_quality_summary', { interval: [0, 0.78], selection });
  const side = q.selection.channels[0];
  assert.equal(side.missingIntervalCount, 15);
  assert.equal(side.validIntervalCount, 15);
  assert.equal(side.missingIntervals.length, 5);
  assert.equal(side.omittedMissingIntervals, 10);
  assert.equal(side.omittedValidIntervals, 10);
  assert.deepEqual(side.longestMissingInterval, { interval: [0.58, 0.78], samples: 11 });
  assert.equal(side.missingIntervals[1].interval[0], 0.02);
});

test('many timestamp gaps remain bounded and retain an exact omitted count', () => {
  const s = new AnalysisSession('file', parameters);
  for (let i = 0; i < 8; i++) for (const offset of [0, 0.01, 0.02]) s.append(pose(), i + offset);
  const q = result(s, 'get_quality_summary', { interval: [0, 7.02], selection });
  assert.equal(q.timing.gapCount, 7);
  assert.equal(q.timing.gapIntervals.length, 5);
  assert.equal(q.timing.omittedGapIntervals, 2);
  assert.equal(q.selection.channels[0].validIntervalCount, 8);
  assert.equal(q.selection.channels[0].omittedValidIntervals, 3);
  assert.equal(q.selection.channels[0].invalidSamples, 0);
});

test('null angular samples and equal extrema keep null events or first source occurrence', () => {
  const s = new AnalysisSession('file', parameters);
  s.append(pose(60), 0);
  s.append(pose(120), 0.03);
  s.append(pose(60), 0.06);
  s.append([], 0.09);
  const m = result(s, 'query_metrics', { interval: [0, 0.09], ...selection });
  assert.equal(m.channels[0].events.minimum.time, 0);
  assert.equal(m.channels[0].events.maximum.time, 0.03);
  assert.equal(m.channels[0].events.maximum.value, m.channels[0].angle.max);
  const empty = result(s, 'query_metrics', { interval: [0.09, 0.09], ...selection });
  assert.deepEqual(empty.channels[0].events, { minimum: null, maximum: null });
  assert.equal(empty.channels[0].angle.sampleCount, 0);
  const q = result(s, 'get_quality_summary', { interval: [0.09, 0.09], selection });
  assert.equal(q.selection.channels[0].coverage, 0);
  assert.equal(q.selection.channels[0].validIntervals.length, 0);
});

test('quality selection rejects partial, duplicate or joint-incompatible channels', () => {
  const s = new AnalysisSession('file', parameters);
  s.append(pose(), 0);
  const tools = createToolRegistry(s);
  for (const selected of [
    { joint: 'knee', channels: ['left'] },
    { joint: 'knee', channels: ['left', 'left'], basis: 'raw' },
    { joint: 'spine', channels: ['left'], basis: 'raw' },
    { joint: 'knee', channels: ['midline'], basis: 'raw' },
  ])
    assert.equal(
      tools.execute('get_quality_summary', input(s, { interval: [0, 0], selection: selected })).ok,
      false,
    );
});

test('report retains selected quality for both intervals and recalculation invalidates old outputs', () => {
  const s = new AnalysisSession('file', { ...parameters, window: 2 });
  for (let i = 0; i < 8; i++) {
    const p = pose(30 + i * 10);
    if (i === 2) p[27].visibility = 0.75;
    s.append(i === 5 ? [] : p, i / 20);
  }
  const tools = createToolRegistry(s);
  const args = input(s, {
    ...selection,
    basis: 'filtered',
    interval: [0, 0.1],
    comparison: [0.2, 0.3],
  });
  const output = tools.execute('prepare_report', args);
  assert.ok(output.ok, JSON.stringify(output));
  const report = output.result as any;
  assert.equal(report.quality.selection.joint, 'knee');
  assert.equal(report.quality.selection.basis, 'filtered');
  assert.deepEqual(report.comparisonQuality.evidence.interval, [0.2, 0.3]);
  assert.equal(report.comparisonQuality.selection.channels[0].notDetectedSamples, 1);
  assert.equal(report.missing.length, 6);
  const old = input(s, { interval: [0, 0.35], selection });
  const prior = tools.execute('get_quality_summary', old);
  assert.ok(prior.ok);
  assert.equal((prior.result as any).selection.channels[0].validSamples, 7);
  s.recalculate({ ...parameters, threshold: 1, window: 3 });
  assert.throws(() => tools.getArtifact(report.handle), /STALE_SESSION/);
  const stale = tools.execute('get_quality_summary', old);
  assert.ok(!stale.ok);
  assert.equal(stale.error.code, 'STALE_SESSION');
  const fresh = tools.execute('get_quality_summary', input(s, { interval: [0, 0.35], selection }));
  assert.ok(fresh.ok);
  assert.equal((fresh.result as any).selection.channels[0].validSamples, 6);
  assert.deepEqual(
    s.frames.map((f) => f.time),
    Array.from({ length: 8 }, (_, i) => i / 20),
  );
  assert.equal(s.frames[5].rawPoints.length, 0);
});
