import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisSession } from '../src/analysis/session.ts';
import { createToolRegistry, TOOL_DEFINITIONS } from '../src/analysis/tools.ts';
import { validate } from '../src/analysis/schema.ts';
import { angleValue, measureFrame } from '../src/utils/poseMath.ts';
import { serializeCSV } from '../src/utils/export.ts';
import type { Landmark } from '../src/types.ts';

// All fixtures in this file are synthetic geometry, never model evidence.
const point = (x: number, y: number, visibility = 1): Landmark => ({ x, y, z: 0, visibility });
function pose(degrees: number, visibility = 1) {
  const p = Array.from({ length: 33 }, (_, i) => point(i / 50, (i % 4) / 5));
  p[23] = point(1, 0);
  p[25] = point(0, 0);
  p[27] = point(
    Math.cos((degrees * Math.PI) / 180),
    Math.sin((degrees * Math.PI) / 180),
    visibility,
  );
  p[24] = point(2, 0);
  p[26] = point(1, 0);
  p[28] = point(1 + Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180));
  return p;
}
const parameters = { threshold: 0.5, window: 1, aspect: 1, metricVersion: '2.0' as const };
const near = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-8, `${a} ≠ ${b}`);
const make = () => new AnalysisSession('demo', parameters);
function successful(
  registry: ReturnType<typeof createToolRegistry>,
  name: string,
  input: unknown,
): any {
  const output = registry.execute(name, input);
  assert.ok(output.ok, JSON.stringify(output));
  return output.result;
}
function failure(
  registry: ReturnType<typeof createToolRegistry>,
  name: string,
  input: unknown,
  code: string,
) {
  const output = registry.execute(name, input);
  assert.ok(!output.ok);
  assert.equal(output.error.code, code);
}
const selection = (s: AnalysisSession) => ({
  sessionId: s.info().sessionId,
  revision: s.info().revision,
  joint: 'knee',
  channels: ['left', 'right'],
  basis: 'raw',
});

test('raw/filtered variance carries population denominator, point/sample counts and source window', () => {
  const s = new AnalysisSession('demo', { ...parameters, window: 2 });
  const a = pose(60),
    b = a.map((p) => ({ ...p, x: p.x + 2 }));
  s.append(a, 1);
  s.append(b, 1.4);
  const f = s.frames[1];
  near(f.variance.raw.value, 1);
  near(f.variance.filtered.value, 0.25);
  assert.equal(f.variance.raw.validPoints, 33);
  assert.equal(f.variance.raw.validSamples, 66);
  assert.equal(f.variance.raw.minSamplesPerPoint, 2);
  assert.equal(f.variance.raw.windowFrames, 2);
  assert.deepEqual(f.windowInterval, [1, 1.4]);
  const a2 = s.frames[0].rawAngles.knee.left!,
    b2 = f.rawAngles.knee.left!;
  near(f.rawVelocity.knee.left, (b2 - a2) / 0.4);
});

test('velocity uses its own raw/filtered angle series and rejects nonpositive source deltas', () => {
  const s = new AnalysisSession('demo', { ...parameters, window: 2 });
  s.append(pose(30), 0);
  s.append(pose(90), 0.25);
  near(s.frames[1].rawVelocity.knee.left, 240);
  near(s.frames[1].velocity.knee.left, 120);
  assert.notEqual(s.frames[1].rawVelocity.knee.left, s.frames[1].velocity.knee.left);
  const p = pose(90);
  for (const t of [0, -1]) {
    const f = measureFrame(p, t, s.frames[0], [p]);
    assert.equal(f.velocity.knee.left, null);
    assert.equal(f.rawVelocity.knee.left, null);
  }
});

test('missing detection and per-landmark occlusion break smoothing/derivative continuity', () => {
  const s = new AnalysisSession('demo', { ...parameters, window: 3 });
  s.append(pose(30), 0);
  s.append([], 0.5);
  s.append(pose(90), 1);
  assert.equal(s.frames[1].confidence, 0);
  assert.equal(s.frames[1].variance.raw.value, null);
  near(s.frames[2].angles.knee.left, 90);
  assert.equal(s.frames[2].velocity.knee.left, null);
  assert.equal(s.frames[2].variance.filtered.value, null);
  s.append(pose(60, 0.1), 1.5);
  s.append(pose(120), 2);
  assert.equal(s.frames[3].rawAngles.knee.left, null);
  assert.equal(s.frames[3].angles.knee.left, null);
  assert.equal(s.frames[4].velocity.knee.left, null);
  near(s.frames[4].points[27].x, pose(120)[27].x);
});

test('session append rejects zero/backward timestamps, nonfinite time/points and stale work', () => {
  const s = make();
  s.append(pose(30), 0);
  const before = s.info();
  assert.equal(s.append(pose(90), 0), false);
  assert.throws(() => s.append(pose(90), -1), /INVALID_TIME/);
  s.append(pose(60), 1);
  assert.equal(s.append(pose(90), 0.5), false);
  assert.throws(() => s.append([], NaN), /INVALID_TIME/);
  const bad = pose(90);
  bad[0].x = Infinity;
  assert.throws(() => s.append(bad, 2), /INVALID_LANDMARKS/);
  assert.throws(() => s.append([], 2, before), /STALE_SESSION/);
  assert.equal(s.frames.length, 2);
});

test('recalculation keeps all source timestamps and raw coordinates, updates one parameter snapshot and revision', () => {
  const s = make();
  s.append(pose(30), 0);
  s.append(pose(90, 0.4), 0.5);
  s.append(pose(60), 1);
  const before = s.info(),
    raw = structuredClone(s.frames.map((f) => f.rawPoints));
  const oldFrames = s.frames;
  s.recalculate({ ...parameters, window: 2, threshold: 0.3 });
  assert.equal(s.info().sessionId, before.sessionId);
  assert.equal(s.info().revision, before.revision + 1);
  assert.deepEqual(
    s.frames.map((f) => f.time),
    [0, 0.5, 1],
  );
  assert.deepEqual(
    s.frames.map((f) => f.rawPoints),
    raw,
  );
  assert.equal(oldFrames[1].angles.knee.left, null);
  assert.notEqual(s.frames[1].angles.knee.left, null);
  near(s.frames[1].angles.knee.left, 60);
  assert.throws(() => s.assertCurrent(before), /STALE_SESSION/);
  const count = s.frames.length;
  s.recalculate(s.info().parameters);
  assert.equal(s.frames.length, count);
  const snapshot = s.info();
  snapshot.parameters.window = 20;
  assert.equal(s.info().parameters.window, 2);
  assert.throws(() => s.recalculate({ ...parameters, window: 0 }), /INVALID_PARAMETERS/);
  assert.equal(s.frames.length, count);
  s.reset('file');
  assert.equal(s.frames.length, 0);
  assert.notEqual(s.info().sessionId, before.sessionId);
  assert.equal(s.info().source, 'file');
  assert.equal(s.info().synthetic, false);
});

test('query provides independently expected ROM, velocity, angle variance, units and evidence', () => {
  const s = make(),
    r = createToolRegistry(s);
  [30, 60, 90].forEach((d, i) => s.append(pose(d), i * 0.5));
  const result = successful(r, 'query_metrics', { ...selection(s), interval: [0, 1] });
  const left = result.channels[0];
  near(left.angle.mean, 60);
  near(left.rom, 60);
  near(left.angle.populationVariance, 600);
  assert.equal(left.angle.sampleCount, 3);
  near(left.velocity.mean, 60);
  assert.equal(left.velocity.sampleCount, 2);
  assert.equal(result.units.angle, 'deg');
  assert.equal(result.units.velocity, 'deg/s');
  assert.equal(result.evidence.sampleCount, 3);
  assert.equal(result.evidence.synthetic, true);
  assert.equal(r.validateEvidence(result.evidence), true);
  assert.ok(!JSON.stringify(result).includes('rawPoints'));
  const sub = successful(r, 'query_metrics', { ...selection(s), interval: [0.25, 1] });
  assert.equal(sub.channels[0].velocity.sampleCount, 1); // Excludes crossing interval start.
  s.append(pose(120), 1.5);
  assert.throws(() => r.validateEvidence(result.evidence), /STALE_SESSION/);
});

test('evidence rejects parameter tampering and forged sample/source metadata', () => {
  const s = make(),
    r = createToolRegistry(s);
  s.append(pose(30), 0);
  s.append(pose(60), 1);
  const evidence = successful(r, 'query_metrics', { ...selection(s), interval: [0, 1] }).evidence;
  assert.throws(
    () =>
      r.validateEvidence({ ...evidence, parameters: { ...evidence.parameters, threshold: 0.1 } }),
    /STALE_PARAMETERS/,
  );
  assert.throws(() => r.validateEvidence({ ...evidence, sampleCount: 30 }), /INVALID_EVIDENCE/);
  assert.throws(() => r.validateEvidence({ ...evidence, synthetic: false }), /INVALID_EVIDENCE/);
  s.recalculate({ ...parameters, window: 2 });
  assert.throws(() => r.validateEvidence(evidence), /STALE_SESSION/);
});

test('quality returns missing and low confidence intervals, sample coverage and bounded aggregate only', () => {
  const s = make(),
    r = createToolRegistry(s);
  s.append(pose(30), 0);
  s.append([], 0.5);
  s.append(pose(60, 0.1), 1);
  s.append(pose(90), 1.5);
  const q = successful(r, 'get_quality_summary', {
    sessionId: s.info().sessionId,
    revision: s.info().revision,
    interval: [0, 1.5],
  });
  assert.equal(q.detectedSamples, 3);
  assert.equal(q.missingSamples, 1);
  assert.equal(q.fullyReliableSamples, 2);
  near(q.effectiveRate, 0.5);
  assert.deepEqual(q.lowConfidenceIntervals, [{ interval: [0.5, 1], samples: 2 }]);
  near(q.maxSampleGapSeconds, 0.5);
  assert.ok(q.evidence.limitations.some((s: string) => s.includes('源视频')));
});

test('comparisons use same selected basis and report second-minus-first differences and quality limits', () => {
  const s = make(),
    r = createToolRegistry(s);
  [30, 60, 60, 120, 90].forEach((d, i) => s.append(pose(d), i));
  const p = { ...selection(s), first: [0, 1], second: [2, 3] };
  const c = successful(r, 'compare_intervals', p);
  assert.equal(c.comparable, true);
  near(c.differences[0].rom, 30);
  assert.equal(c.differenceDirection, 'second_minus_first');
  s.append([], 5);
  const q = successful(r, 'compare_intervals', { ...p, ...selection(s), second: [4, 5] });
  assert.equal(q.comparable, false);
  assert.equal(q.differences[0].rom, null);
  assert.ok(q.reasons.length);
  const overlap = successful(r, 'compare_intervals', { ...p, ...selection(s), second: [0.5, 1.5] });
  assert.equal(overlap.comparable, false);
});

test('spine is one midline measurement; bilateral requests fail and CSV does not duplicate it', () => {
  const s = make(),
    r = createToolRegistry(s);
  s.append(pose(30), 0);
  s.append(pose(60), 1);
  assert.deepEqual(Object.keys(s.frames[0].angles.spine), ['midline']);
  assert.equal(angleValue(s.frames[0].angles, 'spine', 'right'), null);
  const p = { ...selection(s), joint: 'spine', channels: ['midline'], interval: [0, 1] };
  assert.equal(successful(r, 'query_metrics', p).channels.length, 1);
  failure(r, 'query_metrics', { ...p, channels: ['left'] }, 'INVALID_CHANNEL');
  const csv = serializeCSV(s.frames, [], s.info());
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('raw_spine_midline_deg'));
  assert.ok(csv.includes('filtered_spine_midline_velocity_deg_s'));
  assert.ok(!csv.includes('spine_right'));
  assert.ok(csv.includes('raw_coordinate_variance_norm2'));
  assert.ok(csv.includes(s.info().sessionId));
  const lines = csv
    .slice(1)
    .split('\r\n')
    .map((line) => line.split(',').map((cell) => cell.slice(1, -1)));
  assert.equal(lines[0].length, lines[1].length);
  assert.equal(lines[1].length, lines[2].length);
  near(Number(lines[1][lines[0].indexOf('raw_knee_left_deg')]), 30);
  assert.equal(lines[1][lines[0].indexOf('raw_knee_left_velocity_deg_s')], '');
});

test('tool schemas reject malformed fields, numbers, missing versions, illegal intervals, sides and unknown tools', () => {
  const s = make(),
    r = createToolRegistry(s);
  successful(r, 'get_session_info', {});
  failure(r, 'query_metrics', { ...selection(s), interval: [0, 1] }, 'NO_DATA');
  s.append(pose(30), 0);
  s.append(pose(60), 1);
  const p = { ...selection(s), interval: [0, 1] };
  for (const bad of [
    { ...p, revision: '2' },
    { ...p, revision: 0.5 },
    { ...p, surprise: true },
    { ...p, basis: 'invented' },
    { ...p, interval: [NaN, 1] },
    { ...p, channels: [] },
    { ...p, interval: [0, 1, 2] },
    { ...p, channels: ['left', 'right', 'midline'] },
  ])
    failure(r, 'query_metrics', bad, 'SCHEMA_VALIDATION');
  failure(r, 'query_metrics', { ...p, interval: [1, 0] }, 'INVALID_INTERVAL');
  failure(r, 'query_metrics', { ...p, interval: [0, 2] }, 'INVALID_INTERVAL');
  failure(r, 'query_metrics', { ...p, interval: [0.2, 0.3] }, 'NO_SAMPLES');
  failure(r, 'query_metrics', { ...p, channels: ['left', 'left'] }, 'INVALID_CHANNEL');
  failure(r, 'query_metrics', { ...p, revision: 0 }, 'STALE_SESSION');
  failure(r, 'seek_to_time', {}, 'SCHEMA_VALIDATION');
  failure(r, '__proto__', {}, 'UNKNOWN_TOOL');
  for (const d of TOOL_DEFINITIONS)
    assert.throws(() => validate(d.outputSchema, { fake: true }), /SCHEMA/);
});

test('aspect recalculation changes geometry consistently and invalidates references; single samples have no ROM', () => {
  const s = make(),
    r = createToolRegistry(s);
  s.append(pose(60), 0);
  const old = selection(s);
  const one = successful(r, 'query_metrics', { ...old, interval: [0, 0] });
  assert.equal(one.channels[0].rom, null);
  assert.equal(one.channels[0].velocity.mean, null);
  s.recalculate({ ...parameters, aspect: 2 });
  near(s.frames[0].rawAngles.knee.left, (Math.atan(Math.sqrt(3) / 2) * 180) / Math.PI);
  failure(r, 'query_metrics', { ...old, interval: [0, 0] }, 'STALE_SESSION');
  const ref = selection(s);
  s.reset('camera');
  failure(r, 'query_metrics', { ...ref, interval: [0, 0] }, 'STALE_SESSION');
});

test('quality output is bounded and malformed computed results fail output validation', () => {
  const s = make(),
    r = createToolRegistry(s);
  for (let i = 0; i < 205; i++) s.append(i % 2 ? [] : pose(60), i);
  const q = successful(r, 'get_quality_summary', {
    sessionId: s.info().sessionId,
    revision: s.info().revision,
    interval: [0, 204],
  });
  assert.equal(q.lowConfidenceIntervals.length, 100);
  assert.equal(q.omittedIntervals, 2);
  s.frames[0].rawAngles.knee.left = NaN;
  failure(r, 'query_metrics', { ...selection(s), interval: [0, 204] }, 'SCHEMA_VALIDATION');
});
